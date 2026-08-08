'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, Globe2, Trash2 } from 'lucide-react'
import { OPERATIONAL_OVERLAY_LAYERS } from '../operational-overlay/operationalOverlayLayers'
import {
  operationalDateDayKey,
  operationalDateLocalValue,
  operationalDatePickerGeometry,
  operationalDateQuickValue,
  operationalDateValue,
  operationalDateWithinRange,
  type OperationalDatePickerGeometry,
  type OperationalDatePickerMode,
} from './operationalDate'

export interface OperationalDatePickerProps {
  mode: OperationalDatePickerMode
  value: string
  onChange: (value: string) => void
  onCommit?: (value: string) => void
  label: string
  placeholder?: string
  disabled?: boolean
  allDay?: boolean
  onAllDayChange?: (value: boolean) => void
  min?: string
  max?: string
  allowClear?: boolean
  showQuickValues?: boolean
  className?: string
}

const weekdays = ['L', 'M', 'X', 'J', 'V', 'S', 'D']
const months = Array.from({ length: 12 }, (_, month) => new Date(2020, month, 1).toLocaleDateString('es-PE', { month: 'short' }).replace('.', ''))

function sameDay(left: Date, right: Date) {
  return operationalDateDayKey(left) === operationalDateDayKey(right)
}

function monthCursor(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function calendarDays(cursor: Date) {
  const first = monthCursor(cursor)
  const start = new Date(first)
  start.setDate(1 - ((first.getDay() + 6) % 7))
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
}

function safeInitialDate(value: string, mode: OperationalDatePickerMode, min?: string, max?: string) {
  const parsed = operationalDateValue(value, mode)
  if (parsed) return parsed
  const now = new Date()
  if (operationalDateWithinRange(now, min, max)) return now
  return operationalDateValue(min, 'date') || operationalDateValue(max, 'date') || now
}

function localizedValue(value: Date | null, mode: OperationalDatePickerMode, allDay: boolean) {
  if (!value) return ''
  if (mode === 'date') return value.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' })
  return value.toLocaleString('es-PE', allDay ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' })
}

const initialGeometry: OperationalDatePickerGeometry = { left: 12, top: 12, width: 324, maxHeight: 600, placement: 'below' }

export default function OperationalDatePicker({
  mode,
  value,
  onChange,
  onCommit,
  label,
  placeholder = 'Sin fecha',
  disabled = false,
  allDay = false,
  onAllDayChange,
  min,
  max,
  allowClear = true,
  showQuickValues = mode === 'datetime',
  className = '',
}: OperationalDatePickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const yearInputRef = useRef<HTMLInputElement>(null)
  const dayRefs = useRef(new Map<string, HTMLButtonElement>())
  const [open, setOpen] = useState(false)
  const [monthYearOpen, setMonthYearOpen] = useState(false)
  const [draft, setDraft] = useState(() => safeInitialDate(value, mode, min, max))
  const [focusedDay, setFocusedDay] = useState(() => safeInitialDate(value, mode, min, max))
  const [cursor, setCursor] = useState(() => monthCursor(safeInitialDate(value, mode, min, max)))
  const [geometry, setGeometry] = useState(initialGeometry)
  const days = useMemo(() => calendarDays(cursor), [cursor])
  const display = operationalDateValue(value, mode)

  const resetDraft = useCallback(() => {
    const next = safeInitialDate(value, mode, min, max)
    setDraft(next)
    setFocusedDay(next)
    setCursor(monthCursor(next))
    setMonthYearOpen(false)
  }, [max, min, mode, value])

  useEffect(() => {
    if (open) return
    resetDraft()
  }, [open, resetDraft])

  const restoreTriggerFocus = useCallback(() => {
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }, [])

  const closeWithoutCommit = useCallback(() => {
    setOpen(false)
    resetDraft()
    restoreTriggerFocus()
  }, [resetDraft, restoreTriggerFocus])

  const commit = useCallback((date: Date | null) => {
    const next = operationalDateLocalValue(date, mode)
    onChange(next)
    onCommit?.(next)
    setOpen(false)
    restoreTriggerFocus()
  }, [mode, onChange, onCommit, restoreTriggerFocus])

  const updateGeometry = useCallback(() => {
    if (!open || !triggerRef.current || typeof window === 'undefined') return
    const trigger = triggerRef.current.getBoundingClientRect()
    const viewport = window.visualViewport
    const panelHeight = panelRef.current?.offsetHeight || (mode === 'date' ? 430 : 560)
    setGeometry(operationalDatePickerGeometry(
      trigger,
      {
        left: viewport?.offsetLeft || 0,
        top: viewport?.offsetTop || 0,
        width: viewport?.width || window.innerWidth,
        height: viewport?.height || window.innerHeight,
      },
      { width: 324, height: panelHeight },
    ))
  }, [mode, open])

  useLayoutEffect(() => {
    if (!open) return
    updateGeometry()
    const frame = requestAnimationFrame(updateGeometry)
    return () => cancelAnimationFrame(frame)
  }, [cursor, monthYearOpen, open, updateGeometry])

  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(updateGeometry)
    }
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [open, updateGeometry])

  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeWithoutCommit()
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [closeWithoutCommit, open])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      if (monthYearOpen) yearInputRef.current?.focus({ preventScroll: true })
      else dayRefs.current.get(operationalDateDayKey(focusedDay))?.focus({ preventScroll: true }) || panelRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [cursor, focusedDay, monthYearOpen, open])

  const openPicker = () => {
    if (disabled) return
    if (open) return closeWithoutCommit()
    resetDraft()
    setOpen(true)
  }

  const chooseDay = (date: Date) => {
    if (!operationalDateWithinRange(date, min, max)) return
    const next = new Date(date)
    if (mode === 'datetime') next.setHours(draft.getHours(), draft.getMinutes(), 0, 0)
    else next.setHours(0, 0, 0, 0)
    setDraft(next)
    setFocusedDay(next)
  }

  const chooseQuick = (kind: 'today' | 'tomorrow' | 'next_week') => {
    const next = operationalDateQuickValue(kind)
    next.setHours(draft.getHours(), draft.getMinutes(), 0, 0)
    if (!operationalDateWithinRange(next, min, max)) return
    setDraft(next)
    setFocusedDay(next)
    setCursor(monthCursor(next))
  }

  const moveFocusedDay = (next: Date) => {
    if (!operationalDateWithinRange(next, min, max)) return
    setFocusedDay(next)
    if (next.getMonth() !== cursor.getMonth() || next.getFullYear() !== cursor.getFullYear()) setCursor(monthCursor(next))
  }

  const handleDayKey = (event: ReactKeyboardEvent<HTMLButtonElement>, date: Date) => {
    const next = new Date(date)
    if (event.key === 'ArrowLeft') next.setDate(next.getDate() - 1)
    else if (event.key === 'ArrowRight') next.setDate(next.getDate() + 1)
    else if (event.key === 'ArrowUp') next.setDate(next.getDate() - 7)
    else if (event.key === 'ArrowDown') next.setDate(next.getDate() + 7)
    else if (event.key === 'Home') next.setDate(next.getDate() - ((next.getDay() + 6) % 7))
    else if (event.key === 'End') next.setDate(next.getDate() + (6 - ((next.getDay() + 6) % 7)))
    else if (event.key === 'PageUp') next.setMonth(next.getMonth() - (event.shiftKey ? 12 : 1))
    else if (event.key === 'PageDown') next.setMonth(next.getMonth() + (event.shiftKey ? 12 : 1))
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      chooseDay(date)
      return
    } else return
    event.preventDefault()
    moveFocusedDay(next)
  }

  const selectMonth = (month: number) => {
    const year = cursor.getFullYear()
    const next = new Date(year, month, Math.min(focusedDay.getDate(), new Date(year, month + 1, 0).getDate()))
    setCursor(new Date(year, month, 1))
    setFocusedDay(next)
    setMonthYearOpen(false)
  }

  const displayText = localizedValue(display, mode, allDay)
  const triggerSubtitle = mode === 'date'
    ? 'Fecha sin hora'
    : allDay ? 'Todo el día' : Intl.DateTimeFormat().resolvedOptions().timeZone

  return <>
    <button
      ref={triggerRef}
      type="button"
      disabled={disabled}
      aria-label={`${label}: ${displayText || placeholder}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={openPicker}
      data-operational-date-trigger
      className={`flex min-h-11 w-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 text-left outline-none transition hover:border-emerald-300 focus-visible:ring-4 focus-visible:ring-emerald-100 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600"><CalendarDays className="h-4 w-4" /></span>
      <span className="min-w-0 flex-1"><span className={`block truncate text-sm font-semibold ${displayText ? 'text-slate-700' : 'text-slate-400'}`}>{displayText || placeholder}</span><span className="block truncate text-[10px] font-medium text-slate-400">{label} · {triggerSubtitle}</span></span>
      <ChevronRight className={`h-4 w-4 shrink-0 text-slate-400 transition motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
    </button>

    {open && typeof document !== 'undefined' && createPortal(<>
      <button
        type="button"
        aria-label={`Cerrar ${label}`}
        data-operational-picker-backdrop
        className="fixed inset-0 cursor-default"
        style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.pickerBackdrop }}
        onMouseDown={event => { event.preventDefault(); closeWithoutCommit() }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={`Elegir ${label}`}
        tabIndex={-1}
        data-operational-date-picker
        data-placement={geometry.placement}
        style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.picker, left: geometry.left, top: geometry.top, width: geometry.width, maxHeight: geometry.maxHeight }}
        className="fixed overflow-y-auto overscroll-contain rounded-3xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20 outline-none"
      >
        <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-3">
          <button type="button" aria-label="Mes anterior" onClick={() => setCursor(current => new Date(current.getFullYear(), current.getMonth() - 1, 1))} className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" aria-expanded={monthYearOpen} aria-label="Elegir mes y año" onClick={() => setMonthYearOpen(current => !current)} className="flex min-h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl px-2 text-sm font-black capitalize text-slate-800 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">{cursor.toLocaleDateString('es-PE', { month: 'long', year: 'numeric' })}<ChevronDown className={`h-3.5 w-3.5 text-slate-400 transition motion-reduce:transition-none ${monthYearOpen ? 'rotate-180' : ''}`} /></button>
          <button type="button" aria-label="Mes siguiente" onClick={() => setCursor(current => new Date(current.getFullYear(), current.getMonth() + 1, 1))} className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><ChevronRight className="h-4 w-4" /></button>
        </div>

        {monthYearOpen ? (
          <div className="p-3">
            <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400">Año
              <input
                ref={yearInputRef}
                aria-label="Año"
                type="number"
                inputMode="numeric"
                min={1}
                max={9999}
                value={cursor.getFullYear()}
                onChange={event => {
                  const year = Number(event.target.value)
                  if (!Number.isInteger(year) || year < 1 || year > 9999) return
                  setCursor(current => new Date(year, current.getMonth(), 1))
                }}
                className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-center text-base font-bold text-slate-800 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
              />
            </label>
            <div className="mt-3 grid grid-cols-3 gap-2" aria-label="Meses">
              {months.map((month, index) => <button key={month} type="button" aria-pressed={cursor.getMonth() === index} onClick={() => selectMonth(index)} className={`min-h-11 rounded-xl px-2 text-xs font-bold capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${cursor.getMonth() === index ? 'bg-emerald-600 text-white shadow-md shadow-emerald-100' : 'bg-slate-50 text-slate-600 hover:bg-emerald-50 hover:text-emerald-700'}`}>{month}</button>)}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-7 px-3 pt-3" role="grid" aria-label={`Calendario de ${cursor.toLocaleDateString('es-PE', { month: 'long', year: 'numeric' })}`}>
            {weekdays.map(day => <span key={day} role="columnheader" className="py-1 text-center text-[9px] font-black text-slate-400">{day}</span>)}
            {days.map(day => {
              const selected = sameDay(day, draft)
              const focused = sameDay(day, focusedDay)
              const outside = day.getMonth() !== cursor.getMonth()
              const enabled = operationalDateWithinRange(day, min, max)
              const key = operationalDateDayKey(day)
              return <button
                key={key}
                ref={node => { if (node) dayRefs.current.set(key, node); else dayRefs.current.delete(key) }}
                type="button"
                role="gridcell"
                aria-label={day.toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                aria-pressed={selected}
                aria-current={sameDay(day, new Date()) ? 'date' : undefined}
                disabled={!enabled}
                tabIndex={focused ? 0 : -1}
                data-date-key={key}
                onFocus={() => setFocusedDay(day)}
                onKeyDown={event => handleDayKey(event, day)}
                onClick={() => chooseDay(day)}
                className={`mx-auto my-0.5 flex h-9 w-9 items-center justify-center rounded-xl text-[11px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-1 disabled:opacity-20 ${selected ? 'bg-emerald-600 text-white shadow-md shadow-emerald-200' : outside ? 'text-slate-300 hover:bg-slate-50' : 'text-slate-600 hover:bg-emerald-50 hover:text-emerald-700'}`}
              >{day.getDate()}</button>
            })}
          </div>
        )}

        {showQuickValues && !monthYearOpen && <div className="mx-3 mt-2 flex gap-1.5">{([['today', 'Hoy'], ['tomorrow', 'Mañana'], ['next_week', 'Próxima semana']] as const).map(([kind, text]) => <button key={kind} type="button" onClick={() => chooseQuick(kind)} className="min-h-10 flex-1 rounded-xl bg-slate-50 px-2 py-2 text-[10px] font-bold text-slate-600 hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">{text}</button>)}</div>}

        {mode === 'datetime' && !monthYearOpen && <div className="m-3 rounded-2xl border border-slate-200 p-3"><div className="flex items-center gap-2"><Clock3 className="h-4 w-4 text-slate-400" /><input aria-label="Hora" type="time" disabled={allDay} value={`${String(draft.getHours()).padStart(2, '0')}:${String(draft.getMinutes()).padStart(2, '0')}`} onChange={event => { const [hours, minutes] = event.target.value.split(':').map(Number); const next = new Date(draft); next.setHours(hours, minutes, 0, 0); setDraft(next) }} className="min-w-0 flex-1 rounded-lg border-0 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 outline-none disabled:opacity-40" /><button type="button" onClick={() => onAllDayChange?.(!allDay)} disabled={!onAllDayChange} className={`min-h-10 rounded-lg px-2.5 py-2 text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-50 ${allDay ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>Todo el día</button></div><p className="mt-2 flex items-center gap-1 text-[9px] text-slate-400"><Globe2 className="h-3 w-3" />{Intl.DateTimeFormat().resolvedOptions().timeZone}</p></div>}

        <div className="sticky bottom-0 flex items-center gap-2 border-t border-slate-100 bg-slate-50/95 px-3 py-3 backdrop-blur">
          {allowClear && <button type="button" disabled={!value} onClick={() => commit(null)} className="flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-rose-600 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:cursor-not-allowed disabled:opacity-35"><Trash2 className="h-3.5 w-3.5" />Quitar</button>}
          <button type="button" disabled={!operationalDateWithinRange(draft, min, max)} onClick={() => commit(draft)} className="ml-auto flex min-h-10 items-center gap-1.5 rounded-xl bg-emerald-600 px-4 text-xs font-black text-white shadow-lg shadow-emerald-100 hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:opacity-40"><Check className="h-4 w-4" />Aplicar</button>
        </div>
      </div>
    </>, document.body)}
  </>
}

export type { OperationalDatePickerMode }
