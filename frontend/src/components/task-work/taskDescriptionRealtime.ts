import type { Task } from '@/types/task'

export interface TaskDescriptionRealtimePayload {
  action?: string
  task_id?: string
  description?: string
  version?: number
  updated_at?: string
}

export interface TaskDescriptionRealtimeResult {
  tasks: Task[]
  changed: boolean
}

/**
 * Applies the narrow description event without reloading the task collection.
 * Version ordering remains authoritative; same-version echoes and older events
 * are ignored so a delayed socket message cannot roll a task back.
 */
export function reconcileTaskDescriptionRealtime(
  tasks: Task[],
  payload: TaskDescriptionRealtimePayload,
): TaskDescriptionRealtimeResult {
  if (payload.action !== 'description_updated'
    || !payload.task_id
    || typeof payload.description !== 'string'
    || !Number.isFinite(payload.version)) {
    return { tasks, changed: false }
  }

  const index = tasks.findIndex(task => task.id === payload.task_id)
  if (index < 0) return { tasks, changed: false }

  const current = tasks[index]
  if (Number(payload.version) <= Number(current.version || 0)) {
    return { tasks, changed: false }
  }

  const next = [...tasks]
  next[index] = {
    ...current,
    description: payload.description,
    version: Number(payload.version),
    updated_at: payload.updated_at || current.updated_at,
  }
  return { tasks: next, changed: true }
}
