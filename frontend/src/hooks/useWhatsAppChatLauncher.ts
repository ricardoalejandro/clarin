'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { subscribeWebSocket } from '@/lib/api'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import { isDeviceDeleting } from '@/components/settings/deviceLifecycle'
import type { Chat, Device } from '@/types/chat'
import {
  chatDeviceFromOption,
  cleanWhatsAppPhone,
  createWhatsAppChat,
  resolveWhatsAppChat,
  senderConfirmation,
  usableWhatsAppDevice,
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
  | 'no_device'
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
  availability: 'unknown' | 'checking' | 'available' | 'history' | 'unavailable' | 'error'
  notice: string
}

interface UseWhatsAppChatLauncherOptions {
  sessionKey: string | null | undefined
  contactId?: string | null
  onError?: (message: string) => void
  /** Pauses new launches without discarding a resolved choice or an in-flight creation. */
  suspended?: boolean
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
  availability: 'unknown',
  notice: '',
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

export default function useWhatsAppChatLauncher({ sessionKey, contactId, onError, suspended = false }: UseWhatsAppChatLauncherOptions) {
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const authScope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  const [state, setState] = useState<WhatsAppChatLauncherState>(INITIAL_STATE)
  const requestRef = useRef<{ generation: number; controller: AbortController | null; authScope: string }>({ generation: 0, controller: null, authScope })
  const stateScopeRef = useRef(authScope)
  const stateRef = useRef(state)
  stateRef.current = state
  const deletingDeviceIdsRef = useRef(new Set<string>())
  const disconnectedDeviceIdsRef = useRef(new Set<string>())
  const sessionKeyRef = useRef(sessionKey)
  const contactIdRef = useRef(contactId)
  const invokerRef = useRef<HTMLElement | null>(null)
  const onErrorRef = useRef(onError)
  const preparedPhoneRef = useRef('')
  const prepareRef = useRef<(phone: string) => Promise<void>>(async () => {})

  useEffect(() => { onErrorRef.current = onError }, [onError])
  useLayoutEffect(() => { contactIdRef.current = contactId }, [contactId])

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
    setState(current => ({ ...current, phase: 'error', error: message, devices: [], availability: 'error', notice: '' }))
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
    confirmed = false,
  ) => {
    if (suspendedRef.current || isAuthIdentityChanging() || isDeviceDeleting(deviceOption) || deletingDeviceIdsRef.current.has(deviceOption.id) || disconnectedDeviceIdsRef.current.has(deviceOption.id)) return
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
        senderConfirmation: confirmed ? senderConfirmation(deviceOption) : undefined,
      })
      if (!isCurrent(activeRequest.generation, activeRequest.sessionKey)) return
      if (!result.success || !result.chat) {
        if (result.code === 'sender_confirmation_required') {
          const resolution = await resolveWhatsAppChat(phone, { contactId: activeRequest.contactId, signal: activeRequest.controller.signal })
          if (!isCurrent(activeRequest.generation, activeRequest.sessionKey)) return
          if (resolution.success && resolution.devices.length) {
            setState(current => ({ ...current, phase: 'choosing_device', chat: resolution.chat || null, device: null, devices: resolution.devices, historicalPhone: resolution.historical_phone || '', error: '', notice: 'El canal o el historial cambió. Confirma desde qué número deseas continuar.' }))
            return
          }
          if (resolution.success) {
            setState(current => ({ ...current, phase: resolution.chat ? 'read_only' : 'no_device', chat: resolution.chat || null, device: null, devices: [], availability: resolution.chat ? 'history' : 'unavailable', error: '', notice: 'Para enviar mensajes, conecta un dispositivo de WhatsApp Web.', readOnlyReason: 'Puedes consultar esta conversación. Para enviar mensajes, conecta un dispositivo de WhatsApp Web.' }))
            return
          }
        }
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
        availability: 'available',
        notice: '',
      }))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      reportError(activeRequest.generation, activeRequest.sessionKey, 'No se pudo conectar con WhatsApp')
    }
  }, [beginRequest, isCurrent, reportError])

  const open = useCallback(async (rawPhone: string, options: OpenWhatsAppChatOptions = {}) => {
    if (suspendedRef.current || isAuthIdentityChanging()) return
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
      resolution.devices = resolution.devices.filter(device => !deletingDeviceIdsRef.current.has(device.id) && !disconnectedDeviceIdsRef.current.has(device.id))
      if (!resolution.devices.length && resolution.mode !== 'read_only') resolution.mode = resolution.chat ? 'read_only' : 'no_device'
      const base: Omit<WhatsAppChatLauncherState, 'phase'> = {
        phone,
        chat: resolution.chat || null,
        device: null,
        devices: resolution.devices || [],
        historicalPhone: resolution.historical_phone || '',
        error: '',
        readOnlyReason: '',
        availability: resolution.devices.length ? 'available' : resolution.chat ? 'history' : 'unavailable',
        notice: '',
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
        if (suspendedRef.current) {
          setState({ ...base, phase: 'choosing_device', notice: 'La apertura está pausada. Confirma el canal cuando vuelvas a la vista de escritorio.' })
          return
        }
        setState({ ...base, phase: 'opening_chat', device: chatDeviceFromOption(resolution.devices[0]) })
        await openWithDevice(resolution.devices[0], phone, request)
        return
      }
      if (resolution.mode === 'choose_device' && resolution.devices.length > 0) {
        setState({ ...base, phase: 'choosing_device' })
        return
      }
      setState({ ...base, phase: 'no_device', notice: 'Para enviar mensajes, conecta un dispositivo de WhatsApp Web.' })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      reportError(request.generation, request.sessionKey, 'No se pudo conectar con WhatsApp')
    }
  }, [beginRequest, invalidate, isCurrent, openWithDevice, reportError])

  const selectDevice = useCallback((device: WhatsAppDeviceOption) => {
    if (suspendedRef.current || stateRef.current.phase !== 'choosing_device') return
    const current = stateRef.current.devices.find(candidate => candidate.id === device.id)
    if (!current || !usableWhatsAppDevice(current)) return
    void openWithDevice(current, stateRef.current.phone, undefined, true)
  }, [openWithDevice])

  const prepare = useCallback(async (rawPhone: string) => {
    const phone = cleanWhatsAppPhone(rawPhone)
    preparedPhoneRef.current = phone
    if (!phone || !sessionKeyRef.current || isAuthIdentityChanging()) return
    // Availability is read-only: it must never create/reassign a chat or open a window.
    if (['chat', 'read_only', 'resolving', 'opening_chat', 'choosing_device'].includes(stateRef.current.phase)) return
    const request = beginRequest()
    setState(current => ({ ...current, phone, phase: 'idle', availability: 'checking', error: '', notice: '' }))
    try {
      const resolution = await resolveWhatsAppChat(phone, { contactId: request.contactId, signal: request.controller.signal })
      if (!isCurrent(request.generation, request.sessionKey)) return
      if (!resolution.success) { reportError(request.generation, request.sessionKey, resolution.error || 'No pudimos comprobar los canales disponibles.'); return }
      const devices = resolution.devices.filter(device => !deletingDeviceIdsRef.current.has(device.id) && !disconnectedDeviceIdsRef.current.has(device.id))
      setState(current => ({ ...current, phase: 'idle', phone, chat: resolution.chat || null, devices, historicalPhone: resolution.historical_phone || '', availability: devices.length ? 'available' : resolution.chat ? 'history' : 'unavailable', notice: devices.length ? '' : resolution.chat ? 'Puedes consultar esta conversación. Para enviar mensajes, conecta un dispositivo de WhatsApp Web.' : 'Para enviar mensajes, conecta un dispositivo de WhatsApp Web.', error: '' }))
    } catch (error) {
      if (request.controller.signal.aborted) return
      reportError(request.generation, request.sessionKey, 'No pudimos comprobar los canales disponibles. Intenta nuevamente.')
    }
  }, [beginRequest, isCurrent, reportError])
  prepareRef.current = prepare

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

  useLayoutEffect(() => {
    if (sessionKeyRef.current === sessionKey) return
    sessionKeyRef.current = sessionKey
    preparedPhoneRef.current = ''
    reset(false)
  }, [reset, sessionKey])

  useLayoutEffect(() => {
    const changed = stateScopeRef.current !== authScope
    stateScopeRef.current = authScope
    deletingDeviceIdsRef.current.clear()
    disconnectedDeviceIdsRef.current.clear()
    if (changed) reset(false)
    if (isAuthIdentityChanging(authScope)) return
    return subscribeWebSocket(value => {
      if (authScope !== getAuthScope()) return
      const event = value as { event?: string; data?: { device_id?: string; status?: string } }
      if (!['device_deletion', 'device_status'].includes(event.event || '') || !event.data?.device_id) return
      const id = event.data.device_id
      if (event.event === 'device_deletion') deletingDeviceIdsRef.current.add(id)
      if (event.event === 'device_status') {
        if (event.data.status === 'connected') disconnectedDeviceIdsRef.current.delete(id)
        else disconnectedDeviceIdsRef.current.add(id)
      }
      const current = stateRef.current
      if (event.event === 'device_status' && event.data.status === 'connected') {
        if (!['chat', 'read_only', 'resolving', 'opening_chat', 'choosing_device'].includes(current.phase)) void prepareRef.current(preparedPhoneRef.current || current.phone)
        return
      }
      if (current.device?.id !== id && !current.devices.some(device => device.id === id)) return
      if (current.phase === 'idle' || current.phase === 'no_device' || current.phase === 'error') { void prepareRef.current(preparedPhoneRef.current || current.phone); return }
      // The mounted ChatPanel validates its fixed sender and owns recovery.
      if (current.phase === 'chat' && event.event === 'device_status') return
      invalidate()
      setState(previous => {
        const devices = previous.devices.filter(device => device.id !== id)
        if (previous.device?.id === id && previous.chat) return { ...previous, device: null, devices, phase: 'read_only', readOnlyReason: event.event === 'device_deletion' ? 'Este dispositivo se está eliminando. El historial sigue disponible en solo lectura.' : 'Este dispositivo se desconectó. Puedes seguir consultando el historial.' }
        if (devices.length === 0) return previous.chat
          ? { ...previous, devices, device: null, phase: 'read_only', readOnlyReason: 'El dispositivo de este historial no está disponible.' }
          : { ...previous, devices, device: null, phase: 'no_device', availability: 'unavailable', error: '', notice: 'Para enviar mensajes, conecta un dispositivo de WhatsApp Web.' }
        return { ...previous, devices, device: null, phase: 'choosing_device' }
      })
    })
  }, [authScope, reset, invalidate])

  useEffect(() => () => requestRef.current.controller?.abort(), [])

  const close = useCallback(() => { reset(true); stateRef.current = INITIAL_STATE; void prepareRef.current(preparedPhoneRef.current) }, [reset])
  const clear = useCallback(() => reset(false), [reset])
  const retry = useCallback(() => {
    if (!state.phone) return
    void prepare(state.phone)
  }, [prepare, state.phone])

  const visibleState = stateScopeRef.current === authScope && !isAuthIdentityChanging(authScope) ? state : INITIAL_STATE
  return {
    ...visibleState,
    chatOpen: (visibleState.phase === 'chat' || visibleState.phase === 'read_only') && Boolean(visibleState.chat),
    readOnly: visibleState.phase === 'read_only',
    pending: whatsappLauncherIsPending(visibleState.phase),
    checkingAvailability: visibleState.availability === 'checking',
    messageDisabled: visibleState.availability === 'unknown' || visibleState.availability === 'checking' || visibleState.availability === 'unavailable' || visibleState.availability === 'error',
    messageLabel: visibleState.availability === 'history' ? 'Ver conversación' : 'Mensaje',
    showDeviceSelector: visibleState.phase === 'choosing_device',
    crmPhase: whatsappLauncherCrmPhase(visibleState.phase),
    open,
    prepare,
    selectDevice,
    openHistorical,
    retry,
    canRetry: (visibleState.availability === 'error' || visibleState.availability === 'unavailable' || visibleState.availability === 'history') && Boolean(visibleState.phone),
    close,
    reset: clear,
  }
}
