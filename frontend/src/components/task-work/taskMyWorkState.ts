import type { TaskMyWorkItem, TaskMyWorkMutation, TaskMyWorkResponse } from '@/types/task'

export function reorderTaskMyWorkItems(items: TaskMyWorkItem[], activeID: string, overID: string | null) {
  if (!overID || activeID === overID) return items
  const from = items.findIndex(item => item.task.id === activeID)
  const to = items.findIndex(item => item.task.id === overID)
  if (from < 0 || to < 0) return items
  const next = [...items]
  const [moving] = next.splice(from, 1)
  next.splice(to, 0, moving)
  return next
}

export function taskMyWorkBeforeTaskID(items: TaskMyWorkItem[], activeID: string) {
  const index = items.findIndex(item => item.task.id === activeID)
  return index >= 0 && index < items.length - 1 ? items[index + 1].task.id : null
}

export function applyTaskMyWorkMutationOrder(data: TaskMyWorkResponse, mutation: TaskMyWorkMutation): TaskMyWorkResponse {
  const byID = new Map([...data.focus_items, ...data.completed_items].map(item => [item.task.id, item]))
  const ordered = mutation.ordered_task_ids.flatMap(id => {
    const item = byID.get(id)
    return item ? [item] : []
  })
  return {
    ...data,
    focus_items: ordered.filter(item => !taskMyWorkItemClosed(item)),
    completed_items: ordered.filter(taskMyWorkItemClosed),
    summary: {
      ...data.summary,
      business_date: mutation.business_date,
      revision: mutation.revision,
      focus_count: mutation.focus_count,
      completed_count: mutation.completed_count,
    },
  }
}

export function taskMyWorkItemClosed(item: TaskMyWorkItem) {
  const category = item.task.status_detail?.category
  return category === 'done' || category === 'cancelled' || item.task.status === 'completed' || item.task.status === 'cancelled'
}

export function taskMyWorkShouldRefresh(raw: unknown) {
  if (!raw || typeof raw !== 'object') return false
  const message = raw as { event?: string; data?: { action?: string; task_id?: string; task?: unknown } }
  if (message.event !== 'task_update') return false
  const action = message.data?.action || ''
  return action.startsWith('my_work_') || Boolean(message.data?.task_id || message.data?.task)
}
