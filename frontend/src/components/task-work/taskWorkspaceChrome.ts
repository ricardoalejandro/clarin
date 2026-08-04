import type { TaskGroupBy } from '@/types/task'

export type TaskWorkspaceChromeDensity = 'narrow' | 'compact' | 'comfortable'

export const TASK_GROUP_LABELS: Record<TaskGroupBy, string> = {
  none: 'Sin agrupación',
  status: 'Estado',
  list: 'Lista',
  assignee: 'Responsable',
  priority: 'Prioridad',
  type: 'Tipo',
  due: 'Fecha de vencimiento',
}

export function taskWorkspaceChromeDensity(width: number): TaskWorkspaceChromeDensity {
  if (width > 0 && width < 760) return 'narrow'
  if (width > 0 && width < 1100) return 'compact'
  return 'comfortable'
}

export function taskGroupingTriggerText(groupBy: TaskGroupBy, density: TaskWorkspaceChromeDensity) {
  if (density === 'narrow') return ''
  const label = TASK_GROUP_LABELS[groupBy]
  return density === 'comfortable' ? `Agrupar: ${label}` : label
}

export function showIndependentListsHeading(rootListCount: number, phase: 'idle' | 'loading' | 'ready' | 'error', structuralDragActive: boolean) {
  return rootListCount > 0 || phase === 'loading' || phase === 'error' || structuralDragActive
}
