import type { Task, TaskFilters, TaskFolder, TaskViewMode } from '@/types/task'
import { taskMatchesClosedVisibility } from './taskClosedVisibility'

export type TaskWorkspaceScope =
  | { type: 'all' }
  | { type: 'environment'; id: string }
  | { type: 'shared' }
  | { type: 'folder'; id: string }
  | { type: 'list'; id: string }
  | { type: 'trash' }

export function hasActiveTaskQuery(search: string, filterCount: number) {
  return search.trim().length > 0 || filterCount > 0
}

export function upsertCanonicalTask(tasks: Task[], incoming: Task) {
  const index = tasks.findIndex(task => task.id === incoming.id)
  if (index < 0) return [incoming, ...tasks]
  if ((tasks[index].version || 0) > (incoming.version || 0)) return tasks
  return tasks.map(task => task.id === incoming.id ? incoming : task)
}

export function taskBelongsToWorkspaceScope(
  task: Task,
  scope: TaskWorkspaceScope,
  activeEnvironmentID: string,
  folders: Pick<TaskFolder, 'id' | 'lists'>[],
  alreadyVisible = false,
) {
  if (task.parent_task_id) return false
  if (scope.type === 'trash') return Boolean(task.deleted_at)
  if (task.deleted_at) return false
  if (scope.type === 'list') return task.list_id === scope.id
  if (scope.type === 'folder') {
    return Boolean(folders.find(folder => folder.id === scope.id)?.lists.some(list => list.id === task.list_id))
  }
  if (scope.type === 'environment') return task.environment_id === scope.id
  if (scope.type === 'shared') return alreadyVisible && task.environment_id === activeEnvironmentID
  return Boolean(activeEnvironmentID && task.environment_id === activeEnvironmentID)
}

function dateKey(value?: string) {
  if (!value) return ''
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10)
}

export function taskMatchesWorkspaceFilters(
  task: Task,
  filters: TaskFilters,
  view: TaskViewMode,
  search = '',
  now = new Date(),
) {
  if (!taskMatchesClosedVisibility(task, filters, view)) return false
  if (filters.status_ids.length && !filters.status_ids.includes(task.status_id || task.status)) return false
  if (filters.assigned_to_ids.length && !filters.assigned_to_ids.includes(task.assigned_to)) return false
  if (filters.collaborator_ids.length && !filters.collaborator_ids.some(id => task.collaborators?.some(item => item.user_id === id))) return false
  if (filters.priorities.length && !filters.priorities.includes(task.priority)) return false
  if (filters.types.length && !filters.types.includes(task.type)) return false
  if (filters.creator_ids.length && !filters.creator_ids.includes(task.created_by)) return false
  if (filters.has_subtasks !== undefined && Boolean(task.subtask_count) !== filters.has_subtasks) return false
  if (filters.has_comments !== undefined && Boolean(task.comment_count) !== filters.has_comments) return false
  if (filters.has_attachments !== undefined && Boolean(task.attachment_count) !== filters.has_attachments) return false
  if (filters.has_dependencies !== undefined && Boolean(task.dependency_count) !== filters.has_dependencies) return false
  if (filters.starred !== undefined && Boolean(task.starred) !== filters.starred) return false

  const created = dateKey(task.created_at)
  const completed = dateKey(task.completed_at)
  if (filters.created_from && (!created || created < filters.created_from)) return false
  if (filters.created_to && (!created || created > filters.created_to)) return false
  if (filters.completed_from && (!completed || completed < filters.completed_from)) return false
  if (filters.completed_to && (!completed || completed > filters.completed_to)) return false

  if (filters.due) {
    const due = task.due_at ? new Date(task.due_at) : null
    const validDue = due && !Number.isNaN(due.getTime()) ? due : null
    const today = new Date(now)
    today.setHours(0, 0, 0, 0)
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const weekEnd = new Date(today)
    weekEnd.setDate(weekEnd.getDate() + 7)
    if (filters.due === 'no_date' && validDue) return false
    const closed = task.status === 'completed' || task.status === 'cancelled' || task.status_detail?.category === 'done' || task.status_detail?.category === 'cancelled'
    if (filters.due === 'overdue' && (!validDue || validDue >= now || closed)) return false
    if (filters.due === 'today' && (!validDue || validDue < today || validDue >= tomorrow)) return false
    if (filters.due === 'this_week' && (!validDue || validDue < today || validDue >= weekEnd)) return false
  }

  const needle = search.trim().toLocaleLowerCase('es')
  if (needle) {
    const haystack = [task.title, task.description, task.list_name, task.folder_name, task.assigned_to_name, task.created_by_name]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase('es')
    if (!haystack.includes(needle)) return false
  }
  return true
}

export function reconcileCanonicalTaskBatch(
  current: Task[],
  incoming: Task[],
  options: {
    scope: TaskWorkspaceScope
    activeEnvironmentID: string
    folders: Pick<TaskFolder, 'id' | 'lists'>[]
    filters: TaskFilters
    view: TaskViewMode
    search?: string
  },
) {
  const incomingByID = new Map(incoming.map(task => [task.id, task]))
  const next = current.flatMap(existing => {
    const canonical = incomingByID.get(existing.id)
    if (!canonical) return [existing]
    incomingByID.delete(existing.id)
    const belongs = taskBelongsToWorkspaceScope(canonical, options.scope, options.activeEnvironmentID, options.folders, true)
      && taskMatchesWorkspaceFilters(canonical, options.filters, options.view, options.search)
    if (!belongs) return []
    return [{ ...existing, ...canonical, status_detail: canonical.status_detail || existing.status_detail }]
  })
  Array.from(incomingByID.values()).forEach(canonical => {
    if (taskBelongsToWorkspaceScope(canonical, options.scope, options.activeEnvironmentID, options.folders)
      && taskMatchesWorkspaceFilters(canonical, options.filters, options.view, options.search)) {
      next.unshift(canonical)
    }
  })
  return next
}

export function normalizeExpandedFolders(raw: string | null, availableIDs: string[]) {
  const available = new Set(availableIDs)
  if (raw === null) return new Set(availableIDs)
  try {
    const saved = JSON.parse(raw)
    if (!Array.isArray(saved)) return new Set(availableIDs)
    return new Set(saved.filter((id): id is string => typeof id === 'string' && available.has(id)))
  } catch {
    return new Set(availableIDs)
  }
}

export function toggleExpandedFolder(current: Set<string>, folderID: string) {
  const next = new Set(current)
  if (next.has(folderID)) next.delete(folderID)
  else next.add(folderID)
  return next
}

export function ensureExpandedFolder(current: Set<string>, folderID?: string) {
  if (!folderID || current.has(folderID)) return current
  return new Set(Array.from(current).concat(folderID))
}

export function folderAutoExpandedForScope(scope: { type: string; id?: string }, lists: Array<{ id: string; folder_id?: string | null }>) {
  if (scope.type !== 'list' || !scope.id) return undefined
  return lists.find(list => list.id === scope.id)?.folder_id || undefined
}
