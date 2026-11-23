import { afterEach, describe, expect, it } from 'vitest'
import { exclusiveWorkEventEnd, inclusiveWorkEventEnd, shiftWorkEventDate } from './workEventDates'
import { taskAllDayBoundary, taskDueDateOnlyValue } from './TaskDateRangePicker'

const originalTimezone = process.env.TZ
afterEach(() => { if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone })

describe.each(['America/Lima', 'UTC', 'Europe/Madrid', 'Pacific/Kiritimati'])('calendar dates in %s', timezone => {
  it('preserves exact dates and exclusive ends across leap/month/year boundaries', () => {
    process.env.TZ = timezone
    expect(inclusiveWorkEventEnd('2028-03-01')).toBe('2028-02-29')
    expect(exclusiveWorkEventEnd('2028-02-29')).toBe('2028-03-01')
    expect(exclusiveWorkEventEnd('2026-12-31')).toBe('2027-01-01')
    expect(inclusiveWorkEventEnd('2027-01-01')).toBe('2026-12-31')
    expect(taskDueDateOnlyValue('2028-02-29')).toBe('2028-02-29T23:59')
    expect(taskAllDayBoundary('2026-11-15T09:45', 'start')).toBe('2026-11-15T00:00')
  })
})
it('rejects invalid days without rolling them to another month', () => {
  expect(shiftWorkEventDate('2026-02-30', 1)).toBe('')
  expect(shiftWorkEventDate(undefined, -1)).toBe('')
})
