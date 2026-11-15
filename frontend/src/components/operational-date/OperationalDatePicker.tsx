'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
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
import { operationalDateFieldStacked, operationalDateInputText, operationalDateInputValue, type OperationalDateDraftState } from './operationalDateInput'
import { useContainerWidth } from '../responsive/useContainerWidth'

export interface OperationalDateCommitMeta {
  reason: 'enter' | 'blur' | 'calendar' | 'clear'
  relatedTarget: EventTarget | null
  changed: boolean
}

export interface OperationalDatePickerProps {
  mode: OperationalDatePickerMode
  value: string
  onChange: (value: string) => void
  onCommit?: (value: string, meta?: OperationalDateCommitMeta) => void
  onDraftStateChange?: (state: OperationalDateDraftState) => void
  notifyUnchangedCommit?: boolean
  required?: boolean
  id?: string
  name?: string
  compact?: boolean
  inputClassName?: string
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
  const cursor = new Date(date)
  cursor.setDate(1)
  return cursor
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
  onDraftStateChange,
  notifyUnchangedCommit = false,
  required = false,
  id,
  name,
  compact = false,
  inputClassName = '',
}: OperationalDatePickerProps) {
  const generatedId = useId()
  const inputId = id || `operational-date-${generatedId}`
  const { ref: fieldRef, width: fieldWidth } = useContainerWidth<HTMLDivElement>()
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const yearInputRef = useRef<HTMLInputElement>(null)
  const dayRefs = useRef(new Map<string, HTMLButtonElement>())
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  const effectiveMode = mode === 'date' || allDay ? 'date' : 'datetime'
  const stacked = operationalDateFieldStacked(fieldWidth, effectiveMode)
  const mustProvideDate = required || !allowClear
  const [text, setText] = useState(() => operationalDateInputText(value, effectiveMode))
  const textRef = useRef(text)
  const baseline = useRef(value)
  const previousProp = useRef(value)
  const previousMode = useRef(effectiveMode)
  const lastEmitted = useRef(value)
  const listeners = useRef({ onChange, onCommit, onDraftStateChange })
  const published = useRef<OperationalDateDraftState | null>(null)
  listeners.current = { onChange, onCommit, onDraftStateChange }
  const [showError, setShowError] = useState(false)
  const [calendarSelected, setCalendarSelected] = useState(Boolean(value))
  const [calendarTime, setCalendarTime] = useState('')
  const calendarSnapshot = useRef(text)
  const [yearText, setYearText] = useState('')
  const [monthYearOpen, setMonthYearOpen] = useState(false)
  const [draft, setDraft] = useState(() => safeInitialDate(value, mode, min, max))
  const [focusedDay, setFocusedDay] = useState(() => safeInitialDate(value, mode, min, max))
  const [cursor, setCursor] = useState(() => monthCursor(safeInitialDate(value, mode, min, max)))
  const [geometry, setGeometry] = useState(initialGeometry)
  const days = useMemo(() => calendarDays(cursor), [cursor])
  const display = operationalDateValue(value, mode)

  const assess = useCallback((raw: typeof text): OperationalDateDraftState => {
    const parsed = operationalDateInputValue(raw.dateText, raw.timeText, effectiveMode, { required: mustProvideDate, min, max })
    let canonical = parsed.value
    if (canonical && mode === 'datetime' && allDay) {
      const savedTime = operationalDateInputText(baseline.current, 'datetime').timeText || '12:00'
      canonical = `${canonical}T${savedTime}`
    }
    const original = operationalDateInputText(baseline.current, effectiveMode)
    const dirty = raw.dateText !== original.dateText || (effectiveMode === 'datetime' && raw.timeText !== original.timeText)
    if (!dirty && parsed.valid && baseline.current) canonical = baseline.current
    return { ...parsed, value: canonical, dirty, inputId }
  }, [allDay, effectiveMode, inputId, max, min, mode, mustProvideDate])
  const publish = useCallback((raw: typeof text) => {
    const state = assess(raw)
    published.current = state
    inputRef.current?.setCustomValidity(state.message)
    listeners.current.onDraftStateChange?.(state)
    return state
  }, [assess])
  const updateText = (next: typeof text) => {
    textRef.current = next
    setText(next)
    publish(next)
  }
  const restoreText = (next: typeof text) => {
    textRef.current = next
    setText(next)
    publish(next)
    setShowError(false)
  }

  useEffect(() => {
    if (previousMode.current !== effectiveMode) {
      previousMode.current = effectiveMode
      if (effectiveMode === 'datetime' && !textRef.current.timeText && textRef.current.dateText) {
        const clock = operationalDateInputText(value, 'datetime').timeText
        if (clock) {
          textRef.current = { ...textRef.current, timeText: clock }
          setText(textRef.current)
        }
      }
    }
    if (previousProp.current !== value) {
      const pendingState = assess(textRef.current)
      const acknowledged = pendingState.valid && pendingState.value === value
      previousProp.current = value
      baseline.current = value
      lastEmitted.current = value
      if ((!pendingState.dirty || acknowledged) && !openRef.current) {
        const next = operationalDateInputText(value, effectiveMode)
        textRef.current = next
        setText(next)
      }
    }
    publish(textRef.current)
  }, [assess, effectiveMode, publish, value])

  useEffect(() => {
    publish(textRef.current)
  }, [onDraftStateChange, publish])
  useEffect(() => () => {
    if (published.current) listeners.current.onDraftStateChange?.({ ...published.current, active: false })
  }, [inputId])

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
    openRef.current = false
    setOpen(false)
    textRef.current = calendarSnapshot.current
    setText(calendarSnapshot.current)
    publish(calendarSnapshot.current)
    restoreTriggerFocus()
  }, [publish, restoreTriggerFocus])
  useEffect(() => {
    if (disabled && openRef.current) closeWithoutCommit()
  }, [closeWithoutCommit, disabled])

  const emit = (next: string, reason: OperationalDateCommitMeta['reason'], relatedTarget: EventTarget | null = null) => {
    const changed = next !== lastEmitted.current
    baseline.current = next
    lastEmitted.current = next
    restoreText(operationalDateInputText(next, effectiveMode))
    if (changed) listeners.current.onChange(next)
    if (changed || notifyUnchangedCommit) listeners.current.onCommit?.(next, { reason, relatedTarget, changed })
  }
  const confirmText = (reason: 'enter' | 'blur', relatedTarget: EventTarget | null = null) => {
    if (disabled || openRef.current) return
    const state = publish(textRef.current)
    if (!state.valid || state.value === null) { setShowError(true); return }
    emit(state.value, reason, relatedTarget)
  }
  const commit = (date: Date | null) => {
    if (disabled) return
    if (date && (!Number.isFinite(date.getTime()) || !operationalDateWithinRange(date, min, max))) return
    if (date && effectiveMode === 'datetime') {
      const parsed = operationalDateInputValue(operationalDateInputText(operationalDateLocalValue(date, 'date'), 'date').dateText, calendarTime, 'datetime', { required: true, min, max })
      if (!parsed.valid || !parsed.value) return
      date = operationalDateValue(parsed.value, 'datetime')
      if (!date) return
    }
    const next = operationalDateLocalValue(date, mode)
    if (!date && mustProvideDate) return
    openRef.current = false
    setOpen(false)
    emit(next, date ? 'calendar' : 'clear')
    restoreTriggerFocus()
  }

  const updateGeometry = useCallback(() => {
    if (!open || !triggerRef.current || typeof window === 'undefined') return
    const trigger = triggerRef.current.getBoundingClientRect()
    const viewport = window.visualViewport
    const viewportWidth = viewport?.width || window.innerWidth
    const narrowTouch = viewportWidth < 348 && window.matchMedia?.('(pointer: coarse)').matches
    const panelHeight = panelRef.current?.offsetHeight || (mode === 'date' ? 430 : 560)
    setGeometry(operationalDatePickerGeometry(
      trigger,
      {
        left: viewport?.offsetLeft || 0,
        top: viewport?.offsetTop || 0,
        width: viewportWidth,
        height: viewport?.height || window.innerHeight,
      },
      { width: 324, height: panelHeight },
      narrowTouch ? 0 : 12,
    ))
  }, [mode, open])

  useLayoutEffect(() => {
    if (!open) return
    updateGeometry()
    const frame = requestAnimationFrame(updateGeometry)
    return () => cancelAnimationFrame(frame)
  }, [cursor, fieldWidth, monthYearOpen, open, updateGeometry])

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
      if (!openRef.current) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeWithoutCommit()
      } else if (event.key === 'Tab') {
        const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]') || [])
          .filter(node => node.tabIndex >= 0 && !node.closest('[hidden], [inert], [aria-hidden="true"]') && getComputedStyle(node).display !== 'none')
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!controls.length) { panelRef.current?.focus(); return }
        const index = controls.indexOf(document.activeElement as HTMLElement)
        const next = index < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
        controls[next].focus({ preventScroll: true })
      }
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
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
    calendarSnapshot.current = { ...textRef.current }
    const typed = assess(textRef.current)
    const date = safeInitialDate(typed.valid && typed.value ? typed.value : value, mode, min, max)
    if (effectiveMode === 'datetime' && /^([01]\d|2[0-3]):[0-5]\d$/.test(textRef.current.timeText)) {
      const [hours, minutes] = textRef.current.timeText.split(':').map(Number)
      date.setHours(hours, minutes, 0, 0)
    }
    setDraft(date)
    setCalendarTime(`${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`)
    setFocusedDay(date)
    setCursor(monthCursor(date))
    setYearText(String(date.getFullYear()))
    setCalendarSelected(Boolean(typed.valid && typed.value))
    setMonthYearOpen(false)
    openRef.current = true
    setOpen(true)
  }

  const chooseDay = (date: Date) => {
    if (!operationalDateWithinRange(date, min, max)) return
    const next = new Date(date)
    if (mode === 'datetime') next.setHours(draft.getHours(), draft.getMinutes(), 0, 0)
    else next.setHours(0, 0, 0, 0)
    setDraft(next)
    setCalendarSelected(true)
    setFocusedDay(next)
  }

  const chooseQuick = (kind: 'today' | 'tomorrow' | 'next_week') => {
    const next = operationalDateQuickValue(kind)
    next.setHours(draft.getHours(), draft.getMinutes(), 0, 0)
    if (!operationalDateWithinRange(next, min, max)) return
    setDraft(next)
    setCalendarSelected(true)
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
    const end = new Date(cursor)
    end.setMonth(month + 1, 0)
    const next = new Date(cursor)
    next.setMonth(month, 1)
    next.setDate(Math.min(focusedDay.getDate(), end.getDate()))
    setCursor(monthCursor(next))
    setFocusedDay(next)
    setMonthYearOpen(false)
  }

  const displayText = localizedValue(display, mode, allDay)
  const inputState = assess(text)
  const calendarState = operationalDateInputValue(operationalDateInputText(operationalDateLocalValue(draft, 'date'), 'date').dateText, calendarTime, effectiveMode, { required: true, min, max })
  const handleInputKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      confirmText('enter')
    } else if (event.key === 'Escape' && !openRef.current && inputState.dirty) {
      event.preventDefault()
      event.stopPropagation()
      restoreText(operationalDateInputText(baseline.current, effectiveMode))
    } else if (event.key === 'ArrowDown' && event.altKey) {
      event.preventDefault()
      openPicker()
    }
  }

  return <>
    <div
      ref={fieldRef}
      data-operational-date-field
      data-operational-date-stacked={stacked || undefined}
      data-operational-date-owner={inputId}
      onBlur={event => {
        const target = event.relatedTarget as Node | null
        if (target && (fieldRef.current?.contains(target) || panelRef.current?.contains(target))) return
        if (!openRef.current) confirmText('blur', event.relatedTarget)
      }}
      className={`${stacked ? 'grid grid-cols-[minmax(0,1fr)_auto]' : 'flex'} min-w-0 items-center overflow-hidden rounded-xl border bg-white text-slate-800 transition focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-100 ${compact ? 'min-h-9' : 'min-h-11'} ${showError && !inputState.valid ? 'border-rose-400' : 'border-slate-300 hover:border-emerald-300'} ${disabled ? 'cursor-not-allowed opacity-50' : ''} ${className}`}
    >
      <input ref={inputRef} id={inputId} name={name} type="text" autoComplete="off" spellCheck={false} aria-label={label} aria-invalid={!inputState.valid} aria-describedby={showError && !inputState.valid ? `${inputId}-error` : undefined} required={required} disabled={disabled} value={text.dateText} placeholder="DD/MM/AAAA" onInvalid={event => { event.preventDefault(); setShowError(true) }} onChange={event => { setShowError(false); updateText({ dateText: event.target.value, timeText: event.target.value ? textRef.current.timeText : '' }) }} onKeyDown={handleInputKey} className={`w-full min-w-0 min-h-11 flex-1 border-0 bg-transparent px-3 py-2 text-base tabular-nums text-slate-900 outline-none placeholder:text-slate-400 sm:text-sm [@media(pointer:fine)]:min-h-9 ${stacked ? 'col-start-1 row-start-1' : ''} ${inputClassName}`} />
      {effectiveMode === 'datetime' && <input type="text" autoComplete="off" aria-label={`${label}: hora`} disabled={disabled} value={text.timeText} placeholder="HH:mm" onChange={event => { setShowError(false); updateText({ ...textRef.current, timeText: event.target.value }) }} onKeyDown={handleInputKey} className={`${stacked ? 'col-start-1 row-start-2 w-full border-t px-3' : 'w-[4.5rem] shrink-0 border-l px-2'} min-h-11 border-0 border-slate-100 bg-transparent py-2 text-base tabular-nums text-slate-900 outline-none placeholder:text-slate-400 sm:text-sm [@media(pointer:fine)]:min-h-9`} />}
      <button ref={triggerRef} type="button" disabled={disabled} aria-label={`${label}: ${displayText || placeholder}`} title={`Abrir calendario: ${label}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${inputId}-calendar` : undefined} onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()} onClick={openPicker} data-operational-date-trigger className={`${stacked ? 'col-start-2 row-start-1 row-span-2 h-full' : ''} flex min-h-11 w-11 shrink-0 items-center justify-center text-slate-500 outline-none transition hover:bg-slate-50 hover:text-emerald-600 focus-visible:bg-emerald-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 disabled:cursor-not-allowed [@media(pointer:fine)]:min-h-9 [@media(pointer:fine)]:w-9`}><CalendarDays className="h-4 w-4" /></button>
    </div>
    {showError && !inputState.valid && <p id={`${inputId}-error`} role="alert" className="mt-1 text-xs leading-4 text-rose-600">{inputState.message}</p>}

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
        id={`${inputId}-calendar`}
        aria-label={`Elegir ${label}`}
        tabIndex={-1}
        data-operational-date-picker
        data-operational-date-owner={inputId}
        data-placement={geometry.placement}
        style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.picker, left: geometry.left, top: geometry.top, width: geometry.width, maxHeight: geometry.maxHeight }}
        className="fixed overflow-y-auto overscroll-contain rounded-3xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20 outline-none [@media(pointer:coarse)]:[&_button]:min-h-11 [@media(pointer:coarse)]:[&_button]:min-w-11"
      >
        <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-3">
          <button type="button" aria-label="Mes anterior" onClick={() => setCursor(current => new Date(current.getFullYear(), current.getMonth() - 1, 1))} className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" aria-expanded={monthYearOpen} aria-label="Elegir mes y año" onClick={() => { setYearText(String(cursor.getFullYear())); setMonthYearOpen(current => !current) }} className="flex min-h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl px-2 text-sm font-black capitalize text-slate-800 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">{cursor.toLocaleDateString('es-PE', { month: 'long', year: 'numeric' })}<ChevronDown className={`h-3.5 w-3.5 text-slate-400 transition motion-reduce:transition-none ${monthYearOpen ? 'rotate-180' : ''}`} /></button>
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
                value={yearText}
                onChange={event => {
                  setYearText(event.target.value)
                  const year = Number(event.target.value)
                  if (event.target.value.length !== 4 || !Number.isInteger(year) || year < 1 || year > 9999) return
                  setCursor(current => { const next = new Date(current); next.setFullYear(year, current.getMonth(), 1); return next })
                }}
                className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-center text-base font-bold text-slate-800 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
              />
            </label>
            <div className="mt-3 grid grid-cols-3 gap-2" aria-label="Meses">
              {months.map((month, index) => <button key={month} type="button" aria-pressed={cursor.getMonth() === index} onClick={() => selectMonth(index)} className={`min-h-11 rounded-xl px-2 text-xs font-bold capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${cursor.getMonth() === index ? 'bg-emerald-600 text-white shadow-md shadow-emerald-100' : 'bg-slate-50 text-slate-600 hover:bg-emerald-50 hover:text-emerald-700'}`}>{month}</button>)}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-7 px-3 pt-3 [@media(pointer:coarse)]:px-1" role="grid" aria-label={`Calendario de ${cursor.toLocaleDateString('es-PE', { month: 'long', year: 'numeric' })}`}>
            {weekdays.map(day => <span key={day} role="columnheader" className="py-1 text-center text-[9px] font-black text-slate-400">{day}</span>)}
            {days.map(day => {
              const selected = calendarSelected && sameDay(day, draft)
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
                className={`mx-auto my-0.5 flex h-9 w-9 items-center justify-center rounded-xl text-[11px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-1 disabled:opacity-20 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-full ${selected ? 'bg-emerald-600 text-white shadow-md shadow-emerald-200' : outside ? 'text-slate-300 hover:bg-slate-50' : 'text-slate-600 hover:bg-emerald-50 hover:text-emerald-700'}`}
              >{day.getDate()}</button>
            })}
          </div>
        )}

        {showQuickValues && !monthYearOpen && <div className="mx-3 mt-2 flex gap-1.5">{([['today', 'Hoy'], ['tomorrow', 'Mañana'], ['next_week', 'Próxima semana']] as const).map(([kind, text]) => <button key={kind} type="button" onClick={() => chooseQuick(kind)} className="min-h-10 flex-1 rounded-xl bg-slate-50 px-2 py-2 text-[10px] font-bold text-slate-600 hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">{text}</button>)}</div>}

        {mode === 'datetime' && !monthYearOpen && <div className="m-3 rounded-2xl border border-slate-200 p-3"><div className="flex items-center gap-2"><Clock3 className="h-4 w-4 text-slate-400" /><input aria-label="Hora" type="text" data-operational-date-time disabled={allDay} placeholder="HH:mm" value={calendarTime} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (calendarSelected && /^([01]\d|2[0-3]):[0-5]\d$/.test(calendarTime)) commit(draft) } }} onChange={event => { setCalendarTime(event.target.value); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(event.target.value)) return; const [hours, minutes] = event.target.value.split(':').map(Number); const next = new Date(draft); next.setHours(hours, minutes, 0, 0); setDraft(next) }} className="min-w-0 flex-1 rounded-lg border-0 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 outline-none disabled:opacity-40" /><button type="button" onClick={() => onAllDayChange?.(!allDay)} disabled={!onAllDayChange} className={`min-h-10 rounded-lg px-2.5 py-2 text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-50 ${allDay ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>Todo el día</button></div><p className="mt-2 flex items-center gap-1 text-[9px] text-slate-400"><Globe2 className="h-3 w-3" />{Intl.DateTimeFormat().resolvedOptions().timeZone}</p></div>}

        {calendarSelected && !calendarState.valid && <p role="alert" className="px-3 pb-2 text-xs text-rose-600">{calendarState.message}</p>}
        <div className="sticky bottom-0 flex items-center gap-2 border-t border-slate-100 bg-slate-50/95 px-3 py-3 backdrop-blur">
          {allowClear && !required && <button type="button" disabled={!value && !text.dateText} onClick={() => commit(null)} className="flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-rose-600 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:cursor-not-allowed disabled:opacity-35"><Trash2 className="h-3.5 w-3.5" />Quitar</button>}
          <button type="button" disabled={!calendarSelected || !calendarState.valid} onClick={() => commit(draft)} className="ml-auto flex min-h-10 items-center gap-1.5 rounded-xl bg-emerald-600 px-4 text-xs font-black text-white shadow-lg shadow-emerald-100 hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:opacity-40"><Check className="h-4 w-4" />Aplicar</button>
        </div>
      </div>
    </>, document.body)}
  </>
}

export type { OperationalDatePickerMode }
export type { OperationalDateDraftState } from './operationalDateInput'
