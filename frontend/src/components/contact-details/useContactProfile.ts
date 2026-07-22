'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, subscribeWebSocket } from '@/lib/api'
import { contactIdFromRealtimeEvent } from '@/lib/contactProfileEvents'
import type { Observation } from '@/types/contact'
import type {
  ContactProfileCapabilities,
  ContactProfileAvailableTag,
  ContactProfileContact,
  ContactProfileContext,
  ContactProfileCustomFieldDefinition,
  ContactProfileObservationResponse,
  ContactProfileObservationsResponse,
  ContactProfilePatch,
  ContactProfileResponse,
} from '@/types/contact-profile'

const emptyCapabilities: ContactProfileCapabilities = {
  can_view: false,
  can_edit: false,
  can_manage_avatar: false,
  can_manage_observations: false,
  can_create_tags: false,
}

function normalizeContact(contact: Partial<ContactProfileContact> | null | undefined): ContactProfileContact | null {
  if (!contact?.id) return null
  return {
    ...contact,
    id: contact.id,
    structured_tags: Array.isArray(contact.structured_tags) ? contact.structured_tags : [],
    extra_phones: Array.isArray(contact.extra_phones) ? contact.extra_phones : [],
    custom_field_values: Array.isArray(contact.custom_field_values) ? contact.custom_field_values : [],
  }
}

function contextQuery(context: ContactProfileContext) {
  const params = new URLSearchParams({ context_type: context.type, context_id: context.id })
  return params.toString()
}

interface UseContactProfileOptions {
  contactId: string
  context: ContactProfileContext
  initialContact?: Partial<ContactProfileContact> | null
  enabled?: boolean
  onContactChange?: (contact: ContactProfileContact) => void
}

interface MutationResult {
  success: boolean
  error?: string
  contact?: ContactProfileContact
}

export function useContactProfile({
  contactId,
  context,
  initialContact,
  enabled = true,
  onContactChange,
}: UseContactProfileOptions) {
  const initial = useMemo(() => normalizeContact(initialContact), [initialContact])
  const [contact, setContact] = useState<ContactProfileContact | null>(initial)
  const [capabilities, setCapabilities] = useState<ContactProfileCapabilities>(emptyCapabilities)
  const [availableTags, setAvailableTags] = useState<ContactProfileAvailableTag[]>([])
  const [customFieldDefinitions, setCustomFieldDefinitions] = useState<ContactProfileCustomFieldDefinition[]>([])
  const [loading, setLoading] = useState(enabled && !initial)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const [observations, setObservations] = useState<Observation[]>([])
  const [observationCount, setObservationCount] = useState(0)
  const [observationsLoaded, setObservationsLoaded] = useState(false)
  const [observationsLoading, setObservationsLoading] = useState(false)
  const [observationsError, setObservationsError] = useState('')
  const [savingObservation, setSavingObservation] = useState(false)

  const profileRequestRef = useRef(0)
  const observationRequestRef = useRef(0)
  const mutationRequestRef = useRef(0)
  const profileAbortRef = useRef<AbortController | null>(null)
  const observationsAbortRef = useRef<AbortController | null>(null)
  const contactRef = useRef<ContactProfileContact | null>(initial)
  const observationsRef = useRef<Observation[]>([])
  const contextType = context.type
  const contextId = context.id
  const query = useMemo(() => contextQuery({ type: contextType, id: contextId }), [contextId, contextType])
  const activeKey = `${contactId}:${contextType}:${contextId}`
  const activeKeyRef = useRef(activeKey)
  const onContactChangeRef = useRef(onContactChange)

  useEffect(() => {
    onContactChangeRef.current = onContactChange
  }, [onContactChange])

  useEffect(() => {
    contactRef.current = contact
  }, [contact])

  useEffect(() => {
    observationsRef.current = observations
  }, [observations])

  const fetchProfile = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!enabled || !contactId || !contextId) return
    const requestId = ++profileRequestRef.current
    const requestKey = activeKey
    profileAbortRef.current?.abort()
    const controller = new AbortController()
    profileAbortRef.current = controller
    if (options.silent && contactRef.current) setRefreshing(true)
    else setLoading(true)
    setError('')

    const result = await api<ContactProfileResponse>(
      `/api/contact-profiles/${contactId}?${query}`,
      { method: 'GET', signal: controller.signal },
    )
    if (controller.signal.aborted || requestId !== profileRequestRef.current || activeKeyRef.current !== requestKey) return
    if (!result.success || !result.data?.success || !result.data.contact) {
      setError(result.error || 'No se pudo cargar la ficha del contacto.')
    } else {
      const next = normalizeContact(result.data.contact)
      if (next) {
        setContact(next)
        setCapabilities(result.data.capabilities || emptyCapabilities)
        setAvailableTags(Array.isArray(result.data.available_tags) ? result.data.available_tags : [])
        setObservationCount(Math.max(0, Number(result.data.observation_count) || 0))
        setCustomFieldDefinitions(Array.isArray(result.data.custom_field_definitions) ? result.data.custom_field_definitions : [])
        onContactChangeRef.current?.(next)
      }
    }
    setLoading(false)
    setRefreshing(false)
  }, [activeKey, contactId, contextId, enabled, query])

  const fetchObservations = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!enabled || !contactId || !contextId) return
    const requestId = ++observationRequestRef.current
    const requestKey = activeKey
    observationsAbortRef.current?.abort()
    const controller = new AbortController()
    observationsAbortRef.current = controller
    if (!options.silent || observationsRef.current.length === 0) setObservationsLoading(true)
    setObservationsError('')

    const result = await api<ContactProfileObservationsResponse>(
      `/api/contact-profiles/${contactId}/observations?${query}`,
      { method: 'GET', signal: controller.signal },
    )
    if (controller.signal.aborted || requestId !== observationRequestRef.current || activeKeyRef.current !== requestKey) return
    if (!result.success || !result.data?.success) {
      setObservationsError(result.error || 'No se pudo cargar el historial del contacto.')
    } else {
      const next = Array.isArray(result.data.observations) ? result.data.observations : []
      setObservations(next)
      setObservationCount(Math.max(0, Number(result.data.total) || next.length))
      setObservationsLoaded(true)
    }
    setObservationsLoading(false)
  }, [activeKey, contactId, contextId, enabled, query])

  useEffect(() => {
    activeKeyRef.current = activeKey
    profileAbortRef.current?.abort()
    observationsAbortRef.current?.abort()
    profileRequestRef.current += 1
    observationRequestRef.current += 1
    mutationRequestRef.current += 1
    setContact(normalizeContact(initialContact))
    setCapabilities(emptyCapabilities)
    setAvailableTags([])
    setCustomFieldDefinitions([])
    setError('')
    setSaving(false)
    setObservations([])
    setObservationCount(0)
    setObservationsLoaded(false)
    setObservationsError('')
    setSavingObservation(false)
    setLoading(enabled && !normalizeContact(initialContact))
    setObservationsLoading(false)
    if (enabled) {
      void fetchProfile()
    }
    return () => {
      profileAbortRef.current?.abort()
      observationsAbortRef.current?.abort()
    }
    // `initialContact` is deliberately consumed only when the entity key changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, enabled])

  useEffect(() => {
    if (!enabled) return
    return subscribeWebSocket(message => {
      if (!message || typeof message !== 'object') return
      const record = message as { event?: string }
      const event = record.event
      const eventContact = contactIdFromRealtimeEvent(message)
      if (eventContact && eventContact !== contactId) return
      if (event === 'contact_update' && eventContact === contactId) {
        void fetchProfile({ silent: true })
      } else if (event === 'interaction_update' && (!eventContact || eventContact === contactId)) {
        if (observationsLoaded) void fetchObservations({ silent: true })
        else void fetchProfile({ silent: true })
      }
    })
  }, [contactId, enabled, fetchObservations, fetchProfile, observationsLoaded])

  const updateContact = useCallback(async (patch: ContactProfilePatch): Promise<MutationResult> => {
    if (!enabled || !contactId || !context.id || !capabilities.can_edit) {
      return { success: false, error: 'No tienes permiso para editar esta ficha.' }
    }
    const requestId = ++mutationRequestRef.current
    const requestKey = activeKey
    setSaving(true)
    const result = await api<ContactProfileResponse>(
      `/api/contact-profiles/${contactId}?${query}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    )
    if (requestId !== mutationRequestRef.current || activeKeyRef.current !== requestKey) {
      return { success: false, error: 'La ficha cambió mientras se guardaba.' }
    }
    setSaving(false)
    if (!result.success || !result.data?.success || !result.data.contact) {
      return { success: false, error: result.error || 'No se pudo guardar el contacto.' }
    }
    const next = normalizeContact(result.data.contact)
    if (!next) return { success: false, error: 'La respuesta del contacto no es válida.' }
    setContact(next)
    setCapabilities(result.data.capabilities || capabilities)
    setAvailableTags(Array.isArray(result.data.available_tags) ? result.data.available_tags : availableTags)
    setObservationCount(Math.max(0, Number(result.data.observation_count) || observationCount))
    setCustomFieldDefinitions(Array.isArray(result.data.custom_field_definitions) ? result.data.custom_field_definitions : customFieldDefinitions)
    onContactChangeRef.current?.(next)
    return { success: true, contact: next }
  }, [activeKey, availableTags, capabilities, contactId, contextId, customFieldDefinitions, enabled, observationCount, query])

  const updateAvatarLocally = useCallback((avatar: { avatar_url?: string | null; revision?: number }) => {
    setContact(current => {
      if (!current) return current
      const next = {
        ...current,
        avatar_url: avatar.avatar_url ?? current.avatar_url,
        avatar_revision: avatar.revision ?? current.avatar_revision,
      }
      onContactChangeRef.current?.(next)
      return next
    })
  }, [])

  const updateGoogleSyncLocally = useCallback((googleSync: boolean) => {
    setContact(current => {
      if (!current) return current
      const next: ContactProfileContact = {
        ...current,
        google_sync: googleSync,
        google_resource_name: googleSync ? current.google_resource_name : null,
        google_synced_at: googleSync ? current.google_synced_at : null,
        google_sync_error: null,
      }
      onContactChangeRef.current?.(next)
      return next
    })
  }, [])

  const createObservation = useCallback(async (notes: string): Promise<{ success: boolean; error?: string }> => {
    const cleanNotes = notes.trim()
    if (!cleanNotes) return { success: false, error: 'Escribe una observación antes de guardar.' }
    if (!capabilities.can_manage_observations) return { success: false, error: 'No tienes permiso para añadir observaciones.' }
    const requestKey = activeKey
    setSavingObservation(true)
    const result = await api<ContactProfileObservationResponse>(
      `/api/contact-profiles/${contactId}/observations?${query}`,
      { method: 'POST', body: JSON.stringify({ notes: cleanNotes }) },
    )
    if (activeKeyRef.current !== requestKey) return { success: false, error: 'El contacto cambió mientras se guardaba.' }
    setSavingObservation(false)
    if (!result.success || !result.data?.success || !result.data.observation) {
      return { success: false, error: result.error || 'No se pudo guardar la observación.' }
    }
    setObservations(current => [result.data!.observation, ...current.filter(item => item.id !== result.data!.observation.id)])
    setObservationCount(current => typeof result.data!.total === 'number' ? Math.max(0, result.data!.total) : current + 1)
    return { success: true }
  }, [activeKey, capabilities.can_manage_observations, contactId, query])

  const deleteObservation = useCallback(async (observationId: string): Promise<{ success: boolean; error?: string }> => {
    if (!capabilities.can_manage_observations) return { success: false, error: 'No tienes permiso para eliminar observaciones.' }
    const requestKey = activeKey
    const result = await api<{ success: boolean; total?: number }>(
      `/api/contact-profiles/${contactId}/observations/${observationId}?${query}`,
      { method: 'DELETE' },
    )
    if (activeKeyRef.current !== requestKey) return { success: false, error: 'El contacto cambió durante la operación.' }
    if (!result.success || !result.data?.success) {
      return { success: false, error: result.error || 'No se pudo eliminar la observación.' }
    }
    setObservations(current => current.filter(item => item.id !== observationId))
    setObservationCount(current => typeof result.data!.total === 'number' ? Math.max(0, result.data!.total) : Math.max(0, current - 1))
    return { success: true }
  }, [activeKey, capabilities.can_manage_observations, contactId, query])

  return {
    contact,
    capabilities,
    availableTags,
    customFieldDefinitions,
    loading,
    refreshing,
    error,
    saving,
    refresh: () => fetchProfile({ silent: Boolean(contact) }),
    updateContact,
    updateAvatarLocally,
    updateGoogleSyncLocally,
    observations,
    observationCount,
    observationsLoaded,
    observationsLoading,
    observationsError,
    savingObservation,
    refreshObservations: () => fetchObservations({ silent: observations.length > 0 }),
    createObservation,
    deleteObservation,
  }
}
