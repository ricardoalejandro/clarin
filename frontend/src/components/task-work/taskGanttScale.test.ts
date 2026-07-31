import { describe, expect, it } from 'vitest'
import { taskGanttCellWidth, taskGanttVisibleRange } from './taskGanttScale'

describe('task Gantt scale', () => {
  it('supports every fixed scale and clamps flexible zoom to 8–120 pixels', () => {
    expect(['day', 'week', 'month', 'quarter', 'year'].map(scale => taskGanttCellWidth(scale as never, 32))).toEqual([48, 18, 8, 4, 2])
    expect(taskGanttCellWidth('flexible', 1)).toBe(8)
    expect(taskGanttCellWidth('flexible', 999)).toBe(120)
  })

  it('returns an overscanned bounded virtual range', () => {
    expect(taskGanttVisibleRange(0, 1000, 270, 10, 500, 5)).toEqual({ start: 0, end: 83 })
    const range = taskGanttVisibleRange(3000, 1000, 270, 10, 500, 5)
    expect(range.start).toBeGreaterThan(0)
    expect(range.end).toBeLessThanOrEqual(500)
  })
})
