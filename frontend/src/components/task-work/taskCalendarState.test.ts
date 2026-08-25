import { describe, expect, it } from 'vitest'
import { calendarDefaultList, calendarPopoverPosition, calendarSlot, shouldCloseCalendarComposerOnEscape, TASK_CALENDAR_MODE_LABELS } from './taskCalendarState'

describe('task calendar composer', () => {
  it('creates one-hour slots and all-day bounds', () => {
    const date = new Date('2026-07-30T12:00:00Z')
    expect(new Date(calendarSlot(date, 9).dueAt).getTime() - new Date(calendarSlot(date, 9).startAt).getTime()).toBe(3_600_000)
    expect(calendarSlot(date).allDay).toBe(true)
  })

  it('prefers the concrete scope and then the remembered list', () => {
    expect(calendarDefaultList('scope', 'last', ['scope', 'last'])).toBe('scope')
    expect(calendarDefaultList(undefined, 'last', ['scope', 'last'])).toBe('last')
  })

  it('labels every calendar mode consistently', () => {
    expect(TASK_CALENDAR_MODE_LABELS).toEqual({ month: 'Mes', week: 'Semana', day: 'Día' })
  })

  it('centers, flips and clamps calendar popovers inside an offset viewport', () => {
    const viewport = { left: 20, top: 30, width: 320, height: 240 }
    expect(calendarPopoverPosition(
      { left: 280, top: 50, width: 40, height: 24 },
      { width: 220, height: 100 },
      viewport,
    )).toEqual({ left: 108, top: 82 })
    expect(calendarPopoverPosition(
      { left: 4, top: 230, width: 30, height: 24 },
      { width: 220, height: 100 },
      viewport,
    )).toEqual({ left: 32, top: 122 })
  })

  it('lets the first Escape close a nested picker before the composer', () => {
    expect(shouldCloseCalendarComposerOnEscape(true, false)).toBe(false)
    expect(shouldCloseCalendarComposerOnEscape(false, true)).toBe(false)
    expect(shouldCloseCalendarComposerOnEscape(false, false)).toBe(true)
  })
})
