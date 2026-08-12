import { describe, expect, it } from 'vitest'
import type { TaskFolder, TaskList } from '@/types/task'
import {
  folderChildrenShouldLoad, mergeFolderListPage, mergeFolderPage, mergeRootListPage,
  removeTaskContainerFromActiveHierarchy, taskContainerLifecycleMutationFromEvent,
  taskContainerListIDs, taskScopeAffectedByContainerRemoval,
} from './taskHierarchyLazy'

const list = (id: string, folderID?: string) => ({ id, folder_id: folderID } as TaskList)
const folder = (id: string, lists: TaskList[] = []) => ({ id, lists } as TaskFolder)

describe('lazy environment hierarchy', () => {
  it('refreshes folder metadata without discarding children already loaded by the user', () => {
    const merged = mergeFolderPage([folder('f1', [list('l1', 'f1')])], [{ ...folder('f1'), open_task_count: 9 }], true)
    expect(merged[0].open_task_count).toBe(9)
    expect(merged[0].lists.map(item => item.id)).toEqual(['l1'])
  })

  it('keeps root and child cursors isolated and deduplicates overlapping pages', () => {
    expect(mergeRootListPage([list('root-1')], [list('root-1'), list('root-2')], false).map(item => item.id))
      .toEqual(['root-1', 'root-2'])
    const folders = mergeFolderListPage([folder('f1'), folder('f2')], 'f1', [list('l1', 'f1')], true)
    expect(folders[0].lists.map(item => item.id)).toEqual(['l1'])
    expect(folders[1].lists).toEqual([])
  })

  it('loads idle/error folders but not a ready or in-flight folder twice', () => {
    expect(folderChildrenShouldLoad()).toBe(true)
    expect(folderChildrenShouldLoad({ phase: 'error', nextCursor: null })).toBe(true)
    expect(folderChildrenShouldLoad({ phase: 'loading', nextCursor: null })).toBe(false)
    expect(folderChildrenShouldLoad({ phase: 'ready', nextCursor: null })).toBe(false)
  })

  it('removes a lifecycle list from root or lazy folder children without disturbing siblings', () => {
    const hierarchy = {
      rootLists: [list('root-1'), list('root-2')],
      folders: [folder('f1', [list('nested-1', 'f1'), list('nested-2', 'f1')])],
    }
    const rootResult = removeTaskContainerFromActiveHierarchy(hierarchy, { type: 'list', id: 'root-1' })
    expect(rootResult.rootLists.map(item => item.id)).toEqual(['root-2'])
    expect(rootResult.folders[0].lists.map(item => item.id)).toEqual(['nested-1', 'nested-2'])

    const nestedResult = removeTaskContainerFromActiveHierarchy(hierarchy, { type: 'list', id: 'nested-1' })
    expect(nestedResult.rootLists.map(item => item.id)).toEqual(['root-1', 'root-2'])
    expect(nestedResult.folders[0].lists.map(item => item.id)).toEqual(['nested-2'])
  })

  it('removes a folder and identifies selected descendants and affected list IDs', () => {
    const hierarchy = {
      rootLists: [list('root-1')],
      folders: [folder('f1', [list('nested-1', 'f1')]), folder('f2', [list('nested-2', 'f2')])],
    }
    expect(taskScopeAffectedByContainerRemoval({ type: 'list', id: 'nested-1' }, hierarchy, { type: 'folder', id: 'f1' })).toBe(true)
    expect(taskScopeAffectedByContainerRemoval({ type: 'list', id: 'nested-2' }, hierarchy, { type: 'folder', id: 'f1' })).toBe(false)
    expect(Array.from(taskContainerListIDs(hierarchy, { type: 'folder', id: 'f1' }))).toEqual(['nested-1'])
    expect(removeTaskContainerFromActiveHierarchy(hierarchy, { type: 'folder', id: 'f1' }).folders.map(item => item.id)).toEqual(['f2'])
  })

  it('maps only archive and Trash structural events into the shared lifecycle reducer', () => {
    expect(taskContainerLifecycleMutationFromEvent('list_archived', { list_id: 'l1', operation_id: 'op-1' }))
      .toEqual({ type: 'list', id: 'l1', action: 'archived', operationID: 'op-1' })
    expect(taskContainerLifecycleMutationFromEvent('folder_trashed', { target_type: 'folder', target_id: 'f1' }))
      .toEqual({ type: 'folder', id: 'f1', action: 'trashed', operationID: undefined })
    expect(taskContainerLifecycleMutationFromEvent('list_restored', { list_id: 'l1' })).toBeNull()
  })

  it('returns the same hierarchy when an already removed event is replayed', () => {
    const hierarchy = { rootLists: [list('root-1')], folders: [folder('f1')] }
    expect(removeTaskContainerFromActiveHierarchy(hierarchy, { type: 'list', id: 'missing' })).toBe(hierarchy)
  })
})
