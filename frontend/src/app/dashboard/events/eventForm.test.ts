import { describe, expect, it } from 'vitest'
import { eventDateTimePayload, eventDetailPayload, eventLocalDateTime, isEventContextReadOnly, logbookSettingsPatch, readLogbookMutation } from './eventForm'

describe('event form dates and explicit clearing', () => {
  it('shows local wall time and preserves the original instant including seconds', () => {
    const original = new Date(2026, 9, 10, 9, 30, 45, 123).toISOString()
    expect(eventLocalDateTime(original)).toBe('2026-10-10T09:30')
    expect(eventDateTimePayload(eventLocalDateTime(original), original)).toBe(original)
  })

  it('converts an edited wall time exactly once and survives reopening', () => {
    const expected = new Date(2026, 9, 11, 16, 45).toISOString()
    const saved = eventDateTimePayload('2026-10-11T16:45')
    expect(saved).toBe(expected)
    expect(eventDateTimePayload(eventLocalDateTime(saved), saved)).toBe(saved)
  })

  it('sends explicit nulls to remove all optional fields', () => {
    expect(eventDetailPayload({ event_date: '', event_end: '', description: '', location: '' })).toEqual({
      event_date: null, event_end: null, description: null, location: null,
    })
  })

  it('rejects reversed and malformed ranges without silently shifting a date', () => {
    expect(() => eventDetailPayload({ event_date: '2026-10-12T09:00', event_end: '2026-10-10T09:00', description: '', location: '' })).toThrow(/fin/)
    expect(() => eventDateTimePayload('2026-02-30T09:00')).toThrow(/válida/)
    expect(() => eventDateTimePayload('not-a-date')).toThrow(/válida/)
  })

  it('keeps an open-ended event and preserves multiline description', () => {
    const payload = eventDetailPayload({ event_date: '2026-10-10T09:00', event_end: '', description: 'Uno\nDos', location: 'Lima' })
    expect(payload.event_end).toBeNull()
    expect(payload.description).toBe('Uno\nDos')
  })

  it('makes only completed and cancelled context read-only', () => {
    expect(isEventContextReadOnly('completed')).toBe(true)
    expect(isEventContextReadOnly('cancelled')).toBe(true)
    expect(isEventContextReadOnly('active')).toBe(false)
    expect(isEventContextReadOnly('draft')).toBe(false)
  })

  it('propagates snapshot conflicts instead of presenting them as successful saves', async () => {
    const response = new Response(JSON.stringify({ code: 'LOGBOOK_NOTES_OUTSIDE_SNAPSHOT', error: 'No se aplicó la recaptura: conserva las notas.' }), { status: 409 })
    await expect(readLogbookMutation(response)).rejects.toThrow('No se aplicó la recaptura: conserva las notas.')
  })

  it('keeps the canonical successful snapshot and explains malformed server failures', async () => {
    const canonical = { id: 'synthetic-logbook', entries: [{ notes: 'Nota conservada' }] }
    await expect(readLogbookMutation(new Response(JSON.stringify(canonical), { status: 200 }))).resolves.toEqual(canonical)
    await expect(readLogbookMutation(new Response('unavailable', { status: 500 }))).rejects.toThrow(/Vuelve a intentarlo/)
  })

  it('does not send an old pending status, date or untouched title from an open settings editor', () => {
    const initial = { title: 'Original title', date: '2026-10-10', status: 'pending' }
    // Another client can capture the logbook while this immutable draft stays
    // open. Only the field the user actually changed belongs in the request.
    expect(logbookSettingsPatch({ ...initial, title: 'Edited title' }, initial)).toEqual({ title: 'Edited title' })
    expect(logbookSettingsPatch({ ...initial, date: '2026-10-11' }, initial)).toEqual({ date: '2026-10-11' })
    expect(logbookSettingsPatch(initial, initial)).toEqual({})
  })

  it('sends an explicitly changed lifecycle status without rewriting other fields', () => {
    const initial = { title: 'Original title', date: '2026-10-10', status: 'completed' }
    expect(logbookSettingsPatch({ ...initial, status: 'active' }, initial)).toEqual({ status: 'active' })
  })
})
