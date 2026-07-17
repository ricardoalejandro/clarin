'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Search, X, Filter, Users, CheckCircle2, User, Tag, ChevronDown, CheckSquare, FileText, Code, Calendar, Smartphone, AlertCircle, Loader2, Eye, UserCheck, RotateCcw } from 'lucide-react'
import FormulaEditor from '@/components/FormulaEditor'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'

interface PersonResult {
  id: string
  name: string
  phone: string
  phones?: { phone: string; label?: string }[]
  email: string
  source_type: 'contact' | 'lead'
  tags?: { id: string; name: string; color: string }[]
  membership_status?: 'not_added' | 'active' | 'inactive'
  eligibility?: 'eligible' | 'rule_ineligible' | 'event_frozen'
  can_add?: boolean
  participant_id?: string
  stage_id?: string
  stage_name?: string
  stage_color?: string
  membership_source?: string
  membership_reason?: string
  excluded?: boolean
  excluded_label?: string
}

interface CandidateCounts {
  matches: number
  available: number
  already_active: number
  inactive: number
  ineligible: number
}

interface TagItem {
  id: string
  name: string
  color: string
}

export interface SelectedPerson {
  id: string
  name: string
  phone: string
  phones?: { phone: string; label?: string }[]
  email: string
  source_type: 'contact' | 'lead'
  tags?: { id: string; name: string; color: string }[]
  membership_status?: 'not_added' | 'active' | 'inactive'
  eligibility?: 'eligible' | 'rule_ineligible' | 'event_frozen'
  can_add?: boolean
  participant_id?: string
  stage_id?: string
  stage_name?: string
  stage_color?: string
  membership_source?: string
  membership_reason?: string
}

interface DeviceItem {
  id: string
  name: string
  phone: string | null
  phone_number?: string
  status: string
}

const DATE_PRESETS = [
  { key: 'last_15m', label: 'Últimos 15 min' },
  { key: 'last_hour', label: 'Última hora' },
  { key: 'today', label: 'Hoy' },
  { key: 'yesterday', label: 'Ayer' },
  { key: 'last_7d', label: 'Últimos 7 días' },
  { key: 'this_week', label: 'Esta semana' },
  { key: 'this_month', label: 'Este mes' },
  { key: 'last_30d', label: 'Últimos 30 días' },
  { key: 'custom', label: 'Rango personalizado' },
] as const

const MAX_SELECTION = 500

function membershipReasonLabel(reason?: string) {
  switch (reason) {
    case 'rule_ineligible': return 'Dejó de cumplir las reglas actuales del evento.'
    case 'legacy_rule_ineligible': return 'Dejó de cumplir una regla anterior del evento.'
    case 'manual_removed': return 'Fue retirado manualmente del listado activo.'
    default: return reason ? `Motivo registrado: ${reason.replaceAll('_', ' ')}.` : ''
  }
}

function resolveDatePreset(preset: string, customFrom?: string, customTo?: string): { from: string; to: string } | null {
  const now = new Date()
  switch (preset) {
    case 'last_15m': { const f = new Date(now.getTime() - 15 * 60 * 1000); return { from: f.toISOString(), to: now.toISOString() } }
    case 'last_hour': { const f = new Date(now.getTime() - 60 * 60 * 1000); return { from: f.toISOString(), to: now.toISOString() } }
    case 'today': { const s = new Date(now); s.setHours(0, 0, 0, 0); return { from: s.toISOString(), to: now.toISOString() } }
    case 'yesterday': { const s = new Date(now); s.setDate(s.getDate() - 1); s.setHours(0, 0, 0, 0); const e = new Date(s); e.setHours(23, 59, 59, 999); return { from: s.toISOString(), to: e.toISOString() } }
    case 'last_7d': { const f = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); return { from: f.toISOString(), to: now.toISOString() } }
    case 'this_week': { const s = new Date(now); const dow = s.getDay(); s.setDate(s.getDate() - (dow === 0 ? 6 : dow - 1)); s.setHours(0, 0, 0, 0); return { from: s.toISOString(), to: now.toISOString() } }
    case 'this_month': { const s = new Date(now.getFullYear(), now.getMonth(), 1); return { from: s.toISOString(), to: now.toISOString() } }
    case 'last_30d': { const f = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); return { from: f.toISOString(), to: now.toISOString() } }
    case 'custom': { if (!customFrom && !customTo) return null; const f = customFrom ? new Date(customFrom + 'T00:00:00').toISOString() : ''; const t = customTo ? new Date(customTo + 'T23:59:59').toISOString() : ''; return { from: f, to: t } }
    default: return null
  }
}

interface ContactSelectorProps {
  open: boolean
  onClose: () => void
  onConfirm: (selected: SelectedPerson[]) => void
  title?: string
  subtitle?: string
  confirmLabel?: string
  /** Exclude these IDs from results (e.g. already-added participants) */
  excludeIds?: Set<string>
  /** Optional reason shown for excluded contacts (e.g. historical participant status). */
  excludeLabels?: Map<string, string>
  /** Force a source type and hide the type filter */
  sourceFilter?: 'contact' | 'lead'
  /** Enable advanced filter panel (device, date, tag include/exclude, formula) */
  advancedFilters?: boolean
  /** When selecting contacts, only show contacts without an active lead */
  withoutActiveLead?: boolean
  /** Event-aware candidate search. Existing/ineligible contacts remain visible with context. */
  eventId?: string
  /** Open an existing participant directly from an event-aware result. */
  onViewExisting?: (person: SelectedPerson) => void
  /** Prevent double-submit and closing while the parent saves the selection. */
  submitting?: boolean
  /** Parent mutation error shown without dismissing the selector. */
  errorMessage?: string
  /** Forces an authoritative reload after a concurrent/partial mutation. */
  refreshKey?: number
}

export default function ContactSelector({
  open,
  onClose,
  onConfirm,
  title = 'Seleccionar Personas',
  subtitle = 'Busca entre tus contactos y leads',
  confirmLabel = 'Agregar',
  excludeIds,
  excludeLabels,
  sourceFilter,
  advancedFilters = false,
  withoutActiveLead = false,
  eventId,
  onViewExisting,
  submitting = false,
  errorMessage = '',
  refreshKey = 0,
}: ContactSelectorProps) {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [results, setResults] = useState<PersonResult[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [nextOffset, setNextOffset] = useState(0)
  const [loadError, setLoadError] = useState('')
  const [loadMoreError, setLoadMoreError] = useState('')
  const [candidateCounts, setCandidateCounts] = useState<CandidateCounts | null>(null)
  const [candidateMetadataLoaded, setCandidateMetadataLoaded] = useState(false)
  const [eventHasRules, setEventHasRules] = useState(false)
  const [candidateEventStatus, setCandidateEventStatus] = useState('')
  const [selected, setSelected] = useState<Map<string, SelectedPerson>>(new Map())
  const [selectionNotice, setSelectionNotice] = useState('')

  // Basic Filters
  const [sourceType, setSourceType] = useState<'all' | 'contact' | 'lead'>(sourceFilter || 'all')
  const [showFilterDropdown, setShowFilterDropdown] = useState(false)
  const [allTags, setAllTags] = useState<TagItem[]>([])
  const [filterTagIds, setFilterTagIds] = useState<Set<string>>(new Set())
  const [tagSearch, setTagSearch] = useState('')
  const [hasPhone, setHasPhone] = useState(false)

  // Advanced Filters (only used when advancedFilters=true)
  const useAdvanced = advancedFilters && sourceFilter === 'contact'
  const [filterTagNames, setFilterTagNames] = useState<Set<string>>(new Set())
  const [excludeFilterTagNames, setExcludeFilterTagNames] = useState<Set<string>>(new Set())
  const [tagFilterMode, setTagFilterMode] = useState<'OR' | 'AND'>('OR')
  const [formulaType, setFormulaType] = useState<'simple' | 'advanced'>('simple')
  const [formulaText, setFormulaText] = useState('')
  const [formulaIsValid, setFormulaIsValid] = useState(true)
  const [filterDevice, setFilterDevice] = useState('')
  const [filterDateField, setFilterDateField] = useState<'created_at' | 'updated_at'>('created_at')
  const [filterDatePreset, setFilterDatePreset] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [advDevices, setAdvDevices] = useState<DeviceItem[]>([])

  const filterRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const peopleRequestRef = useRef(0)
  const peopleAbortRef = useRef<AbortController | null>(null)
  const refreshKeyRef = useRef(refreshKey)
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : ''

  const handleDialogEscape = useCallback(() => {
    if (showFilterDropdown) {
      setShowFilterDropdown(false)
      return
    }
    if (!submitting) onClose()
  }, [onClose, showFilterDropdown, submitting])

  useAccessibleDialog(open, dialogRef, handleDialogEscape, searchRef)

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 500)
    return () => clearTimeout(t)
  }, [search])

  // Focus search on open
  useEffect(() => {
    if (open) {
      fetchTags()
      if (useAdvanced) fetchDevices()
    } else {
      peopleRequestRef.current += 1
      peopleAbortRef.current?.abort()
      peopleAbortRef.current = null
      // Reset state on close
      setSearch('')
      setDebouncedSearch('')
      setResults([])
      setTotal(0)
      setLoading(false)
      setLoadingMore(false)
      setHasMore(false)
      setNextOffset(0)
      setLoadError('')
      setLoadMoreError('')
      setCandidateCounts(null)
      setCandidateMetadataLoaded(false)
      setEventHasRules(false)
      setCandidateEventStatus('')
      setSelected(new Map())
      setSelectionNotice('')
      setSourceType(sourceFilter || 'all')
      setFilterTagIds(new Set())
      setHasPhone(false)
      setShowFilterDropdown(false)
      setTagSearch('')
      // Reset advanced state
      setFilterTagNames(new Set())
      setExcludeFilterTagNames(new Set())
      setTagFilterMode('OR')
      setFormulaType('simple')
      setFormulaText('')
      setFilterDevice('')
      setFilterDatePreset('')
      setFilterDateFrom('')
      setFilterDateTo('')
    }
  }, [open])

  // Fetch people when search/filters change
  useEffect(() => {
    if (!open) return
    fetchPeople()
  }, [debouncedSearch, sourceType, filterTagIds, hasPhone, open, filterTagNames, excludeFilterTagNames, tagFilterMode, filterDevice, filterDatePreset, filterDateField, filterDateFrom, filterDateTo, formulaType, formulaText])

  useEffect(() => {
    if (refreshKeyRef.current === refreshKey) return
    refreshKeyRef.current = refreshKey
    if (!open) return
    setSelected(new Map())
    setSelectionNotice('')
    fetchPeople(0, false)
  }, [refreshKey, open])

  // Click outside to close filter dropdown
  useEffect(() => {
    if (!showFilterDropdown) { setTagSearch(''); return }
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setShowFilterDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showFilterDropdown])

  const fetchTags = useCallback(async () => {
    try {
      const res = await fetch('/api/tags', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) setAllTags(data.tags || [])
    } catch (e) { console.error(e) }
  }, [token])

  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch('/api/devices', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) setAdvDevices(data.devices || [])
    } catch (e) { console.error(e) }
  }, [token])

  const fetchPeople = useCallback(async (offset = 0, append = false) => {
    peopleAbortRef.current?.abort()
    const abortController = new AbortController()
    peopleAbortRef.current = abortController
    const requestId = ++peopleRequestRef.current
    if (append) setLoadingMore(true)
    else setLoading(true)
    if (append) setLoadMoreError('')
    else {
      setLoadError('')
      setLoadMoreError('')
    }
    try {
      const pageLimit = 50
      const applyPage = (mapped: PersonResult[], rawCount: number, data: any) => {
        if (requestId !== peopleRequestRef.current) return
        setResults(previous => {
          if (!append) return mapped
          const byID = new Map(previous.map(person => [person.id, person]))
          mapped.forEach(person => byID.set(person.id, person))
          return Array.from(byID.values())
        })
        const responseTotal = Number(data.total || 0)
        setTotal(responseTotal)
        setNextOffset(offset + rawCount)
        setHasMore(Boolean(data.has_more ?? (offset + rawCount < responseTotal)))
      }

      if (eventId) {
        const params = new URLSearchParams()
        if (debouncedSearch) params.set('search', debouncedSearch)
        if (filterTagIds.size > 0) params.set('tag_ids', Array.from(filterTagIds).join(','))
        if (hasPhone) params.set('has_phone', 'true')
        params.set('limit', String(pageLimit))
        params.set('offset', String(offset))

        const res = await fetch(`/api/events/${eventId}/participant-candidates?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: abortController.signal,
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.success) throw new Error('candidate_search_failed')

        const rawCandidates = (data.candidates || []) as any[]
        const mapped: PersonResult[] = rawCandidates.map(candidate => {
          const contact = candidate.contact || {}
          const rawTags = Array.isArray(contact.structured_tags) && contact.structured_tags.length > 0
            ? contact.structured_tags
            : Array.isArray(contact.tags) ? contact.tags : []
          const mappedTags = rawTags.map((tag: any) => typeof tag === 'string'
            ? { id: tag, name: tag, color: '#64748b' }
            : { id: tag.id || tag.name, name: tag.name, color: tag.color || '#64748b' })
          const extraPhones = Array.isArray(contact.extra_phones)
            ? contact.extra_phones
              .filter((phone: any) => typeof phone?.phone === 'string' && phone.phone.trim())
              .map((phone: any) => ({ phone: phone.phone, label: phone.label || '' }))
            : []
          return {
            id: contact.id,
            name: contact.custom_name || contact.short_name || contact.name || contact.push_name || contact.phone || '',
            phone: contact.phone || '',
            phones: extraPhones,
            email: contact.email || '',
            source_type: 'contact' as const,
            tags: mappedTags,
            membership_status: candidate.membership_status,
            eligibility: candidate.eligibility,
            can_add: Boolean(candidate.can_add),
            participant_id: candidate.participant_id,
            stage_id: candidate.stage_id,
            stage_name: candidate.stage_name,
            stage_color: candidate.stage_color,
            membership_source: candidate.membership_source,
            membership_reason: candidate.membership_reason,
          }
        }).filter(person => Boolean(person.id))

        if (requestId === peopleRequestRef.current) {
          const counts = data.counts || {}
          setCandidateCounts({
            matches: Number(counts.matches ?? data.total ?? 0),
            available: Number(counts.available ?? mapped.filter(person => person.can_add).length),
            already_active: Number(counts.already_active ?? mapped.filter(person => person.membership_status === 'active').length),
            inactive: Number(counts.inactive ?? mapped.filter(person => person.membership_status === 'inactive').length),
            ineligible: Number(counts.ineligible ?? mapped.filter(person => person.eligibility === 'rule_ineligible').length),
          })
          setEventHasRules(Boolean(data.has_rules ?? data.has_membership_rules))
          setCandidateEventStatus(data.event_status || '')
          setCandidateMetadataLoaded(true)
        }
        applyPage(mapped, rawCandidates.length, data)
      } else if (useAdvanced) {
        // Advanced path: use /api/contacts with full filter support
        const params = new URLSearchParams()
        if (debouncedSearch) params.set('search', debouncedSearch)
        if (filterDevice) params.set('device_id', filterDevice)

        // Formula vs simple tag filter
        if (formulaType === 'advanced' && formulaText) {
          params.set('tag_formula', formulaText)
        } else {
          if (filterTagNames.size > 0) params.set('tag_names', Array.from(filterTagNames).join(','))
          if (excludeFilterTagNames.size > 0) params.set('exclude_tag_names', Array.from(excludeFilterTagNames).join(','))
          if (filterTagNames.size > 0 || excludeFilterTagNames.size > 0) params.set('tag_mode', tagFilterMode)
        }

        // Date filter
        if (filterDatePreset) {
          const resolved = resolveDatePreset(filterDatePreset, filterDateFrom, filterDateTo)
          if (resolved) {
            params.set('date_field', filterDateField)
            if (resolved.from) params.set('date_from', resolved.from)
            if (resolved.to) params.set('date_to', resolved.to)
          }
        }

        params.set('limit', String(pageLimit))
        params.set('offset', String(offset))
        params.set('has_phone', 'false')
        if (withoutActiveLead) params.set('without_active_lead', 'true')

        const res = await fetch(`/api/contacts?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: abortController.signal,
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.success) throw new Error('people_search_failed')
        if (requestId === peopleRequestRef.current) {
          // Map Contact → PersonResult
          const contacts = (data.contacts || []) as any[]
          const mapped: PersonResult[] = contacts.map((c: any) => ({
            id: c.id,
            name: c.custom_name || c.name || c.push_name || c.phone || '',
            phone: c.phone || '',
            email: c.email || '',
            source_type: 'contact' as const,
            tags: (c.structured_tags || []).map((t: any) => ({ id: t.id, name: t.name, color: t.color })),
            excluded: Boolean(excludeIds?.has(c.id)),
            excluded_label: excludeLabels?.get(c.id),
          }))
          applyPage(mapped, contacts.length, data)
        }
      } else {
        // Basic path: use /api/people/search
        const params = new URLSearchParams()
        if (debouncedSearch) params.set('search', debouncedSearch)
        if (sourceType !== 'all') params.set('type', sourceType)
        if (filterTagIds.size > 0) params.set('tag_ids', Array.from(filterTagIds).join(','))
        if (hasPhone) params.set('has_phone', 'true')
        params.set('limit', String(pageLimit))
        params.set('offset', String(offset))

        const res = await fetch(`/api/people/search?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: abortController.signal,
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.success) throw new Error('people_search_failed')
        if (requestId === peopleRequestRef.current) {
          const people = (data.people || []) as PersonResult[]
          const mapped = people.map(person => ({
            ...person,
            excluded: Boolean(excludeIds?.has(person.id)),
            excluded_label: excludeLabels?.get(person.id),
          }))
          applyPage(mapped, people.length, data)
        }
      }
    } catch (e) {
      if (abortController.signal.aborted) return
      if (requestId === peopleRequestRef.current) {
        console.error(e)
        if (append) {
          setLoadMoreError('No pudimos cargar más contactos. Los resultados anteriores siguen disponibles.')
        } else {
          setLoadError('No pudimos cargar los contactos. Revisa tu conexión e inténtalo nuevamente.')
          setResults([])
          setTotal(0)
          setHasMore(false)
          setCandidateCounts(null)
          setCandidateMetadataLoaded(false)
        }
      }
    } finally {
      if (requestId === peopleRequestRef.current) {
        if (peopleAbortRef.current === abortController) peopleAbortRef.current = null
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [debouncedSearch, sourceType, filterTagIds, hasPhone, token, excludeIds, excludeLabels, eventId, useAdvanced, filterDevice, filterTagNames, excludeFilterTagNames, tagFilterMode, formulaType, formulaText, filterDatePreset, filterDateField, filterDateFrom, filterDateTo, withoutActiveLead])

  const isSelectable = useCallback((person: PersonResult) => {
    if (eventId) return person.can_add === true
    return !person.excluded
  }, [eventId])

  const toggleSelect = (person: PersonResult) => {
    if (!isSelectable(person)) return
    const next = new Map(selected)
    if (next.has(person.id)) {
      next.delete(person.id)
      setSelectionNotice('')
    } else {
      if (next.size >= MAX_SELECTION) {
        setSelectionNotice(`Puedes agregar hasta ${MAX_SELECTION} contactos en una sola operación.`)
        return
      }
      next.set(person.id, {
        id: person.id,
        name: person.name,
        phone: person.phone,
        phones: person.phones,
        email: person.email,
        source_type: person.source_type,
        tags: person.tags,
        membership_status: person.membership_status,
        eligibility: person.eligibility,
        can_add: person.can_add,
        participant_id: person.participant_id,
        stage_id: person.stage_id,
        stage_name: person.stage_name,
        stage_color: person.stage_color,
        membership_source: person.membership_source,
        membership_reason: person.membership_reason,
      })
    }
    setSelected(next)
  }

  const selectAll = () => {
    const next = new Map(selected)
    results.forEach(p => {
      if (next.size < MAX_SELECTION && isSelectable(p) && !next.has(p.id)) {
        next.set(p.id, {
          id: p.id, name: p.name, phone: p.phone, phones: p.phones, email: p.email, source_type: p.source_type, tags: p.tags,
          membership_status: p.membership_status, eligibility: p.eligibility, can_add: p.can_add,
          participant_id: p.participant_id, stage_id: p.stage_id, stage_name: p.stage_name,
          stage_color: p.stage_color, membership_source: p.membership_source, membership_reason: p.membership_reason,
        })
      }
    })
    if (results.some(person => isSelectable(person) && !next.has(person.id))) {
      setSelectionNotice(`Se seleccionaron los primeros ${MAX_SELECTION}. Agrega el resto en otra operación.`)
    } else {
      setSelectionNotice('')
    }
    setSelected(next)
  }

  const handleConfirm = () => {
    if (submitting) return
    onConfirm(Array.from(selected.values()))
  }

  const activeFilterCount = useAdvanced
    ? (filterTagNames.size > 0 ? 1 : 0) + (excludeFilterTagNames.size > 0 ? 1 : 0) + (filterDevice ? 1 : 0) + (filterDatePreset ? 1 : 0) + (formulaType === 'advanced' && formulaText ? 1 : 0)
    : (!sourceFilter && sourceType !== 'all' ? 1 : 0) + (filterTagIds.size > 0 ? 1 : 0) + (hasPhone ? 1 : 0)

  // Tag search with wildcard support (% as wildcard, like leads page)
  const filteredTags = allTags.filter(tag => {
    if (!tagSearch.trim()) return true
    const term = tagSearch.trim()
    if (term.includes('%')) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')
      try { return new RegExp(`^${escaped}$`, 'i').test(tag.name) } catch { return true }
    }
    return tag.name.toLowerCase().includes(term.toLowerCase())
  })
  const selectableResults = results.filter(isSelectable)
  const eventIsFrozen = candidateEventStatus === 'completed' || candidateEventStatus === 'cancelled'

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/50 p-0 backdrop-blur-sm sm:p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="contact-selector-title" aria-describedby="contact-selector-description" aria-busy={submitting} tabIndex={-1} className="flex h-full max-h-none w-full max-w-5xl flex-col overflow-hidden bg-white shadow-2xl sm:h-auto sm:max-h-[90vh] sm:rounded-3xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 id="contact-selector-title" className="text-lg font-semibold text-gray-900">{title}</h2>
            <p id="contact-selector-description" className="text-sm text-gray-500 mt-0.5">{subtitle}</p>
          </div>
          <button onClick={onClose} disabled={submitting} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Cerrar selector de contactos">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search + Filters */}
        <div className="px-6 py-4 border-b border-gray-100 space-y-3">
          <div className="flex gap-3">
            <div ref={filterRef} className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                ref={searchRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); setShowFilterDropdown(false) } }}
                placeholder="Buscar por nombre, teléfono, email..."
                className="w-full pl-10 pr-10 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900 text-sm"
              />
              <button
                onClick={() => setShowFilterDropdown(!showFilterDropdown)}
                className={`absolute right-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${activeFilterCount > 0 ? 'bg-green-100 text-green-700' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
                aria-label="Abrir filtros de contactos"
                aria-expanded={showFilterDropdown}
              >
                <Filter className="w-4 h-4" />
                {activeFilterCount > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-green-600 text-white text-[10px] rounded-full flex items-center justify-center">{activeFilterCount}</span>
                )}
              </button>

              {/* Filter Dropdown */}
              {showFilterDropdown && (
                <div className={`absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-xl z-30 ${useAdvanced ? 'right-0 max-h-[520px] overflow-y-auto' : 'right-0 max-h-[400px] overflow-y-auto'}`}>
                  <div className="p-3 border-b border-slate-100 flex items-center justify-between">
                    <span className="text-sm font-semibold text-slate-700">Filtros</span>
                    <div className="flex items-center gap-2">
                      {activeFilterCount > 0 && (
                        <button
                          onClick={() => {
                            if (useAdvanced) {
                              setFilterTagNames(new Set()); setExcludeFilterTagNames(new Set()); setTagFilterMode('OR')
                              setFormulaType('simple'); setFormulaText(''); setFilterDevice('')
                              setFilterDatePreset(''); setFilterDateFrom(''); setFilterDateTo('')
                            } else {
                              setSourceType(sourceFilter || 'all'); setFilterTagIds(new Set()); setHasPhone(false)
                            }
                          }}
                          className="text-xs text-red-500 hover:text-red-700"
                        >
                          Limpiar filtros
                        </button>
                      )}
                      <button onClick={() => setShowFilterDropdown(false)} className="p-0.5 hover:bg-slate-100 rounded">
                        <X className="w-4 h-4 text-slate-400" />
                      </button>
                    </div>
                  </div>

                  {useAdvanced ? (
                    /* ====== ADVANCED FILTER PANEL (2 columns) ====== */
                    <div className="grid grid-cols-2 divide-x divide-slate-100">
                      {/* LEFT COLUMN: Device + Date */}
                      <div className="p-3 space-y-4">
                        {/* Device filter */}
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <Smartphone className="w-3.5 h-3.5 text-slate-400" />
                            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Dispositivo</p>
                          </div>
                          <select
                            value={filterDevice}
                            onChange={e => setFilterDevice(e.target.value)}
                            className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-700 focus:ring-1 focus:ring-emerald-500"
                          >
                            <option value="">Todos</option>
                            {advDevices.map(d => (
                              <option key={d.id} value={d.id}>{d.name} {d.phone ? `(${d.phone})` : d.phone_number ? `(${d.phone_number})` : ''}</option>
                            ))}
                          </select>
                        </div>

                        {/* Date filter */}
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <Calendar className="w-3.5 h-3.5 text-slate-400" />
                            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Fecha</p>
                          </div>
                          <div className="flex rounded-lg border border-slate-200 bg-slate-50/50 overflow-hidden mb-2">
                            <button
                              onClick={() => setFilterDateField('created_at')}
                              className={`flex-1 px-2 py-1.5 text-[10px] font-semibold transition-all ${filterDateField === 'created_at' ? 'bg-blue-500 text-white shadow-sm' : 'text-slate-500 hover:bg-white'}`}
                            >
                              Creación
                            </button>
                            <button
                              onClick={() => setFilterDateField('updated_at')}
                              className={`flex-1 px-2 py-1.5 text-[10px] font-semibold transition-all ${filterDateField === 'updated_at' ? 'bg-blue-500 text-white shadow-sm' : 'text-slate-500 hover:bg-white'}`}
                            >
                              Modificación
                            </button>
                          </div>
                          <div className="grid grid-cols-2 gap-1">
                            {DATE_PRESETS.map(p => (
                              <button
                                key={p.key}
                                onClick={() => {
                                  if (filterDatePreset === p.key) { setFilterDatePreset(''); setFilterDateFrom(''); setFilterDateTo('') }
                                  else { setFilterDatePreset(p.key); if (p.key !== 'custom') { setFilterDateFrom(''); setFilterDateTo('') } }
                                }}
                                className={`px-2 py-1.5 rounded-lg text-[10px] font-medium transition-all border ${
                                  filterDatePreset === p.key
                                    ? 'bg-blue-500 text-white border-blue-500 shadow-sm'
                                    : 'border-slate-200 text-slate-600 hover:bg-white hover:shadow-sm'
                                }`}
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                          {filterDatePreset === 'custom' && (
                            <div className="mt-2 space-y-1.5">
                              <div>
                                <label className="text-[9px] font-semibold text-slate-400 uppercase">Desde</label>
                                <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)}
                                  className="w-full px-2 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400" />
                              </div>
                              <div>
                                <label className="text-[9px] font-semibold text-slate-400 uppercase">Hasta</label>
                                <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)}
                                  className="w-full px-2 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400" />
                              </div>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* RIGHT COLUMN: Tags + Formula */}
                      <div className="p-3 space-y-3">
                        {/* Simple / Advanced toggle */}
                        <div className="flex rounded-xl border border-slate-200 bg-slate-50/50 overflow-hidden">
                          <button type="button" onClick={() => setFormulaType('simple')}
                            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-semibold transition-all ${
                              formulaType === 'simple' ? 'bg-emerald-500 text-white shadow-sm' : 'text-slate-500 hover:bg-white hover:text-slate-700'
                            }`}>
                            <FileText className="w-3.5 h-3.5" />
                            Simple
                          </button>
                          <button type="button" onClick={() => setFormulaType('advanced')}
                            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-semibold transition-all ${
                              formulaType === 'advanced' ? 'bg-violet-500 text-white shadow-sm' : 'text-slate-500 hover:bg-white hover:text-slate-700'
                            }`}>
                            <Code className="w-3.5 h-3.5" />
                            Avanzado
                          </button>
                        </div>

                        {formulaType === 'simple' ? (
                          <>
                            {/* AND/OR toggle */}
                            <div className="flex items-center gap-2">
                              <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
                                <button onClick={() => setTagFilterMode('OR')}
                                  className={`px-3 py-1 text-[10px] font-bold tracking-wide transition-all ${tagFilterMode === 'OR' ? 'bg-emerald-500 text-white' : 'bg-white text-slate-400 hover:bg-slate-50'}`}>
                                  OR
                                </button>
                                <button onClick={() => setTagFilterMode('AND')}
                                  className={`px-3 py-1 text-[10px] font-bold tracking-wide transition-all ${tagFilterMode === 'AND' ? 'bg-blue-500 text-white' : 'bg-white text-slate-400 hover:bg-slate-50'}`}>
                                  AND
                                </button>
                              </div>
                              <p className="text-[10px] text-slate-400 leading-tight">
                                {tagFilterMode === 'AND' ? 'Todas' : 'Al menos una'}
                              </p>
                            </div>

                            {/* Tag search */}
                            <div className="relative">
                              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                              <input
                                value={tagSearch}
                                onChange={e => setTagSearch(e.target.value)}
                                placeholder="Buscar etiquetas..."
                                className="w-full pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                              />
                            </div>

                            {/* Tag list with 3-click cycle */}
                            <div className="max-h-[220px] overflow-y-auto space-y-0.5">
                              {filteredTags.map(tag => {
                                const isIncluded = filterTagNames.has(tag.name)
                                const isExcluded = excludeFilterTagNames.has(tag.name)
                                return (
                                  <div
                                    key={tag.id}
                                    onClick={() => {
                                      if (!isIncluded && !isExcluded) {
                                        const next = new Set(filterTagNames); next.add(tag.name); setFilterTagNames(next)
                                      } else if (isIncluded) {
                                        const incl = new Set(filterTagNames); incl.delete(tag.name); setFilterTagNames(incl)
                                        const excl = new Set(excludeFilterTagNames); excl.add(tag.name); setExcludeFilterTagNames(excl)
                                      } else {
                                        const next = new Set(excludeFilterTagNames); next.delete(tag.name); setExcludeFilterTagNames(next)
                                      }
                                    }}
                                    className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl cursor-pointer select-none transition-all ${
                                      isIncluded ? 'bg-emerald-50 ring-1 ring-emerald-200' : isExcluded ? 'bg-red-50 ring-1 ring-red-200' : 'hover:bg-white hover:shadow-sm'
                                    }`}
                                  >
                                    {isIncluded ? (
                                      <div className="w-4 h-4 rounded-full shrink-0 bg-emerald-500 flex items-center justify-center"><CheckSquare className="w-2.5 h-2.5 text-white" /></div>
                                    ) : isExcluded ? (
                                      <div className="w-4 h-4 rounded-full shrink-0 bg-red-500 flex items-center justify-center"><X className="w-2.5 h-2.5 text-white" /></div>
                                    ) : (
                                      <div className="w-3 h-3 rounded-full shrink-0 ring-2 ring-white shadow-sm" style={{ backgroundColor: tag.color || '#6b7280' }} />
                                    )}
                                    <span className={`flex-1 text-[11px] transition-colors ${
                                      isIncluded ? 'text-emerald-700 font-semibold' : isExcluded ? 'text-red-400 line-through' : 'text-slate-700'
                                    }`}>{tag.name}</span>
                                  </div>
                                )
                              })}
                              {filteredTags.length === 0 && tagSearch.trim() && (
                                <p className="text-xs text-slate-400 text-center py-2">Sin resultados</p>
                              )}
                            </div>
                          </>
                        ) : (
                          /* FormulaEditor (advanced mode) */
                          <div className="space-y-2">
                            <div className="p-2 bg-slate-50 rounded-lg border border-slate-100">
                              <p className="text-[10px] text-slate-500 leading-relaxed">
                                Sintaxis: <code className="bg-white px-1 rounded text-[9px]">{'"tag" and "tag2" or not "tag3"'}</code>
                              </p>
                            </div>
                            <FormulaEditor
                              value={formulaText}
                              onChange={setFormulaText}
                              tags={allTags}
                              compact
                              rows={4}
                              onValidChange={setFormulaIsValid}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    /* ====== BASIC FILTER PANEL (original) ====== */
                    <>
                      {/* Source type filter */}
                      {!sourceFilter && (
                      <div className="p-3 border-b border-gray-100">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Tipo</p>
                        <div className="flex flex-wrap gap-1.5">
                          {[
                            { value: 'all' as const, label: 'Todos' },
                            { value: 'contact' as const, label: 'Contactos' },
                            { value: 'lead' as const, label: 'Leads' },
                          ].map(opt => (
                            <button
                              key={opt.value}
                              onClick={() => setSourceType(opt.value)}
                              className={`px-3 py-1.5 rounded-full text-xs font-medium transition border ${
                                sourceType === opt.value
                                  ? 'border-green-300 bg-green-50 text-green-700'
                                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                              }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      )}

                      {/* Has phone filter */}
                      <div className="p-3 border-b border-gray-100">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Teléfono</p>
                        <button
                          onClick={() => setHasPhone(!hasPhone)}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            hasPhone ? 'bg-green-50 border-green-300 text-green-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          Solo con teléfono
                        </button>
                      </div>

                      {/* Tag filters */}
                      {allTags.length > 0 && (
                        <div className="p-3">
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Etiquetas</p>
                          <div className="relative mb-2">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                            <input
                              value={tagSearch}
                              onChange={e => setTagSearch(e.target.value)}
                              placeholder="Buscar... (usa % como comodín)"
                              className="w-full pl-8 pr-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-800 placeholder:text-gray-400 focus:ring-2 focus:ring-green-500 focus:border-green-500"
                            />
                          </div>
                          {filterTagIds.size > 0 && (
                            <div className="flex flex-wrap gap-1 mb-2">
                              {Array.from(filterTagIds).map(tid => {
                                const tag = allTags.find(t => t.id === tid)
                                if (!tag) return null
                                return (
                                  <span
                                    key={tid}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium text-white"
                                    style={{ backgroundColor: tag.color || '#6b7280' }}
                                  >
                                    {tag.name}
                                    <button onClick={() => { const n = new Set(filterTagIds); n.delete(tid); setFilterTagIds(n) }} className="hover:opacity-75">
                                      <X className="w-2.5 h-2.5" />
                                    </button>
                                  </span>
                                )
                              })}
                            </div>
                          )}
                          <div className="max-h-[200px] overflow-y-auto space-y-0.5">
                            {filteredTags.map(tag => {
                              const isActive = filterTagIds.has(tag.id)
                              return (
                                <label
                                  key={tag.id}
                                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 cursor-pointer transition"
                                >
                                  <input
                                    type="checkbox"
                                    checked={isActive}
                                    onChange={() => {
                                      const next = new Set(filterTagIds)
                                      if (isActive) next.delete(tag.id); else next.add(tag.id)
                                      setFilterTagIds(next)
                                    }}
                                    className="w-3.5 h-3.5 rounded border-gray-300 text-green-600 focus:ring-green-500"
                                  />
                                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: tag.color || '#6b7280' }} />
                                  <span className="flex-1 text-xs text-gray-700">{tag.name}</span>
                                </label>
                              )
                            })}
                            {filteredTags.length === 0 && tagSearch.trim() && (
                              <p className="text-xs text-gray-400 text-center py-2">Sin resultados</p>
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  <div className="p-3 border-t border-slate-100 sticky bottom-0 bg-white rounded-b-xl">
                    <button
                      onClick={() => setShowFilterDropdown(false)}
                      disabled={useAdvanced && formulaType === 'advanced' && !formulaIsValid}
                      className="w-full px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition text-sm font-medium"
                    >
                      Aplicar
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Active filter badges */}
          {activeFilterCount > 0 && (
            <div className="flex flex-wrap gap-2">
              {useAdvanced ? (
                <>
                  {filterDevice && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-50 text-emerald-700 rounded-full text-xs font-medium border border-emerald-200">
                      Dispositivo
                      <button onClick={() => setFilterDevice('')} className="hover:text-emerald-900"><X className="w-3 h-3" /></button>
                    </span>
                  )}
                  {filterDatePreset && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-50 text-blue-700 rounded-full text-xs font-medium border border-blue-200">
                      {DATE_PRESETS.find(p => p.key === filterDatePreset)?.label || 'Fecha'}
                      <button onClick={() => { setFilterDatePreset(''); setFilterDateFrom(''); setFilterDateTo('') }} className="hover:text-blue-900"><X className="w-3 h-3" /></button>
                    </span>
                  )}
                  {formulaType === 'advanced' && formulaText ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-violet-50 text-violet-700 rounded-full text-xs font-medium border border-violet-200">
                      Fórmula
                      <button onClick={() => { setFormulaText(''); setFormulaType('simple') }} className="hover:text-violet-900"><X className="w-3 h-3" /></button>
                    </span>
                  ) : (
                    <>
                      {Array.from(filterTagNames).map(name => {
                        const tag = allTags.find(t => t.name === name)
                        return (
                          <span key={`inc-${name}`} className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-50 text-emerald-700 rounded-full text-xs font-medium border border-emerald-200">
                            {name}
                            <button onClick={() => { const n = new Set(filterTagNames); n.delete(name); setFilterTagNames(n) }} className="hover:text-emerald-900"><X className="w-3 h-3" /></button>
                          </span>
                        )
                      })}
                      {Array.from(excludeFilterTagNames).map(name => (
                        <span key={`exc-${name}`} className="inline-flex items-center gap-1 px-2.5 py-1 bg-red-50 text-red-600 rounded-full text-xs font-medium border border-red-200 line-through">
                          {name}
                          <button onClick={() => { const n = new Set(excludeFilterTagNames); n.delete(name); setExcludeFilterTagNames(n) }} className="hover:text-red-800"><X className="w-3 h-3" /></button>
                        </span>
                      ))}
                    </>
                  )}
                </>
              ) : (
                <>
                  {sourceType !== 'all' && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-green-50 text-green-700 rounded-full text-xs font-medium border border-green-200">
                      {sourceType === 'contact' ? 'Contactos' : 'Leads'}
                      <button onClick={() => setSourceType('all')} className="hover:text-green-900"><X className="w-3 h-3" /></button>
                    </span>
                  )}
                  {hasPhone && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-green-50 text-green-700 rounded-full text-xs font-medium border border-green-200">
                      Con teléfono
                      <button onClick={() => setHasPhone(false)} className="hover:text-green-900"><X className="w-3 h-3" /></button>
                    </span>
                  )}
                  {Array.from(filterTagIds).map(tid => {
                    const tag = allTags.find(t => t.id === tid)
                    if (!tag) return null
                    return (
                      <span
                        key={tid}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium text-white"
                        style={{ backgroundColor: tag.color || '#6b7280' }}
                      >
                        {tag.name}
                        <button onClick={() => { const n = new Set(filterTagIds); n.delete(tid); setFilterTagIds(n) }} className="hover:opacity-75"><X className="w-3 h-3" /></button>
                      </span>
                    )
                  })}
                </>
              )}
            </div>
          )}

          {eventId && !loading && !loadError && candidateMetadataLoaded && (
            <div className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-xs ${eventIsFrozen ? 'border-slate-200 bg-slate-50 text-slate-600' : eventHasRules ? 'border-amber-200 bg-amber-50/70 text-amber-800' : 'border-emerald-200 bg-emerald-50/70 text-emerald-800'}`}>
              {eventIsFrozen ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : eventHasRules ? <Filter className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
              <p>
                {eventIsFrozen
                  ? 'Este evento está cerrado y sus participantes son de solo lectura.'
                  : eventHasRules
                    ? 'Solo puedes agregar contactos que cumplan las reglas actuales del evento. Los demás se muestran con el motivo del bloqueo.'
                    : 'Este evento no tiene reglas: puedes agregar cualquier contacto disponible de la cuenta.'}
              </p>
            </div>
          )}
        </div>

        {/* Results */}
        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
          {/* Selection info bar */}
          <div className="flex items-center justify-between px-6 py-2.5 bg-gray-50 border-b border-gray-100">
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500">
                {loading
                  ? 'Buscando…'
                  : eventId && candidateCounts
                    ? `${candidateCounts.matches} coincidencia${candidateCounts.matches !== 1 ? 's' : ''} · ${candidateCounts.available} para añadir · ${candidateCounts.already_active} ya participa${candidateCounts.already_active !== 1 ? 'n' : ''}`
                    : `${total} resultado${total !== 1 ? 's' : ''}`}
              </span>
              {selectableResults.length > 0 && (
                <button onClick={selectAll} className="text-xs text-green-600 hover:text-green-700 font-medium">
                  Seleccionar disponibles mostrados
                </button>
              )}
            </div>
            {selected.size > 0 && (
              <span className="text-xs font-medium text-green-700 bg-green-100 px-2.5 py-1 rounded-full">
                {selected.size} seleccionado{selected.size !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Selected pills */}
          {selected.size > 0 && (
            <div className="px-6 py-3 border-b border-gray-100 bg-green-50/50">
              <div className="flex flex-wrap gap-1.5">
                {Array.from(selected.values()).map(p => (
                  <span key={p.id} className="inline-flex items-center gap-1 px-2.5 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium">
                    {p.name || p.phone || 'Sin nombre'}
                    {sourceFilter !== 'contact' && (
                      <span className={`px-1 py-0 rounded text-[9px] font-bold ${p.source_type === 'contact' ? 'bg-blue-100 text-blue-600' : 'bg-purple-100 text-purple-600'}`}>
                        {p.source_type === 'contact' ? 'C' : 'L'}
                      </span>
                    )}
                    <button onClick={() => { const n = new Map(selected); n.delete(p.id); setSelected(n); setSelectionNotice('') }} className="hover:text-green-900">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {selectionNotice && (
            <div role="status" className="mx-6 mt-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {selectionNotice}
            </div>
          )}

          {/* Results list */}
          <div className="flex-1 overflow-y-auto px-6 py-2">
            {loading ? (
              <div className="space-y-2 py-2">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="h-14 bg-gray-100 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : loadError ? (
              <div className="flex flex-col items-center justify-center py-16 text-center" role="alert">
                <div className="mb-3 rounded-2xl bg-red-50 p-3 text-red-500"><AlertCircle className="h-7 w-7" /></div>
                <p className="font-medium text-slate-700">No pudimos cargar los contactos</p>
                <p className="mt-1 max-w-sm text-sm text-slate-500">{loadError}</p>
                <button type="button" onClick={() => fetchPeople(0, false)} className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
                  <RotateCcw className="h-4 w-4" /> Reintentar
                </button>
              </div>
            ) : results.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Users className="w-12 h-12 text-gray-300 mb-3" />
                <p className="text-gray-500 font-medium">
                  {debouncedSearch || activeFilterCount > 0 ? 'No se encontraron coincidencias' : eventId || sourceFilter === 'contact' ? 'Busca un contacto para añadirlo' : 'Escribe para buscar contactos y leads'}
                </p>
                <p className="text-gray-400 text-sm mt-1">
                  {debouncedSearch ? 'Prueba con otro nombre, teléfono o correo' : 'Puedes buscar por nombre, teléfono o email'}
                </p>
              </div>
            ) : (
              <div className="space-y-2 py-1">
                {results.map(person => {
                  const isSelected = selected.has(person.id)
                  const selectable = isSelectable(person) && (isSelected || selected.size < MAX_SELECTION)
                  const isActiveParticipant = person.membership_status === 'active'
                  const extraPhones = (person.phones || []).filter(item => item.phone !== person.phone)
                  const reasonLabel = membershipReasonLabel(person.membership_reason)
                  let statusLabel = ''
                  let statusClass = ''
                  if (isActiveParticipant) {
                    statusLabel = `Ya participa${person.stage_name ? ` · ${person.stage_name}` : ''}`
                    statusClass = 'border-blue-200 bg-blue-50 text-blue-700'
                  } else if (person.eligibility === 'rule_ineligible') {
                    statusLabel = 'No cumple las reglas'
                    statusClass = 'border-amber-200 bg-amber-50 text-amber-700'
                  } else if (person.eligibility === 'event_frozen') {
                    statusLabel = 'Evento cerrado'
                    statusClass = 'border-slate-200 bg-slate-100 text-slate-600'
                  } else if (person.excluded) {
                    statusLabel = person.excluded_label || 'Ya agregado'
                    statusClass = 'border-slate-200 bg-slate-100 text-slate-600'
                  } else if (person.membership_status === 'inactive') {
                    statusLabel = 'Disponible para reactivar'
                    statusClass = 'border-violet-200 bg-violet-50 text-violet-700'
                  } else if (eventId) {
                    statusLabel = 'Disponible'
                    statusClass = 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  }
                  return (
                    <div key={person.id} className={`flex items-stretch overflow-hidden rounded-xl border transition ${isSelected ? 'border-emerald-300 bg-emerald-50/70 shadow-sm' : selectable ? 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/60' : 'border-slate-200 bg-slate-50/70'}`}>
                      <button type="button" disabled={!selectable} onClick={() => toggleSelect(person)} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left disabled:cursor-default">
                        <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold ${isSelected ? 'bg-emerald-200 text-emerald-800' : selectable ? 'bg-slate-200 text-slate-600' : 'bg-slate-100 text-slate-400'}`}>
                          {person.name ? person.name.charAt(0).toUpperCase() : '?'}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className={`truncate text-sm font-medium ${selectable ? 'text-slate-900' : 'text-slate-600'}`}>{person.name || 'Sin nombre'}</p>
                            {statusLabel && (
                              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusClass}`}>
                                {person.stage_color && isActiveParticipant && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: person.stage_color }} />}
                                {statusLabel}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                            {person.phone && <span className="text-xs text-slate-500">{person.phone}</span>}
                            {extraPhones.slice(0, 2).map((item, index) => (
                              <span key={`${item.phone}-${index}`} className="text-xs text-slate-400">
                                {item.phone}{item.label ? ` · ${item.label}` : ''}
                              </span>
                            ))}
                            {extraPhones.length > 2 && <span className="text-[10px] font-medium text-slate-400">+{extraPhones.length - 2} teléfonos</span>}
                            {person.email && <span className="truncate text-xs text-slate-400">{person.email}</span>}
                          </div>
                          {person.tags && person.tags.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {person.tags.slice(0, 4).map(tag => (
                                <span key={tag.id} className="rounded-full px-1.5 py-0.5 text-[10px] font-medium text-white" style={{ backgroundColor: tag.color || '#6b7280' }}>{tag.name}</span>
                              ))}
                              {person.tags.length > 4 && <span className="text-[10px] text-slate-400">+{person.tags.length - 4}</span>}
                            </div>
                          )}
                          {(person.eligibility === 'rule_ineligible' || reasonLabel) && (
                            <p className={`mt-1.5 text-xs ${person.eligibility === 'rule_ineligible' ? 'text-amber-700' : 'text-slate-500'}`}>
                              {reasonLabel || 'Ajusta sus etiquetas para que cumpla la configuración del evento.'}
                            </p>
                          )}
                        </div>
                        {isSelected && <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-emerald-600" />}
                        {!isSelected && selectable && person.membership_status === 'inactive' && <RotateCcw className="h-4 w-4 flex-shrink-0 text-violet-500" />}
                        {!isSelected && selectable && person.membership_status !== 'inactive' && eventId && <UserCheck className="h-4 w-4 flex-shrink-0 text-emerald-500" />}
                      </button>
                      {isActiveParticipant && person.participant_id && onViewExisting && (
                        <button
                          type="button"
                          onClick={() => onViewExisting({ ...person })}
                          className="inline-flex shrink-0 items-center gap-1.5 border-l border-slate-200 px-3 text-xs font-semibold text-blue-700 transition hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
                        >
                          <Eye className="h-4 w-4" /> <span className="hidden sm:inline">Ver participante</span>
                        </button>
                      )}
                    </div>
                  )
                })}
                {hasMore && !loadMoreError && (
                  <div className="flex justify-center py-3">
                    <button type="button" onClick={() => fetchPeople(nextOffset, true)} disabled={loadingMore} className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60">
                      {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                      {loadingMore ? 'Cargando…' : 'Cargar más'}
                    </button>
                  </div>
                )}
                {loadMoreError && (
                  <div role="alert" className="mx-auto my-2 flex max-w-lg items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800">
                    <span>{loadMoreError}</span>
                    <button type="button" onClick={() => fetchPeople(nextOffset, true)} disabled={loadingMore} className="shrink-0 rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 font-semibold transition hover:bg-amber-100 disabled:cursor-wait disabled:opacity-60">
                      {loadingMore ? 'Reintentando…' : 'Reintentar'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        {errorMessage && (
          <div role="alert" className="mx-6 mb-0 flex items-start gap-2 rounded-t-xl border border-b-0 border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{errorMessage}</p>
          </div>
        )}
        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
          <button onClick={onClose} disabled={submitting} className="min-h-11 rounded-xl px-4 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
            Cancelar
          </button>
          <button
            onClick={handleConfirm}
            disabled={selected.size === 0 || submitting || eventIsFrozen}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-green-600 px-6 text-sm font-medium text-white shadow-sm transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitting ? 'Agregando…' : confirmLabel} {!submitting && selected.size > 0 ? `(${selected.size})` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
