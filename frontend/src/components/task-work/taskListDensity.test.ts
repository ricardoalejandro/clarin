import { describe, expect, it } from 'vitest'
import { taskListDensity } from './taskListDensity'

describe('task list density', () => {
  it('uses measured container width for every layout tier', () => {
    expect(taskListDensity(640)).toBe('stacked')
    expect(taskListDensity(900)).toBe('compact')
    expect(taskListDensity(1320)).toBe('comfortable')
  })
})
