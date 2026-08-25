import type { Task, TaskStatusCategory, TaskWorkflowStatus } from '@/types/task'

export type TaskCompletionAction = 'complete' | 'reopen'

export interface TaskCompletionTransition {
  action: TaskCompletionAction
  currentCategory: TaskStatusCategory
  target: TaskWorkflowStatus
}

const legacyCategory: Record<Task['status'], TaskStatusCategory> = {
  pending: 'not_started',
  overdue: 'active',
  completed: 'done',
  cancelled: 'cancelled',
}

export function taskStatusCategory(task: Pick<Task, 'status' | 'status_id' | 'status_detail'>, statuses: TaskWorkflowStatus[]): TaskStatusCategory {
  return task.status_detail?.category
    || statuses.find(status => status.id === task.status_id)?.category
    || legacyCategory[task.status]
}

export function preferredStatusForCategory(statuses: TaskWorkflowStatus[], category: TaskStatusCategory): TaskWorkflowStatus | null {
  return [...statuses]
    .filter(status => status.category === category)
    .sort((left, right) => Number(right.is_default) - Number(left.is_default) || left.sort_order - right.sort_order || left.name.localeCompare(right.name))[0]
    || null
}

export function taskCompletionTransition(task: Pick<Task, 'status' | 'status_id' | 'status_detail'>, statuses: TaskWorkflowStatus[]): TaskCompletionTransition | null {
  const currentCategory = taskStatusCategory(task, statuses)
  const action: TaskCompletionAction = currentCategory === 'done' || currentCategory === 'cancelled' ? 'reopen' : 'complete'
  const target = preferredStatusForCategory(statuses, action === 'complete' ? 'done' : 'not_started')
  if (!target || target.id === task.status_id) return null
  return { action, currentCategory, target }
}
