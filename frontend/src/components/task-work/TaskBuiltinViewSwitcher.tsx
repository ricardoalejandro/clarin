'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { BarChart3, CalendarDays, Check, Columns3, GanttChartSquare, LayoutList, MoreHorizontal } from 'lucide-react'
import type { TaskViewMode } from '@/types/task'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'

const views = [
  { id: 'list', label: 'Lista', icon: LayoutList },
  { id: 'board', label: 'Tablero', icon: Columns3 },
  { id: 'calendar', label: 'Calendario', icon: CalendarDays },
  { id: 'gantt', label: 'Gantt', icon: GanttChartSquare },
  { id: 'summary', label: 'Resumen', icon: BarChart3 },
] as const

export default function TaskBuiltinViewSwitcher({ value, active = true, width, onChange }: {
  value: TaskViewMode; active?: boolean; width: number; onChange: (view: TaskViewMode) => void
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({})
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  useEffect(() => {
    if (!open) return
    const measure = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const menuWidth = Math.min(220, window.innerWidth - 24)
      setPosition({ width: menuWidth, left: Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12)), top: Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 120)), maxHeight: window.innerHeight - 24 })
    }
    measure()
    const frame = requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus())
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [open])
  return <div className="flex min-w-0 shrink-0 items-center" role="group" aria-label="Vistas de tareas">
    {views.filter((view, index) => index < 3 || (active && view.id === value)).map(option => {
      const Icon = option.icon
      const selected = active && value === option.id
      const hideLabel = width < (active && (value === 'gantt' || value === 'summary') ? 410 : 310) && !selected
      return <button key={option.id} type="button" aria-label={option.label} aria-pressed={selected} title={hideLabel ? option.label : undefined} onClick={() => onChange(option.id)} className={`flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${selected ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:bg-white/60 hover:text-slate-800'}`}><Icon className="h-3.5 w-3.5" /><span className={hideLabel ? 'sr-only' : ''}>{option.label}</span></button>
    })}
    <button ref={trigger} type="button" aria-label="Más vistas" aria-haspopup="menu" aria-expanded={open} title="Más vistas" onClick={() => setOpen(current => !current)} className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-slate-500 hover:bg-white/60"><MoreHorizontal className="h-4 w-4" /><span className={width < 500 ? 'sr-only' : ''}>Más vistas</span></button>
    {open && createPortal(<>
      <button type="button" tabIndex={-1} aria-label="Cerrar más vistas" onClick={close} className="fixed inset-0 cursor-default" style={{ zIndex: TASK_OVERLAY_LAYERS.workspacePopover - 1 }} />
      <div ref={menu} role="menu" aria-label="Más vistas" style={{ ...position, zIndex: TASK_OVERLAY_LAYERS.workspacePopover }} className="fixed overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg" onKeyDown={event => {
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        if (event.key === 'Escape') { event.preventDefault(); close() }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
          items[next]?.focus()
        }
        if (event.key === 'Tab') close()
      }}>{views.slice(3).map(option => { const Icon = option.icon; return <button key={option.id} type="button" role="menuitemradio" aria-checked={active && value === option.id} onClick={() => { onChange(option.id); close() }} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-slate-700 hover:bg-slate-50 focus-visible:bg-emerald-50 focus-visible:outline-none"><Icon className="h-4 w-4 text-slate-500" /><span className="flex-1">{option.label}</span>{active && value === option.id && <Check className="h-4 w-4 text-emerald-600" />}</button> })}</div>
    </>, document.body)}
  </div>
}
