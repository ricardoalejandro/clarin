import { describe, expect, it } from 'vitest'
import { validateManualProgress } from './taskProgress'

describe('manual task progress', () => {
  it.each([
    ['0', 0],
    ['75', 75],
    ['100', 100],
    [' 42 ', 42],
  ])('accepts %s as an integer percentage', (raw, expected) => {
    expect(validateManualProgress(raw)).toEqual({ valid: true, value: expected, error: '' })
  })

  it.each(['', ' ', '-1', '101', '10.5', 'abc'])('rejects invalid value %j', raw => {
    expect(validateManualProgress(raw)).toMatchObject({ valid: false, value: null })
  })
})
