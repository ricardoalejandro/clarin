'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { subscribeWebSocket } from '@/lib/api'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import { isDeviceDeleting } from '@/components/settings/deviceLifecycle'
import type { Chat, Device } from '@/types/chat'
import {
  chatDeviceFromOption,
  cleanWhatsAppPhone,
  createWhatsAppChat,
  resolveWhatsAppChat,
  type WhatsAppDeviceOption,
} from '@/lib/whatsappChatLauncher'
import type { CrmMessagePhase } from '@/components/crm-detail/crmMessageWorkflow'

export type WhatsAppChatLauncherPhase =
  | 'idle'
  | 'resolving'
  | 'choosing_device'
  | 'opening_chat'
  | 'chat'
  | 'read_only'
  | 'error'

export interface WhatsAppChatLauncherState {
  phase: WhatsAppChatLauncherPhase
  phone: string
  chat: Chat | null
  device: Device | null
  devices: WhatsAppDeviceOption[]
  historicalPhone: string
  error: string
  readOnlyReason: string
}

interface UseWhatsAppChatLauncherOptions {
  sessionKey: string | null | undefined
  contactId?: string | null
  onError?: (message: string) => void
}

interface OpenWhatsAppChatOptions {
  invoker?: HTMLElement | null
  sessionKey?: string | null
  contactId?: string | null
}

const INITIAL_STATE: WhatsAppChatLauncherState = {
  phase: 'idle',
  phone: '',
  chat: null,
  device: null,
  devices: [],
  historicalPhone: '',
  error: '',
  readOnlyReason: '',
}

export function whatsappLauncherCrmPhase(phase: WhatsAppChatLauncherPhase): CrmMessagePhase {
  switch (phase) {
    case 'resolving': return 'resolving'
    case 'choosing_device': return 'choosing_device'
    case 'opening_chat': return 'opening_chat'
    case 'chat':
    case 'read_only': return 'chat'
    default: return 'idle'
  }
}

export function whatsappLauncherIsPending(phase: WhatsAppChatLauncherPhase) {
  return phase === 'resolving' || phase === 'opening_chat'
}

export default function useWhatsAppChatLauncher({ sessionKey, contactId, onError }: UseWhatsAppChatLauncherOptions) {
  const authScope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  const [state, setState] = useState<WhatsAppChatLauncherState>(INITIAL_STATE)
  const requestRef = useRef<{ generation: number; controller: AbortController | null; authScope: string }>({ generation: 0, controller: null, authScope })
  const stateScopeRef = useRef(authScope)
  const stateRef = useRef(state)
  stateRef.current = state
  const deletingDeviceIdsRef = useRef(new Set<string>())
  const sessionKeyRef = useRef(sessionKey)
  const contactIdRef = useRef(contactId)
  const invokerRef = useRef<HTMLElement | null>(null)
  const onErrorRef = useRef(onError)

  useEffect(() => { onErrorRef.current = onError }, [onError])
  useEffect(() => { contactIdRef.current = contactId }, [contactId])

  const invalidate = useCallback(() => {
    requestRef.current.controller?.abort()
    requestRef.current = { generation: requestRef.current.generation + 1, controller: null, authScope: getAuthScope() }
    return requestRef.current.generation
  }, [])

  const beginRequest = useCallback(() => {
    const generation = invalidate()
    const controller = new AbortController()
    requestRef.current.controller = controller
    return { generation, controller, sessionKey: sessionKeyRef.current, contactId: contactIdRef.current || null }
  }, [invalidate])

  const isCurrent = useCallback((generation: number, expectedSessionKey: string | null | undefined) => (
    requestRef.current.generation === generation && sessionKeyRef.current === expectedSessionKey && requestRef.current.authScope === getAuthScope() && !isAuthIdentityChanging()
  ), [])

  const reportError = useCallback((generation: number, expectedSessionKey: string | null | undefined, message: string) => {
    if (!isCurrent(generation, expectedSessionKey)) return
    setState(current => ({ ...current, phase: 'error', error: message, devices: [] }))
    onErrorRef.current?.(message)
  }, [isCurrent])

  const reset = useCallback((restoreFocus = false) => {
    invalidate()
    setState(INITIAL_STATE)
    if (restoreFocus) {
      const target = invokerRef.current
      invokerRef.current = null
      requestAnimationFrame(() => target?.focus({ preventScroll: true }))
    }
  }, [invalidate])

  const openWithDevice = useCallback(async (
    deviceOption: WhatsAppDeviceOption,
    phone: string,
    request?: ReturnType<typeof beginRequest>,
  ) => {
    if (isAuthIdentityChanging() || isDeviceDeleting(deviceOption) || deletingDeviceIdsRef.current.has(deviceOption.id)) return
    const activeRequest = request || beginRequest()
    setState(current => ({
      ...current,
      phase: 'opening_chat',
      phone,
      device: chatDeviceFromOption(deviceOption),
      error: '',
    }))
    try {
      const result = await createWhatsAppChat(deviceOption.id, phone, {
        contactId: activeRequest.contactId,
        signal: activeRequest.controller.signal,
      })
      if (!isCurrent(activeRequest.generation, activeRequest.sessionKey)) return
      if (!result.success || !result.chat) {
        reportError(activeRequest.generation, activeRequest.sessionKey, result.error || 'No se pudo abrir la conversación')
        return
      }
      setState(current => ({
        ...current,
        phase: 'chat',
        chat: result.chat || null,
        device: chatDeviceFromOption(deviceOption),
        devices: [],
        error: '',
        readOnlyReason: '',
      }))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      reportError(activeRequest.generation, activeRequest.sessionKey, 'No se pudo conectar con WhatsApp')
    }
  }, [beginRequest, isCurrent, reportError])

  const open = useCallback(async (rawPhone: string, options: OpenWhatsAppChatOptions = {}) => {
    if (isAuthIdentityChanging()) return
    if (options.sessionKey !== undefined) sessionKeyRef.current = options.sessionKey
    if (options.contactId !== undefined) contactIdRef.current = options.contactId
    invokerRef.current = options.invoker || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    const phone = cleanWhatsAppPhone(rawPhone)
    if (!phone) {
      invalidate()
      onErrorRef.current?.('El contacto no tiene un teléfono válido')
      setState({ ...INITIAL_STATE, phase: 'error', error: 'El contacto no tiene un teléfono válido' })
      return
    }
    const request = beginRequest()
    setState({ ...INITIAL_STATE, phase: 'resolving', phone })
    try {
      const resolution = await resolveWhatsAppChat(phone, {
        contactId: request.contactId,
        signal: request.controller.signal,
      })
      if (!isCurrent(request.generation, request.sessionKey)) return
      if (!resolution.success) {
        reportError(request.generation, request.sessionKey, resolution.error || 'No se pudo resolver la conversación')
        return
      }
      resolution.devices = resolution.devices.filter(device => !deletingDeviceIdsRef.current.has(device.id))
      if (!resolution.devices.length && resolution.mode !== 'read_only') resolution.mode = resolution.chat ? 'read_only' : 'no_device'
      const base = {
        phone,
        chat: resolution.chat || null,
        device: null,
        devices: resolution.devices || [],
        historicalPhone: resolution.historical_phone || '',
        error: '',
        readOnlyReason: '',
      }
      if (resolution.mode === 'read_only' && resolution.chat) {
        setState({
          ...base,
          phase: 'read_only',
          devices: [],
          readOnlyReason: 'El dispositivo de este historial no está disponible. Puedes consultar la conversación en modo de solo lectura, sin enviar ni reaccionar.',
        })
        return
      }
      if (resolution.mode === 'open_direct' && resolution.devices[0]) {
        setState({ ...base, phase: 'opening_chat', device: chatDeviceFromOption(resolution.devices[0]) })
        await openWithDevice(resolution.devices[0], phone, request)
        return
      }
      if (resolution.mode === 'choose_device' && resolution.devices.length > 0) {
        setState({ ...base, phase: 'choosing_device' })
        return
      }
      reportError(request.generation, request.sessionKey, 'No hay dispositivos WhatsApp Web conectados para enviar')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      reportError(request.generation, request.sessionKey, 'No se pudo conectar con WhatsApp')
    }
  }, [beginRequest, invalidate, isCurrent, openWithDevice, reportError])

  const selectDevice = useCallback((device: WhatsAppDeviceOption) => {
    void openWithDevice(device, state.phone)
  }, [openWithDevice, state.phone])

  const openHistorical = useCallback(() => {
    if (!state.chat) return
    invalidate()
    setState(current => ({
      ...current,
      phase: 'read_only',
      device: null,
      devices: [],
      error: '',
      readOnlyReason: 'Estás viendo el historial del dispositivo anterior. Este modo es solo lectura.',
    }))
  }, [invalidate, state.chat])

  useEffect(() => {
    if (sessionKeyRef.current === sessionKey) return
    sessionKeyRef.current = sessionKey
    reset(false)
  }, [reset, sessionKey])

  useEffect(() => {
    stateScopeRef.current = authScope
    deletingDeviceIdsRef.current.clear()
    reset(false)
    if (isAuthIdentityChanging(authScope)) return
    return subscribeWebSocket(value => {
      if (authScope !== getAuthScope()) return
      const event = value as { event?: string; data?: { device_id?: string } }
      if (event.event !== 'device_deletion' || !event.data?.device_id) return
      const id = event.data.device_id
      deletingDeviceIdsRef.current.add(id)
      const current = stateRef.current
      if (current.device?.id !== id && !current.devices.some(device => device.id === id)) return
      invalidate()
      setState(previous => {
        const devices = previous.devices.filter(device => device.id !== id)
        if (previous.device?.id === id && previous.chat) return { ...previous, device: null, devices, phase: 'read_only', readOnlyReason: 'Este dispositivo se está eliminando. El historial sigue disponible en solo lectura.' }
        if (devices.length === 0) return previous.chat
          ? { ...previous, devices, device: null, phase: 'read_only', readOnlyReason: 'El dispositivo de este historial no está disponible.' }
          : { ...previous, devices, device: null, phase: 'error', error: 'No hay dispositivos disponibles para enviar.' }
        return { ...previous, devices, device: null, phase: 'choosing_device' }
      })
    })
  }, [authScope, reset, invalidate])

  useEffect(() => () => requestRef.current.controller?.abort(), [])

  const close = useCallback(() => reset(true), [reset])
  const clear = useCallback(() => reset(false), [reset])
  const retry = useCallback(() => {
    if (!state.phone) return
    void open(state.phone, { sessionKey: sessionKeyRef.current, contactId: contactIdRef.current })
  }, [open, state.phone])

  const visibleState = stateScopeRef.current === authScope && !isAuthIdentityChanging(authScope) ? state : INITIAL_STATE
  return {
    ...visibleState,
    chatOpen: (visibleState.phase === 'chat' || visibleState.phase === 'read_only') && Boolean(visibleState.chat),
    readOnly: visibleState.phase === 'read_only',
    pending: whatsappLauncherIsPending(visibleState.phase),
    showDeviceSelector: visibleState.phase === 'choosing_device',
    crmPhase: whatsappLauncherCrmPhase(visibleState.phase),
    open,
    selectDevice,
    openHistorical,
    retry,
    canRetry: state.phase === 'error' && Boolean(state.phone),
    close,
    reset: clear,
  }
}
