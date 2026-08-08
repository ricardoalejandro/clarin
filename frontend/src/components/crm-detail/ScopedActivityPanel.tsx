'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, ChevronDown, ChevronUp, FileText, Loader2, MessageSquarePlus, PhoneCall, Plus, RefreshCw, StickyNote, Trash2, UserRound } from 'lucide-react'
import { api, subscribeWebSocket } from '@/lib/api'
import type { Observation } from '@/types/contact'
import type { ActivityScope } from '@/types/crm-detail'

export type ActivityEntryType = 'note' | 'call'

type Props = {
  scope: ActivityScope
  title?: string
  description?: string
  readOnly?: boolean
  initiallyOpen?: boolean
  embedded?: boolean
  onCountChange?: (count: number) => void
  onChange?: () => void
}

export function activityScopeKey(scope: ActivityScope) {
  if (scope.kind === 'contact') return `contact:${scope.contactId}`
  if (scope.kind === 'lead') return `lead:${scope.leadId}`
  return `event_participant:${scope.eventId}:${scope.participantId}`
}

export function activityScopeQuery(scope: ActivityScope) {
  if (scope.kind === 'contact') return `/api/contacts/${encodeURIComponent(scope.contactId)}/interactions?limit=100`
  if (scope.kind === 'lead') return `/api/leads/${encodeURIComponent(scope.leadId)}/interactions?limit=100`
  const params = new URLSearchParams({ participant_id: scope.participantId, scope: 'participant', limit: '100' })
  return `/api/interactions?${params.toString()}`
}

export function activityScopePayload(scope: ActivityScope, notes: string, type: ActivityEntryType = 'note') {
  if (scope.kind === 'contact') return { contact_id: scope.contactId, type, notes }
  if (scope.kind === 'lead') return { lead_id: scope.leadId, contact_id: scope.contactId || undefined, type, notes }
  return {
    event_id: scope.eventId,
    participant_id: scope.participantId,
    contact_id: scope.contactId || undefined,
    lead_id: scope.leadId || undefined,
    type,
    notes,
  }
}

function realtimePayload(message: unknown): Record<string, unknown> | null {
  if (!message || typeof message !== 'object') return null
  const record = message as Record<string, unknown>
  if (record.event !== 'interaction_update') return null
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : record
  const interaction = data.interaction && typeof data.interaction === 'object' ? data.interaction as Record<string, unknown> : null
  return interaction ? { ...data, ...interaction } : data
}

export function activityRealtimeMatchesScope(scope: ActivityScope, message: unknown): boolean {
  const payload = realtimePayload(message)
  if (!payload) return false
  if (scope.kind === 'contact') return payload.contact_id === scope.contactId
  if (scope.kind === 'lead') return payload.lead_id === scope.leadId
  return payload.participant_id === scope.participantId
}

export function activityAuthorLabel(item: Pick<Observation, 'created_by_name' | 'source_label'>) {
  const author = item.created_by_name?.trim()
  if (author) return author
  const source = item.source_label?.trim()
  if (source && /import|kommo|excel/i.test(source)) return `Importación · ${source}`
  if (source && /system|automat|regla/i.test(source)) return `Sistema · ${source}`
  if (source) return source
  return 'Usuario no disponible'
}

function dateLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('es-PE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function typeLabel(type: string) {
  if (type === 'call') return 'Llamada'
  if (type === 'meeting') return 'Reunión'
  return 'Nota'
}

export default function ScopedActivityPanel({
  scope,
  title = scope.kind === 'lead' ? 'Observaciones de la oportunidad' : scope.kind === 'event_participant' ? 'Observaciones de esta participación' : 'Historial del contacto',
  description,
  readOnly = false,
  initiallyOpen = true,
  embedded = false,
  onCountChange,
  onChange,
}: Props) {
  const scopeKey = activityScopeKey(scope)
  const [items, setItems] = useState<Observation[]>([])
  const [open, setOpen] = useState(initiallyOpen || embedded)
  const [composerOpen, setComposerOpen] = useState(false)
  const [entryType, setEntryType] = useState<ActivityEntryType>('note')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const requestRef = useRef(0)
  const loadedKeyRef = useRef('')
  const activeScopeKeyRef = useRef(scopeKey)
  activeScopeKeyRef.current = scopeKey

  const load = useCallback(async (silent = false) => {
    const request = ++requestRef.current
    if (!silent) setLoading(true)
    setError('')
    const result = await api<{ success: boolean; interactions: Observation[] }>(activityScopeQuery(scope), { method: 'GET' })
    if (request !== requestRef.current) return
    if (!result.success || !result.data?.success) setError(result.error || 'No se pudieron cargar las observaciones.')
    else {
      const next = Array.isArray(result.data.interactions) ? result.data.interactions : []
      setItems(next)
      onCountChange?.(next.length)
      loadedKeyRef.current = scopeKey
    }
    setLoading(false)
  }, [onCountChange, scope, scopeKey])

  useEffect(() => {
    requestRef.current += 1
    loadedKeyRef.current = ''
    setItems([])
    setDraft('')
    setEntryType('note')
    setError('')
    setComposerOpen(false)
    setSaving(false)
    setLoading(false)
    setOpen(initiallyOpen || embedded)
    if (initiallyOpen || embedded) void load()
  }, [embedded, initiallyOpen, scopeKey])

  useEffect(() => subscribeWebSocket(message => {
    if (activityRealtimeMatchesScope(scope, message)) void load(true)
  }), [load, scope, scopeKey])

  const toggleOpen = () => {
    const next = !open
    setOpen(next)
    if (next && loadedKeyRef.current !== scopeKey) void load()
  }

  const add = async () => {
    const notes = draft.trim()
    if (!notes || saving || readOnly) return
    const requestKey = scopeKey
    setSaving(true)
    setError('')
    const result = await api<{ success: boolean; interaction: Observation }>('/api/interactions', {
      method: 'POST',
      body: JSON.stringify(activityScopePayload(scope, notes, entryType)),
    })
    if (requestKey !== activeScopeKeyRef.current) {
      setSaving(false)
      return
    }
    setSaving(false)
    if (!result.success || !result.data?.success || !result.data.interaction) {
      setError(result.error || 'No se pudo guardar la observación.')
      return
    }
    setDraft('')
    setOpen(true)
    setItems(current => {
      const next = [result.data!.interaction, ...current.filter(item => item.id !== result.data!.interaction.id)]
      onCountChange?.(next.length)
      return next
    })
    loadedKeyRef.current = scopeKey
    onChange?.()
  }

  const remove = async (item: Observation) => {
    if (readOnly || !window.confirm('¿Eliminar esta observación? Esta acción no se puede deshacer.')) return
    const snapshot = items
    const next = items.filter(current => current.id !== item.id)
    setItems(next)
    onCountChange?.(next.length)
    setError('')
    const result = await api<{ success: boolean }>(`/api/interactions/${item.id}`, { method: 'DELETE' })
    if (!result.success || !result.data?.success) {
      setItems(snapshot)
      onCountChange?.(snapshot.length)
      setError(result.error || 'No se pudo eliminar la observación. Restauramos el historial.')
    } else onChange?.()
  }

  const listOpen = embedded || open
  return (
    <section
      id={`crm-activity-${scopeKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
      data-crm-activity-panel
      className={embedded ? 'scroll-mt-24' : 'scroll-mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm'}
      aria-labelledby={embedded ? undefined : `activity-${scopeKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
    >
      {!embedded && <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><h3 id={`activity-${scopeKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`} className="flex items-center gap-2 text-sm font-bold text-slate-900"><FileText className="h-4 w-4 text-emerald-600" />{title}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{description || `${items.length} registro${items.length === 1 ? '' : 's'} en este contexto`}</p></div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold tabular-nums text-slate-600">{items.length}</span>
      </div>}

      <div className={`grid gap-2 ${embedded ? '' : 'mt-3'} ${readOnly ? (embedded ? 'hidden' : 'grid-cols-1') : embedded ? 'grid-cols-1' : 'grid-cols-2'}`}>
        {!embedded && <button type="button" onClick={toggleOpen} aria-expanded={open} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50">{open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}{open ? 'Ocultar' : 'Ver historial'}</button>}
        {!readOnly && <button data-crm-activity-add type="button" onClick={() => setComposerOpen(value => !value)} aria-expanded={composerOpen} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-amber-200 bg-amber-50/60 text-xs font-bold text-amber-800 hover:bg-amber-100"><MessageSquarePlus className="h-4 w-4" />{composerOpen ? 'Cerrar formulario' : 'Añadir observación'}</button>}
      </div>

      {composerOpen && !readOnly && <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50/45 p-3">
        <div className="mb-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Tipo de observación">
          <button type="button" role="radio" aria-checked={entryType === 'note'} onClick={() => setEntryType('note')} className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border text-xs font-bold transition ${entryType === 'note' ? 'border-amber-300 bg-white text-amber-800 shadow-sm' : 'border-transparent text-slate-500 hover:bg-white/70'}`}><StickyNote className="h-4 w-4" />Nota</button>
          <button type="button" role="radio" aria-checked={entryType === 'call'} onClick={() => setEntryType('call')} className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border text-xs font-bold transition ${entryType === 'call' ? 'border-blue-300 bg-white text-blue-800 shadow-sm' : 'border-transparent text-slate-500 hover:bg-white/70'}`}><PhoneCall className="h-4 w-4" />Llamada</button>
        </div>
        <textarea autoFocus rows={3} maxLength={4000} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void add() } }} placeholder={entryType === 'call' ? 'Registra el resultado o detalle de la llamada…' : 'Escribe una observación para este contexto…'} className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100" />
        <div className="mt-2 flex items-center justify-between gap-3"><span className="text-[10px] font-medium text-slate-500">Ctrl/Cmd + Enter para guardar</span><button type="button" onClick={() => void add()} disabled={!draft.trim() || saving} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white disabled:opacity-45">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}{saving ? 'Guardando…' : `Guardar ${entryType === 'call' ? 'llamada' : 'nota'}`}</button></div>
      </div>}

      {error && <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 flex-1">{error}</span><button type="button" onClick={() => void load()} aria-label="Reintentar observaciones" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg hover:bg-red-100"><RefreshCw className="h-4 w-4" /></button></div>}

      {listOpen && (loading ? <div className="flex min-h-24 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-amber-600" /></div> : items.length === 0 ? <div className="mt-3 rounded-2xl border border-dashed border-amber-200 bg-amber-50/20 px-4 py-7 text-center"><FileText className="mx-auto h-6 w-6 text-amber-300" /><p className="mt-2 text-xs text-slate-400">Todavía no hay observaciones en este contexto.</p></div> : <div className="mt-3 space-y-2">{items.map(item => {
        const isCall = item.type === 'call'
        return <article key={item.id} className={`group rounded-2xl border p-3 ${isCall ? 'border-blue-100 bg-blue-50/45' : 'border-amber-100 bg-amber-50/40'}`}><div className="flex items-start justify-between gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-extrabold ${isCall ? 'border-blue-200 bg-white text-blue-700' : 'border-amber-200 bg-white text-amber-700'}`}>{isCall ? <PhoneCall className="h-3 w-3" /> : <StickyNote className="h-3 w-3" />}{typeLabel(item.type)}</span><time className="text-[10px] font-medium text-slate-400">{dateLabel(item.created_at)}</time></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{item.notes || '(sin contenido)'}</p><p className="mt-2 flex items-center gap-1.5 text-[11px] font-semibold text-slate-500"><UserRound className="h-3.5 w-3.5" />{activityAuthorLabel(item)}</p></div>{!readOnly && item.type === 'note' && <button type="button" onClick={() => void remove(item)} aria-label="Eliminar observación" className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 opacity-100 hover:bg-red-50 hover:text-red-600 lg:opacity-0 lg:group-hover:opacity-100 lg:focus:opacity-100"><Trash2 className="h-4 w-4" /></button>}</div></article>
      })}</div>)}
    </section>
  )
}
