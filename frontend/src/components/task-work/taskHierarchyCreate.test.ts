import { describe, expect, it } from 'vitest'
import type { TaskFolder, TaskList } from '@/types/task'
import { mergeCreatedTaskHierarchy } from './taskHierarchyCreate'

const now = '2026-08-02T00:00:00Z'
const list = (id: string, folderId?: string, order = 1024): TaskList => ({
  id, account_id: 'account-1', environment_id: 'environment-1', folder_id: folderId,
  name: id, color: '#10B981', icon: 'list', sort_order: order, created_by: 'user-1',
  created_at: now, updated_at: now, task_count: 0, open_task_count: 0,
  completed_task_count: 0, cancelled_task_count: 0, is_default: false, workflow_inherited: true,
})
const folder = (id: string, lists: TaskList[] = [], order = 1024): TaskFolder => ({
  id, account_id: 'account-1', environment_id: 'environment-1', name: id, color: '#10B981', icon: 'folder',
  sort_order: order, created_by: 'user-1', created_at: now, updated_at: now, task_count: 0,
  open_task_count: 0, completed_task_count: 0, cancelled_task_count: 0, lists,
})

describe('mergeCreatedTaskHierarchy', () => {
  it('adds a folder once in canonical order', () => {
    const initial = { folders: [folder('later', [], 2048)], rootLists: [] }
    const created = folder('first', [], 1024)
    const once = mergeCreatedTaskHierarchy(initial, { type: 'folder', folder: created })
    const twice = mergeCreatedTaskHierarchy(once, { type: 'folder', folder: created })
    expect(twice.folders.map(item => item.id)).toEqual(['first', 'later'])
  })

  it('adds a nested list without losing already loaded siblings', () => {
    const existing = list('existing', 'folder-1', 1024)
    const created = list('created', 'folder-1', 2048)
    const next = mergeCreatedTaskHierarchy({ folders: [folder('folder-1', [existing])], rootLists: [] }, { type: 'list', list: created })
    expect(next.folders[0].lists.map(item => item.id)).toEqual(['existing', 'created'])
  })

  it('moves a canonical create response to root without duplicates', () => {
    const existing = list('list-1', 'folder-1')
    const next = mergeCreatedTaskHierarchy({ folders: [folder('folder-1', [existing])], rootLists: [] }, { type: 'list', list: { ...existing, folder_id: undefined } })
    expect(next.rootLists.map(item => item.id)).toEqual(['list-1'])
    expect(next.folders[0].lists).toHaveLength(0)
  })
})
