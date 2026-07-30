export type TaskListDensity = 'stacked' | 'compact' | 'comfortable'

export function taskListDensity(width: number): TaskListDensity {
  if (width > 0 && width < 760) return 'stacked'
  if (width > 0 && width < 1120) return 'compact'
  return 'comfortable'
}
