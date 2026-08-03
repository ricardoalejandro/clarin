import { describe, expect, it } from 'vitest'
import type { TaskFolder, TaskList } from '@/types/task'
import { folderChildrenShouldLoad, mergeFolderListPage, mergeFolderPage, mergeRootListPage } from './taskHierarchyLazy'

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
})

