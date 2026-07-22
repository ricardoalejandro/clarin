'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { ContactProfileContext } from '@/types/contact-profile'

interface GoogleConnectionStatusResponse {
  success: boolean
  connected: boolean
  configured?: boolean
  token_valid?: boolean
}

interface GoogleContactMutationResponse {
  success: boolean
  error?: string
}

type GoogleMutation = 'sync' | 'desync' | null

interface UseGoogleContactSyncOptions {
  contactId: string
  context: ContactProfileContext
  contactSynced: boolean
  onSyncedChange?: (synced: boolean) => void
}

export function useGoogleContactSync({
  contactId,
  context,
  contactSynced,
  onSyncedChange,
}: UseGoogleContactSyncOptions) {
  const activeKey = `${contactId}:${context.type}:${context.id}`
  const activeKeyRef = useRef(activeKey)
  const statusRequestRef = useRef(0)
  const mutationRequestRef = useRef(0)
  const statusAbortRef = useRef<AbortController | null>(null)
  const mutationAbortRef = useRef<AbortController | null>(null)
  const onSyncedChangeRef = useRef(onSyncedChange)

  const [statusLoading, setStatusLoading] = useState(true)
  const [connected, setConnected] = useState(false)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [synced, setSynced] = useState(contactSynced)
  const [mutation, setMutation] = useState<GoogleMutation>(null)
  const [statusError, setStatusError] = useState('')
  const [actionError, setActionError] = useState('')
  const [feedback, setFeedback] = useState('')

  useEffect(() => {
    onSyncedChangeRef.current = onSyncedChange
  }, [onSyncedChange])

  useEffect(() => {
    setSynced(contactSynced)
  }, [activeKey, contactSynced])

  const loadStatus = useCallback(async () => {
    if (!contactId || !context.id) return
    const requestId = ++statusRequestRef.current
    const requestKey = activeKey
    statusAbortRef.current?.abort()
    const controller = new AbortController()
    statusAbortRef.current = controller

    setStatusLoading(true)
    setStatusError('')
    setPermissionDenied(false)

    const result = await api<GoogleConnectionStatusResponse>('/api/google/status', {
      method: 'GET',
      signal: controller.signal,
    })
    if (controller.signal.aborted || requestId !== statusRequestRef.current || activeKeyRef.current !== requestKey) return

    setStatusLoading(false)
    if (result.status === 403) {
      // Preserve the existing permission boundary: users without Integrations
      // permission do not see a control that they cannot use.
      setConnected(false)
      setPermissionDenied(true)
      return
    }
    if (!result.success || !result.data?.success) {
      setConnected(false)
      setStatusError(result.error || 'No se pudo consultar Google Contacts.')
      return
    }
    setConnected(Boolean(result.data.connected))
  }, [activeKey, contactId, context.id])

  useEffect(() => {
    activeKeyRef.current = activeKey
    statusAbortRef.current?.abort()
    mutationAbortRef.current?.abort()
    statusRequestRef.current += 1
    mutationRequestRef.current += 1
    setStatusLoading(true)
    setConnected(false)
    setPermissionDenied(false)
    setMutation(null)
    setStatusError('')
    setActionError('')
    setFeedback('')
    void loadStatus()

    return () => {
      statusAbortRef.current?.abort()
      mutationAbortRef.current?.abort()
    }
  }, [activeKey, loadStatus])

  const mutate = useCallback(async (nextSynced: boolean) => {
    if (!contactId || mutation) return
    const requestId = ++mutationRequestRef.current
    const requestKey = activeKey
    mutationAbortRef.current?.abort()
    const controller = new AbortController()
    mutationAbortRef.current = controller
    const nextMutation: Exclude<GoogleMutation, null> = nextSynced ? 'sync' : 'desync'

    setMutation(nextMutation)
    setActionError('')
    setFeedback('')

    const result = await api<GoogleContactMutationResponse>(`/api/google/contacts/${contactId}/sync`, {
      method: nextSynced ? 'POST' : 'DELETE',
      signal: controller.signal,
    })
    if (controller.signal.aborted || requestId !== mutationRequestRef.current || activeKeyRef.current !== requestKey) return

    setMutation(null)
    if (!result.success || !result.data?.success) {
      setActionError(result.error || (nextSynced
        ? 'No se pudo iniciar la sincronización con Google Contacts.'
        : 'No se pudo quitar el contacto de Google Contacts.'))
      return
    }

    setSynced(nextSynced)
    setFeedback(nextSynced
      ? 'Sincronización iniciada. Google Contacts se actualizará en segundo plano.'
      : 'El contacto se quitó de Google Contacts.')
    onSyncedChangeRef.current?.(nextSynced)
  }, [activeKey, contactId, mutation])

  return {
    statusLoading,
    connected,
    permissionDenied,
    synced,
    mutation,
    statusError,
    actionError,
    feedback,
    retryStatus: loadStatus,
    sync: () => mutate(true),
    desync: () => mutate(false),
  }
}
