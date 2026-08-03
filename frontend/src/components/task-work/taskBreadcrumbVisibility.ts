import type { Task } from '@/types/task'

export function taskLocationLabel(task: Pick<Task, 'breadcrumbs_visible' | 'list_name'>) {
  if (task.breadcrumbs_visible === false) return 'Compartida contigo'
  return task.list_name || 'Bandeja general'
}

