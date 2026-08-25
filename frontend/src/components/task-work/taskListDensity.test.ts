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
    expect(compact.rowHeight).toBe(44)
    expect(compact.touchRowHeight).toBe(56)
    expect(compact.gridClass).toContain('minmax(200px,1fr)')
    expect(compact.actionMode).toBe('menu')
    expect(compact.actionSlotClass).toContain('w-9')
    expect(taskListPresentation('comfortable').actionMode).toBe('direct')
    expect(taskListPresentation('comfortable').actionSlotClass).toContain('w-[104px]')
    expect(taskListPresentation('comfortable').gridClass).not.toContain('_34px]')
    expect(taskListPresentation('stacked').gridClass).toBe('grid-cols-[26px_minmax(0,1fr)] [@media(pointer:coarse)]:grid-cols-[44px_minmax(0,1fr)]')
  })
})
