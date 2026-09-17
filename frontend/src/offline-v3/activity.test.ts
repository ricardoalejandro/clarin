import { describe, expect, it } from 'vitest'
import { nextOfflineActivitySequence } from './activity'

describe('offline activity sequence', () => {
  it('advances only for trusted user events', () => {
    expect(nextOfflineActivitySequence(4, true)).toBe(5)
    expect(nextOfflineActivitySequence(4, false)).toBe(4)
  })

  it('never emits a negative, fractional, or overflowing sequence', () => {
    expect(nextOfflineActivitySequence(-1, true)).toBe(0)
    expect(nextOfflineActivitySequence(1.5, true)).toBe(0)
    expect(nextOfflineActivitySequence(Number.MAX_SAFE_INTEGER, true)).toBe(Number.MAX_SAFE_INTEGER)
  })
})
