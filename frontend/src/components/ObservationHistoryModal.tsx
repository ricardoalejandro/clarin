'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { X, Clock, FileText, Phone, Trash2, Plus, XCircle, ChevronDown, Filter, SlidersHorizontal, CalendarCheck2 } from 'lucide-react'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'

export interface HistoryObservation {
  id: string
  contact_id: string | null
  lead_id: string | null
  type: string
  direction: string | null
  outcome: string | null
  notes: string | null
  created_by_name: string | null
  created_at: string
  program_id?: string | null
  program_session_id?: string | null
  program_participant_id?: string | null
  source_label?: string | null
}

interface ObservationHistoryModalProps {
  isOpen: boolean
  onClose: () => void
  /** Lead ID for CRM lead history. Not used by event participants. */
  leadId?: string | null
  /** Event participant ID — when present, history is resolved through participant/contact. */
  participantId?: string | null
  /** Event ID used when creating participant observations */
  eventId?: string | null
  /** Contact ID — if provided, API calls use /api/contacts/:id/interactions */
  contactId?: string | null
  programId?: string | null
  programParticipantId?: string | null
  attendanceContext?: { programId: string; sessionId: string; participantId: string } | null
  defaultNewType?: 'note' | 'call'
  /** Display name for header */
  name: string
  /** Initial observations (caller already has them). Component refreshes internally after add/delete. */
  observations: HistoryObservation[]
  /** Called after an observation is added or deleted so caller can refresh its own list */
  onObservationChange?: () => void
  /** Controls whether existing observations can be removed and whether new ones can be appended. */
  mutationMode?: 'manage' | 'append-only' | 'read-only'
  allowedNewTypes?: Array<'note' | 'call'>
  initialComposerOpen?: boolean
  loading?: boolean
  errorMessage?: string
  onRetry?: () => void
}

const PAGE_SIZE = 20

export default function ObservationHistoryModal({
  isOpen,
  onClose,
  leadId,
  participantId,
  eventId,
  contactId,
  programId,
  programParticipantId,
  attendanceContext,
  defaultNewType = 'call',
  name,
  observations: initialObservations,
  onObservationChange,
  mutationMode = 'manage',
  allowedNewTypes = ['note', 'call'],
  initialComposerOpen = false,
  loading = false,
  errorMessage = '',
  onRetry,
}: ObservationHistoryModalProps) {
  const kommoEnabled = typeof window !== 'undefined' && localStorage.getItem('kommo_enabled') === 'true'
  const [observations, setObservations] = useState<HistoryObservation[]>(initialObservations)
  const [filterType, setFilterType] = useState('')
  const [filterFrom, setFilterFrom] = useState('')
  const [filterTo, setFilterTo] = useState('')

  // Filters and composer are independent: opening a filter must not expose the
  // write controls, and adding one observation must not collapse the composer.
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)

  // Add observation form
  const [newType, setNewType] = useState<'note' | 'call'>(defaultNewType)
  const [newText, setNewText] = useState('')
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState('')

  // Infinite scroll
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [loadingMore, setLoadingMore] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null)
  const modalWasOpenRef = useRef(false)
  const isOpenRef = useRef(isOpen)
  const viewIdentityRef = useRef('')
  const viewGenerationRef = useRef(0)

  const viewIdentity = !isOpen
    ? 'closed'
    : attendanceContext
    ? `attendance:${attendanceContext.programId}:${attendanceContext.sessionId}:${attendanceContext.participantId}`
    : participantId
    ? `participant:${participantId}`
    : contactId
    ? `contact:${contactId}`
    : leadId
    ? `lead:${leadId}`
    : 'open:none'
  isOpenRef.current = isOpen
  if (viewIdentityRef.current !== viewIdentity) {
    viewIdentityRef.current = viewIdentity
    viewGenerationRef.current += 1
  }

  // Sync observations when prop changes
  useEffect(() => { setObservations(initialObservations) }, [initialObservations])

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setFilterType(''); setFilterFrom(''); setFilterTo(''); setNewText(''); setNewType(defaultNewType)
      setFiltersOpen(false); setComposerOpen(false); setVisibleCount(PAGE_SIZE); setActionError('')
    }
  }, [defaultNewType, isOpen])

  useEffect(() => {
    if (isOpen && !modalWasOpenRef.current) {
      setFiltersOpen(false)
      setComposerOpen(initialComposerOpen)
    }
    modalWasOpenRef.current = isOpen
  }, [initialComposerOpen, isOpen])

  useEffect(() => {
    if (!composerOpen) return
    const frame = window.requestAnimationFrame(() => composerTextareaRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [composerOpen])

  // Escape key — capture phase to prevent parent handlers from firing
  useEffect(() => {
    if (!isOpen) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose() }
    }
    document.addEventListener('keydown', h, true)
    return () => document.removeEventListener('keydown', h, true)
  }, [isOpen, onClose])

  const fetchObservations = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const url = attendanceContext
        ? `/api/programs/${attendanceContext.programId}/sessions/${attendanceContext.sessionId}/participants/${attendanceContext.participantId}/attendance-observations`
        : participantId
        ? `/api/interactions?participant_id=${participantId}&limit=200`
        : contactId
        ? `/api/contacts/${contactId}/interactions?limit=200`
        : leadId
        ? `/api/leads/${leadId}/interactions?limit=200`
        : null
      if (!url) return
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) {
        const next = attendanceContext
          ? (data.observations || []).map((observation: any) => ({ ...observation, contact_id: null, lead_id: null, type: 'attendance', direction: null, outcome: null }))
          : (data.interactions || [])
        setObservations(next)
        setVisibleCount(PAGE_SIZE)
      }
    } catch (err) {
      console.error('Failed to fetch observations:', err)
    }
  }, [attendanceContext, leadId, participantId, contactId])

  // Infinite scroll with IntersectionObserver
  useEffect(() => {
    if (!isOpen) return
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleCount(prev => prev + PAGE_SIZE)
        }
      },
      { root: scrollRef.current, rootMargin: '100px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [isOpen, observations.length, filterType, filterFrom, filterTo])

  const handleAdd = async () => {
    if (!newText.trim() || (!attendanceContext && !participantId && !contactId && !leadId)) return
    const operationGeneration = viewGenerationRef.current
    setSaving(true)
    setActionError('')
    const token = localStorage.getItem('token')
    try {
      const body = attendanceContext
        ? { notes: newText.trim() }
        : participantId
        ? { event_id: eventId || undefined, participant_id: participantId, contact_id: contactId || undefined, type: newType, notes: newText.trim() }
        : contactId
        ? { contact_id: contactId, program_id: programId || undefined, program_participant_id: programParticipantId || undefined, type: newType, notes: newText.trim() }
        : { lead_id: leadId, type: newType, notes: newText.trim() }
      const url = attendanceContext
        ? `/api/programs/${attendanceContext.programId}/sessions/${attendanceContext.sessionId}/participants/${attendanceContext.participantId}/attendance-observations`
        : '/api/interactions'
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error(data.error || 'No se pudo guardar la observación.')
      if (!isOpenRef.current || operationGeneration !== viewGenerationRef.current) return
      setNewText('')
      window.requestAnimationFrame(() => composerTextareaRef.current?.focus())
      if (onObservationChange) onObservationChange()
      else await fetchObservations()
    } catch (err) {
      console.error('Failed to add observation:', err)
      if (isOpenRef.current && operationGeneration === viewGenerationRef.current) {
        setActionError(err instanceof Error ? err.message : 'No se pudo guardar la observación.')
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (obsId: string) => {
    if (!confirm('¿Eliminar esta observación?')) return
    const operationGeneration = viewGenerationRef.current
    const token = localStorage.getItem('token')
    try {
      const url = attendanceContext
        ? `/api/programs/${attendanceContext.programId}/sessions/${attendanceContext.sessionId}/participants/${attendanceContext.participantId}/attendance-observations/${obsId}`
        : `/api/interactions/${obsId}`
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error(data.error || 'No se pudo eliminar la observación.')
      if (!isOpenRef.current || operationGeneration !== viewGenerationRef.current) return
      if (onObservationChange) onObservationChange()
      else await fetchObservations()
    } catch (err) {
      console.error('Failed to delete observation:', err)
      if (isOpenRef.current && operationGeneration === viewGenerationRef.current) {
        setActionError(err instanceof Error ? err.message : 'No se pudo eliminar la observación.')
      }
    }
  }

  if (!isOpen) return null

  const hasFilters = !!(filterType || filterFrom || filterTo)

  const filtered = observations.filter(obs => {
    if (filterType && obs.type !== filterType) return false
    if (filterFrom && new Date(obs.created_at) < new Date(filterFrom)) return false
    if (filterTo) {
      const to = new Date(filterTo)
      to.setDate(to.getDate() + 1)
      if (new Date(obs.created_at) >= to) return false
    }
    return true
  })

  const visible = filtered.slice(0, visibleCount)
  const hasMore = visibleCount < filtered.length

  const typeLabel = (t: string) =>
    t === 'note' ? 'Nota' : t === 'call' ? 'Llamada' : t === 'attendance' ? 'Asistencia' : t === 'whatsapp' ? 'WhatsApp' : t === 'email' ? 'Email' : t === 'meeting' ? 'Reunión' : t

  const typeStyle = (t: string) =>
    t === 'note' ? 'bg-amber-50 text-amber-700 border-amber-200/60'
    : t === 'call' ? 'bg-blue-50 text-blue-700 border-blue-200/60'
    : t === 'attendance' ? 'bg-emerald-50 text-emerald-700 border-emerald-200/60'
    : t === 'whatsapp' ? 'bg-green-50 text-green-700 border-green-200/60'
    : t === 'email' ? 'bg-purple-50 text-purple-700 border-purple-200/60'
    : 'bg-orange-50 text-orange-700 border-orange-200/60'

  return (
    <div className="app-viewport fixed inset-0 z-[90] flex items-stretch justify-center bg-black/50 p-0 backdrop-blur-sm animate-in fade-in duration-150 sm:items-center sm:p-4" onClick={onClose}>
      <div className="flex h-[var(--app-height)] w-full max-w-3xl flex-col overflow-hidden rounded-none border border-slate-200/60 bg-white shadow-2xl animate-in zoom-in-95 duration-200 sm:h-auto sm:max-h-[85vh] sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white shrink-0">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center">
              <Clock className="w-4 h-4 text-emerald-600" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900">{attendanceContext ? 'Observaciones de asistencia' : 'Historial de Observaciones'}</h2>
              <p className="truncate text-[11px] text-slate-500">{name || 'Sin nombre'} · {observations.length} registro{observations.length !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {mutationMode !== 'append-only' && <button
              type="button"
              onClick={() => setFiltersOpen(value => !value)}
              className={`inline-flex h-11 w-11 items-center justify-center rounded-xl transition-all sm:h-9 sm:w-9 ${filtersOpen || hasFilters ? 'text-emerald-600 bg-emerald-50 hover:bg-emerald-100' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`}
              title="Filtrar observaciones"
              aria-label="Filtrar observaciones"
              aria-expanded={filtersOpen}
            >
              <SlidersHorizontal className="w-4 h-4" />
            </button>}
            <button type="button" onClick={onClose} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 transition-all hover:bg-slate-100 hover:text-slate-600 sm:h-9 sm:w-9" title="Cerrar (Esc)" aria-label="Cerrar observaciones">
              <X className="w-4.5 h-4.5" />
            </button>
          </div>
        </div>

        {mutationMode !== 'read-only' && (
          <div className="shrink-0 border-b border-slate-100 bg-white px-4 py-2">
            <button type="button" onClick={() => { setComposerOpen(value => !value); setActionError('') }} className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${composerOpen ? 'border border-slate-200 bg-slate-50 text-slate-600' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`} aria-expanded={composerOpen}>
              {composerOpen ? <><ChevronDown className="h-4 w-4 rotate-180" /> Ocultar formulario</> : <><Plus className="h-4 w-4" /> Nueva observación</>}
            </button>
          </div>
        )}

        {/* Filters are independent from the observation composer. */}
        {filtersOpen && mutationMode !== 'append-only' && (
          <div className="border-b border-slate-100 bg-slate-50/50 shrink-0 animate-in slide-in-from-top-2 duration-150">
            <div className="px-5 py-2.5 flex items-end gap-3 flex-wrap">
              {!attendanceContext && <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-0.5 block font-semibold">Tipo</label>
                <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="px-2.5 py-1 border border-slate-200 rounded-lg text-xs text-slate-700 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-300 bg-white transition">
                  <option value="">Todos</option>
                  <option value="note">Nota</option>
                  <option value="call">Llamada</option>
                  <option value="attendance">Asistencia</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">Email</option>
                  <option value="meeting">Reunión</option>
                </select>
              </div>}
              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-0.5 block font-semibold">Desde</label>
                <input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} className="px-2.5 py-1 border border-slate-200 rounded-lg text-xs text-slate-700 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-300 bg-white transition" />
              </div>
              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-0.5 block font-semibold">Hasta</label>
                <input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} className="px-2.5 py-1 border border-slate-200 rounded-lg text-xs text-slate-700 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-300 bg-white transition" />
              </div>
              {hasFilters && (
                <button onClick={() => { setFilterType(''); setFilterFrom(''); setFilterTo('') }} className="px-2 py-1 text-[11px] text-slate-500 hover:text-red-600 hover:bg-red-50 flex items-center gap-1 transition rounded-lg">
                  <XCircle className="w-3 h-3" /> Limpiar
                </button>
              )}
            </div>
          </div>
        )}

        {composerOpen && mutationMode !== 'read-only' && (
          <div className="shrink-0 animate-in border-b border-slate-100 bg-slate-50/50 slide-in-from-top-2 duration-150">
            <div className="px-5 py-2.5">
              <div className="flex items-center gap-1.5 mb-1.5">
                {!attendanceContext && allowedNewTypes.includes('note') && <button
                  type="button"
                  onClick={() => setNewType('note')}
                  className={`flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md transition font-medium ${
                    newType === 'note' ? 'bg-yellow-100 text-yellow-700 ring-1 ring-yellow-300' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}
                >
                  <FileText className="w-3 h-3" /> Nota
                </button>}
                {!attendanceContext && allowedNewTypes.includes('call') && <button
                  type="button"
                  onClick={() => setNewType('call')}
                  className={`flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md transition font-medium ${
                    newType === 'call' ? 'bg-blue-100 text-blue-700 ring-1 ring-blue-300' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}
                >
                  <Phone className="w-3 h-3" /> Llamada
                </button>}
              </div>
              <div className="flex flex-col gap-2 min-[390px]:flex-row">
                <textarea
                  ref={composerTextareaRef}
                  value={newText}
                  onChange={(e) => setNewText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && newText.trim() && !saving) {
                      e.preventDefault()
                      handleAdd()
                    }
                  }}
                  placeholder={attendanceContext ? 'Escribir observación de asistencia... (Ctrl+Enter)' : newType === 'call' ? 'Resultado de llamada... (Ctrl+Enter)' : 'Escribir observación... (Ctrl+Enter)'}
                  rows={2}
                  className="min-w-0 w-full flex-1 px-3 py-1.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-emerald-500 text-sm text-slate-900 placeholder:text-slate-400 resize-none"
                />
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={!newText.trim() || saving}
                  className="flex min-h-11 w-full shrink-0 items-center justify-center gap-1.5 self-stretch rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white transition hover:bg-emerald-700 disabled:opacity-50 min-[390px]:w-auto min-[390px]:self-end"
                >
                  {saving ? <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white" /> : <Plus className="w-3 h-3" />}
                  Agregar
                </button>
              </div>
              {actionError && <div role="alert" className="mt-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"><XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{actionError}</span></div>}
            </div>
          </div>
        )}

        {/* Active filters indicator (when filters are closed) */}
        {!filtersOpen && hasFilters && (
          <div className="px-5 py-1.5 border-b border-slate-100 bg-emerald-50/50 shrink-0 flex items-center gap-2">
            <Filter className="w-3 h-3 text-emerald-600" />
            <span className="text-[11px] text-emerald-700 font-medium">
              Filtros activos — {filtered.length} de {observations.length} registros
            </span>
            <button onClick={() => { setFilterType(''); setFilterFrom(''); setFilterTo('') }} className="ml-auto text-[11px] text-emerald-600 hover:text-red-600 transition">
              Limpiar
            </button>
          </div>
        )}

        {/* Content — observations list */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="space-y-2 py-2" aria-label="Cargando observaciones">
              <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
              <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
              <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
            </div>
          ) : errorMessage ? (
            <div className="flex min-h-48 items-center justify-center py-8 text-center">
              <div><XCircle className="mx-auto h-9 w-9 text-red-300" /><p className="mt-3 text-sm font-semibold text-slate-700">No se pudo cargar el historial</p><p className="mt-1 text-xs text-slate-500">{errorMessage}</p>{onRetry && <button type="button" onClick={onRetry} className="mt-4 min-h-11 rounded-xl border border-red-200 bg-white px-4 text-sm font-semibold text-red-700 hover:bg-red-50">Reintentar</button>}</div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-16">
              <FileText className="w-10 h-10 text-slate-200 mx-auto mb-3" />
              <p className="text-sm text-slate-400">No hay registros{hasFilters ? ' con los filtros seleccionados' : ''}</p>
              {!composerOpen && mutationMode !== 'read-only' && (
                <button type="button" onClick={() => setComposerOpen(true)} className="mt-3 min-h-11 rounded-xl px-3 text-xs font-medium text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700">
                  + Agregar observación
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              {visible.map((obs) => (
                <div key={obs.id} className="px-3.5 py-2.5 bg-white rounded-xl group relative border border-slate-100 hover:border-slate-200 hover:shadow-sm transition-all">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className={`px-2 py-px text-[10px] rounded font-semibold tracking-wide border ${typeStyle(obs.type)}`}>
                          {typeLabel(obs.type)}
                        </span>
                        <span className="text-[11px] text-slate-400">{format(new Date(obs.created_at), "d MMM yyyy, HH:mm", { locale: es })}</span>
                        <span data-testid="observation-author" className="text-[10px] text-slate-500">
                          <span className="sm:hidden">Registrado por </span>
                          <span className="hidden sm:inline">· </span>
                          {obs.created_by_name || 'Autor no registrado'}
                        </span>
                        {kommoEnabled && obs.notes?.startsWith('(sinc)') && <span className="px-1.5 py-px bg-emerald-50 text-emerald-600 text-[9px] rounded-full font-medium border border-emerald-100">Kommo</span>}
                      </div>
                      <p className="text-sm text-slate-700 whitespace-pre-wrap break-words leading-relaxed">{obs.notes?.startsWith('(sinc) ') ? obs.notes.slice(7) : (obs.notes || '(sin contenido)')}</p>
                      {obs.program_id && obs.source_label && <p className={`mt-1.5 flex items-center gap-1.5 text-[11px] font-medium ${obs.type === 'attendance' ? 'text-emerald-700' : 'text-slate-500'}`}><CalendarCheck2 className="h-3 w-3" />{obs.source_label}</p>}
                    </div>
                    {mutationMode === 'manage' && (obs.type !== 'attendance' || attendanceContext) && <button onClick={() => handleDelete(obs.id)} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-300 transition-all hover:bg-red-50 hover:text-red-500 sm:h-7 sm:w-7 sm:opacity-0 sm:group-hover:opacity-100" title="Eliminar"><Trash2 className="w-3 h-3" /></button>}
                  </div>
                </div>
              ))}
              {/* Infinite scroll sentinel */}
              <div ref={sentinelRef} className="h-1" />
              {hasMore && (
                <div className="text-center py-2">
                  <div className="inline-flex items-center gap-2 text-[11px] text-slate-400">
                    <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-slate-400" />
                    Cargando más...
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
