'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Globe2, Trash2 } from 'lucide-react'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import { taskDateLocalValue, taskDateQuickValue, taskDateValue } from './taskDateTime'

interface Props {
  value: string
  onChange: (value: string) => void
  onCommit?: (value: string) => void
  label: string
  disabled?: boolean
  allDay?: boolean
  onAllDayChange?: (value: boolean) => void
  min?: string
  className?: string
}

const weekdays = ['L', 'M', 'X', 'J', 'V', 'S', 'D']

export default function TaskDateTimePicker({ value, onChange, onCommit, label, disabled, allDay = false, onAllDayChange, min, className = '' }: Props) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const initial = taskDateValue(value) || new Date()
  const [cursor, setCursor] = useState(() => new Date(initial.getFullYear(), initial.getMonth(), 1))
  const [draft, setDraft] = useState(() => taskDateValue(value) || new Date())
  useEffect(() => {
    const next = taskDateValue(value)
    if (!next) return
    setDraft(next)
    setCursor(new Date(next.getFullYear(), next.getMonth(), 1))
  }, [value])
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      buttonRef.current?.focus()
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])
  const days = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
    const start = new Date(first)
    start.setDate(1 - ((first.getDay() + 6) % 7))
    return Array.from({ length: 42 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); return date })
  }, [cursor])
  const commit = (date: Date | null) => {
    const next = taskDateLocalValue(date)
    onChange(next)
    onCommit?.(next)
    setOpen(false)
    requestAnimationFrame(() => buttonRef.current?.focus())
  }
  const chooseDay = (date: Date) => {
    const next = new Date(date)
    next.setHours(draft.getHours(), draft.getMinutes(), 0, 0)
    setDraft(next)
  }
  const chooseQuick = (kind: 'today' | 'tomorrow' | 'next_week') => {
    const next = taskDateQuickValue(kind)
    next.setHours(draft.getHours(), draft.getMinutes(), 0, 0)
    setDraft(next)
    setCursor(new Date(next.getFullYear(), next.getMonth(), 1))
  }
  const display = taskDateValue(value)
  return <>
    <button ref={buttonRef} type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(current => !current)} className={`flex min-h-11 w-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 text-left outline-none transition hover:border-emerald-300 focus:ring-4 focus:ring-emerald-100 disabled:opacity-50 ${className}`}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600"><CalendarDays className="h-4 w-4" /></span>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-700">{display ? display.toLocaleString('es', allDay ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' }) : 'Sin fecha'}</span><span className="block truncate text-[10px] font-medium text-slate-400">{label} · {allDay ? 'Todo el día' : Intl.DateTimeFormat().resolvedOptions().timeZone}</span></span>
      <ChevronRight className={`h-4 w-4 text-slate-400 transition ${open ? 'rotate-90' : ''}`} />
    </button>
    {open && typeof document !== 'undefined' && createPortal(<><button type="button" aria-label={`Cerrar ${label}`} onMouseDown={() => setOpen(false)} className="fixed inset-0 cursor-default" style={{ zIndex: TASK_OVERLAY_LAYERS.pickerBackdrop }} /><div role="dialog" aria-label={`Elegir ${label}`} style={{ zIndex: TASK_OVERLAY_LAYERS.picker, left: Math.max(12, Math.min(window.innerWidth - 336, buttonRef.current?.getBoundingClientRect().left || 12)), top: Math.min(window.innerHeight - 472, (buttonRef.current?.getBoundingClientRect().bottom || 60) + 8) }} className="fixed w-[324px] overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20">
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-3"><button type="button" onClick={() => setCursor(current => new Date(current.getFullYear(), current.getMonth() - 1, 1))} className="rounded-xl p-2 text-slate-500 hover:bg-slate-100"><ChevronLeft className="h-4 w-4" /></button><p className="min-w-0 flex-1 text-center text-sm font-black capitalize text-slate-800">{cursor.toLocaleDateString('es', { month: 'long', year: 'numeric' })}</p><button type="button" onClick={() => setCursor(current => new Date(current.getFullYear(), current.getMonth() + 1, 1))} className="rounded-xl p-2 text-slate-500 hover:bg-slate-100"><ChevronRight className="h-4 w-4" /></button></div>
      <div className="grid grid-cols-7 px-3 pt-3">{weekdays.map(day => <span key={day} className="py-1 text-center text-[9px] font-black text-slate-400">{day}</span>)}{days.map(day => { const selected = day.toDateString() === draft.toDateString(); const outside = day.getMonth() !== cursor.getMonth(); const tooEarly = Boolean(min && taskDateValue(min) && day < new Date(new Date(min).setHours(0, 0, 0, 0))); return <button key={day.toISOString()} type="button" disabled={tooEarly} onClick={() => chooseDay(day)} className={`mx-auto my-0.5 flex h-8 w-8 items-center justify-center rounded-xl text-[11px] font-bold transition disabled:opacity-20 ${selected ? 'bg-emerald-600 text-white shadow-md shadow-emerald-200' : outside ? 'text-slate-300 hover:bg-slate-50' : 'text-slate-600 hover:bg-emerald-50 hover:text-emerald-700'}`}>{day.getDate()}</button> })}</div>
      <div className="mx-3 mt-2 flex gap-1.5">{([['today','Hoy'],['tomorrow','Mañana'],['next_week','Próxima semana']] as const).map(([kind,text]) => <button key={kind} type="button" onClick={() => chooseQuick(kind)} className="flex-1 rounded-xl bg-slate-50 px-2 py-2 text-[10px] font-bold text-slate-600 hover:bg-emerald-50 hover:text-emerald-700">{text}</button>)}</div>
      <div className="m-3 rounded-2xl border border-slate-200 p-3"><div className="flex items-center gap-2"><Clock3 className="h-4 w-4 text-slate-400" /><input aria-label="Hora" type="time" disabled={allDay} value={`${String(draft.getHours()).padStart(2,'0')}:${String(draft.getMinutes()).padStart(2,'0')}`} onChange={event => { const [hours, minutes] = event.target.value.split(':').map(Number); const next = new Date(draft); next.setHours(hours, minutes, 0, 0); setDraft(next) }} className="min-w-0 flex-1 rounded-lg border-0 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 outline-none disabled:opacity-40" /><button type="button" onClick={() => onAllDayChange?.(!allDay)} className={`rounded-lg px-2.5 py-2 text-[10px] font-bold ${allDay ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>Todo el día</button></div><p className="mt-2 flex items-center gap-1 text-[9px] text-slate-400"><Globe2 className="h-3 w-3" />{Intl.DateTimeFormat().resolvedOptions().timeZone}</p></div>
      <div className="flex items-center gap-2 border-t border-slate-100 bg-slate-50/70 px-3 py-3"><button type="button" onClick={() => commit(null)} className="flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-rose-600 hover:bg-rose-50"><Trash2 className="h-3.5 w-3.5" />Quitar</button><button type="button" onClick={() => commit(draft)} className="ml-auto flex min-h-10 items-center gap-1.5 rounded-xl bg-emerald-600 px-4 text-xs font-black text-white shadow-lg shadow-emerald-100 hover:bg-emerald-700"><Check className="h-4 w-4" />Aplicar</button></div>
    </div></>, document.body)}
  </>
}
