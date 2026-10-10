import type { Task } from '@/types/task'

export interface TaskMediaRealtimeEvent {
  action?: string
  task_id?: string
  origin?: string
  attachment_scope?: string
}

/** Comment media are not part of the task's attachment badge. Canonical task
 * reconciliation still follows each event, including echoes from this client. */
export function reconcileTaskMediaCounts(task: Task, event: TaskMediaRealtimeEvent): Task {
  if (task.id !== event.task_id) return task
  if (event.action === 'comment_created') return { ...task, comment_count: (task.comment_count || 0) + 1 }
  if (event.action === 'comment_deleted') return { ...task, comment_count: Math.max(0, (task.comment_count || 0) - 1) }
  if (event.action !== 'attachment_added' && event.action !== 'attachment_deleted') return task
  if (event.attachment_scope && event.attachment_scope !== 'task') return task
  // New storage events must specify their scope. Older normal attachment
  // events retain their historical task-scoped behavior.
  if (event.origin === 'storage' && event.attachment_scope !== 'task') return task
  return { ...task, attachment_count: Math.max(0, (task.attachment_count || 0) + (event.action === 'attachment_added' ? 1 : -1)) }
}
