import type { Task } from '@/types/task'

export function hasActiveTaskQuery(search: string, filterCount: number) {
  return search.trim().length > 0 || filterCount > 0
}

export function upsertCanonicalTask(tasks: Task[], incoming: Task) {
  const index = tasks.findIndex(task => task.id === incoming.id)
  if (index < 0) return [incoming, ...tasks]
  if ((tasks[index].version || 0) > (incoming.version || 0)) return tasks
  return tasks.map(task => task.id === incoming.id ? incoming : task)
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
