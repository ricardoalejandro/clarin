'use client'

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ListTodo, Loader2, Search, X } from 'lucide-react'
import { apiGet } from '@/lib/api'
import { SEARCH_DEBOUNCE_MS } from '@/lib/useDebouncedValue'
import { SearchRequestLifecycle } from '@/lib/searchRequestLifecycle'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import { taskContainerRemovalEndpoint, type TaskContainerRemovalDestination, type TaskContainerRemovalType } from './taskContainerRemoval'
import { useTaskRemovalDialogFocus } from './useTaskRemovalDialogFocus'

export default function TaskContainerRemovalDestinationPicker({ type, id, selected, onChange, disabled }: {
  type: TaskContainerRemovalType
  id: string
  selected: TaskContainerRemovalDestination | null
  onChange: (item: TaskContainerRemovalDestination) => void
  disabled?: boolean
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return <>
    <button ref={triggerRef} type="button" aria-label="Lista de destino" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen(true)} className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-slate-300 bg-white px-3 py-2 text-left text-sm outline-none focus:ring-4 focus:ring-emerald-100 disabled:opacity-50"><ListTodo className="h-4 w-4 shrink-0 text-slate-400" /><span className="min-w-0 flex-1 break-words">{selected?.name || 'Selecciona una lista del mismo Entorno'}{selected?.folder_name && <span className="block text-xs text-slate-500">{selected.folder_name}</span>}</span><ChevronDown className="h-4 w-4 shrink-0 text-slate-400" /></button>
    {open && <DestinationPanel type={type} id={id} trigger={triggerRef.current} selected={selected} onClose={() => setOpen(false)} onChange={item => { onChange(item); setOpen(false) }} />}
  </>
}

function DestinationPanel({ type, id, trigger, selected, onChange, onClose }: {
  type: TaskContainerRemovalType
  id: string
  trigger: HTMLButtonElement | null
  selected: TaskContainerRemovalDestination | null
  onChange: (item: TaskContainerRemovalDestination) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const requests = useRef(new SearchRequestLifecycle())
  const [query, setQuery] = useState('')
  const [settled, setSettled] = useState('')
  const [items, setItems] = useState<TaskContainerRemovalDestination[]>([])
  const [cursor, setCursor] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [position, setPosition] = useState<CSSProperties>({})
  useTaskRemovalDialogFocus(panelRef, onClose, true)
  const load = useCallback(async (search: string, next = '') => {
    const lease = requests.current.begin()
    setLoading(true); setError('')
    const params = new URLSearchParams({ limit: '50' })
    if (search.trim()) params.set('search', search.trim())
    if (next) params.set('cursor', next)
    try {
      const result = await apiGet<{ lists: TaskContainerRemovalDestination[]; next_cursor?: string }>(`${taskContainerRemovalEndpoint(type, id)}/removal-destinations?${params}`, { signal: lease.signal })
      if (!requests.current.isCurrent(lease)) return
      if (!result.success) { setError(result.error || 'No se pudieron cargar los destinos.'); return }
      setItems(current => Array.from(new Map([...(next ? current : []), ...(result.data?.lists || [])].map(item => [item.id, item])).values()))
      setCursor(result.data?.next_cursor || '')
    } catch { if (requests.current.isCurrent(lease)) setError('No se pudieron cargar los destinos. Reintenta.') }
    finally { if (requests.current.isCurrent(lease)) setLoading(false) }
  }, [id, type])
  useEffect(() => {
    const run = () => { setSettled(query); void load(query) }
    const timer = query ? window.setTimeout(run, SEARCH_DEBOUNCE_MS) : undefined
    if (!query) run()
    return () => { if (timer !== undefined) window.clearTimeout(timer); requests.current.invalidate() }
  }, [load, query])
  useEffect(() => {
    const positionPanel = () => {
      const rect = trigger?.getBoundingClientRect()
      if (!rect) return
      const viewport = window.visualViewport
      const width = viewport?.width || window.innerWidth
      const height = viewport?.height || window.innerHeight
      const left = viewport?.offsetLeft || 0
      const top = viewport?.offsetTop || 0
      const panelWidth = Math.min(Math.max(300, rect.width), width - 24)
      const below = top + height - rect.bottom - 12
      const above = rect.top - top - 12
      const flip = below < 280 && above > below
      setPosition({ width: panelWidth, left: Math.max(left + 12, Math.min(rect.left, left + width - panelWidth - 12)), maxHeight: Math.min(400, Math.max(120, flip ? above : below)), ...(flip ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) })
    }
    positionPanel()
    window.addEventListener('resize', positionPanel)
    window.addEventListener('scroll', positionPanel, true)
    window.visualViewport?.addEventListener('resize', positionPanel)
    return () => { window.removeEventListener('resize', positionPanel); window.removeEventListener('scroll', positionPanel, true); window.visualViewport?.removeEventListener('resize', positionPanel) }
  }, [trigger])
  if (typeof document === 'undefined') return null
  return createPortal(<>
    <button type="button" tabIndex={-1} data-task-picker-backdrop aria-label="Cerrar destinos" onMouseDown={onClose} className="fixed inset-0 cursor-default" style={{ zIndex: TASK_OVERLAY_LAYERS.pickerBackdrop }} />
    <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Elegir lista de destino" data-task-removal-picker style={{ ...position, zIndex: TASK_OVERLAY_LAYERS.picker }} className="fixed flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl outline-none">
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-3 py-2"><Search className="h-4 w-4 shrink-0 text-slate-400" /><input data-removal-initial-focus aria-label="Buscar listas de destino" value={query} onChange={event => { requests.current.invalidate(); setQuery(event.target.value); if (!event.target.value) setSettled('') }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); panelRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus() } }} placeholder="Buscar listas…" className="min-h-10 min-w-0 flex-1 text-sm outline-none" />{(loading || query !== settled) && <Loader2 aria-label="Cargando destinos" className="h-4 w-4 animate-spin text-emerald-600" />}{query && <button type="button" aria-label="Limpiar búsqueda" onClick={() => { requests.current.invalidate(); setQuery(''); setSettled('') }} className="min-h-11 min-w-11 rounded-xl text-slate-400"><X className="mx-auto h-4 w-4" /></button>}</div>
      <div role="listbox" aria-label="Destinos disponibles" className="min-h-0 overflow-y-auto p-2" onKeyDown={event => {
        const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'))
        const index = options.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === 'ArrowDown' ? (index + 1) % options.length : event.key === 'ArrowUp' ? (index + options.length - 1) % options.length : -1
        if (next >= 0 && options[next]) { event.preventDefault(); options[next].focus() }
      }}>
        {items.map(item => <button key={item.id} type="button" role="option" aria-selected={item.id === selected?.id} disabled={loading || query !== settled} onClick={() => onChange(item)} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-emerald-50 focus:bg-emerald-50 focus:outline-none disabled:opacity-40"><ListTodo className="h-4 w-4 shrink-0" style={{ color: item.color || '#64748B' }} /><span className="min-w-0 flex-1"><span className="block break-words text-sm font-semibold text-slate-700">{item.name}</span><span className="block break-words text-xs text-slate-500">{item.folder_name || 'Lista independiente'} · {item.lifecycle === 'archived' ? 'Archivo' : 'Activa'}</span></span>{item.id === selected?.id && <Check className="h-4 w-4 shrink-0 text-emerald-600" />}</button>)}
        {!loading && !items.length && !error && <p className="p-5 text-sm text-slate-500">No hay destinos compatibles. Deben pertenecer al mismo Entorno y al mismo estado de Archivo.</p>}
        {error && <div role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}<button type="button" onClick={() => void load(settled)} className="ml-2 underline">Reintentar</button></div>}
        {cursor && !error && <button type="button" disabled={loading || query !== settled} onClick={() => void load(settled, cursor)} className="min-h-11 w-full text-sm font-semibold text-emerald-700 disabled:opacity-50">Cargar más destinos</button>}
      </div>
    </div>
  </>, document.body)
}
