'use client'

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownAZ, ArrowUpAZ, Check, ChevronDown, Layers3 } from 'lucide-react'
import type { TaskGroupBy, TaskGroupDirection } from '@/types/task'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import {
  TASK_GROUP_LABELS,
  taskGroupingTriggerText,
  type TaskWorkspaceChromeDensity,
} from './taskWorkspaceChrome'

const GROUP_OPTIONS: Array<{ value: TaskGroupBy; description: string }> = [
  { value: 'none', description: 'Mantiene un orden manual continuo.' },
  { value: 'status', description: 'Separa las tareas por estado.' },
  { value: 'list', description: 'Organiza por lista de origen.' },
  { value: 'assignee', description: 'Agrupa por responsable.' },
  { value: 'priority', description: 'Ordena por nivel de prioridad.' },
  { value: 'type', description: 'Agrupa por tipo de tarea.' },
  { value: 'due', description: 'Separa por fecha de vencimiento.' },
]

interface Props {
  groupBy: TaskGroupBy
  direction: TaskGroupDirection
  collapsedGroupKeys: string[]
  density: TaskWorkspaceChromeDensity
  onChange: (groupBy: TaskGroupBy, direction: TaskGroupDirection, collapsedGroupKeys: string[]) => void
}

export default function TaskListGroupingControl({ groupBy, direction, collapsedGroupKeys, density, onChange }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties>({})
  const label = TASK_GROUP_LABELS[groupBy]
  const triggerText = taskGroupingTriggerText(groupBy, density)

  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }, [])

  useEffect(() => {
    if (!open) return
    const position = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(320, window.innerWidth - 24)
      const roomBelow = window.innerHeight - rect.bottom - 12
      const roomAbove = rect.top - 12
      const placeAbove = roomBelow < 360 && roomAbove > roomBelow
      const maxHeight = Math.max(220, Math.min(430, placeAbove ? roomAbove - 6 : roomBelow - 6))
      setStyle({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        width,
        maxHeight,
        ...(placeAbove ? { bottom: window.innerHeight - rect.top + 7, top: undefined } : { top: rect.bottom + 7, bottom: undefined }),
      })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLButtonElement>(`[data-group-value="${groupBy}"]`)?.focus({ preventScroll: true }))
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [groupBy, open])

  const moveOptionFocus = (event: React.KeyboardEvent<HTMLDivElement>, delta: number) => {
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-group-value]'))
    if (!options.length) return
    const current = options.indexOf(document.activeElement as HTMLButtonElement)
    const next = current < 0 ? 0 : (current + delta + options.length) % options.length
    options[next]?.focus()
  }

  return <>
    <button
      ref={triggerRef}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`Agrupar tareas: ${label}`}
      title={`Agrupar tareas: ${label}`}
      onClick={() => setOpen(value => !value)}
      className={`relative inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white text-xs font-semibold text-slate-600 outline-none transition hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 focus:ring-4 focus:ring-emerald-100 ${density === 'narrow' ? 'w-11 px-0' : 'max-w-48 px-3'}`}
    >
      <Layers3 className="h-3.5 w-3.5 shrink-0" />
      {triggerText && <span className="truncate">{triggerText}</span>}
      {density !== 'narrow' && <ChevronDown className={`h-3 w-3 shrink-0 text-slate-400 transition motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />}
      {density === 'narrow' && groupBy !== 'none' && <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-white" />}
    </button>

    {open && typeof document !== 'undefined' && createPortal(<>
      <button
        type="button"
        aria-label="Cerrar agrupación"
        className="fixed inset-0 cursor-default"
        style={{ zIndex: TASK_OVERLAY_LAYERS.workspacePopover - 1 }}
        onMouseDown={() => close()}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Configurar agrupación"
        style={{ ...style, zIndex: TASK_OVERLAY_LAYERS.workspacePopover }}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
          if (event.key === 'ArrowDown') { event.preventDefault(); moveOptionFocus(event, 1); return }
          if (event.key === 'ArrowUp') { event.preventDefault(); moveOptionFocus(event, -1); return }
          if (event.key === 'Home') { event.preventDefault(); panelRef.current?.querySelector<HTMLButtonElement>('[data-group-value]')?.focus(); return }
          if (event.key === 'End') {
            event.preventDefault()
            const options = panelRef.current?.querySelectorAll<HTMLButtonElement>('[data-group-value]')
            options?.[options.length - 1]?.focus()
          }
        }}
        className="fixed flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20 ring-1 ring-slate-900/5"
      >
        <div className="shrink-0 border-b border-slate-100 px-4 py-3">
          <p className="text-[10px] font-black uppercase tracking-[.14em] text-emerald-600">Organización de Lista</p>
          <p className="mt-0.5 text-sm font-bold text-slate-900">Agrupar tareas</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {GROUP_OPTIONS.map(option => {
            const selected = option.value === groupBy
            return <button
              key={option.value}
              type="button"
              data-group-value={option.value}
              aria-pressed={selected}
              onClick={() => onChange(option.value, direction, option.value === groupBy ? collapsedGroupKeys : [])}
              className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition hover:bg-slate-50 focus:bg-emerald-50 focus:ring-2 focus:ring-inset focus:ring-emerald-300 ${selected ? 'bg-emerald-50/80' : ''}`}
            >
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${selected ? 'bg-white text-emerald-700 shadow-sm' : 'bg-slate-50 text-slate-400'}`}><Layers3 className="h-4 w-4" /></span>
              <span className="min-w-0 flex-1"><span className={`block text-sm font-semibold ${selected ? 'text-emerald-800' : 'text-slate-700'}`}>{TASK_GROUP_LABELS[option.value]}</span><span className="block truncate text-[10px] text-slate-400">{option.description}</span></span>
              {selected && <Check className="h-4 w-4 shrink-0 text-emerald-600" />}
            </button>
          })}
        </div>
        <div className="shrink-0 border-t border-slate-100 bg-slate-50/80 p-2.5">
          <p className="mb-2 px-1 text-[9px] font-black uppercase tracking-[.14em] text-slate-400">Dirección</p>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-200/70 p-1" role="group" aria-label="Dirección de agrupación">
            <button type="button" aria-pressed={direction === 'asc'} onClick={() => onChange(groupBy, 'asc', collapsedGroupKeys)} className={`flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-bold transition ${direction === 'asc' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><ArrowDownAZ className="h-3.5 w-3.5" />Ascendente</button>
            <button type="button" aria-pressed={direction === 'desc'} onClick={() => onChange(groupBy, 'desc', collapsedGroupKeys)} className={`flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-bold transition ${direction === 'desc' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><ArrowUpAZ className="h-3.5 w-3.5" />Descendente</button>
          </div>
        </div>
      </div>
    </>, document.body)}
  </>
}
