'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, CircleDot, Flag, Loader2, Search, X } from 'lucide-react'
import { TASK_PRIORITY_CONFIG, type TaskPriority, type TaskWorkflowStatus } from '@/types/task'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'

interface CommonProps {
  disabled?: boolean
  pending?: boolean
  className?: string
}

interface StatusProps extends CommonProps {
  value: string
  statuses: TaskWorkflowStatus[]
  onChange: (statusID: string) => void
  placeholder?: string
  compact?: boolean
}

interface PriorityProps extends CommonProps {
  value: TaskPriority
  onChange: (priority: TaskPriority) => void
}

const categoryLabels: Record<TaskWorkflowStatus['category'], string> = {
  not_started: 'No iniciado',
  active: 'Activo',
  done: 'Finalizado',
  cancelled: 'Cancelado',
}

const categoryOrder: TaskWorkflowStatus['category'][] = ['not_started', 'active', 'done', 'cancelled']

const priorityDescriptions: Record<TaskPriority, string> = {
  low: 'Puede esperar',
  medium: 'Ritmo normal',
  high: 'Requiere atención',
  urgent: 'Atención inmediata',
}

function usePickerPosition(open: boolean, triggerRef: React.RefObject<HTMLButtonElement | null>) {
  const [style, setStyle] = useState<CSSProperties>({})
  useEffect(() => {
    if (!open) return
    const position = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const viewport = window.visualViewport
      const viewportLeft = viewport?.offsetLeft || 0
      const viewportTop = viewport?.offsetTop || 0
      const viewportWidth = viewport?.width || window.innerWidth
      const viewportHeight = viewport?.height || window.innerHeight
      const horizontalMargin = Math.min(12, Math.max(0, viewportWidth / 2))
      const verticalMargin = Math.min(12, Math.max(0, viewportHeight / 2))
      const availableWidth = Math.max(0, viewportWidth - horizontalMargin * 2)
      const availableHeight = Math.max(0, viewportHeight - verticalMargin * 2)
      const width = Math.min(Math.max(280, rect.width), availableWidth)
      const left = Math.max(viewportLeft + horizontalMargin, Math.min(rect.left, viewportLeft + viewportWidth - width - horizontalMargin))
      const roomBelow = viewportTop + viewportHeight - rect.bottom
      const roomAbove = rect.top - viewportTop
      const panelHeight = Math.min(360, availableHeight)
      const openAbove = roomBelow < 260 && roomAbove > roomBelow
      const preferredTop = openAbove ? rect.top - panelHeight - 6 : rect.bottom + 6
      const top = Math.max(viewportTop + verticalMargin, Math.min(preferredTop, viewportTop + viewportHeight - panelHeight - verticalMargin))
      setStyle({ left, top, width, maxHeight: panelHeight })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    window.visualViewport?.addEventListener('resize', position)
    window.visualViewport?.addEventListener('scroll', position)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      window.visualViewport?.removeEventListener('resize', position)
      window.visualViewport?.removeEventListener('scroll', position)
    }
  }, [open, triggerRef])
  return style
}

function PickerPortal({ label, open, style, highlighted, count, containerRef, onHighlight, onChoose, onClose, header, children }: { label: string; open: boolean; style: CSSProperties; highlighted: number; count: number; containerRef: React.RefObject<HTMLDivElement | null>; onHighlight: (index: number) => void; onChoose: (index: number) => void; onClose: () => void; header?: React.ReactNode; children: React.ReactNode }) {
  const highlightedRef = useRef(highlighted)
  useEffect(() => { highlightedRef.current = highlighted }, [highlighted])
  useLayoutEffect(() => {
    if (open) containerRef.current?.focus({ preventScroll: true })
  }, [containerRef, open])
  if (!open || typeof document === 'undefined') return null
  return createPortal(<>
    <button type="button" aria-label={`Cerrar ${label}`} data-task-picker-backdrop className="fixed inset-0 cursor-default" style={{ zIndex: TASK_OVERLAY_LAYERS.pickerBackdrop }} onMouseDown={onClose} />
    <div ref={containerRef} data-task-property-picker-portal role="dialog" aria-label={label} style={{ ...style, zIndex: TASK_OVERLAY_LAYERS.picker }} tabIndex={-1} onKeyDown={event => {
      const fromSearch = (event.target as HTMLElement).matches('input[data-task-picker-search]')
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      if (event.key === 'ArrowDown') { event.preventDefault(); const next = Math.min(count - 1, highlightedRef.current + 1); highlightedRef.current = next; onHighlight(next) }
      if (event.key === 'ArrowUp') { event.preventDefault(); const next = Math.max(0, highlightedRef.current - 1); highlightedRef.current = next; onHighlight(next) }
      if (!fromSearch && event.key === 'Home') { event.preventDefault(); highlightedRef.current = 0; onHighlight(0) }
      if (!fromSearch && event.key === 'End') { event.preventDefault(); const next = Math.max(0, count - 1); highlightedRef.current = next; onHighlight(next) }
      if ((event.key === 'Enter' || (!fromSearch && event.key === ' ')) && count) { event.preventDefault(); onChoose(highlightedRef.current) }
    }} className="fixed flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-900/15 outline-none">{header}<div role="listbox" aria-label={label} style={{ zIndex: TASK_OVERLAY_LAYERS.picker }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div></div>
  </>, document.body)
}

export function TaskStatusPicker({ value, statuses, onChange, placeholder = 'Selecciona un estado', disabled, pending, compact = false, className = '' }: StatusProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const portalRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const [query, setQuery] = useState('')
  const [settledQuery, setSettledQuery] = useDebouncedValue(query)
  const labelRef = useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = useState(false)
  const ordered = useMemo(() => [...statuses].sort((a, b) => a.sort_order - b.sort_order), [statuses])
  const filtered = useMemo(() => {
    const normalized = settledQuery.trim().toLocaleLowerCase('es')
    return normalized ? ordered.filter(status => `${status.name} ${categoryLabels[status.category]}`.toLocaleLowerCase('es').includes(normalized)) : ordered
  }, [ordered, settledQuery])
  const grouped = useMemo(() => categoryOrder.map(category => ({ category, statuses: filtered.filter(status => status.category === category) })).filter(group => group.statuses.length), [filtered])
  const searchPending = query.trim() !== settledQuery.trim()
  const selected = ordered.find(status => status.id === value)
  const style = usePickerPosition(open, triggerRef)
  useEffect(() => {
    if (!open) return
    setHighlighted(Math.max(0, filtered.findIndex(status => status.id === value)))
    requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }))
  }, [filtered, open, value])
  useLayoutEffect(() => {
    const label = labelRef.current
    if (!label) return
    const measure = () => setTruncated(label.scrollWidth > label.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(label)
    return () => observer.disconnect()
  }, [compact, selected?.name])
  const close = () => { setOpen(false); setQuery(''); setSettledQuery(''); window.setTimeout(() => triggerRef.current?.focus({ preventScroll: true }), 0) }
  const choose = (index: number) => { const item = filtered[index]; if (item && item.id !== value) onChange(item.id); close() }
  return <>
    <button ref={triggerRef} type="button" disabled={disabled || pending} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(current => !current)} data-task-status-picker title={truncated ? selected?.name : undefined} className={`flex w-full items-center gap-2 rounded-xl border border-slate-200 bg-white text-left text-sm outline-none transition hover:border-slate-300 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 disabled:opacity-50 ${compact ? 'min-h-9 px-2 py-1.5' : 'min-h-11 px-3 py-2'} ${className}`}>
      <span className={`flex shrink-0 items-center justify-center rounded-lg bg-slate-50 ${compact ? 'h-6 w-6' : 'h-7 w-7'}`}>{selected ? <i className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: selected.color }} /> : <CircleDot className="h-3.5 w-3.5 text-slate-400" />}</span>
      <span className="min-w-0 flex-1"><span ref={labelRef} className={`block truncate font-semibold ${selected ? 'text-slate-700' : 'text-slate-400'}`}>{selected?.name || placeholder}</span>{selected && !compact && <span className="block text-[10px] font-medium text-slate-400">{categoryLabels[selected.category]}</span>}</span>
      {pending ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-emerald-600" /> : <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />}
    </button>
    <PickerPortal label="Seleccionar estado" open={open} style={style} highlighted={highlighted} count={filtered.length} containerRef={portalRef} onHighlight={setHighlighted} onChoose={choose} onClose={close} header={<div className="relative mb-1.5 border-b border-slate-100 p-1.5 pb-2"><Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-[65%] text-slate-400" /><input ref={searchRef} data-task-picker-search type="search" value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value) setSettledQuery(''); setHighlighted(0) }} placeholder="Buscar estado…" aria-label="Buscar estado" className="min-h-10 w-full rounded-xl border border-slate-200 bg-slate-50 pl-9 pr-9 text-sm text-slate-700 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-100" />{searchPending ? <Loader2 aria-label="Esperando para filtrar" className="absolute right-4 top-1/2 h-3.5 w-3.5 -translate-y-[65%] animate-spin text-emerald-600" /> : query && <button type="button" aria-label="Limpiar búsqueda" onClick={() => { setQuery(''); setSettledQuery(''); setHighlighted(0); searchRef.current?.focus() }} className="absolute right-3 top-1/2 flex h-7 w-7 -translate-y-[58%] items-center justify-center rounded-lg text-slate-400 hover:bg-slate-200"><X className="h-3.5 w-3.5" /></button>}</div>}>{grouped.map(group => <div key={group.category} role="group" aria-label={categoryLabels[group.category]} className="py-1"><p className="px-3 pb-1 pt-1 text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{categoryLabels[group.category]}</p>{group.statuses.map(status => { const index = filtered.findIndex(item => item.id === status.id); return <button key={status.id} type="button" role="option" aria-selected={status.id === value} onMouseEnter={() => setHighlighted(index)} onClick={() => choose(index)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ${highlighted === index ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}><span className="flex h-8 w-8 items-center justify-center rounded-xl bg-white shadow-sm"><i className="h-3 w-3 rounded-full" style={{ backgroundColor: status.color }} /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-700">{status.name}</span><span className="block text-[10px] font-medium text-slate-400">{categoryLabels[status.category]}</span></span>{status.id === value && <Check className="h-4 w-4 text-emerald-600" />}</button>})}</div>)}{!filtered.length && <div className="px-4 py-8 text-center"><p className="text-sm font-semibold text-slate-600">No encontramos estados</p><p className="mt-1 text-xs text-slate-400">Prueba con otro nombre o categoría.</p></div>}</PickerPortal>
  </>
}

export function TaskPriorityPicker({ value, onChange, disabled, pending, className = '' }: PriorityProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const portalRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const priorities = Object.keys(TASK_PRIORITY_CONFIG) as TaskPriority[]
  const [highlighted, setHighlighted] = useState(Math.max(0, priorities.indexOf(value)))
  const style = usePickerPosition(open, triggerRef)
  const selected = TASK_PRIORITY_CONFIG[value]
  useEffect(() => {
    if (!open) return
    setHighlighted(Math.max(0, priorities.indexOf(value)))
    requestAnimationFrame(() => portalRef.current?.focus())
  }, [open, value]) // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { setOpen(false); window.setTimeout(() => triggerRef.current?.focus({ preventScroll: true }), 0) }
  const choose = (index: number) => { const item = priorities[index]; if (item && item !== value) onChange(item); close() }
  return <>
    <button ref={triggerRef} type="button" disabled={disabled || pending} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(current => !current)} data-task-priority-picker className={`flex min-h-11 w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-sm outline-none transition hover:border-slate-300 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 disabled:opacity-50 ${className}`}>
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${selected.bg}`}><Flag className={`h-3.5 w-3.5 ${selected.color}`} /></span><span className="min-w-0 flex-1"><span className={`block truncate font-semibold ${selected.color}`}>{selected.label}</span><span className="block text-[10px] font-medium text-slate-400">{priorityDescriptions[value]}</span></span>{pending ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-emerald-600" /> : <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />}
    </button>
    <PickerPortal label="Seleccionar prioridad" open={open} style={style} highlighted={highlighted} count={priorities.length} containerRef={portalRef} onHighlight={setHighlighted} onChoose={choose} onClose={close}>{priorities.map((priority, index) => { const config = TASK_PRIORITY_CONFIG[priority]; return <button key={priority} type="button" role="option" aria-selected={priority === value} onMouseEnter={() => setHighlighted(index)} onClick={() => choose(index)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ${highlighted === index ? 'bg-slate-50' : 'hover:bg-slate-50'}`}><span className={`flex h-8 w-8 items-center justify-center rounded-xl ${config.bg}`}><Flag className={`h-4 w-4 ${config.color}`} /></span><span className="min-w-0 flex-1"><span className={`block text-sm font-semibold ${config.color}`}>{config.label}</span><span className="block text-[10px] font-medium text-slate-400">{priorityDescriptions[priority]}</span></span>{priority === value && <Check className="h-4 w-4 text-emerald-600" />}</button> })}</PickerPortal>
  </>
}
