'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Clock3, Plus, X } from 'lucide-react'
import OperationalDatePicker from '../operational-date/OperationalDatePicker'
import type { OperationalDateDraftState } from '../operational-date/operationalDateInput'
import { operationalDateDayKey, operationalDateLocalValue, operationalDateValue } from '../operational-date/operationalDate'

export interface TaskDateRangeValue { startAt: string; endAt: string; isAllDay: boolean }
export interface TaskDateRangePickerProps {
  label: string; startValue: string; endValue: string; allDay: boolean
  disabled?: boolean; pending?: boolean; compact?: boolean
  onApply: (value: TaskDateRangeValue) => void
  onAllDayDraftChange?: (allDay: boolean) => void
  onStartDraftStateChange?: (state: OperationalDateDraftState) => void
  onEndDraftStateChange?: (state: OperationalDateDraftState) => void
}
type Endpoint = 'start' | 'end'
type CommitMeta = { reason: 'enter' | 'blur' | 'calendar' | 'clear'; relatedTarget: EventTarget | null; changed?: boolean }
const parsedDate = (value: string) => operationalDateValue(value, 'datetime')
function localized(value: string, allDay: boolean) {
  const date = parsedDate(value)
  return date ? date.toLocaleString('es-PE', allDay ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' }) : value ? 'Fecha no válida' : 'Sin fecha'
}
export function taskDateRangeSummary(start: string, end: string, allDay: boolean) {
  if (start && end) return `${localized(start, allDay)} → ${localized(end, allDay)}`
  if (start) return `Inicio: ${localized(start, allDay)}`
  return end ? `Entrega: ${localized(end, allDay)}` : 'Agregar fecha de entrega'
}
export function taskDateRangeIsValid(start: string, end: string, allDay: boolean) {
  const first = start ? parsedDate(start) : null, last = end ? parsedDate(end) : null
  if (start && !first || end && !last) return false
  if (!first || !last) return true
  return allDay ? operationalDateDayKey(last) >= operationalDateDayKey(first) : last.getTime() >= first.getTime()
}
export function taskAllDayBoundary(value: string, endpoint: Endpoint) {
  if (!value) return ''
  const date = operationalDateValue(value.slice(0, 10), 'date')
  if (!date) return value
  date.setHours(endpoint === 'start' ? 0 : 23, endpoint === 'start' ? 0 : 59, 0, 0)
  return operationalDateLocalValue(date, 'datetime')
}
export function taskDueDateOnlyValue(dateKey: string) {
  const date = operationalDateValue(dateKey, 'date')
  return date && operationalDateDayKey(date) === dateKey ? taskAllDayBoundary(dateKey, 'end') : ''
}
export function taskDateRangeInitialDraft(startAt: string, endAt: string, isAllDay: boolean, _now?: Date): TaskDateRangeValue {
  return { startAt, endAt, isAllDay }
}

export default function TaskDateRangePicker(props: TaskDateRangePickerProps) {
  const { label, startValue, endValue, allDay, disabled = false, pending = false, compact = false } = props
  const id = useId(), startId = `${id}-start`, endId = `${id}-end`
  const group = useRef<HTMLDivElement>(null)
  const [showStart, setShowStart] = useState(Boolean(startValue))
  const [start, setStart] = useState(startValue), [end, setEnd] = useState(endValue)
  const initialAllDay = startValue || endValue ? allDay : true
  const [draftAllDay, setDraftAllDay] = useState(initialAllDay), [rangeError, setRangeError] = useState('')
  const latest = useRef(props); latest.current = props
  const chosenMode = useRef<boolean | null>(null)
  const values = useRef({ start: startValue, end: endValue, allDay: initialAllDay })
  const states = useRef<Partial<Record<Endpoint, OperationalDateDraftState>>>({})
  const reports = useRef<Partial<Record<Endpoint, string>>>({})
  const lastApplied = useRef(JSON.stringify({ startAt: startValue, endAt: endValue, isAllDay: Boolean(startValue || endValue) && allDay }))
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const normal = (value: string, endpoint: Endpoint) => values.current.allDay ? taskAllDayBoundary(value, endpoint) : value
  const snapshot = (override?: { endpoint: Endpoint; value: string }): TaskDateRangeValue | null => {
    const read = (endpoint: Endpoint) => override?.endpoint === endpoint ? override.value : states.current[endpoint]?.value ?? values.current[endpoint]
    if (['start', 'end'].some(key => key !== override?.endpoint && states.current[key as Endpoint]?.valid === false)) return null
    const first = read('start'), last = read('end')
    if (first === null || last === null) return null
    return { startAt: normal(first, 'start'), endAt: normal(last, 'end'), isAllDay: Boolean(first || last) && values.current.allDay }
  }
  const publish = useRef(() => {})
  publish.current = () => {
    const pair = snapshot(), invalidRange = Boolean(pair && !taskDateRangeIsValid(pair.startAt, pair.endAt, pair.isAllDay))
    setRangeError(invalidRange ? 'La entrega no puede ser anterior al inicio.' : '')
    for (const endpoint of ['start', 'end'] as const) {
      const base = states.current[endpoint] ?? { value: values.current[endpoint], valid: true, dirty: false, inputId: endpoint === 'start' ? startId : endId, message: '' }
      const normalized = base.value === null ? null : normal(base.value, endpoint)
      const canonical = endpoint === 'start' ? latest.current.startValue : latest.current.endValue
      const state: OperationalDateDraftState = { ...base, value: normalized, valid: base.valid && !(endpoint === 'end' && invalidRange), dirty: base.dirty || normalized !== normal(canonical, endpoint) || Boolean(values.current.start || values.current.end) && values.current.allDay !== latest.current.allDay, message: endpoint === 'end' && invalidRange ? 'La entrega no puede ser anterior al inicio.' : base.message }
      const encoded = JSON.stringify(state)
      if (reports.current[endpoint] === encoded) continue
      reports.current[endpoint] = encoded
      ;(endpoint === 'start' ? latest.current.onStartDraftStateChange : latest.current.onEndDraftStateChange)?.(state)
    }
  }
  const receive = useCallback((endpoint: Endpoint, state: OperationalDateDraftState) => {
    if (state.active === false) {
      delete states.current[endpoint]; delete reports.current[endpoint]
      ;(endpoint === 'start' ? latest.current.onStartDraftStateChange : latest.current.onEndDraftStateChange)?.(state)
      return
    }
    states.current[endpoint] = state; publish.current()
  }, [])
  const receiveStart = useCallback((state: OperationalDateDraftState) => receive('start', state), [receive])
  const receiveEnd = useCallback((state: OperationalDateDraftState) => receive('end', state), [receive])
  useEffect(() => {
    const dayOnly = startValue || endValue ? allDay : chosenMode.current ?? true
    values.current = { start: startValue, end: endValue, allDay: dayOnly }
    setStart(startValue); setEnd(endValue); setDraftAllDay(dayOnly); setShowStart(Boolean(startValue)); setRangeError('')
    lastApplied.current = JSON.stringify({ startAt: startValue, endAt: endValue, isAllDay: Boolean(startValue || endValue) && allDay })
  }, [startValue, endValue, allDay])
  useLayoutEffect(() => { publish.current() }, [draftAllDay])
  useLayoutEffect(() => {
    reports.current = {}
    publish.current()
  }, [props.onStartDraftStateChange, props.onEndDraftStateChange])
  useEffect(() => () => clearTimeout(blurTimer.current), [])
  const owned = (target: EventTarget | null) => {
    if (!(target instanceof Node)) return false
    if (group.current?.contains(target)) return true
    const owner = (target instanceof Element ? target : target.parentElement)?.closest<HTMLElement>('[data-operational-date-owner]')?.dataset.operationalDateOwner
    return owner === startId || owner === endId
  }
  const popupOpen = () => Array.from(document.querySelectorAll<HTMLElement>('[data-operational-date-picker]')).some(panel => owned(panel))
  const commit = (override?: { endpoint: Endpoint; value: string }) => {
    if (latest.current.disabled || latest.current.pending) return
    const pair = snapshot(override)
    if (!pair) { publish.current(); return }
    if (!taskDateRangeIsValid(pair.startAt, pair.endAt, pair.isAllDay)) { setRangeError('La entrega no puede ser anterior al inicio.'); publish.current(); return }
    setRangeError('')
    const encoded = JSON.stringify(pair)
    if (encoded === lastApplied.current) return
    lastApplied.current = encoded; latest.current.onApply(pair)
  }
  const endpointCommit = (endpoint: Endpoint, value: string, meta?: CommitMeta) => {
    if (meta?.reason === 'blur' && owned(meta.relatedTarget)) return
    commit({ endpoint, value })
  }
  const change = (endpoint: Endpoint, value: string) => {
    values.current[endpoint] = value
    if (endpoint === 'start') setStart(value); else setEnd(value)
  }
  const toggleTime = () => {
    values.current.allDay = !values.current.allDay; chosenMode.current = values.current.allDay; setDraftAllDay(values.current.allDay)
    latest.current.onAllDayDraftChange?.(values.current.allDay)
    if (!values.current.allDay) for (const endpoint of ['start', 'end'] as const) {
      const value = states.current[endpoint]?.value ?? values.current[endpoint]
      if (value && !value.includes('T')) {
        const next = taskAllDayBoundary(value, endpoint)
        change(endpoint, next)
        if (states.current[endpoint]) states.current[endpoint] = { ...states.current[endpoint]!, value: next }
      }
    }
    publish.current(); commit()
  }
  return <div ref={group} role="group" aria-label={label} data-task-date-range-field className="min-w-0 space-y-1.5" onClickCapture={event => {
    if (event.target instanceof Element && event.target.closest('[data-operational-date-trigger]')) clearTimeout(blurTimer.current)
  }} onBlurCapture={event => {
    clearTimeout(blurTimer.current)
    if (event.target instanceof Element && event.target.closest('[data-operational-date-picker]')) return
    if (popupOpen()) return
    blurTimer.current = setTimeout(() => { if (!owned(document.activeElement) && !popupOpen()) commit() }, 0)
  }}>
    <div className="grid min-w-0 gap-2" style={{ gridTemplateColumns: showStart ? `repeat(auto-fit, minmax(min(100%, ${draftAllDay ? 220 : 280}px), 1fr))` : 'minmax(0, 1fr)' }}>
      {showStart && <div className="min-w-0"><label htmlFor={startId} className="mb-1 block text-xs text-slate-500">Inicio</label><OperationalDatePicker id={startId} mode={draftAllDay ? 'date' : 'datetime'} label="Inicio opcional" value={start} allDay={draftAllDay} compact={compact} disabled={disabled || pending} onChange={value => change('start', value)} onDraftStateChange={receiveStart} notifyUnchangedCommit onCommit={(value, meta) => endpointCommit('start', value, meta)} className="min-w-0" /></div>}
      <div className="min-w-0">{showStart && <label htmlFor={endId} className="mb-1 block text-xs text-slate-500">Entrega</label>}<OperationalDatePicker id={endId} mode={draftAllDay ? 'date' : 'datetime'} label={label} value={end} allDay={draftAllDay} compact={compact} disabled={disabled || pending} onChange={value => change('end', value)} onDraftStateChange={receiveEnd} notifyUnchangedCommit onCommit={(value, meta) => endpointCommit('end', value, meta)} /></div>
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{showStart && <button type="button" aria-label="Quitar inicio" disabled={disabled || pending} onMouseDown={event => event.preventDefault()} onClick={() => {
        states.current.start = { value: '', valid: true, dirty: true, inputId: startId, message: '' }; change('start', ''); setShowStart(false); commit({ endpoint: 'start', value: '' })
      }} className="inline-flex min-h-11 items-center gap-1 text-xs text-slate-500 outline-none hover:text-rose-600 focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40 [@media(pointer:fine)]:min-h-9"><X size={13} />Quitar inicio</button>}{!showStart && <button type="button" disabled={disabled || pending} onClick={() => { setShowStart(true); requestAnimationFrame(() => document.getElementById(startId)?.focus()) }} className="inline-flex min-h-11 items-center gap-1 text-xs [@media(pointer:fine)]:min-h-9 text-slate-500 outline-none hover:text-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40"><Plus size={13} />Añadir fecha de inicio</button>}<button type="button" disabled={disabled || pending} onMouseDown={event => event.preventDefault()} onClick={toggleTime} className="inline-flex min-h-11 items-center gap-1 text-xs [@media(pointer:fine)]:min-h-9 text-slate-500 outline-none hover:text-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40"><Clock3 size={13} />{draftAllDay ? 'Añadir hora' : 'Usar todo el día'}</button></div>
    {rangeError && <p role="alert" className="text-xs text-rose-700">{rangeError}</p>}
  </div>
}
