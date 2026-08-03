import type { TaskFolder, TaskList } from '@/types/task'
import type { TaskHierarchyState } from './taskHierarchyCounts'

export type TaskHierarchyCreateMutation =
  | { type: 'folder'; folder: TaskFolder }
  | { type: 'list'; list: TaskList }

function ordered<T extends { sort_order: number; id: string }>(items: T[]) {
  return [...items].sort((left, right) => left.sort_order - right.sort_order || left.id.localeCompare(right.id))
}

export function mergeCreatedTaskHierarchy(state: TaskHierarchyState, mutation: TaskHierarchyCreateMutation): TaskHierarchyState {
  if (mutation.type === 'folder') {
    const folder = { ...mutation.folder, lists: mutation.folder.lists || [] }
    return { ...state, folders: ordered([...state.folders.filter(item => item.id !== folder.id), folder]) }
  }

  const list = mutation.list
  if (!list.folder_id) {
    return {
      ...state,
      rootLists: ordered([...state.rootLists.filter(item => item.id !== list.id), list]),
      folders: state.folders.map(folder => ({ ...folder, lists: folder.lists.filter(item => item.id !== list.id) })),
    }
  }

  return {
    ...state,
    rootLists: state.rootLists.filter(item => item.id !== list.id),
    folders: state.folders.map(folder => folder.id !== list.folder_id ? folder : {
      ...folder,
      lists: ordered([...folder.lists.filter(item => item.id !== list.id), list]),
    }),
  }
}
