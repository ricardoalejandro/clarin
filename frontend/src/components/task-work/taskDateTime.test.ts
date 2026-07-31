import { describe, expect, it } from 'vitest'
import { taskDateLocalValue, taskDateQuickValue, taskDateRangeValid } from './taskDateTime'

describe('Clarin Work date helpers', () => {
  it('keeps local date and time without a browser-native date input', () => {
    expect(taskDateLocalValue(new Date(2026, 6, 31, 9, 5))).toBe('2026-07-31T09:05')
  })

  it('provides deterministic quick dates and validates linked ranges', () => {
    const now = new Date(2026, 6, 31, 10, 0)
    expect(taskDateQuickValue('tomorrow', now).getDate()).toBe(1)
    expect(taskDateRangeValid('2026-07-31T10:00', '2026-07-31T09:00')).toBe(false)
    expect(taskDateRangeValid('2026-07-31T10:00', '')).toBe(true)
  })
})
