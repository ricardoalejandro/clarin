import { apiGet } from '@/lib/api'
import type { TaskFilters, TaskWorkSummary } from '@/types/task'

export async function loadTaskSummary(params: URLSearchParams, signal: AbortSignal) {
  const response = await apiGet<{ summary: TaskWorkSummary }>(`/api/tasks/summary?${params}`, { signal })
  return { ...response, data: response.data?.summary }
}

export function appendTaskFilters(params: URLSearchParams, filters: TaskFilters) {
  params.set('include_closed', String(filters.include_closed))
  if (filters.status_ids.length) {
    params.set('status_ids', filters.status_ids.join(','))
    if (filters.status_ids.length === 1) params.set('status', filters.status_ids[0])
  }
  if (filters.assigned_to_ids.length) {
    params.set('assigned_to_ids', filters.assigned_to_ids.join(','))
    if (filters.assigned_to_ids.length === 1) params.set('assigned_to', filters.assigned_to_ids[0])
  }
  if (filters.collaborator_ids.length) params.set('collaborator_ids', filters.collaborator_ids.join(','))
  if (filters.priorities.length) params.set('priorities', filters.priorities.join(','))
  if (filters.types.length) params.set('types', filters.types.join(','))
  if (filters.creator_ids.length) params.set('creator_ids', filters.creator_ids.join(','))
  if (filters.due) params.set('due', filters.due)
  if (filters.created_from) params.set('created_from', filters.created_from)
  if (filters.created_to) params.set('created_to', filters.created_to)
  if (filters.completed_from) params.set('completed_from', filters.completed_from)
  if (filters.completed_to) params.set('completed_to', filters.completed_to)
  if (filters.has_subtasks !== undefined) params.set('has_subtasks', String(filters.has_subtasks))
  if (filters.has_comments !== undefined) params.set('has_comments', String(filters.has_comments))
  if (filters.has_attachments !== undefined) params.set('has_attachments', String(filters.has_attachments))
  if (filters.has_dependencies !== undefined) params.set('has_dependencies', String(filters.has_dependencies))
  if (filters.starred !== undefined) params.set('starred', String(filters.starred))
}
