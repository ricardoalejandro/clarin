import {
  TASK_PRIORITY_CONFIG,
  TASK_TYPE_CONFIG,
  type Task,
  type TaskGroupBy,
  type TaskGroupDirection,
  type TaskList,
  type TaskWorkflowStatus,
} from '@/types/task'

export interface TaskListGroup {
  key: string
  label: string
  color: string
  value: string | null
  tasks: Task[]
}

const dueKey = (task: Task, now: Date) => {
  if (!task.due_at) return 'none'
  const due = new Date(task.due_at)
  if (!Number.isFinite(due.getTime())) return 'none'
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1)
  const week = new Date(today); week.setDate(today.getDate() + 7)
  if (due < today) return 'overdue'
  if (due < tomorrow) return 'today'
  if (due < week) return 'week'
  return 'later'
}

export function taskListGroupKey(task: Task, groupBy: TaskGroupBy, now = new Date()): string {
  switch (groupBy) {
  case 'none': return 'all'
  case 'status': return task.status_id || 'none'
  case 'list': return task.list_id || 'none'
  case 'assignee': return task.assigned_to || 'none'
  case 'priority': return task.priority || 'none'
  case 'type': return task.type || 'none'
  case 'due': return dueKey(task, now)
  }
}

export function buildTaskListGroups(
  tasks: Task[],
  groupBy: TaskGroupBy,
  direction: TaskGroupDirection,
  statuses: TaskWorkflowStatus[],
  lists: TaskList[],
  now = new Date(),
): TaskListGroup[] {
  const statusMap = new Map(statuses.map(status => [status.id, status]))
  const listMap = new Map(lists.map(list => [list.id, list]))
  const order = groupBy === 'due'
    ? ['overdue', 'today', 'week', 'later', 'none']
    : Array.from(new Set(tasks.map(task => taskListGroupKey(task, groupBy, now))))
  const groups = order.map((key): TaskListGroup => {
    const matching = tasks.filter(task => taskListGroupKey(task, groupBy, now) === key)
    if (groupBy === 'none') return { key, label: 'Todas las tareas', color: '#64748b', value: null, tasks: matching }
    if (groupBy === 'status') {
      const status = statusMap.get(key)
      return { key, label: status?.name || 'Sin estado', color: status?.color || '#94a3b8', value: status?.category || null, tasks: matching }
    }
    if (groupBy === 'list') {
      const list = listMap.get(key)
      return { key, label: list?.name || 'Sin lista', color: list?.color || '#94a3b8', value: list?.id || null, tasks: matching }
    }
    if (groupBy === 'assignee') {
      return { key, label: matching[0]?.assigned_to_name || 'Sin responsable', color: '#8b5cf6', value: key === 'none' ? null : key, tasks: matching }
    }
    if (groupBy === 'priority') {
      const config = TASK_PRIORITY_CONFIG[key as keyof typeof TASK_PRIORITY_CONFIG]
      return { key, label: config?.label || 'Sin prioridad', color: key === 'urgent' ? '#ef4444' : key === 'high' ? '#f97316' : key === 'medium' ? '#3b82f6' : '#64748b', value: config ? key : null, tasks: matching }
    }
    if (groupBy === 'type') {
      const config = TASK_TYPE_CONFIG[key as keyof typeof TASK_TYPE_CONFIG]
      return { key, label: config?.label || 'Sin tipo', color: '#0f766e', value: config ? key : null, tasks: matching }
    }
    const due = {
      overdue: ['Vencidas', '#ef4444'], today: ['Hoy', '#f97316'], week: ['Próximos 7 días', '#3b82f6'], later: ['Más adelante', '#10b981'], none: ['Sin fecha', '#94a3b8'],
    }[key] || ['Sin fecha', '#94a3b8']
    return { key, label: due[0], color: due[1], value: key === 'none' ? null : key, tasks: matching }
  }).filter(group => group.tasks.length || (groupBy === 'due' && group.key === 'none'))
  return direction === 'desc' ? [...groups].reverse() : groups
}

export function taskListDropMutation(groupBy: TaskGroupBy, group: TaskListGroup) {
  if (groupBy === 'status') return group.value ? { endpoint: 'move' as const, statusCategory: group.value } : null
  if (groupBy === 'list') return group.value ? { endpoint: 'move' as const, listId: group.value } : null
  if (groupBy === 'assignee') return group.value ? { endpoint: 'update' as const, property: 'assigned_to', value: group.value } : null
  if (groupBy === 'priority') return group.value ? { endpoint: 'update' as const, property: 'priority', value: group.value } : null
  if (groupBy === 'type') return group.value ? { endpoint: 'update' as const, property: 'type', value: group.value } : null
  if (groupBy === 'due') return { endpoint: 'date' as const, clear: group.key === 'none' }
  return null
}

export function taskListCursor(state: 'idle' | 'handle' | 'dragging' | 'selecting') {
  if (state === 'dragging') return 'grabbing'
  if (state === 'handle') return 'grab'
  return 'pointer'
}

export function reorderTaskSelection(tasks: Task[], selectedIDs: string[], beforeTaskID: string) {
  const selected = new Set(selectedIDs)
  if (!selectedIDs.length || selected.has(beforeTaskID)) return tasks
  const moving = selectedIDs.map(id => tasks.find(task => task.id === id)).filter((task): task is Task => Boolean(task))
  const base = tasks.filter(task => !selected.has(task.id))
  const anchor = base.findIndex(task => task.id === beforeTaskID)
  if (!moving.length || anchor < 0) return tasks
  return [...base.slice(0, anchor), ...moving, ...base.slice(anchor)]
}
