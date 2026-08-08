import { describe, expect, it } from 'vitest'
import {
  operationalDateLocalValue,
  operationalDatePickerGeometry,
  operationalDateRangeValid,
  operationalDateValue,
  operationalDateWithinRange,
} from './operationalDate'

describe('operational date helpers', () => {
  it('round-trips a date-only value through local calendar fields without UTC conversion', () => {
    const parsed = operationalDateValue('1992-05-04', 'date')
    expect(parsed).not.toBeNull()
    expect(parsed?.getFullYear()).toBe(1992)
    expect(parsed?.getMonth()).toBe(4)
    expect(parsed?.getDate()).toBe(4)
    expect(operationalDateLocalValue(parsed, 'date')).toBe('1992-05-04')
    expect(operationalDateLocalValue(operationalDateValue('1992-05-04T23:00:00Z', 'date'), 'date')).toBe('1992-05-04')
  })

  it('rejects invalid dates and enforces inclusive limits', () => {
    expect(operationalDateValue('2026-02-31', 'date')).toBeNull()
    expect(operationalDateWithinRange(new Date(2026, 0, 10), '2026-01-10', '2026-01-20')).toBe(true)
    expect(operationalDateWithinRange(new Date(2026, 0, 9), '2026-01-10', '2026-01-20')).toBe(false)
    expect(operationalDateWithinRange(new Date(2026, 0, 21), '2026-01-10', '2026-01-20')).toBe(false)
  })

  it('preserves the existing Clarin Work local datetime contract', () => {
    const parsed = operationalDateValue('2026-07-31T09:05', 'datetime')
    expect(operationalDateLocalValue(parsed, 'datetime')).toBe('2026-07-31T09:05')
    expect(operationalDateRangeValid('2026-07-31T09:05', '2026-07-31T09:04')).toBe(false)
  })

  it('keeps the portal inside narrow viewports and flips above when needed', () => {
    expect(operationalDatePickerGeometry(
      { left: 290, right: 318, top: 100, bottom: 144 },
      { left: 0, top: 0, width: 320, height: 640 },
      { width: 324, height: 430 },
    )).toMatchObject({ left: 12, width: 296, placement: 'below' })

    const above = operationalDatePickerGeometry(
      { left: 1500, right: 1700, top: 650, bottom: 694 },
      { left: 0, top: 0, width: 1747, height: 818 },
      { width: 324, height: 430 },
    )
    expect(above.placement).toBe('above')
    expect(above.left + above.width).toBeLessThanOrEqual(1735)
    expect(above.top).toBeGreaterThanOrEqual(12)
  })
})
