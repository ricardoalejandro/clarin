import { describe, expect, it } from 'vitest'
import { operationalDateFieldStacked, operationalDateInputText, operationalDateInputValue } from './operationalDateInput'

describe('manual operational dates', () => {
  it('reflows date and time from the measured field width without changing date-only fields', () => {
    expect(operationalDateFieldStacked(182, 'datetime')).toBe(true)
    expect(operationalDateFieldStacked(239, 'datetime')).toBe(true)
    expect(operationalDateFieldStacked(240, 'datetime')).toBe(false)
    expect(operationalDateFieldStacked(0, 'datetime')).toBe(false)
    expect(operationalDateFieldStacked(182, 'date')).toBe(false)
  })
  it('normalizes complete local dates and ISO paste without guessing two-digit years', () => {
    expect(operationalDateInputValue('3/4/1965', '', 'date')).toMatchObject({ valid: true, value: '1965-04-03' })
    expect(operationalDateInputValue('1965-04-03', '', 'date')).toMatchObject({ valid: true, value: '1965-04-03' })
    expect(operationalDateInputText('1965-04-03', 'date').dateText).toBe('03/04/1965')
    expect(operationalDateInputValue('03/04/65', '', 'date').valid).toBe(false)
    expect(operationalDateInputValue('03/04/196', '', 'date').value).toBeNull()
    expect(operationalDateInputText('2026-08-26T23:59', 'date').timeText).toBe('23:59')
  })
  it('validates the real calendar, including leap centuries and early years', () => {
    expect(operationalDateInputValue('29/02/2000', '', 'date').valid).toBe(true)
    expect(operationalDateInputValue('29/02/1900', '', 'date').valid).toBe(false)
    expect(operationalDateInputValue('31/04/1990', '', 'date').valid).toBe(false)
    expect(operationalDateInputValue('01/01/0001', '', 'date').value).toBe('0001-01-01')
    expect(operationalDateInputValue('01/01/0000', '', 'date').valid).toBe(false)
  })
  it('preserves optional empty values and required/date limits', () => {
    expect(operationalDateInputValue('', '', 'date')).toMatchObject({ value: '', valid: true })
    expect(operationalDateInputValue('', '', 'date', { required: true }).valid).toBe(false)
    expect(operationalDateInputValue('01/01/2000', '', 'date', { min: '2000-01-01', max: '2000-01-01' }).valid).toBe(true)
    expect(operationalDateInputValue('31/12/1999', '', 'date', { min: '2000-01-01' }).valid).toBe(false)
  })
  it('requires valid explicit time only in datetime mode', () => {
    expect(operationalDateInputValue('12/11/2000', '', 'date').value).toBe('2000-11-12')
    expect(operationalDateInputValue('12/11/2000', '', 'datetime').valid).toBe(false)
    expect(operationalDateInputValue('12/11/2000', '09:45', 'datetime').value).toBe('2000-11-12T09:45')
    expect(operationalDateInputValue('12/11/2000', '24:00', 'datetime').valid).toBe(false)
    expect(operationalDateInputValue('12/11/2000', '10:60', 'datetime').valid).toBe(false)
  })
})
