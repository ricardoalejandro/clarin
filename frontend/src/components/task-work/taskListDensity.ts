export type TaskListDensity = 'stacked' | 'compact' | 'comfortable'

export const TASK_LIST_PRESENTATION = {
  comfortable: {
    rowHeight: 48,
    groupHeight: 40,
    gridClass: 'grid-cols-[26px_minmax(260px,1fr)_minmax(136px,160px)_minmax(112px,140px)_76px_34px]',
  },
  compact: {
    rowHeight: 48,
    groupHeight: 40,
    gridClass: 'grid-cols-[26px_minmax(200px,1fr)_136px_minmax(96px,120px)_68px_34px]',
  },
  stacked: {
    rowHeight: 48,
    groupHeight: 40,
    gridClass: 'grid-cols-[26px_minmax(0,1fr)_40px]',
  },
} as const

export function taskListPresentation(density: TaskListDensity) {
  return TASK_LIST_PRESENTATION[density]
}

export function taskListDensity(width: number): TaskListDensity {
  if (width > 0 && width < 760) return 'stacked'
  if (width > 0 && width < 1120) return 'compact'
  return 'comfortable'
}
