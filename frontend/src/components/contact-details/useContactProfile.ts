'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { api, subscribeWebSocket } from '@/lib/api'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import { contactIdFromRealtimeEvent } from '@/lib/contactProfileEvents'
import type { Observation } from '@/types/contact'
import type { ContactProfileCapabilities, ContactProfileAvailableTag, ContactProfileContact, ContactProfileContext, ContactProfileCustomFieldDefinition, ContactProfileObservationResponse, ContactProfileObservationsResponse, ContactProfilePatch, ContactProfileResponse } from '@/types/contact-profile'

const emptyCapabilities: ContactProfileCapabilities = { can_view: false, can_edit: false, can_manage_avatar: false, can_manage_observations: false, can_create_tags: false }
const PAGE_SIZE = 50
const canonicalCount = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback

function preserveNewerAvatar(previous: ContactProfileContact | null, incoming: ContactProfileContact) {
  return previous?.id === incoming.id && (previous.avatar_revision || 0) > (incoming.avatar_revision || 0)
    ? { ...incoming, avatar_url: previous.avatar_url, avatar_revision: previous.avatar_revision, avatar_source: previous.avatar_source, avatar_updated_at: previous.avatar_updated_at, avatar_media_asset_id: previous.avatar_media_asset_id }
    : incoming
}

function normalizeContact(contact: Partial<ContactProfileContact> | null | undefined): ContactProfileContact | null {
  if (!contact?.id) return null
  return { ...contact, id: contact.id, structured_tags: Array.isArray(contact.structured_tags) ? contact.structured_tags : [], extra_phones: Array.isArray(contact.extra_phones) ? contact.extra_phones : [], custom_field_values: Array.isArray(contact.custom_field_values) ? contact.custom_field_values : [] }
}

export function mergeContactObservations(previous: Observation[], incoming: Observation[]) {
  const rows = new Map(previous.map(row => [row.id, row]))
  incoming.forEach(row => rows.set(row.id, row))
  const pinned = (row: Observation) => row.type === 'note' && Boolean(row.is_pinned)
  const timestamp = (value?: string | null) => value ? Date.parse(value) || 0 : 0
  return [...rows.values()].sort((a, b) => Number(pinned(b)) - Number(pinned(a)) || timestamp(b.pinned_at) - timestamp(a.pinned_at) || timestamp(b.created_at) - timestamp(a.created_at) || b.id.localeCompare(a.id))
}

interface UseContactProfileOptions {
  contactId: string
  context: ContactProfileContext
  initialContact?: Partial<ContactProfileContact> | null
  enabled?: boolean
  onContactChange?: (contact: ContactProfileContact) => void
}
interface MutationResult { success: boolean; error?: string; contact?: ContactProfileContact; stale?: boolean }
type AvatarUpdate = { avatar_url?: string | null; revision?: number; source?: ContactProfileContact['avatar_source']; updated_at?: string | null }
const staleMutation: MutationResult = { success: false, stale: true }

export function useContactProfile({ contactId, context, initialContact, enabled = true, onContactChange }: UseContactProfileOptions) {
  const authScope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  const snapshotScopeRef = useRef(authScope)
  const ready = enabled && !isAuthIdentityChanging(authScope)
  const initial = useMemo(() => normalizeContact(initialContact), [initialContact])
  const [contact, setContact] = useState<ContactProfileContact | null>(initial)
  const [capabilities, setCapabilities] = useState(emptyCapabilities)
  const [availableTags, setAvailableTags] = useState<ContactProfileAvailableTag[]>([])
  const [customFieldDefinitions, setCustomFieldDefinitions] = useState<ContactProfileCustomFieldDefinition[]>([])
  const [loading, setLoading] = useState(ready && !initial)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [observations, setObservations] = useState<Observation[]>([])
  const [observationCount, setObservationCount] = useState(0)
  const [pinnedObservationCount, setPinnedObservationCount] = useState(0)
  const [observationsLoaded, setObservationsLoaded] = useState(false)
  const [observationsLoading, setObservationsLoading] = useState(false)
  const [observationsLoadingMore, setObservationsLoadingMore] = useState(false)
  const [observationsHasMore, setObservationsHasMore] = useState(false)
  const [observationsError, setObservationsError] = useState('')
  const [savingObservation, setSavingObservation] = useState(false)
  const [pendingObservationIds, setPendingObservationIds] = useState<Set<string>>(new Set())
  const profileRequestRef = useRef(0)
  const observationRequestRef = useRef(0)
  const generationRef = useRef(0)
  const profileAbortRef = useRef<AbortController | null>(null)
  const observationsAbortRef = useRef<AbortController | null>(null)
  const mutationsRef = useRef(new Set<AbortController>())
  const pendingNotesRef = useRef(new Map<string, AbortController>())
  const savingContactRef = useRef(false)
  const savingObservationRef = useRef(false)
  const contactRef = useRef(initial)
  const observationsRef = useRef<Observation[]>([])
  const observationsLoadedRef = useRef(false)
  const observationsRequestedRef = useRef(false)
  const nextCursorRef = useRef('')
  const contextType = context.type
  const contextId = context.id
  const query = useMemo(() => new URLSearchParams({ context_type: contextType, context_id: contextId }).toString(), [contextType, contextId])
  const activeKey = `${authScope}:${initialContact?.account_id || ''}:${contactId}:${contextType}:${contextId}`
  const activeKeyRef = useRef(activeKey)
  const stateKeyRef = useRef(activeKey)
  activeKeyRef.current = activeKey
  const onContactChangeRef = useRef(onContactChange)
  onContactChangeRef.current = onContactChange
  const lease = () => ({ key: activeKey, generation: generationRef.current, scope: authScope })
  const current = (request: ReturnType<typeof lease>) => request.key === activeKeyRef.current && request.generation === generationRef.current && request.scope === getAuthScope() && !isAuthIdentityChanging(request.scope)
  const commitObservations = (rows: Observation[]) => { observationsRef.current = rows; setObservations(rows) }

  const fetchProfile = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!ready || !contactId || !contextId || mutationsRef.current.size) return
    const request = lease()
    if (!current(request)) return
    const requestId = ++profileRequestRef.current
    profileAbortRef.current?.abort()
    const controller = new AbortController()
    profileAbortRef.current = controller
    if (options.silent && contactRef.current) setRefreshing(true)
    else setLoading(true)
    setError('')
    const result = await api<ContactProfileResponse>(`/api/contact-profiles/${contactId}?${query}`, { method: 'GET', signal: controller.signal })
    if (!current(request) || controller.signal.aborted || requestId !== profileRequestRef.current) return
    const incoming = result.success && result.data?.success ? normalizeContact(result.data.contact) : null
    const next = incoming ? preserveNewerAvatar(contactRef.current, incoming) : null
    if (!next || next.id !== contactId) setError(result.error || 'No se pudo cargar la ficha del contacto.')
    else {
      contactRef.current = next
      setContact(next)
      setCapabilities(result.data!.capabilities || emptyCapabilities)
      setAvailableTags(Array.isArray(result.data!.available_tags) ? result.data!.available_tags : [])
      setCustomFieldDefinitions(Array.isArray(result.data!.custom_field_definitions) ? result.data!.custom_field_definitions : [])
      setObservationCount(canonicalCount(result.data!.observation_count, 0))
      setPinnedObservationCount(canonicalCount(result.data!.pinned_observation_count, 0))
      onContactChangeRef.current?.(next)
    }
    setLoading(false)
    setRefreshing(false)
  }, [activeKey, contactId, contextId, query, ready])

  // Rebuild the loaded depth silently after ordering changes, rather than retaining stale cursors.
  const fetchObservations = useCallback(async (options: { silent?: boolean; append?: boolean } = {}) => {
    if (!ready || !contactId || !contextId) return
    observationsRequestedRef.current = true
    if (mutationsRef.current.size) return
    if (options.append && (!nextCursorRef.current || observationsAbortRef.current && !observationsAbortRef.current.signal.aborted)) return
    const request = lease()
    if (!current(request)) return
    const requestId = ++observationRequestRef.current
    observationsAbortRef.current?.abort()
    const controller = new AbortController()
    observationsAbortRef.current = controller
    const targetDepth = options.append ? PAGE_SIZE : Math.max(PAGE_SIZE, observationsRef.current.length)
    const maxPages = Math.ceil(targetDepth / PAGE_SIZE)
    let cursor = options.append ? nextCursorRef.current : ''
    let collected: Observation[] = []
    let page: ContactProfileObservationsResponse | undefined
    let failed = false
    let pages = 0
    if (options.append) setObservationsLoadingMore(true)
    else if (!options.silent || observationsRef.current.length === 0) setObservationsLoading(true)
    setObservationsError('')
    do {
      const params = new URLSearchParams(query)
      params.set('limit', String(PAGE_SIZE))
      if (cursor) params.set('cursor', cursor)
      const result = await api<ContactProfileObservationsResponse>(`/api/contact-profiles/${contactId}/observations?${params}`, { method: 'GET', signal: controller.signal })
      if (!current(request) || controller.signal.aborted || requestId !== observationRequestRef.current) return
      if (!result.success || !result.data?.success) {
        failed = true
        setObservationsError(result.error || 'No se pudo cargar el historial del contacto.')
        break
      }
      page = result.data
      collected = mergeContactObservations(collected, Array.isArray(page.observations) ? page.observations : [])
      pages += 1
      const nextCursor = page.next_cursor || ''
      if (nextCursor === cursor) { cursor = ''; break }
      cursor = nextCursor
    } while (!options.append && page?.has_more && cursor && collected.length < targetDepth && pages < maxPages)
    if (page && !failed) {
      commitObservations(options.append ? mergeContactObservations(observationsRef.current, collected) : collected)
      nextCursorRef.current = cursor
      setObservationsHasMore(Boolean(page.has_more && cursor))
      setObservationCount(value => canonicalCount(page!.total, value))
      setPinnedObservationCount(value => canonicalCount(page!.pinned_total, value))
      observationsLoadedRef.current = true
      setObservationsLoaded(true)
    }
    observationsAbortRef.current = null
    setObservationsLoading(false)
    setObservationsLoadingMore(false)
  }, [activeKey, contactId, contextId, query, ready])

  useEffect(() => {
    stateKeyRef.current = activeKey
    generationRef.current += 1
    profileRequestRef.current += 1
    observationRequestRef.current += 1
    const next = ready && snapshotScopeRef.current === authScope ? normalizeContact(initialContact) : null
    contactRef.current = next
    setContact(next)
    setCapabilities(emptyCapabilities)
    setAvailableTags([])
    setCustomFieldDefinitions([])
    setError('')
    savingContactRef.current = false
    savingObservationRef.current = false
    setSaving(false)
    commitObservations([])
    nextCursorRef.current = ''
    observationsLoadedRef.current = false
    observationsRequestedRef.current = false
    setObservationCount(0)
    setPinnedObservationCount(0)
    setObservationsLoaded(false)
    setObservationsHasMore(false)
    setObservationsError('')
    setSavingObservation(false)
    setPendingObservationIds(new Set())
    setLoading(ready && !next)
    setRefreshing(false)
    setObservationsLoading(false)
    setObservationsLoadingMore(false)
    if (ready) void fetchProfile()
    return () => {
      generationRef.current += 1
      profileAbortRef.current?.abort()
      observationsAbortRef.current?.abort()
      mutationsRef.current.forEach(controller => controller.abort())
      mutationsRef.current.clear()
      pendingNotesRef.current.clear()
    }
    // Snapshot props seed only a newly opened identity/session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, ready])

  useEffect(() => {
    if (!ready) return
    return subscribeWebSocket(message => {
      if (!message || typeof message !== 'object') return
      const event = (message as { event?: string }).event
      const eventContact = contactIdFromRealtimeEvent(message)
      if (eventContact && eventContact !== contactId) return
      if (event === 'contact_update' && eventContact === contactId) void fetchProfile({ silent: true })
      else if (event === 'interaction_update' && (!eventContact || eventContact === contactId)) {
        if (observationsRequestedRef.current) void fetchObservations({ silent: true })
        else void fetchProfile({ silent: true })
      }
    })
  }, [contactId, ready, fetchObservations, fetchProfile])

  const beginMutation = (noteId?: string) => {
    const request = lease()
    if (!ready || !current(request) || noteId && pendingNotesRef.current.has(noteId)) return null
    const controller = new AbortController()
    mutationsRef.current.add(controller)
    profileRequestRef.current += 1
    observationRequestRef.current += 1
    profileAbortRef.current?.abort()
    observationsAbortRef.current?.abort()
    observationsAbortRef.current = null
    nextCursorRef.current = ''
    setObservationsHasMore(false)
    setRefreshing(false)
    setLoading(false)
    setObservationsLoading(false)
    setObservationsLoadingMore(false)
    if (noteId) { pendingNotesRef.current.set(noteId, controller); setPendingObservationIds(new Set(pendingNotesRef.current.keys())) }
    return { request, controller, noteId }
  }
  const finishMutation = (operation: NonNullable<ReturnType<typeof beginMutation>>) => {
    mutationsRef.current.delete(operation.controller)
    if (!current(operation.request) || operation.controller.signal.aborted) return
    if (operation.noteId && pendingNotesRef.current.get(operation.noteId) === operation.controller) {
      pendingNotesRef.current.delete(operation.noteId)
      setPendingObservationIds(new Set(pendingNotesRef.current.keys()))
    }
    if (!mutationsRef.current.size) {
      void fetchProfile({ silent: true })
      if (observationsRequestedRef.current) void fetchObservations({ silent: true })
    }
  }
  const applyCounts = (data: { total?: number; pinned_total?: number }, totalDelta = 0, pinDelta = 0) => {
    setObservationCount(value => canonicalCount(data.total, Math.max(0, value + totalDelta)))
    setPinnedObservationCount(value => canonicalCount(data.pinned_total, Math.max(0, value + pinDelta)))
  }

  const updateContact = async (patch: ContactProfilePatch): Promise<MutationResult> => {
    if (!capabilities.can_edit || savingContactRef.current) return { success: false, error: 'No puedes guardar esta ficha ahora.' }
    const operation = beginMutation()
    if (!operation) return staleMutation
    savingContactRef.current = true
    setSaving(true)
    const result = await api<ContactProfileResponse>(`/api/contact-profiles/${contactId}?${query}`, { method: 'PATCH', body: JSON.stringify(patch), signal: operation.controller.signal })
    if (!current(operation.request) || operation.controller.signal.aborted) return staleMutation
    savingContactRef.current = false
    setSaving(false)
    const incoming = result.success && result.data?.success ? normalizeContact(result.data.contact) : null
    const next = incoming ? preserveNewerAvatar(contactRef.current, incoming) : null
    if (!next || next.id !== contactId) { finishMutation(operation); return { success: false, error: result.error || 'No se pudo guardar el contacto.' } }
    contactRef.current = next
    setContact(next)
    setCapabilities(result.data!.capabilities || capabilities)
    if (Array.isArray(result.data!.available_tags)) setAvailableTags(result.data!.available_tags)
    if (Array.isArray(result.data!.custom_field_definitions)) setCustomFieldDefinitions(result.data!.custom_field_definitions)
    setObservationCount(value => canonicalCount(result.data!.observation_count, value))
    setPinnedObservationCount(value => canonicalCount(result.data!.pinned_observation_count, value))
    onContactChangeRef.current?.(next)
    finishMutation(operation)
    return { success: true, contact: next }
  }

  const updateAvatarLocally = useCallback((avatar: AvatarUpdate) => {
    if (activeKeyRef.current !== activeKey || getAuthScope() !== authScope) return
    const previous = contactRef.current
    if (!previous || avatar.revision !== undefined && avatar.revision < (previous.avatar_revision || 0)) return
    const next = { ...previous, avatar_url: avatar.avatar_url !== undefined ? avatar.avatar_url : previous.avatar_url, avatar_revision: avatar.revision ?? previous.avatar_revision, avatar_source: avatar.source !== undefined ? avatar.source : previous.avatar_source, avatar_updated_at: avatar.updated_at !== undefined ? avatar.updated_at : previous.avatar_updated_at, avatar_media_asset_id: avatar.avatar_url === null ? null : previous.avatar_media_asset_id }
    if (next.avatar_url === previous.avatar_url && next.avatar_revision === previous.avatar_revision && next.avatar_source === previous.avatar_source && next.avatar_updated_at === previous.avatar_updated_at) return
    contactRef.current = next
    setContact(next)
    onContactChangeRef.current?.(next)
  }, [activeKey, authScope])
  useEffect(() => {
    if (!ready) return
    const receiveAvatar = (event: Event) => {
      const detail = (event as CustomEvent<{ contactId?: string; authScope?: string; avatar?: AvatarUpdate }>).detail
      if (detail?.contactId === contactId && detail.authScope === authScope && detail.authScope === getAuthScope() && detail.avatar) updateAvatarLocally(detail.avatar)
    }
    window.addEventListener('clarin:contact-avatar-updated', receiveAvatar)
    return () => window.removeEventListener('clarin:contact-avatar-updated', receiveAvatar)
  }, [contactId, authScope, ready, updateAvatarLocally])
  const updateGoogleSyncLocally = useCallback((googleSync: boolean) => {
    if (activeKeyRef.current !== activeKey || getAuthScope() !== authScope) return
    setContact(previous => {
      if (!previous) return previous
      const next = { ...previous, google_sync: googleSync, google_resource_name: googleSync ? previous.google_resource_name : null, google_synced_at: googleSync ? previous.google_synced_at : null, google_sync_error: null }
      contactRef.current = next
      onContactChangeRef.current?.(next)
      return next
    })
  }, [activeKey, authScope])

  const createObservation = async (notes: string): Promise<MutationResult> => {
    const clean = notes.trim()
    if (!clean || clean.length > 4000) return { success: false, error: 'La nota debe contener entre 1 y 4000 caracteres.' }
    if (!capabilities.can_manage_observations || savingObservationRef.current) return { success: false, error: 'No puedes añadir observaciones ahora.' }
    const operation = beginMutation()
    if (!operation) return staleMutation
    savingObservationRef.current = true
    setSavingObservation(true)
    const result = await api<ContactProfileObservationResponse>(`/api/contact-profiles/${contactId}/observations?${query}`, { method: 'POST', body: JSON.stringify({ notes: clean }), signal: operation.controller.signal })
    if (!current(operation.request) || operation.controller.signal.aborted) return staleMutation
    savingObservationRef.current = false
    setSavingObservation(false)
    if (!result.success || !result.data?.success || !result.data.observation) { finishMutation(operation); return { success: false, error: result.error || 'No se pudo guardar la observación.' } }
    const existed = observationsRef.current.some(row => row.id === result.data!.observation.id)
    commitObservations(mergeContactObservations(observationsRef.current, [result.data.observation]))
    applyCounts(result.data, existed ? 0 : 1)
    finishMutation(operation)
    return { success: true }
  }
  const mutateObservation = async (observation: Observation, action: 'delete' | 'edit' | 'pin', value?: string | boolean): Promise<MutationResult> => {
    const permission = action === 'delete' ? observation.can_delete : action === 'edit' ? observation.can_edit : observation.can_pin
    if (!capabilities.can_manage_observations || !permission) return { success: false, error: 'No tienes permiso para modificar esta nota.' }
    const operation = beginMutation(observation.id)
    if (!operation) return pendingNotesRef.current.has(observation.id) ? { success: false, error: 'La nota tiene una operación pendiente.' } : staleMutation
    const suffix = action === 'pin' ? '/pin' : ''
    const body = action === 'edit' ? { notes: value, expected_updated_at: observation.updated_at || observation.created_at } : { pinned: value }
    const result = await api<ContactProfileObservationResponse>(`/api/contact-profiles/${contactId}/observations/${observation.id}${suffix}?${query}`, { method: action === 'delete' ? 'DELETE' : 'PATCH', ...(action !== 'delete' ? { body: JSON.stringify(body) } : {}), signal: operation.controller.signal })
    if (!current(operation.request) || operation.controller.signal.aborted) return staleMutation
    if (!result.success || !result.data?.success || action !== 'delete' && !result.data.observation) { finishMutation(operation); return { success: false, error: result.error || 'No se pudo modificar la nota.' } }
    const previous = observationsRef.current.find(row => row.id === observation.id) || observation
    const wasPinned = previous.type === 'note' && Boolean(previous.is_pinned)
    if (action === 'delete') {
      commitObservations(observationsRef.current.filter(row => row.id !== observation.id))
      applyCounts(result.data, -1, wasPinned ? -1 : 0)
    } else {
      const updated = result.data.observation!
      commitObservations(mergeContactObservations(observationsRef.current, [updated]))
      applyCounts(result.data, 0, Number(updated.type === 'note' && Boolean(updated.is_pinned)) - Number(wasPinned))
    }
    finishMutation(operation)
    return { success: true }
  }
  const deleteObservation = (id: string) => {
    const row = observationsRef.current.find(item => item.id === id)
    return row ? mutateObservation(row, 'delete') : Promise.resolve({ success: false, error: 'La nota ya no está disponible.' })
  }
  const updateObservation = (row: Observation, notes: string) => {
    const clean = notes.trim()
    return !clean || clean.length > 4000 ? Promise.resolve({ success: false, error: 'La nota debe contener entre 1 y 4000 caracteres.' }) : mutateObservation(row, 'edit', clean)
  }
  const visibleSession = ready && stateKeyRef.current === activeKey
  return { sessionKey: activeKey, contact: visibleSession ? contact : null, capabilities: visibleSession ? capabilities : emptyCapabilities, availableTags, customFieldDefinitions, loading, refreshing, error, saving, refresh: () => fetchProfile({ silent: Boolean(contact) }), updateContact, updateAvatarLocally, updateGoogleSyncLocally, observations: visibleSession ? observations : [], observationCount: visibleSession ? observationCount : 0, pinnedObservationCount: visibleSession ? pinnedObservationCount : 0, observationsLoaded, observationsLoading, observationsLoadingMore, observationsHasMore, observationsError, savingObservation, pendingObservationIds, refreshObservations: () => fetchObservations({ silent: observationsRef.current.length > 0 }), loadMoreObservations: () => fetchObservations({ append: true }), createObservation, deleteObservation, updateObservation, setObservationPinned: (row: Observation, pinned: boolean) => mutateObservation(row, 'pin', pinned) }
}
