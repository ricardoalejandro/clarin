import type { TaskFolder, TaskList } from '@/types/task'

export type TaskHierarchyLoadPhase = 'idle' | 'loading' | 'ready' | 'error'

export interface TaskFolderChildrenState {
  phase: TaskHierarchyLoadPhase
  nextCursor: string | null
  error?: string
}

export interface TaskContainerLifecycleMutation {
  type: 'list' | 'folder'
  id: string
  action: 'archived' | 'trashed'
  operationID?: string
}

type ActiveHierarchy = {
  folders: TaskFolder[]
  rootLists: TaskList[]
}

type TaskContainerEventPayload = {
  target_type?: 'list' | 'folder' | 'task' | 'environment'
  target_id?: string
  list_id?: string
  folder_id?: string
  operation_id?: string
}

export function mergeFolderPage(current: TaskFolder[], incoming: TaskFolder[], reset: boolean) {
  const currentByID = new Map(current.map(folder => [folder.id, folder]))
  const normalized = incoming.map(folder => ({
    ...folder,
    lists: currentByID.get(folder.id)?.lists || folder.lists || [],
  }))
  if (reset) return normalized
  const next = [...current]
  const indexes = new Map(next.map((folder, index) => [folder.id, index]))
  for (const folder of normalized) {
    const index = indexes.get(folder.id)
    if (index === undefined) {
      indexes.set(folder.id, next.length)
      next.push(folder)
    } else next[index] = folder
  }
  return next
}

export function mergeRootListPage(current: TaskList[], incoming: TaskList[], reset: boolean) {
  if (reset) return Array.from(new Map(incoming.map(list => [list.id, list])).values())
  const next = [...current]
  const indexes = new Map(next.map((list, index) => [list.id, index]))
  for (const list of incoming) {
    const index = indexes.get(list.id)
    if (index === undefined) {
      indexes.set(list.id, next.length)
      next.push(list)
    } else next[index] = list
  }
  return next
}

export function mergeFolderListPage(folders: TaskFolder[], folderID: string, incoming: TaskList[], reset: boolean) {
  return folders.map(folder => folder.id !== folderID ? folder : {
    ...folder,
    lists: mergeRootListPage(folder.lists || [], incoming, reset),
  })
}

export function folderChildrenShouldLoad(state?: TaskFolderChildrenState) {
  return !state || state.phase === 'idle' || state.phase === 'error'
}

export function removeTaskContainerFromActiveHierarchy<T extends ActiveHierarchy>(
  hierarchy: T,
  mutation: Pick<TaskContainerLifecycleMutation, 'type' | 'id'>,
): T {
  if (mutation.type === 'folder') {
    const folders = hierarchy.folders.filter(folder => folder.id !== mutation.id)
    return folders.length === hierarchy.folders.length ? hierarchy : { ...hierarchy, folders }
  }
  let changed = false
  const rootLists = hierarchy.rootLists.filter(list => {
    const keep = list.id !== mutation.id
    if (!keep) changed = true
    return keep
  })
  const folders = hierarchy.folders.map(folder => {
    const lists = (folder.lists || []).filter(list => list.id !== mutation.id)
    if (lists.length === (folder.lists || []).length) return folder
    changed = true
    return { ...folder, lists }
  })
  return changed ? { ...hierarchy, folders, rootLists } : hierarchy
}

export function taskContainerListIDs(
  hierarchy: ActiveHierarchy,
  mutation: Pick<TaskContainerLifecycleMutation, 'type' | 'id'>,
) {
  if (mutation.type === 'list') return new Set([mutation.id])
  const folder = hierarchy.folders.find(item => item.id === mutation.id)
  return new Set((folder?.lists || []).map(list => list.id))
}

export function taskScopeAffectedByContainerRemoval(
  scope: { type: string; id?: string },
  hierarchy: ActiveHierarchy,
  mutation: Pick<TaskContainerLifecycleMutation, 'type' | 'id'>,
) {
  if (mutation.type === 'list') return scope.type === 'list' && scope.id === mutation.id
  if (scope.type === 'folder') return scope.id === mutation.id
  if (scope.type !== 'list' || !scope.id) return false
  return hierarchy.folders.some(folder => folder.id === mutation.id && (folder.lists || []).some(list => list.id === scope.id))
}

export function taskContainerLifecycleMutationFromEvent(
  action: string,
  payload: TaskContainerEventPayload,
): TaskContainerLifecycleMutation | null {
  const descriptors = {
    list_archived: { type: 'list', action: 'archived', id: payload.list_id || (payload.target_type === 'list' ? payload.target_id : '') },
    list_trashed: { type: 'list', action: 'trashed', id: payload.list_id || (payload.target_type === 'list' ? payload.target_id : '') },
    folder_archived: { type: 'folder', action: 'archived', id: payload.folder_id || (payload.target_type === 'folder' ? payload.target_id : '') },
    folder_trashed: { type: 'folder', action: 'trashed', id: payload.folder_id || (payload.target_type === 'folder' ? payload.target_id : '') },
  } as const
  const descriptor = descriptors[action as keyof typeof descriptors]
  const id = descriptor?.id
  if (!descriptor || !id) return null
  return { type: descriptor.type, id, action: descriptor.action, operationID: payload.operation_id }
}
