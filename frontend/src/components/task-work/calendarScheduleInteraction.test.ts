import { describe, expect, it } from 'vitest'
import type { AgendaItem, Task, WorkEventOccurrence } from '@/types/task'
import {
  applyCalendarSchedule,
  buildEventSchedulePayload,
  buildTaskSchedulePayload,
  calendarItemSchedule,
  calendarInteractionLabel,
  calendarPointerDelta,
  calendarScheduleAfterInteraction,
  calendarScheduleChanged,
  calendarSpanOverflowCount,
  layoutCalendarSpans,
} from './calendarScheduleInteraction'

const taskItem = (id: string, start: string, end: string, allDay = false): AgendaItem => ({
  kind: 'task',
  key: `task:${id}`,
  task: {
    id,
    title: id,
    start_at: start,
    due_at: end,
    is_all_day: allDay,
    version: 4,
    permissions: { can_edit: true },
  } as Task,
})

const occurrence = (recurring = false) => ({
  series_id: 'event-1',
  occurrence_key: '2026-08-10T09:00:00.000Z',
  start_at: '2026-08-10T09:00:00.000Z',
  end_at: '2026-08-10T10:00:00.000Z',
  is_exception: false,
  event: {
    id: 'event-1',
    title: 'Revisión',
    description: '',
    list_id: 'list-1',
    environment_id: 'environment-1',
    organizer_id: 'user-1',
    organizer_name: 'Ricardo',
    availability: 'busy',
    is_all_day: false,
    timezone: 'America/Lima',
    recurrence_rule: recurring ? 'FREQ=WEEKLY' : '',
    status: 'scheduled',
    version: 7,
    attendees: [],
    capabilities: { can_edit: true },
  },
} as unknown as WorkEventOccurrence)

describe('calendar schedule interaction', () => {
  it('snaps pointer geometry and preserves duration while moving across days', () => {
    const delta = calendarPointerDelta('timed', { x: 100, y: 200 }, { x: 310, y: 238 }, { columnWidth: 200 })
    expect(delta).toEqual({ days: 1, minutes: 45 })
    const original = { start: new Date('2026-08-10T09:00:00Z'), end: new Date('2026-08-10T10:30:00Z'), allDay: false }
    const moved = calendarScheduleAfterInteraction(original, 'move', delta)
    expect(moved.start.toISOString()).toBe('2026-08-11T09:45:00.000Z')
    expect(moved.end.toISOString()).toBe('2026-08-11T11:15:00.000Z')
    expect(calendarScheduleChanged(original, moved)).toBe(true)
    expect(calendarInteractionLabel(moved)).toContain('1 h 30 min')
  })

  it('enforces timed and all-day minimum durations when resizing the end', () => {
    const timed = { start: new Date('2026-08-10T09:00:00Z'), end: new Date('2026-08-10T10:00:00Z'), allDay: false }
    expect(calendarScheduleAfterInteraction(timed, 'resize-end', { days: 0, minutes: -120 }).end.toISOString()).toBe('2026-08-10T09:15:00.000Z')
    const allDay = { start: new Date('2026-08-10T00:00:00Z'), end: new Date('2026-08-12T00:00:00Z'), allDay: true }
    expect(calendarScheduleAfterInteraction(allDay, 'resize-end', { days: -9, minutes: 0 }).end.toISOString()).toBe('2026-08-11T00:00:00.000Z')
  })

  it('normalizes task writes to start/due and clears the legacy due_end_at field', () => {
    const item = taskItem('task-1', '2026-08-10T00:00:00Z', '2026-08-10T23:59:00Z', true)
    const schedule = calendarItemSchedule(item)
    expect(schedule?.end.toISOString()).toBe('2026-08-11T00:00:00.000Z')
    const moved = calendarScheduleAfterInteraction(schedule!, 'move', { days: 2, minutes: 0 })
    expect(buildTaskSchedulePayload((item as Extract<AgendaItem, { kind: 'task' }>).task, moved, 'operation-1')).toMatchObject({
      start_at: '2026-08-12T00:00:00.000Z',
      due_at: '2026-08-12T23:59:00.000Z',
      due_end_at: '',
      is_all_day: true,
      version: 4,
      operation_id: 'operation-1',
    })
    expect((applyCalendarSchedule(item, moved) as Extract<AgendaItem, { kind: 'task' }>).task.due_end_at).toBeUndefined()
  })

  it('keeps recurring event drag occurrence-scoped and uses exclusive all-day dates', () => {
    const event = occurrence(true)
    const payload = buildEventSchedulePayload(event, {
      start: new Date('2026-08-17T00:00:00Z'),
      end: new Date('2026-08-20T00:00:00Z'),
      allDay: true,
    }, 'operation-2')
    expect(payload).toMatchObject({
      is_all_day: true,
      start_date: '2026-08-17',
      end_date_exclusive: '2026-08-20',
      scope: 'occurrence',
      occurrence_key: event.occurrence_key,
      version: 7,
    })
    expect(payload).not.toHaveProperty('attendees')
  })

  it('splits spans at week boundaries and allocates deterministic overlap lanes', () => {
    const rangeStart = new Date('2026-08-03T00:00:00')
    const first = taskItem('span', '2026-08-08T00:00:00', '2026-08-11T23:59:00', true)
    const overlapping = taskItem('overlap', '2026-08-08T00:00:00', '2026-08-09T23:59:00', true)
    const segments = layoutCalendarSpans([first, overlapping], rangeStart, 14)
    expect(segments.filter(segment => segment.item.key === first.key).map(segment => [segment.startIndex, segment.endIndex])).toEqual([[5, 7], [7, 9]])
    expect(segments.find(segment => segment.item.key === overlapping.key)?.lane).toBe(1)
    expect(calendarSpanOverflowCount(segments, 5, 1)).toBe(1)
  })
})
