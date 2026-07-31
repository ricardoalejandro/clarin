import type { Task, TaskFilters, TaskViewMode } from '@/types/task'

export function taskIsClosed(task: Task) {
  const category = task.status_detail?.category
  return category === 'done' || category === 'cancelled' || (!category && (task.status === 'completed' || task.status === 'cancelled'))
}

/** Explicit statuses always win. Otherwise operational views hide closed work
 * while Resumen keeps its historical population. */
export function taskMatchesClosedVisibility(task: Task, filters: TaskFilters, view: TaskViewMode) {
  if (filters.status_ids.length) return Boolean(task.status_id && filters.status_ids.includes(task.status_id))
  if (view === 'summary' || filters.include_closed) return true
  return !taskIsClosed(task)
}

export function taskQueryFiltersForView(filters: TaskFilters, view: TaskViewMode): TaskFilters {
  return view === 'summary' ? { ...filters, include_closed: true } : filters
}

/** Preserve a local task omitted by an older response only when it changed
 * after that request and still belongs to the visible population. */
export function shouldPreserveConcurrentTask(
  task: Task,
  versionAtRequestStart: number,
  queryActive: boolean,
  tombstoned: boolean,
  filters: TaskFilters,
  view: TaskViewMode,
) {
  return !queryActive
    && !tombstoned
    && (task.version || 0) > versionAtRequestStart
    && taskMatchesClosedVisibility(task, filters, view)
}
