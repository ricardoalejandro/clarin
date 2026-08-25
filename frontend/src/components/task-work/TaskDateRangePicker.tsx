'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Globe2,
  Loader2,
  Trash2,
  X,
} from 'lucide-react'
import {
  operationalDateDayKey,
  operationalDateLocalValue,
  operationalDatePickerGeometry,
  operationalDateQuickValue,
  operationalDateValue,
  type OperationalDatePickerGeometry,
} from '../operational-date/operationalDate'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'

export interface TaskDateRangeValue {
  startAt: string
  endAt: string
  isAllDay: boolean
}

export interface TaskDateRangePickerProps {
  label: string
  startValue: string
  endValue: string
  allDay: boolean
  disabled?: boolean
  pending?: boolean
  compact?: boolean
  onApply: (value: TaskDateRangeValue) => void
}

type RangeEndpoint = 'start' | 'end'

const weekdays = ['L', 'M', 'X', 'J', 'V', 'S', 'D']
const months = Array.from({ length: 12 }, (_, month) => new Date(2020, month, 1)
  .toLocaleDateString('es-PE', { month: 'short' })
  .replace('.', ''))

const initialGeometry: OperationalDatePickerGeometry = {
  left: 12,
  top: 12,
  width: 680,
  maxHeight: 720,
  placement: 'below',
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

function parsedDate(value: string) {
  return operationalDateValue(value, 'datetime')
}

function rangeAnchor(endpoint: RangeEndpoint, startValue: string, endValue: string) {
  return parsedDate(endpoint === 'start' ? startValue : endValue)
    || parsedDate(endpoint === 'start' ? endValue : startValue)
    || new Date()
}

function localizedEndpoint(value: string, allDay: boolean) {
  const date = parsedDate(value)
  if (!date) return value ? 'Fecha no válida' : 'Sin fecha'
  return date.toLocaleString('es-PE', allDay
    ? { dateStyle: 'medium' }
    : { dateStyle: 'medium', timeStyle: 'short' })
}

export function taskDateRangeSummary(startValue: string, endValue: string, allDay: boolean) {
  const start = startValue ? localizedEndpoint(startValue, allDay) : ''
  const end = endValue ? localizedEndpoint(endValue, allDay) : ''
  if (start && end) return `${start} → ${end}`
  if (start) return `Desde ${start}`
  if (end) return `Hasta ${end}`
  return 'Agregar fechas'
}

export function taskDateRangeIsValid(startValue: string, endValue: string, allDay: boolean) {
  const start = startValue ? parsedDate(startValue) : null
  const end = endValue ? parsedDate(endValue) : null
  if ((startValue && !start) || (endValue && !end)) return false
  if (!start || !end) return true
  if (allDay) return operationalDateDayKey(end) >= operationalDateDayKey(start)
  return end.getTime() >= start.getTime()
}

export function taskAllDayBoundary(value: string, endpoint: RangeEndpoint) {
  const date = parsedDate(value)
  if (!date) return value
  const normalized = new Date(date)
  if (endpoint === 'start') normalized.setHours(0, 0, 0, 0)
  else normalized.setHours(23, 59, 0, 0)
  return operationalDateLocalValue(normalized, 'datetime')
}

function invalidRangeMessage(startValue: string, endValue: string, allDay: boolean) {
  if (startValue && !parsedDate(startValue)) return 'Revisa la fecha de inicio.'
  if (endValue && !parsedDate(endValue)) return 'Revisa la fecha de entrega.'
  if (!taskDateRangeIsValid(startValue, endValue, allDay)) {
    return 'La entrega no puede ser anterior al inicio.'
  }
  return ''
}

function timeValue(value: string) {
  const date = parsedDate(value)
  if (!date) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function replaceDay(value: string, day: Date) {
  const source = parsedDate(value) || new Date()
  return operationalDateLocalValue(new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    source.getHours(),
    source.getMinutes(),
    0,
    0,
  ), 'datetime')
}

function replaceTime(value: string, time: string) {
  const source = parsedDate(value)
  if (!source) return value
  const [hours, minutes] = time.split(':').map(Number)
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return value
  const next = new Date(source)
  next.setHours(hours, minutes, 0, 0)
  return operationalDateLocalValue(next, 'datetime')
}

function EndpointSummary({ value, allDay }: { value: string; allDay: boolean }) {
  return <span className={`block truncate text-xs font-semibold ${value ? 'text-slate-700' : 'text-slate-400'}`}>
    {localizedEndpoint(value, allDay)}
  </span>
}

export default function TaskDateRangePicker({
  label,
  startValue,
  endValue,
  allDay,
  disabled = false,
  pending = false,
  compact = false,
  onApply,
}: TaskDateRangePickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const startEndpointRef = useRef<HTMLButtonElement>(null)
  const endEndpointRef = useRef<HTMLButtonElement>(null)
  const yearInputRef = useRef<HTMLInputElement>(null)
  const dayRefs = useRef(new Map<string, HTMLButtonElement>())
  const [open, setOpen] = useState(false)
  const [activeEndpoint, setActiveEndpoint] = useState<RangeEndpoint>('start')
  const [draftStart, setDraftStart] = useState(startValue)
  const [draftEnd, setDraftEnd] = useState(endValue)
  const [draftAllDay, setDraftAllDay] = useState(allDay)
  const initialAnchor = rangeAnchor(startValue ? 'start' : endValue ? 'end' : 'start', startValue, endValue)
  const [cursor, setCursor] = useState(() => monthCursor(initialAnchor))
  const [focusedDay, setFocusedDay] = useState(initialAnchor)
  const [monthYearOpen, setMonthYearOpen] = useState(false)
  const [geometry, setGeometry] = useState(initialGeometry)

  const days = useMemo(() => calendarDays(cursor), [cursor])
  const summary = taskDateRangeSummary(startValue, endValue, allDay)
  const invalidMessage = invalidRangeMessage(draftStart, draftEnd, draftAllDay)
  const activeValue = activeEndpoint === 'start' ? draftStart : draftEnd
  const startDayKey = parsedDate(draftStart) ? operationalDateDayKey(parsedDate(draftStart) as Date) : ''
  const endDayKey = parsedDate(draftEnd) ? operationalDateDayKey(parsedDate(draftEnd) as Date) : ''

  const resetDraft = useCallback(() => {
    const endpoint: RangeEndpoint = startValue ? 'start' : endValue ? 'end' : 'start'
    const anchor = rangeAnchor(endpoint, startValue, endValue)
    setDraftStart(startValue)
    setDraftEnd(endValue)
    setDraftAllDay(allDay)
    setActiveEndpoint(endpoint)
    setFocusedDay(anchor)
    setCursor(monthCursor(anchor))
    setMonthYearOpen(false)
  }, [allDay, endValue, startValue])

  useEffect(() => {
    if (!open) resetDraft()
  }, [open, resetDraft])

  const restoreTriggerFocus = useCallback(() => {
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }, [])

  const cancel = useCallback(() => {
    setOpen(false)
    resetDraft()
    restoreTriggerFocus()
  }, [resetDraft, restoreTriggerFocus])

  const updateGeometry = useCallback(() => {
    if (!open || !triggerRef.current || typeof window === 'undefined') return
    const viewport = window.visualViewport
    const panelHeight = panelRef.current?.offsetHeight || 650
    setGeometry(operationalDatePickerGeometry(
      triggerRef.current.getBoundingClientRect(),
      {
        left: viewport?.offsetLeft || 0,
        top: viewport?.offsetTop || 0,
        width: viewport?.width || window.innerWidth,
        height: viewport?.height || window.innerHeight,
      },
      { width: 680, height: panelHeight },
    ))
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    updateGeometry()
    const frame = requestAnimationFrame(updateGeometry)
    return () => cancelAnimationFrame(frame)
  }, [activeEndpoint, cursor, draftAllDay, invalidMessage, monthYearOpen, open, updateGeometry])

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
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [cancel, open])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      if (monthYearOpen) yearInputRef.current?.focus({ preventScroll: true })
      else (activeEndpoint === 'start' ? startEndpointRef : endEndpointRef).current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [monthYearOpen, open])

  const openPicker = () => {
    if (disabled || pending) return
    if (open) return cancel()
    resetDraft()
    setOpen(true)
  }

  const activateEndpoint = (endpoint: RangeEndpoint) => {
    const anchor = rangeAnchor(endpoint, draftStart, draftEnd)
    setActiveEndpoint(endpoint)
    setFocusedDay(anchor)
    setCursor(monthCursor(anchor))
    setMonthYearOpen(false)
  }

  const updateActiveValue = (value: string) => {
    if (activeEndpoint === 'start') setDraftStart(value)
    else setDraftEnd(value)
  }

  const chooseDay = (day: Date) => {
    const next = replaceDay(activeValue, day)
    updateActiveValue(next)
    setFocusedDay(day)
  }

  const chooseQuick = (kind: 'today' | 'tomorrow' | 'next_week') => {
    const next = operationalDateQuickValue(kind)
    const value = replaceDay(activeValue, next)
    updateActiveValue(value)
    setFocusedDay(next)
    setCursor(monthCursor(next))
  }

  const moveFocusedDay = (next: Date) => {
    setFocusedDay(next)
    if (next.getMonth() !== cursor.getMonth() || next.getFullYear() !== cursor.getFullYear()) {
      setCursor(monthCursor(next))
    }
    requestAnimationFrame(() => dayRefs.current.get(operationalDateDayKey(next))?.focus({ preventScroll: true }))
  }

  const handleDayKey = (event: ReactKeyboardEvent<HTMLButtonElement>, day: Date) => {
    const next = new Date(day)
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
      chooseDay(day)
      return
    } else return
    event.preventDefault()
    moveFocusedDay(next)
  }

  const selectMonth = (month: number) => {
    const year = cursor.getFullYear()
    const day = Math.min(focusedDay.getDate(), new Date(year, month + 1, 0).getDate())
    const next = new Date(year, month, day)
    setCursor(new Date(year, month, 1))
    setFocusedDay(next)
    setMonthYearOpen(false)
  }

  const apply = () => {
    if (pending || invalidMessage) return
    onApply({
      startAt: draftAllDay ? taskAllDayBoundary(draftStart, 'start') : draftStart,
      endAt: draftAllDay ? taskAllDayBoundary(draftEnd, 'end') : draftEnd,
      isAllDay: draftAllDay,
    })
    setOpen(false)
    restoreTriggerFocus()
  }

  const activeLabel = activeEndpoint === 'start' ? 'Inicio' : 'Entrega'
  const activeHasValue = Boolean(activeValue && parsedDate(activeValue))
  const splitLayout = geometry.width >= 600
  const splitEndpoints = geometry.width >= 500

  return <>
    <button
      ref={triggerRef}
      type="button"
      disabled={disabled || pending}
      aria-label={`${label}: ${summary}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-busy={pending || undefined}
      onClick={openPicker}
      data-task-date-range-trigger
      data-compact={compact || undefined}
      className={`flex w-full items-center rounded-xl border border-slate-200 bg-white text-left outline-none transition hover:border-emerald-300 focus-visible:ring-4 focus-visible:ring-emerald-100 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${compact ? 'min-h-9 gap-2 px-2' : 'min-h-11 gap-3 px-3'}`}
    >
      <span className={`flex shrink-0 items-center justify-center bg-emerald-50 text-emerald-600 ${compact ? 'h-7 w-7 rounded-lg' : 'h-8 w-8 rounded-xl'}`}>
        <CalendarDays className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate font-semibold ${compact ? 'text-xs' : 'text-sm'} ${startValue || endValue ? 'text-slate-700' : 'text-slate-400'}`}>{summary}</span>
        {!compact && <span className="block truncate text-[10px] font-medium text-slate-400">{label} · {allDay ? 'Todo el día' : Intl.DateTimeFormat().resolvedOptions().timeZone}</span>}
      </span>
      {pending
        ? <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin text-emerald-500 motion-reduce:animate-none" />
        : <ChevronRight className={`h-4 w-4 shrink-0 text-slate-400 transition motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />}
    </button>

    {open && typeof document !== 'undefined' && createPortal(<>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Cerrar ${label}`}
        data-task-date-range-backdrop
        className="fixed inset-0 cursor-default"
        style={{ zIndex: TASK_OVERLAY_LAYERS.pickerBackdrop }}
        onMouseDown={event => {
          event.preventDefault()
          cancel()
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={`Editar ${label}`}
        data-task-date-range-picker
        data-placement={geometry.placement}
        style={{
          zIndex: TASK_OVERLAY_LAYERS.picker,
          left: geometry.left,
          top: geometry.top,
          width: geometry.width,
          maxHeight: geometry.maxHeight,
        }}
        className="fixed overflow-y-auto overscroll-contain rounded-3xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20 outline-none"
      >
        <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-slate-100 bg-white/95 px-4 py-3 backdrop-blur">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
            <CalendarDays className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-black text-slate-900">Programar tarea</span>
            <span className="mt-0.5 block text-[10px] leading-4 text-slate-400">Define inicio, entrega o ambos antes de aplicar.</span>
          </span>
          <button type="button" aria-label={`Cerrar selector de ${label}`} onClick={cancel} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="p-3 sm:p-4">
          <div className="grid gap-2" style={{ gridTemplateColumns: splitEndpoints ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)' }}>
            <div className={`flex min-w-0 items-center rounded-2xl border p-1 transition motion-reduce:transition-none ${activeEndpoint === 'start' ? 'border-emerald-300 bg-emerald-50/50 ring-2 ring-emerald-100' : 'border-slate-200 bg-slate-50/70'}`}>
              <button ref={startEndpointRef} type="button" aria-pressed={activeEndpoint === 'start'} onClick={() => activateEndpoint('start')} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${activeEndpoint === 'start' ? 'bg-emerald-600 text-white' : 'bg-white text-slate-400 shadow-sm'}`}>1</span>
                <span className="min-w-0 flex-1"><span className="block text-[9px] font-black uppercase tracking-[.12em] text-slate-400">Inicio</span><EndpointSummary value={draftStart} allDay={draftAllDay} /></span>
              </button>
              {draftStart && <button type="button" disabled={pending} aria-label="Quitar inicio" onClick={() => setDraftStart('')} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-white hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:opacity-40"><X className="h-3.5 w-3.5" /></button>}
            </div>

            <div className={`flex min-w-0 items-center rounded-2xl border p-1 transition motion-reduce:transition-none ${activeEndpoint === 'end' ? 'border-emerald-300 bg-emerald-50/50 ring-2 ring-emerald-100' : 'border-slate-200 bg-slate-50/70'}`}>
              <button ref={endEndpointRef} type="button" aria-pressed={activeEndpoint === 'end'} onClick={() => activateEndpoint('end')} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${activeEndpoint === 'end' ? 'bg-emerald-600 text-white' : 'bg-white text-slate-400 shadow-sm'}`}>2</span>
                <span className="min-w-0 flex-1"><span className="block text-[9px] font-black uppercase tracking-[.12em] text-slate-400">Entrega</span><EndpointSummary value={draftEnd} allDay={draftAllDay} /></span>
              </button>
              {draftEnd && <button type="button" disabled={pending} aria-label="Quitar entrega" onClick={() => setDraftEnd('')} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-white hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:opacity-40"><X className="h-3.5 w-3.5" /></button>}
            </div>
          </div>

          <div className="mt-3 grid gap-3" style={{ gridTemplateColumns: splitLayout ? 'minmax(0, 1fr) 248px' : 'minmax(0, 1fr)' }}>
            <section aria-label="Calendario del rango" className="min-w-0 rounded-2xl border border-slate-200 bg-white">
              <div className="flex items-center gap-1 border-b border-slate-100 px-2 py-2">
                <button type="button" aria-label="Mes anterior" onClick={() => setCursor(current => new Date(current.getFullYear(), current.getMonth() - 1, 1))} className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><ChevronLeft className="h-4 w-4" /></button>
                <button type="button" aria-expanded={monthYearOpen} aria-label="Elegir mes y año" onClick={() => setMonthYearOpen(current => !current)} className="flex min-h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl px-2 text-sm font-black capitalize text-slate-800 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                  <span className="truncate">{cursor.toLocaleDateString('es-PE', { month: 'long', year: 'numeric' })}</span>
                  <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition motion-reduce:transition-none ${monthYearOpen ? 'rotate-180' : ''}`} />
                </button>
                <button type="button" aria-label="Mes siguiente" onClick={() => setCursor(current => new Date(current.getFullYear(), current.getMonth() + 1, 1))} className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><ChevronRight className="h-4 w-4" /></button>
              </div>

              {monthYearOpen ? <div className="p-3">
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
              </div> : <>
                <div className="grid grid-cols-7 px-2 pt-2" role="grid" aria-label={`Calendario de ${cursor.toLocaleDateString('es-PE', { month: 'long', year: 'numeric' })}`}>
                  {weekdays.map(day => <span key={day} role="columnheader" className="py-1 text-center text-[9px] font-black text-slate-400">{day}</span>)}
                  {days.map(day => {
                    const key = operationalDateDayKey(day)
                    const outside = day.getMonth() !== cursor.getMonth()
                    const activeSelected = key === (activeEndpoint === 'start' ? startDayKey : endDayKey)
                    const isStart = key === startDayKey
                    const isEnd = key === endDayKey
                    const withinRange = Boolean(startDayKey && endDayKey && key > startDayKey && key < endDayKey)
                    const focused = operationalDateDayKey(focusedDay) === key
                    return <button
                      key={key}
                      ref={node => { if (node) dayRefs.current.set(key, node); else dayRefs.current.delete(key) }}
                      type="button"
                      role="gridcell"
                      aria-label={day.toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                      aria-pressed={activeSelected}
                      aria-current={operationalDateDayKey(new Date()) === key ? 'date' : undefined}
                      tabIndex={focused ? 0 : -1}
                      data-task-range-date={key}
                      data-range-boundary={isStart ? 'start' : isEnd ? 'end' : undefined}
                      onFocus={() => setFocusedDay(day)}
                      onKeyDown={event => handleDayKey(event, day)}
                      onClick={() => chooseDay(day)}
                      className={`mx-auto my-0.5 flex h-9 w-9 items-center justify-center rounded-xl text-[11px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-1 motion-reduce:transition-none ${activeSelected ? 'bg-emerald-600 text-white shadow-md shadow-emerald-200' : isStart || isEnd ? 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300' : withinRange ? 'bg-emerald-50 text-emerald-700' : outside ? 'text-slate-300 hover:bg-slate-50' : 'text-slate-600 hover:bg-emerald-50 hover:text-emerald-700'}`}
                    >{day.getDate()}</button>
                  })}
                </div>
                <div className="mx-2 mb-2 mt-1 flex gap-1.5">
                  {([['today', 'Hoy'], ['tomorrow', 'Mañana'], ['next_week', 'Próxima semana']] as const).map(([kind, text]) => <button key={kind} type="button" onClick={() => chooseQuick(kind)} className="min-h-10 min-w-0 flex-1 rounded-xl bg-slate-50 px-1.5 py-2 text-[10px] font-bold text-slate-600 hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">{text}</button>)}
                </div>
              </>}
            </section>

            <aside aria-label="Ajustes del rango" className="min-w-0 space-y-3">
              <section className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white text-emerald-600 shadow-sm"><Clock3 className="h-4 w-4" /></span>
                  <span className="min-w-0"><span className="block text-[9px] font-black uppercase tracking-[.12em] text-slate-400">Editando</span><span className="block truncate text-xs font-bold text-slate-700">{activeLabel}</span></span>
                </div>
                <label className="mt-3 block text-[10px] font-bold text-slate-500">Hora
                  <input
                    aria-label={`Hora de ${activeLabel.toLocaleLowerCase('es')}`}
                    type="time"
                    value={timeValue(activeValue)}
                    disabled={pending || draftAllDay || !activeHasValue}
                    onChange={event => updateActiveValue(replaceTime(activeValue, event.target.value))}
                    className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:opacity-45"
                  />
                </label>
                {!activeHasValue && <p className="mt-2 text-[10px] leading-4 text-slate-400">Elige una fecha para habilitar la hora.</p>}
              </section>

              <button
                type="button"
                aria-pressed={draftAllDay}
                disabled={pending}
                onClick={() => setDraftAllDay(current => !current)}
                className={`flex min-h-11 w-full items-center gap-3 rounded-2xl border px-3 text-left outline-none transition focus-visible:ring-4 focus-visible:ring-emerald-100 disabled:opacity-45 motion-reduce:transition-none ${draftAllDay ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-200'}`}
              >
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${draftAllDay ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-400'}`}><Check className="h-3.5 w-3.5" /></span>
                <span className="min-w-0"><span className="block text-xs font-bold">Todo el día</span><span className="block text-[9px] leading-4 text-slate-400">Inicio 00:00 · entrega 23:59.</span></span>
              </button>

              <p className="flex items-start gap-1.5 rounded-xl bg-slate-50 px-3 py-2 text-[9px] leading-4 text-slate-400"><Globe2 className="mt-0.5 h-3 w-3 shrink-0" /><span>{Intl.DateTimeFormat().resolvedOptions().timeZone}<br />Se guardará la hora local.</span></p>
            </aside>
          </div>

          {invalidMessage && <p role="alert" className="mt-3 flex items-center gap-2 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700"><AlertCircle className="h-4 w-4 shrink-0" />{invalidMessage}</p>}
        </div>

        <footer className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-slate-100 bg-white/95 px-3 py-3 backdrop-blur sm:px-4">
          <button type="button" disabled={pending || (!draftStart && !draftEnd)} onClick={() => { setDraftStart(''); setDraftEnd('') }} className="flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-rose-600 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:cursor-not-allowed disabled:opacity-35"><Trash2 className="h-3.5 w-3.5" />Quitar todas</button>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" disabled={pending} onClick={cancel} className="min-h-10 rounded-xl px-3 text-xs font-bold text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-40">Cancelar</button>
            <button type="button" disabled={pending || Boolean(invalidMessage)} onClick={apply} className="flex min-h-10 items-center gap-1.5 rounded-xl bg-emerald-600 px-4 text-xs font-black text-white shadow-lg shadow-emerald-100 hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40">
              {pending ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ArrowRight className="h-4 w-4" />}
              {pending ? 'Guardando…' : 'Aplicar'}
            </button>
          </div>
        </footer>
      </div>
    </>, document.body)}
  </>
}
