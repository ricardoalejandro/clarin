import type { AgendaItem, Task, WorkEventOccurrence } from '@/types/task'
import { agendaItemInterval } from './calendarAgendaLayout'

export const CALENDAR_SNAP_MINUTES = 15
export const CALENDAR_MIN_DURATION_MINUTES = 15
export const CALENDAR_TOUCH_HOLD_MS = 520

export type CalendarInteractionMode = 'move' | 'resize-end'
export type CalendarInteractionSurface = 'timed' | 'all-day' | 'month'

export interface CalendarSchedule {
  start: Date
  end: Date
  allDay: boolean
}

export interface CalendarInteractionDelta {
  days: number
  minutes: number
}

export interface CalendarPointerGeometry {
  columnWidth: number
  rowHeight?: number
}

export interface CalendarSpanSegment {
  item: AgendaItem
  startIndex: number
  endIndex: number
  weekIndex: number
  lane: number
  isStart: boolean
  isEnd: boolean
}

const DAY_MS = 86_400_000

export function calendarDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function calendarStartOfDay(date: Date) {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

export function calendarAddDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

export function calendarDayDistance(from: Date, to: Date) {
  const left = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())
  const right = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())
  return Math.round((right - left) / DAY_MS)
}

export function calendarItemSchedule(item: AgendaItem): CalendarSchedule | null {
  const interval = agendaItemInterval(item)
  if (!interval) return null
  return { start: new Date(interval.start), end: new Date(interval.end), allDay: interval.allDay }
}

export function calendarSnapMinutes(value: number) {
  return Math.round(value / CALENDAR_SNAP_MINUTES) * CALENDAR_SNAP_MINUTES
}

export function calendarPointerDelta(
  surface: CalendarInteractionSurface,
  origin: { x: number; y: number },
  current: { x: number; y: number },
  geometry: CalendarPointerGeometry,
): CalendarInteractionDelta {
  const columnWidth = Math.max(1, geometry.columnWidth)
  const columnDelta = Math.round((current.x - origin.x) / columnWidth)
  if (surface === 'timed') {
    return { days: columnDelta, minutes: calendarSnapMinutes(current.y - origin.y) }
  }
  if (surface === 'month') {
    const rowHeight = Math.max(1, geometry.rowHeight || columnWidth)
    return { days: columnDelta + Math.round((current.y - origin.y) / rowHeight) * 7, minutes: 0 }
  }
  return { days: columnDelta, minutes: 0 }
}

function addScheduleDelta(date: Date, delta: CalendarInteractionDelta) {
  const next = calendarAddDays(date, delta.days)
  if (delta.minutes) next.setMinutes(next.getMinutes() + delta.minutes)
  return next
}

export function calendarScheduleAfterInteraction(
  schedule: CalendarSchedule,
  mode: CalendarInteractionMode,
  delta: CalendarInteractionDelta,
): CalendarSchedule {
  if (mode === 'move') {
    const normalized = schedule.allDay ? { days: delta.days, minutes: 0 } : delta
    return {
      ...schedule,
      start: addScheduleDelta(schedule.start, normalized),
      end: addScheduleDelta(schedule.end, normalized),
    }
  }
  if (schedule.allDay) {
    const end = calendarAddDays(schedule.end, delta.days)
    const minimum = calendarAddDays(calendarStartOfDay(schedule.start), 1)
    return { ...schedule, end: end > minimum ? end : minimum }
  }
  const end = addScheduleDelta(schedule.end, delta)
  const minimum = new Date(schedule.start.getTime() + CALENDAR_MIN_DURATION_MINUTES * 60_000)
  return { ...schedule, end: end > minimum ? end : minimum }
}

export function calendarScheduleChanged(left: CalendarSchedule, right: CalendarSchedule) {
  return left.allDay !== right.allDay || left.start.getTime() !== right.start.getTime() || left.end.getTime() !== right.end.getTime()
}

export function applyCalendarSchedule(item: AgendaItem, schedule: CalendarSchedule): AgendaItem {
  if (item.kind === 'task') {
    const due = schedule.allDay ? new Date(schedule.end.getTime() - 60_000) : schedule.end
    return {
      ...item,
      task: {
        ...item.task,
        start_at: schedule.start.toISOString(),
        due_at: due.toISOString(),
        due_end_at: undefined,
        is_all_day: schedule.allDay,
      },
    }
  }
  const occurrence = item.event
  if (schedule.allDay) {
    const startDate = calendarDateKey(schedule.start)
    const endDateExclusive = calendarDateKey(schedule.end)
    return {
      ...item,
      event: {
        ...occurrence,
        start_at: undefined,
        end_at: undefined,
        start_date: startDate,
        end_date_exclusive: endDateExclusive,
        event: {
          ...occurrence.event,
          is_all_day: true,
          start_at: undefined,
          end_at: undefined,
          start_date: startDate,
          end_date_exclusive: endDateExclusive,
        },
      },
    }
  }
  return {
    ...item,
    event: {
      ...occurrence,
      start_date: undefined,
      end_date_exclusive: undefined,
      start_at: schedule.start.toISOString(),
      end_at: schedule.end.toISOString(),
      event: {
        ...occurrence.event,
        is_all_day: false,
        start_date: undefined,
        end_date_exclusive: undefined,
        start_at: schedule.start.toISOString(),
        end_at: schedule.end.toISOString(),
      },
    },
  }
}

export function buildTaskSchedulePayload(task: Task, schedule: CalendarSchedule, operationID: string) {
  const due = schedule.allDay ? new Date(schedule.end.getTime() - 60_000) : schedule.end
  return {
    start_at: schedule.start.toISOString(),
    due_at: due.toISOString(),
    due_end_at: '',
    is_all_day: schedule.allDay,
    version: task.version || 0,
    operation_id: operationID,
  }
}

export function buildEventSchedulePayload(
  occurrence: WorkEventOccurrence,
  schedule: CalendarSchedule,
  operationID: string,
  confirmConflicts = false,
) {
  const event = occurrence.event
  const recurring = Boolean(event.recurrence_rule)
  return {
    title: event.title,
    description: event.description || '',
    list_id: event.list_id,
    location: event.location || '',
    meeting_url: event.meeting_url || '',
    color: event.color || null,
    availability: event.availability,
    is_all_day: schedule.allDay,
    timezone: event.timezone,
    version: event.version,
    operation_id: operationID,
    confirm_conflicts: confirmConflicts,
    ...(schedule.allDay
      ? { start_date: calendarDateKey(schedule.start), end_date_exclusive: calendarDateKey(schedule.end) }
      : { start_at: schedule.start.toISOString(), end_at: schedule.end.toISOString() }),
    ...(recurring
      ? { scope: 'occurrence', occurrence_key: occurrence.occurrence_key }
      : {
          scope: 'series',
          recurrence_rule: '',
          attendees: event.attendees
            .filter(attendee => attendee.user_id !== event.organizer_id)
            .map(attendee => ({ user_id: attendee.user_id, attendance_type: attendee.attendance_type })),
        }),
  }
}

export function calendarInteractionLabel(schedule: CalendarSchedule) {
  if (schedule.allDay) {
    const inclusiveEnd = calendarAddDays(schedule.end, -1)
    const startLabel = schedule.start.toLocaleDateString('es', { day: 'numeric', month: 'short' })
    const endLabel = inclusiveEnd.toLocaleDateString('es', { day: 'numeric', month: 'short' })
    const dayCount = Math.max(1, calendarDayDistance(schedule.start, schedule.end))
    return calendarDateKey(schedule.start) === calendarDateKey(inclusiveEnd)
      ? `${startLabel} · Todo el día · 1 día`
      : `${startLabel} – ${endLabel} · ${dayCount} días`
  }
  const day = schedule.start.toLocaleDateString('es', { day: 'numeric', month: 'short' })
  const start = schedule.start.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
  const end = schedule.end.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
  const durationMinutes = Math.max(CALENDAR_MIN_DURATION_MINUTES, Math.round((schedule.end.getTime() - schedule.start.getTime()) / 60_000))
  const hours = Math.floor(durationMinutes / 60)
  const minutes = durationMinutes % 60
  const duration = [hours ? `${hours} h` : '', minutes ? `${minutes} min` : ''].filter(Boolean).join(' ')
  return `${day} · ${start}–${end} · ${duration}`
}

function visualEndDay(schedule: CalendarSchedule) {
  if (schedule.allDay) return calendarStartOfDay(schedule.end)
  const endDay = calendarStartOfDay(schedule.end)
  return schedule.end.getTime() === endDay.getTime() ? endDay : calendarAddDays(endDay, 1)
}

export function layoutCalendarSpans(items: AgendaItem[], rangeStart: Date, dayCount: number): CalendarSpanSegment[] {
  const normalizedStart = calendarStartOfDay(rangeStart)
  const rangeEnd = calendarAddDays(normalizedStart, dayCount)
  const provisional: Array<Omit<CalendarSpanSegment, 'lane'>> = []
  for (const item of items) {
    const schedule = calendarItemSchedule(item)
    if (!schedule) continue
    const itemStart = calendarStartOfDay(schedule.start)
    const itemEnd = visualEndDay(schedule)
    if (itemStart >= rangeEnd || itemEnd <= normalizedStart) continue
    const clippedStart = itemStart < normalizedStart ? normalizedStart : itemStart
    const clippedEnd = itemEnd > rangeEnd ? rangeEnd : itemEnd
    let startIndex = calendarDayDistance(normalizedStart, clippedStart)
    const finalIndex = calendarDayDistance(normalizedStart, clippedEnd)
    while (startIndex < finalIndex) {
      const weekIndex = Math.floor(startIndex / 7)
      const endIndex = Math.min(finalIndex, (weekIndex + 1) * 7)
      provisional.push({
        item,
        startIndex,
        endIndex,
        weekIndex,
        isStart: clippedStart.getTime() === itemStart.getTime() && startIndex === calendarDayDistance(normalizedStart, clippedStart),
        isEnd: clippedEnd.getTime() === itemEnd.getTime() && endIndex === finalIndex,
      })
      startIndex = endIndex
    }
  }
  provisional.sort((left, right) => {
    const leftSchedule = calendarItemSchedule(left.item)
    const rightSchedule = calendarItemSchedule(right.item)
    return left.weekIndex - right.weekIndex
      || left.startIndex - right.startIndex
      || right.endIndex - left.endIndex
      || (rightSchedule?.end.getTime() || 0) - (leftSchedule?.end.getTime() || 0)
      || left.item.key.localeCompare(right.item.key)
  })
  const laneEnds = new Map<number, number[]>()
  return provisional.map(segment => {
    const lanes = laneEnds.get(segment.weekIndex) || []
    let lane = lanes.findIndex(end => end <= segment.startIndex)
    if (lane < 0) lane = lanes.length
    lanes[lane] = segment.endIndex
    laneEnds.set(segment.weekIndex, lanes)
    return { ...segment, lane }
  })
}

export function calendarSpanOverflowCount(segments: CalendarSpanSegment[], dayIndex: number, visibleLanes: number) {
  return segments.filter(segment => segment.startIndex <= dayIndex && segment.endIndex > dayIndex && segment.lane >= visibleLanes).length
}
