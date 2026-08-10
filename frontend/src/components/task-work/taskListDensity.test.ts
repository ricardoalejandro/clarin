import { describe, expect, it } from 'vitest'
import { taskListDensity, taskListPresentation } from './taskListDensity'

describe('task list density', () => {
  it('uses measured container width for every layout tier', () => {
    expect(taskListDensity(759)).toBe('stacked')
    expect(taskListDensity(760)).toBe('compact')
    expect(taskListDensity(1119)).toBe('compact')
    expect(taskListDensity(1120)).toBe('comfortable')
    expect(taskListDensity(640)).toBe('stacked')
    expect(taskListDensity(900)).toBe('compact')
    expect(taskListDensity(1320)).toBe('comfortable')
  })

  it('fits eleven compact rows and a group header in 600 pixels', () => {
    const compact = taskListPresentation('compact')
    expect(compact.rowHeight * 11 + compact.groupHeight).toBeLessThanOrEqual(600)
    expect(compact.gridClass).toContain('minmax(200px,1fr)')
    expect(taskListPresentation('stacked').gridClass).toContain('40px')
  })
})
