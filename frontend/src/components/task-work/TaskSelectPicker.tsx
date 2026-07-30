'use client'

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import type { TaskFolder, TaskList } from '@/types/task'
import { TaskContainerIcon } from './TaskContainerAppearance'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'

export interface TaskSelectOption {
  value: string
  label: string
  description?: string
  group?: string
  leading?: ReactNode
  badge?: string
  disabled?: boolean
}

function pickerPosition(open: boolean, triggerRef: React.RefObject<HTMLButtonElement>) {
  const [style, setStyle] = useState<CSSProperties>({})
  useEffect(() => {
    if (!open) return
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(Math.max(280, rect.width), window.innerWidth - 24)
      const roomBelow = window.innerHeight - rect.bottom
      const above = roomBelow < 320 && rect.top > roomBelow
      setStyle({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width, maxHeight: Math.min(360, Math.max(180, above ? rect.top - 18 : roomBelow - 18)), ...(above ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [open, triggerRef])
  return style
}

export function TaskSelectPicker({ value, options, onChange, placeholder = 'Selecciona una opción', label = 'Seleccionar opción', searchable = false, disabled = false, className = '' }: {
  value: string
  options: TaskSelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  label?: string
  searchable?: boolean
  disabled?: boolean
  className?: string
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const selected = options.find(option => option.value === value)
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('es')
    return options.filter(option => !needle || `${option.label} ${option.description || ''} ${option.group || ''}`.toLocaleLowerCase('es').includes(needle))
  }, [options, query])
  const style = pickerPosition(open, triggerRef)
  useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlighted(Math.max(0, options.findIndex(option => option.value === value)))
    if (!searchable) requestAnimationFrame(() => listRef.current?.focus())
  }, [open, options, searchable, value])
  const close = () => { setOpen(false); requestAnimationFrame(() => triggerRef.current?.focus()) }
  const choose = (option: TaskSelectOption) => { if (!option.disabled) onChange(option.value); close() }
  const move = (delta: number) => setHighlighted(current => Math.max(0, Math.min(visible.length - 1, current + delta)))
  let previousGroup = ''
  return <>
    <button ref={triggerRef} type="button" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(current => !current)} className={`flex min-h-11 w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-sm outline-none transition hover:border-slate-300 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 disabled:opacity-50 ${className}`}><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-slate-500">{selected?.leading || <Search className="h-3.5 w-3.5" />}</span><span className="min-w-0 flex-1"><span className={`block truncate font-semibold ${selected ? 'text-slate-700' : 'text-slate-400'}`}>{selected?.label || placeholder}</span>{selected?.description && <span className="block truncate text-[10px] text-slate-400">{selected.description}</span>}</span>{selected?.badge && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-bold text-slate-500">{selected.badge}</span>}<ChevronDown className={`h-4 w-4 text-slate-400 transition ${open ? 'rotate-180' : ''}`} /></button>
    {open && typeof document !== 'undefined' && createPortal(<><button type="button" aria-label={`Cerrar ${label}`} data-task-picker-backdrop className="fixed inset-0 cursor-default" style={{ zIndex: TASK_OVERLAY_LAYERS.pickerBackdrop }} onMouseDown={close} /><div ref={listRef} data-task-select-picker-portal role="listbox" aria-label={label} tabIndex={-1} style={{ ...style, zIndex: TASK_OVERLAY_LAYERS.picker }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close() }; if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }; if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }; if (event.key === 'Enter' && visible[highlighted]) { event.preventDefault(); choose(visible[highlighted]) } }} className="fixed flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-900/15 outline-none">{searchable && <div className="mb-1 flex items-center gap-2 rounded-xl bg-slate-50 px-3"><Search className="h-4 w-4 text-slate-400" /><input autoFocus value={query} onChange={event => { setQuery(event.target.value); setHighlighted(0) }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }; if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }; if (event.key === 'Enter' && visible[highlighted]) { event.preventDefault(); choose(visible[highlighted]) }; if (event.key === 'Escape') { event.preventDefault(); close() } }} placeholder="Buscar…" className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none" />{query && <button type="button" onClick={() => setQuery('')} className="text-slate-400"><X className="h-3.5 w-3.5" /></button>}</div>}<div className="min-h-0 overflow-y-auto">{visible.map((option, index) => { const showGroup = Boolean(option.group && option.group !== previousGroup); previousGroup = option.group || previousGroup; return <div key={option.value}>{showGroup && <div className="px-3 pb-1 pt-2 text-[9px] font-black uppercase tracking-[0.14em] text-slate-400">{option.group}</div>}<button type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} onMouseEnter={() => setHighlighted(index)} onClick={() => choose(option)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left disabled:opacity-40 ${highlighted === index ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white text-slate-500 shadow-sm">{option.leading}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-700">{option.label}</span>{option.description && <span className="block truncate text-[10px] text-slate-400">{option.description}</span>}</span>{option.badge && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-bold text-slate-500">{option.badge}</span>}{option.value === value && <Check className="h-4 w-4 text-emerald-600" />}</button></div>})}{!visible.length && <div className="p-6 text-center text-xs text-slate-400">Sin resultados</div>}</div></div></>, document.body)}
  </>
}

export function TaskListPicker({ value, lists, folders, onChange, disabled, className }: { value: string; lists: TaskList[]; folders?: TaskFolder[]; onChange: (value: string) => void; disabled?: boolean; className?: string }) {
  const folderByID = new Map((folders || []).map(folder => [folder.id, folder]))
  const options = [...lists].sort((a, b) => Number(Boolean(b.is_default)) - Number(Boolean(a.is_default)) || a.sort_order - b.sort_order).map(list => {
    const folder = list.folder_id ? folderByID.get(list.folder_id) : undefined
    return { value: list.id, label: list.name, group: list.is_default ? 'Bandeja general' : folder ? folder.name : 'Listas independientes', description: folder ? `${folder.name} / ${list.name}` : list.is_default ? 'Lista fija de la cuenta' : 'Nivel principal', leading: <span style={{ color: list.color }}><TaskContainerIcon value={list.icon || (list.is_default ? 'inbox' : 'list')} className="h-4 w-4" /></span>, badge: list.is_default ? 'BASE' : undefined }
  })
  return <TaskSelectPicker value={value} options={options} onChange={onChange} placeholder="Selecciona una lista" label="Seleccionar lista" searchable disabled={disabled} className={className} />
}
