import type { TaskFolder, TaskList } from '@/types/task'

export type TaskHierarchyLoadPhase = 'idle' | 'loading' | 'ready' | 'error'

export interface TaskFolderChildrenState {
  phase: TaskHierarchyLoadPhase
  nextCursor: string | null
  error?: string
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

