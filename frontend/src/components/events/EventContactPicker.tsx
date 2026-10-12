'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Eye, Filter, Loader2, RotateCcw, Search, Users, X } from 'lucide-react'
import OperationalWindowShell from '@/components/operational-window/OperationalWindowShell'
import { OPERATIONAL_OVERLAY_LAYERS, useOperationalOverlayPortal, useOperationalOverlayRegistration } from '@/components/operational-window/OperationalOverlayContext'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import { api } from '@/lib/api'
import { getAuthScope, subscribeAuthScope } from '@/lib/authScope'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { EMPTY_EVENT_CONTACT_FILTER, eventContactName, eventContactPickCount, eventContactQuery, eventContactSelected, eventContactSelectionPayload, eventSelectionNeedsReview, selectEventContactPage, toggleEventContact, type EventCandidatePage, type EventContactCandidate, type EventContactFilter, type EventContactPick, type EventContactSelection, type EventContactSelectionResult } from './eventContactSelection'

interface Props {
 eventId: string; eventName: string; open: boolean; suspended?: boolean; readOnly?: boolean; onClose: () => void
 onAdded: (result: EventContactSelectionResult) => void
 onInspectParticipant?: (participantId: string, contactId: string) => void
}
interface Tag { id: string; name: string; color: string }
interface Reply { success: boolean; page?: EventCandidatePage; selection?: EventContactSelection; result?: EventContactSelectionResult; code?: string }
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500'
const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2'
const input = 'h-11 w-full rounded-xl border border-slate-300 px-3 text-sm text-slate-900 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100 disabled:bg-slate-50'
const emptyPick = (): EventContactPick => ({ mode: 'ids', ids: [] })
export default function EventContactPicker(props: Props) {
 const [scope, setScope] = useState(getAuthScope)
 useEffect(() => subscribeAuthScope(() => setScope(getAuthScope())), [])
 return props.open ? <PickerSession key={props.eventId + scope} {...props} scope={scope} /> : null
}
function DiscardDialog({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
 const portal = useOperationalOverlayPortal()
 const ref = useRef<HTMLDivElement>(null)
 useOperationalOverlayRegistration(true, 'event-contact-discard')
 useAccessibleDialog(true, ref, onKeep)
 if (!portal) return null
 return createPortal(<div data-operational-confirmation className="fixed inset-0 flex items-center justify-center bg-slate-950/40 p-4" style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.confirmation }}>
  <div ref={ref} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="event-contact-discard-title" className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
   <h3 id="event-contact-discard-title" className="font-semibold text-slate-950">¿Descartar esta selección?</h3>
   <p className="mt-2 text-sm text-slate-600">Todavía no has añadido estos contactos. Puedes seguir revisándolos o cerrar la ventana.</p>
   <div className="mt-5 flex flex-wrap justify-end gap-2"><button className={button} onClick={onKeep}>Seguir seleccionando</button><button className={primary} onClick={onDiscard}>Descartar y cerrar</button></div>
  </div>
 </div>, portal)
}
function PickerSession({ eventId, eventName, onClose, onAdded, onInspectParticipant, scope, suspended, readOnly }: Props & { scope: string }) {
 const [searchInput, setSearchInput] = useState({ value: '', revision: 0 })
 const [settledInput, setSettledInput] = useDebouncedValue(searchInput)
 const search = searchInput.value
 const settledSearch = settledInput.value
 const [filter, setFilter] = useState<EventContactFilter>(EMPTY_EVENT_CONTACT_FILTER)
 const [draft, setDraft] = useState<EventContactFilter>(EMPTY_EVENT_CONTACT_FILTER)
 const [filterOpen, setFilterOpen] = useState(false)
 const [tagSearch, setTagSearch] = useState('')
 const [settledTags, setSettledTags] = useDebouncedValue(tagSearch)
 const [tags, setTags] = useState<Tag[]>([])
 const [tagLabels, setTagLabels] = useState<Record<string, Tag>>({})
 const [tagsBusy, setTagsBusy] = useState(false)
 const [tagsError, setTagsError] = useState('')
 const [page, setPage] = useState<EventCandidatePage | null>(null)
 const [pick, setPick] = useState<EventContactPick>(emptyPick)
 const [cursors, setCursors] = useState<string[]>([''])
 const [loading, setLoading] = useState(false)
 const [error, setError] = useState('')
 const [review, setReview] = useState<EventContactSelection | null>(null)
 const [preparing, setPreparing] = useState(false)
 const [confirming, setConfirming] = useState(false)
 const [uncertain, setUncertain] = useState(false)
 const [confirmationStarted, setConfirmationStarted] = useState(false)
 const [discard, setDiscard] = useState(false)
 const [revision, setRevision] = useState(0)
 const operationRef = useRef('')
 const mounted = useRef(true)
 const request = useRef(0)
 const abort = useRef<AbortController | null>(null)
 const listRef = useRef<HTMLDivElement>(null)
 const browseScroll = useRef(0)
 const recoveryKey = 'clarin:event-contact-operation:' + scope + ':' + eventId
 const selectionCount = eventContactPickCount(pick)
 const frozen = !!readOnly || page?.event_status === 'completed' || page?.event_status === 'cancelled'
 const busy = preparing || confirming
 const searchPending = searchInput !== settledInput
 const appliedFilter = { ...filter, search: settledSearch }
 const query = eventContactQuery(appliedFilter)
 const cursor = cursors[cursors.length - 1]
 const finish = useCallback((result: EventContactSelectionResult) => {
  try { sessionStorage.removeItem(recoveryKey) } catch {}
  onAdded(result); onClose()
 }, [onAdded, onClose, recoveryKey])
 useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; abort.current?.abort() } }, [])
 useEffect(() => {
  let pending: { selection_id?: string; operation_id?: string } = {}
  try { pending = JSON.parse(sessionStorage.getItem(recoveryKey) || '{}') } catch {}
  if (!pending.selection_id || !pending.operation_id) return
  setConfirmationStarted(true)
  const controller = new AbortController()
  setPreparing(true)
  void api<Reply>(`/api/events/${eventId}/participant-selections/${pending.selection_id}`, { signal: controller.signal }).then(response => {
   if (controller.signal.aborted || !mounted.current) return
   if (response.success && response.data?.selection) {
    operationRef.current = pending.operation_id!; setReview(response.data.selection); setUncertain(true)
    setError('Recuperamos tu última operación. Comprueba el resultado antes de volver a confirmar.')
   } else {
    if (response.status === 404 || eventSelectionNeedsReview(response.data?.code)) {
     setConfirmationStarted(false)
     try { sessionStorage.removeItem(recoveryKey) } catch {}
    } else {
     operationRef.current = pending.operation_id!
     setReview({ selection_id: pending.selection_id!, selected: 0, new: 0, reactivations: 0, expires_at: '' })
     setUncertain(true)
    }
    setError(response.error || 'La revisión anterior ya no está disponible.')
   }
  }).finally(() => { if (!controller.signal.aborted && mounted.current) setPreparing(false) })
  return () => controller.abort()
 }, [eventId, recoveryKey])
 useEffect(() => {
  if (filterOpen) return
  const controller = new AbortController()
  abort.current?.abort(); abort.current = controller
  const generation = ++request.current
  setLoading(true)
  const path = review
   ? `/api/events/${eventId}/participant-selections/${review.selection_id}?review=true&cursor=${encodeURIComponent(cursor)}`
   : `/api/events/${eventId}/contact-candidates?${query}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`
  void api<Reply>(path, { signal: controller.signal }).then(response => {
   if (controller.signal.aborted || generation !== request.current || !mounted.current) return
   if (!response.success || !response.data?.page) {
    if (response.success && response.data?.selection?.result) { setReview(response.data.selection); return }
    setError(response.error || 'No pudimos cargar los contactos. Reintenta la búsqueda.'); setPage(null); return
   }
   setPage(response.data.page)
  }).finally(() => { if (!controller.signal.aborted && generation === request.current && mounted.current) setLoading(false) })
  return () => controller.abort()
 }, [eventId, query, settledInput, cursor, revision, review?.selection_id, filterOpen, readOnly])
 useEffect(() => {
  if (!filterOpen) return
  const controller = new AbortController()
  setTagsBusy(true); setTagsError('')
  void api<{ tags: Tag[] }>(`/api/tags?limit=20&search=${encodeURIComponent(settledTags)}`, { signal: controller.signal }).then(response => {
   if (controller.signal.aborted || !mounted.current) return
   if (!response.success) { setTagsError(response.error || 'No pudimos buscar etiquetas.'); setTags([]); return }
   const found = response.data?.tags || []
   setTags(found); setTagLabels(previous => ({ ...previous, ...Object.fromEntries(found.map(tag => [tag.id, tag])) }))
  }).finally(() => { if (!controller.signal.aborted && mounted.current) setTagsBusy(false) })
  return () => controller.abort()
 }, [filterOpen, settledTags, revision])
 useEffect(() => { setCursors(['']) }, [query])
 const close = () => {
  if (busy) return
  if (confirmationStarted || uncertain || review?.result) { onClose(); return }
  if (selectionCount || review) setDiscard(true)
  else onClose()
 }
 const clear = () => { setPick(emptyPick()); setError('') }
 const updateSearch = (value: string) => {
  abort.current?.abort(); request.current++; setError('')
  const next = { value, revision: searchInput.revision + 1 }
  setSearchInput(next)
  if (!value) setSettledInput(next)
 }
 const prepare = async () => {
  if (!selectionCount || busy || frozen || searchPending) return
  setPreparing(true); setError(''); browseScroll.current = listRef.current?.scrollTop || 0
  const response = await api<Reply>(`/api/events/${eventId}/participant-selections`, { method: 'POST', body: JSON.stringify(eventContactSelectionPayload(pick)) })
  if (!mounted.current) return
  setPreparing(false)
  if (!response.success || !response.data?.selection) { setError(response.error || 'No pudimos preparar la selección.'); setRevision(value => value + 1); return }
  operationRef.current = crypto.randomUUID(); setReview(response.data.selection); setCursors([''])
 }
 const confirm = async () => {
  if (!review || busy || frozen) return
  setConfirming(true); setConfirmationStarted(true); setError('')
  try { sessionStorage.setItem(recoveryKey, JSON.stringify({ selection_id: review.selection_id, operation_id: operationRef.current })) } catch {}
  const response = await api<Reply>(`/api/events/${eventId}/participant-selections/${review.selection_id}/confirm`, { method: 'POST', body: JSON.stringify({ operation_id: operationRef.current }) })
  if (!mounted.current) return
  setConfirming(false)
  if (response.success && response.data?.result) { finish(response.data.result); return }
  if (eventSelectionNeedsReview(response.data?.code)) {
   try { sessionStorage.removeItem(recoveryKey) } catch {}
   setReview(null); setCursors(['']); setUncertain(false); setConfirmationStarted(false); setRevision(value => value + 1)
  } else setUncertain(true)
  setError(response.error || 'No recibimos la confirmación. Comprueba el resultado para continuar de forma segura.')
 }
 const recover = async () => {
  if (!review || busy) return
  setConfirming(true)
  const response = await api<Reply>(`/api/events/${eventId}/participant-selections/${review.selection_id}`)
  if (!mounted.current) return
  setConfirming(false)
  if (response.success && response.data?.selection?.result) { finish(response.data.selection.result); return }
  if (response.success && response.data?.selection) { setReview(response.data.selection); setUncertain(false); setError('Todavía no hay un resultado confirmado. Puedes reintentar: conservamos el mismo identificador para evitar duplicados.'); return }
  if (response.status === 404 || eventSelectionNeedsReview(response.data?.code)) {
   setReview(null); setUncertain(false); setConfirmationStarted(false); setCursors(['']); setRevision(value => value + 1)
   operationRef.current = ''
   try { sessionStorage.removeItem(recoveryKey) } catch {}
  }
  setError(response.error || 'No pudimos comprobar el resultado. Vuelve a intentarlo.')
 }
 const back = () => {
  if (confirmationStarted || uncertain || busy) return
  setReview(null); setError(''); setCursors([''])
  requestAnimationFrame(() => { if (listRef.current) listRef.current.scrollTop = browseScroll.current })
 }
 const rows = page?.candidates || []
 const rowDisabled = !!review || busy || frozen || searchPending || loading
 return <OperationalWindowShell open={!suspended} storageKey="clarin:event-contact-picker" storageScope={scope} title={review ? 'Revisar contactos' : filterOpen ? 'Filtros de contactos' : 'Añadir contactos'} eyebrow={eventName} description={review ? 'Comprueba el alcance antes de confirmar.' : 'Selecciona contactos de tu cuenta para este evento.'} icon={Users} defaultWidth={960} defaultHeight={760} minWidth={520} minHeight={480} dockedWidth={700} busy={busy} onRequestClose={close} overlayZIndex={100} dataAttribute="event-contact-picker" contentClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
 footer={<div className="flex flex-wrap items-center justify-between gap-3">
  <p className="text-xs text-slate-500">{review ? `${review.selected.toLocaleString('es-PE')} contactos · revisión válida 15 minutos` : selectionCount ? `${selectionCount.toLocaleString('es-PE')} seleccionados` : 'Seleccionar no añade contactos.'}</p>
  <div className="flex flex-wrap gap-2">{filterOpen ? <><button className={button} onClick={() => setFilterOpen(false)}>Cancelar</button><button className={primary} onClick={() => { setFilter(draft); setFilterOpen(false); setCursors(['']); if (pick.mode === 'filtered') clear() }}>{pick.mode === 'filtered' ? 'Aplicar y limpiar selección' : 'Aplicar filtros'}</button></>
   : review ? <>{!confirmationStarted && !uncertain && !review.result && <button className={button} disabled={busy} onClick={back}><ArrowLeft className="h-4 w-4" />Volver</button>}<button className={primary} disabled={busy || (frozen && !uncertain && !review.result)} onClick={uncertain || review.result ? recover : confirm}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{uncertain || review.result ? 'Comprobar resultado' : `Confirmar ${review.selected.toLocaleString('es-PE')} contactos`}</button></>
   : <><button className={button} disabled={busy} onClick={close}>Cerrar</button><button className={primary} disabled={!selectionCount || busy || frozen || searchPending || loading} onClick={prepare}>{preparing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}Revisar selección</button></>}
  </div>
 </div>}>
 {frozen && <p role="status" className="mx-4 mt-3 shrink-0 rounded-xl bg-slate-100 px-3 py-2.5 text-sm text-slate-600">Este evento está cerrado. Tu selección se conserva; podrás continuar si se reactiva. Puedes consultar sus contactos y comprobar operaciones anteriores.</p>}
 {error && <div role="alert" className="mx-4 mt-3 flex shrink-0 items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><p className="min-w-0 flex-1">{error}</p><button aria-label="Cerrar aviso" className="shrink-0 p-1" onClick={() => setError('')}><X className="h-4 w-4" /></button></div>}
 {filterOpen ? <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
  {pick.mode === 'filtered' && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Al aplicar otros filtros se limpiará la selección de todos los resultados.</p>}
  <fieldset><legend className="mb-2 text-sm font-semibold text-slate-800">Participación</legend><div className="flex flex-wrap gap-2">{([['available', 'Disponibles'], ['active', 'Ya participan'], ['inactive', 'Para reactivar'], ['ineligible', 'No elegibles'], ['all', 'Todos']] as const).map(([value, label]) => <label key={value} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm ${draft.membership === value ? 'border-emerald-400 bg-emerald-50 text-emerald-800' : 'border-slate-200'}`}><input type="radio" name="event-membership-filter" checked={draft.membership === value} onChange={() => setDraft(current => ({ ...current, membership: value }))} />{label}</label>)}</div></fieldset>
  <label className="flex min-h-11 items-center gap-3 text-sm text-slate-700"><input type="checkbox" checked={draft.has_phone === true} onChange={event => setDraft(current => ({ ...current, has_phone: event.target.checked ? true : undefined }))} className="h-4 w-4 accent-emerald-600" />Solo contactos con teléfono</label>
  <div><p className="mb-2 text-sm font-semibold text-slate-800">Etiquetas <span className="font-normal text-slate-500">· cualquiera de las seleccionadas</span></p>
   {!!draft.tag_ids.length && <div className="mb-3 flex flex-wrap gap-2">{draft.tag_ids.map(id => <button key={id} className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-slate-100 px-2 text-xs text-slate-700" onClick={() => setDraft(current => ({ ...current, tag_ids: current.tag_ids.filter(value => value !== id) }))}>{tagLabels[id]?.name || 'Etiqueta seleccionada'}<X className="h-3 w-3" /></button>)}</div>}
   <input value={tagSearch} onChange={event => { setTagSearch(event.target.value); if (!event.target.value) setSettledTags('') }} placeholder="Buscar etiquetas…" aria-label="Buscar etiquetas" className={input} />
   <div className="mt-2 space-y-1">{tagsBusy || tagSearch !== settledTags ? <p role="status" className="p-3 text-sm text-slate-500">Buscando etiquetas…</p> : tagsError ? <p role="alert" className="p-3 text-sm text-amber-800">{tagsError}<button className="ml-2 underline" onClick={() => setRevision(value => value + 1)}>Reintentar</button></p> : tags.length ? tags.map(tag => <label key={tag.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 hover:bg-slate-50"><input type="checkbox" checked={draft.tag_ids.includes(tag.id)} onChange={() => setDraft(current => ({ ...current, tag_ids: current.tag_ids.includes(tag.id) ? current.tag_ids.filter(id => id !== tag.id) : [...current.tag_ids, tag.id].slice(0, 100) }))} className="h-4 w-4 accent-emerald-600" /><span className="h-2 w-2 rounded-full bg-slate-400" style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(tag.color) ? tag.color : undefined }} /><span className="text-sm text-slate-700">{tag.name}</span></label>) : <p className="p-3 text-sm text-slate-500">No hay etiquetas que coincidan.</p>}</div>
   <p className="mt-2 text-xs text-slate-500">Hasta 20 coincidencias. Refina la búsqueda para encontrar otra etiqueta.</p>
  </div><button className={button} onClick={() => setDraft({ ...EMPTY_EVENT_CONTACT_FILTER, search })}>Limpiar filtros</button>
 </div> : <>
  {review ? <div className="shrink-0 border-b border-slate-100 p-4"><div className="grid grid-cols-2 gap-3"><div className="rounded-xl bg-emerald-50 px-4 py-3"><p className="text-2xl font-semibold text-emerald-800">{review.new.toLocaleString('es-PE')}</p><p className="text-xs text-emerald-700">Contactos nuevos en el evento</p></div><div className="rounded-xl bg-violet-50 px-4 py-3"><p className="text-2xl font-semibold text-violet-800">{review.reactivations.toLocaleString('es-PE')}</p><p className="text-xs text-violet-700">Participaciones que se reactivarán</p></div></div><p className="mt-3 text-xs leading-relaxed text-slate-600">Se conservará el historial de las participaciones reactivadas. Las reglas se comprobarán nuevamente al confirmar. Los contactos que ya participan no se duplicarán.</p></div>
   : <div className="shrink-0 space-y-3 border-b border-slate-100 p-4">
    <div className="flex gap-2"><div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" /><input value={search} onChange={event => updateSearch(event.target.value)} disabled={pick.mode === 'filtered' || busy} placeholder="Nombre, teléfono o correo" aria-label="Buscar contactos" className={input + ' pl-9 pr-10'} />{search && pick.mode !== 'filtered' && <button aria-label="Limpiar búsqueda" className="absolute right-1 top-1 flex h-9 w-9 items-center justify-center text-slate-400" onClick={() => updateSearch('')}><X className="h-4 w-4" /></button>}</div><button className={button} disabled={busy} onClick={() => { setDraft(filter); setFilterOpen(true) }}><Filter className="h-4 w-4" />Filtros{filter.tag_ids.length + (filter.has_phone ? 1 : 0) > 0 ? ` (${filter.tag_ids.length + (filter.has_phone ? 1 : 0)})` : ''}</button></div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><p className="text-slate-500" role="status">{loading || searchPending ? 'Buscando…' : `${(page?.total || 0).toLocaleString('es-PE')} coincidencias · ${(page?.counts.available || 0).toLocaleString('es-PE')} disponibles`}</p>{page?.has_rules && <span className="text-amber-700">Se aplican las reglas del evento</span>}</div>
    {selectionCount > 0 && <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"><span>{pick.mode === 'filtered' ? `Todos los disponibles de esta búsqueda${pick.excluded_ids.length ? ` · ${pick.excluded_ids.length} excluidos` : ''}` : `${selectionCount} seleccionados entre páginas`}</span><button className="min-h-8 font-semibold underline underline-offset-2" onClick={clear}>Limpiar selección</button>{pick.mode === 'filtered' && <p className="w-full text-emerald-700">Limpia la selección para cambiar la búsqueda.</p>}</div>}
    {!frozen && <div className="flex flex-wrap gap-x-4 gap-y-1"><button className="min-h-9 text-xs font-semibold text-emerald-700 disabled:opacity-40" disabled={loading || searchPending || !rows.some(row => row.can_add) || busy} onClick={() => setPick(current => selectEventContactPage(current, rows))}>Seleccionar esta página</button>{(page?.counts.available || 0) > 0 && filter.membership !== 'active' && filter.membership !== 'ineligible' && <button className="min-h-9 text-xs font-semibold text-emerald-700 disabled:opacity-40" disabled={loading || searchPending || busy} onClick={() => setPick({ mode: 'filtered', filter: appliedFilter, excluded_ids: [], total: page!.counts.available })}>Seleccionar todos los disponibles ({page?.counts.available.toLocaleString('es-PE')})</button>}</div>}
    {pick.mode === 'ids' && pick.ids.length === 500 && <p className="text-xs text-amber-800">Llegaste a 500 contactos individuales. Para una selección mayor, utiliza todos los disponibles de una búsqueda.</p>}
   </div>}
  <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-2" aria-busy={loading}>
   {loading && !page ? <div role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500"><Loader2 className="h-5 w-5 animate-spin" />Cargando contactos…</div>
    : !page ? <div className="py-16 text-center"><p className="text-sm text-slate-500">La búsqueda no está disponible.</p><button className={button + ' mt-3'} onClick={() => { setError(''); setRevision(value => value + 1) }}><RotateCcw className="h-4 w-4" />Reintentar</button></div>
    : !rows.length ? <div className="py-16 text-center"><Users className="mx-auto mb-3 h-8 w-8 text-slate-300" /><p className="text-sm font-medium text-slate-700">No hay contactos que coincidan</p><p className="mt-1 text-xs text-slate-500">Prueba otro nombre o ajusta los filtros.</p></div>
    : <div className={loading || searchPending ? 'opacity-50' : ''}>{rows.map(candidate => <CandidateRow key={candidate.contact.id} candidate={candidate} checked={!!review || eventContactSelected(pick, candidate)} disabled={rowDisabled || !candidate.can_add || (pick.mode === 'ids' && pick.ids.length >= 500 && !pick.ids.includes(candidate.contact.id))} review={!!review} onToggle={() => setPick(current => toggleEventContact(current, candidate))} onInspect={onInspectParticipant} />)}</div>}
  </div>
  <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-100 px-4 py-2"><span className="text-xs text-slate-500">Página {cursors.length} · hasta 50 contactos</span><div className="flex gap-2"><button aria-label="Página anterior" className={button} disabled={cursors.length === 1 || loading || busy || searchPending} onClick={() => { setCursors(current => current.slice(0, -1)); if (listRef.current) listRef.current.scrollTop = 0 }}><ChevronLeft className="h-4 w-4" /></button><button aria-label="Página siguiente" className={button} disabled={!page?.next_cursor || loading || busy || searchPending} onClick={() => { setCursors(current => [...current, page!.next_cursor!]); if (listRef.current) listRef.current.scrollTop = 0 }}><ChevronRight className="h-4 w-4" /></button></div></div>
 </>}
 {discard && <DiscardDialog onKeep={() => setDiscard(false)} onDiscard={onClose} />}
 </OperationalWindowShell>
}
function CandidateRow({ candidate, checked, disabled, review, onToggle, onInspect }: { candidate: EventContactCandidate; checked: boolean; disabled: boolean; review: boolean; onToggle: () => void; onInspect?: Props['onInspectParticipant'] }) {
 const contact = candidate.contact
 const name = eventContactName(contact)
 const status = candidate.membership_status === 'active' ? `Ya participa${candidate.stage_name ? ' · ' + candidate.stage_name : ''}` : candidate.eligibility === 'rule_ineligible' ? 'No cumple las reglas' : candidate.membership_status === 'inactive' ? 'Se reactivará' : 'Disponible'
 const phone = contact.phone?.trim() || contact.extra_phones?.find(item => item.phone.trim())?.phone
 return <div className={`my-1 flex items-stretch rounded-xl border ${checked ? 'border-emerald-200 bg-emerald-50/50' : 'border-transparent hover:bg-slate-50'}`}>
  <label className={`flex min-w-0 flex-1 items-start gap-3 px-3 py-3 ${disabled ? 'cursor-default' : 'cursor-pointer'}`}>
   <input type="checkbox" aria-label={`Seleccionar ${name}`} checked={checked} disabled={disabled} onChange={onToggle} className="mt-1 h-4 w-4 shrink-0 accent-emerald-600" />
   <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500">{name === 'Contacto sin nombre' ? '?' : name.slice(0, 2).toUpperCase()}</span>
   <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="truncate text-sm font-semibold text-slate-900">{name}</span><span className={`text-[11px] ${candidate.membership_status === 'inactive' ? 'text-violet-700' : candidate.eligibility === 'rule_ineligible' ? 'text-amber-700' : 'text-slate-500'}`}>{status}</span></span><span className="mt-0.5 block truncate text-xs text-slate-500">{[phone, contact.email].filter(Boolean).join(' · ') || 'Sin teléfono ni correo registrados'}</span>{contact.structured_tags?.length ? <span className="mt-1.5 flex flex-wrap gap-1">{contact.structured_tags.slice(0, 3).map(tag => <span key={tag.id} className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{tag.name}</span>)}{contact.structured_tags.length > 3 && <span className="text-[10px] text-slate-500">+{contact.structured_tags.length - 3}</span>}</span> : null}</span>
  </label>
  {!review && candidate.participant_id && onInspect && <button type="button" className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl px-2 text-slate-500 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-500" title="Ver participante" aria-label={`Ver participante ${name}`} onClick={() => onInspect(candidate.participant_id!, contact.id)}><Eye className="h-4 w-4" /></button>}
 </div>
}
