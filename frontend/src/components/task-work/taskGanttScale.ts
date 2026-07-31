export type TaskGanttScale = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'flexible'

export function taskGanttCellWidth(scale: TaskGanttScale, flexibleWidth: number) {
  if (scale === 'day') return 48
  if (scale === 'week') return 18
  if (scale === 'month') return 8
  if (scale === 'quarter') return 4
  if (scale === 'year') return 2
  return Math.max(8, Math.min(120, flexibleWidth))
}

export function taskGanttVisibleRange(scrollLeft: number, viewportWidth: number, labelWidth: number, cellWidth: number, count: number, overscan = 10) {
  const start = Math.max(0, Math.floor(Math.max(0, scrollLeft - labelWidth) / cellWidth) - overscan)
  const visible = Math.ceil(Math.max(0, viewportWidth - labelWidth) / cellWidth)
  return { start, end: Math.min(count, start + visible + overscan * 2) }
}
