import { describe, expect, it } from 'vitest'
import { calendarDefaultList, calendarSlot } from './taskCalendarState'

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
})
