'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, CircleDot, Flag, Loader2 } from 'lucide-react'
import { TASK_PRIORITY_CONFIG, type TaskPriority, type TaskWorkflowStatus } from '@/types/task'

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
}

interface PriorityProps extends CommonProps {
  value: TaskPriority
  onChange: (priority: TaskPriority) => void
}

const categoryLabels: Record<TaskWorkflowStatus['category'], string> = {
  not_started: 'Inicial',
  active: 'En curso',
  done: 'Completada',
  cancelled: 'Cancelada',
}

const priorityDescriptions: Record<TaskPriority, string> = {
  low: 'Puede esperar',
  medium: 'Ritmo normal',
  high: 'Requiere atención',
  urgent: 'Atención inmediata',
}

function usePickerPosition(open: boolean, triggerRef: React.RefObject<HTMLButtonElement>) {
  const [style, setStyle] = useState<CSSProperties>({})
  useEffect(() => {
    if (!open) return
    const position = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(Math.max(260, rect.width), window.innerWidth - 24)
      const roomBelow = window.innerHeight - rect.bottom
      const openAbove = roomBelow < 260 && rect.top > roomBelow
      setStyle({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width, ...(openAbove ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open, triggerRef])
  return style
}

function PickerPortal({ label, open, style, highlighted, count, containerRef, onHighlight, onChoose, onClose, children }: { label: string; open: boolean; style: CSSProperties; highlighted: number; count: number; containerRef: React.RefObject<HTMLDivElement>; onHighlight: (index: number) => void; onChoose: (index: number) => void; onClose: () => void; children: React.ReactNode }) {
  const highlightedRef = useRef(highlighted)
  useEffect(() => { highlightedRef.current = highlighted }, [highlighted])
  useLayoutEffect(() => {
    if (open) containerRef.current?.focus({ preventScroll: true })
  }, [containerRef, open])
  if (!open || typeof document === 'undefined') return null
  return createPortal(<>
    <button type="button" aria-label={`Cerrar ${label}`} className="fixed inset-0 z-[119] cursor-default" onMouseDown={onClose} />
    <div ref={containerRef} data-task-property-picker-portal role="listbox" aria-label={label} style={style} tabIndex={-1} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      if (event.key === 'ArrowDown') { event.preventDefault(); const next = Math.min(count - 1, highlightedRef.current + 1); highlightedRef.current = next; onHighlight(next) }
      if (event.key === 'ArrowUp') { event.preventDefault(); const next = Math.max(0, highlightedRef.current - 1); highlightedRef.current = next; onHighlight(next) }
      if (event.key === 'Home') { event.preventDefault(); highlightedRef.current = 0; onHighlight(0) }
      if (event.key === 'End') { event.preventDefault(); const next = Math.max(0, count - 1); highlightedRef.current = next; onHighlight(next) }
      if ((event.key === 'Enter' || event.key === ' ') && count) { event.preventDefault(); onChoose(highlightedRef.current) }
    }} className="fixed z-[120] overflow-hidden rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-900/15 outline-none">{children}</div>
  </>, document.body)
}

export function TaskStatusPicker({ value, statuses, onChange, placeholder = 'Selecciona un estado', disabled, pending, className = '' }: StatusProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const portalRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const ordered = useMemo(() => [...statuses].sort((a, b) => a.sort_order - b.sort_order), [statuses])
  const selected = ordered.find(status => status.id === value)
  const style = usePickerPosition(open, triggerRef)
  useEffect(() => {
    if (!open) return
    setHighlighted(Math.max(0, ordered.findIndex(status => status.id === value)))
    requestAnimationFrame(() => portalRef.current?.focus())
  }, [open, ordered, value])
  const close = () => { setOpen(false); requestAnimationFrame(() => triggerRef.current?.focus()) }
  const choose = (index: number) => { const item = ordered[index]; if (item && item.id !== value) onChange(item.id); close() }
  return <>
    <button ref={triggerRef} type="button" disabled={disabled || pending} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(current => !current)} data-task-status-picker className={`flex min-h-11 w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-sm outline-none transition hover:border-slate-300 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 disabled:opacity-50 ${className}`}>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-50">{selected ? <i className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: selected.color }} /> : <CircleDot className="h-3.5 w-3.5 text-slate-400" />}</span>
      <span className="min-w-0 flex-1"><span className={`block truncate font-semibold ${selected ? 'text-slate-700' : 'text-slate-400'}`}>{selected?.name || placeholder}</span>{selected && <span className="block text-[10px] font-medium text-slate-400">{categoryLabels[selected.category]}</span>}</span>
      {pending ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-emerald-600" /> : <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />}
    </button>
    <PickerPortal label="Seleccionar estado" open={open} style={style} highlighted={highlighted} count={ordered.length} containerRef={portalRef} onHighlight={setHighlighted} onChoose={choose} onClose={close}>{ordered.map((status, index) => <button key={status.id} type="button" role="option" aria-selected={status.id === value} onMouseEnter={() => setHighlighted(index)} onClick={() => choose(index)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ${highlighted === index ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}><span className="flex h-8 w-8 items-center justify-center rounded-xl bg-white shadow-sm"><i className="h-3 w-3 rounded-full" style={{ backgroundColor: status.color }} /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-700">{status.name}</span><span className="block text-[10px] font-medium text-slate-400">{categoryLabels[status.category]}</span></span>{status.id === value && <Check className="h-4 w-4 text-emerald-600" />}</button>)}</PickerPortal>
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
  const close = () => { setOpen(false); requestAnimationFrame(() => triggerRef.current?.focus()) }
  const choose = (index: number) => { const item = priorities[index]; if (item && item !== value) onChange(item); close() }
  return <>
    <button ref={triggerRef} type="button" disabled={disabled || pending} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(current => !current)} data-task-priority-picker className={`flex min-h-11 w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-sm outline-none transition hover:border-slate-300 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 disabled:opacity-50 ${className}`}>
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${selected.bg}`}><Flag className={`h-3.5 w-3.5 ${selected.color}`} /></span><span className="min-w-0 flex-1"><span className={`block truncate font-semibold ${selected.color}`}>{selected.label}</span><span className="block text-[10px] font-medium text-slate-400">{priorityDescriptions[value]}</span></span>{pending ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-emerald-600" /> : <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />}
    </button>
    <PickerPortal label="Seleccionar prioridad" open={open} style={style} highlighted={highlighted} count={priorities.length} containerRef={portalRef} onHighlight={setHighlighted} onChoose={choose} onClose={close}>{priorities.map((priority, index) => { const config = TASK_PRIORITY_CONFIG[priority]; return <button key={priority} type="button" role="option" aria-selected={priority === value} onMouseEnter={() => setHighlighted(index)} onClick={() => choose(index)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ${highlighted === index ? 'bg-slate-50' : 'hover:bg-slate-50'}`}><span className={`flex h-8 w-8 items-center justify-center rounded-xl ${config.bg}`}><Flag className={`h-4 w-4 ${config.color}`} /></span><span className="min-w-0 flex-1"><span className={`block text-sm font-semibold ${config.color}`}>{config.label}</span><span className="block text-[10px] font-medium text-slate-400">{priorityDescriptions[priority]}</span></span>{priority === value && <Check className="h-4 w-4 text-emerald-600" />}</button> })}</PickerPortal>
  </>
}
