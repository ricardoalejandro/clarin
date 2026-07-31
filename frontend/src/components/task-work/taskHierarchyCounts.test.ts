import { describe, expect, it } from 'vitest'
import type { Task, TaskFolder, TaskList } from '@/types/task'
import {
  applyCanonicalHierarchyCounts,
  hierarchyCountTooltip,
  hierarchyCountSnapshotCursor,
  hierarchyItemOpenCount,
  hierarchyOpenCount,
  preserveHierarchyCounts,
  reduceHierarchyForTaskMutation,
  shouldApplyHierarchyCountSnapshot,
  shouldIgnoreTaskOperationEcho,
  taskHierarchyCountMutationDecision,
  type TaskHierarchyCounts,
} from './taskHierarchyCounts'

const list = (id: string, folderID?: string): TaskList => ({
  id, account_id: 'account', folder_id: folderID, name: id, color: '#10B981', icon: 'list', sort_order: 1,
  created_by: 'user', created_at: '', updated_at: '', task_count: 0, open_task_count: 0,
  completed_task_count: 0, cancelled_task_count: 0,
})
const task = (id: string, listID: string, category: 'not_started' | 'active' | 'done' | 'cancelled'): Task => ({
  id, account_id: 'account', created_by: 'user', assigned_to: 'user', title: id, description: '', type: 'reminder',
  priority: 'medium', status: category === 'done' ? 'completed' : category === 'cancelled' ? 'cancelled' : 'pending',
  status_detail: { id: category, account_id: 'account', workflow_id: 'workflow', name: category, color: '#10B981', category, sort_order: 1, is_default: false, created_at: '', updated_at: '' },
  list_id: listID, recurrence_rule: '', notes: '', created_at: '', updated_at: '',
})

describe('task hierarchy counts', () => {
  it('applies canonical list, folder and global open counts without a reload', () => {
    const root = list('root')
    const child = list('child', 'folder')
    const folder: TaskFolder = { id: 'folder', account_id: 'account', name: 'Folder', color: '#10B981', icon: 'folder', sort_order: 1, created_by: 'user', created_at: '', updated_at: '', task_count: 0, open_task_count: 0, completed_task_count: 0, cancelled_task_count: 0, lists: [child] }
    const snapshot: TaskHierarchyCounts = {
      task_count: 8, open_task_count: 5, completed_task_count: 2, cancelled_task_count: 1,
      lists: [
        { id: 'root', task_count: 3, open_task_count: 2, completed_task_count: 1, cancelled_task_count: 0 },
        { id: 'child', task_count: 5, open_task_count: 3, completed_task_count: 1, cancelled_task_count: 1 },
      ],
      folders: [{ id: 'folder', task_count: 5, open_task_count: 3, completed_task_count: 1, cancelled_task_count: 1 }],
    }
    const next = applyCanonicalHierarchyCounts({ rootLists: [root], folders: [folder] }, snapshot)
    expect(next.rootLists[0].open_task_count).toBe(2)
    expect(next.folders[0].completed_task_count).toBe(1)
    expect(hierarchyOpenCount(next.folders, next.rootLists)).toBe(5)
    expect(hierarchyCountTooltip(next.folders[0])).toBe('3 abiertas · 1 completadas · 1 canceladas · 5 total')
  })

  it('optimistically handles create, complete, reopen, move and trash exactly once', () => {
    const state = { rootLists: [list('a'), list('b')], folders: [] as TaskFolder[] }
    const openA = task('task', 'a', 'active')
    const created = reduceHierarchyForTaskMutation(state, null, openA)
    expect(created.rootLists.map(item => [item.task_count, item.open_task_count])).toEqual([[1, 1], [0, 0]])

    const doneA = task('task', 'a', 'done')
    const completed = reduceHierarchyForTaskMutation(created, openA, doneA)
    expect(completed.rootLists[0]).toMatchObject({ task_count: 1, open_task_count: 0, completed_task_count: 1 })

    const reopened = reduceHierarchyForTaskMutation(completed, doneA, openA)
    expect(reopened.rootLists[0]).toMatchObject({ task_count: 1, open_task_count: 1, completed_task_count: 0 })

    const openB = task('task', 'b', 'active')
    const moved = reduceHierarchyForTaskMutation(reopened, openA, openB)
    expect(moved.rootLists.map(item => item.open_task_count)).toEqual([0, 1])

    const trashed = reduceHierarchyForTaskMutation(moved, openB, null)
    expect(trashed.rootLists.map(item => item.task_count)).toEqual([0, 0])
  })

  it('does not count subtasks as navigation inventory', () => {
    const state = { rootLists: [list('a')], folders: [] as TaskFolder[] }
    const child = { ...task('child', 'a', 'active'), parent_task_id: 'parent' }
    expect(reduceHierarchyForTaskMutation(state, null, child)).toEqual(state)
  })

  it('renders only open inventory and rejects snapshots with an older monotonic revision', () => {
    expect(hierarchyItemOpenCount({ task_count: 9, open_task_count: 2, completed_task_count: 5, cancelled_task_count: 2 })).toBe(2)
    const current = { revision: 12, captured_at: '2026-07-31T15:00:00.000000000Z' }
    expect(shouldApplyHierarchyCountSnapshot(current, {
      revision: 11,
      captured_at: '2026-07-31T16:00:00.000000000Z',
      task_count: 1, open_task_count: 1, completed_task_count: 0, cancelled_task_count: 0, lists: [], folders: [],
    })).toBe(false)
    expect(shouldApplyHierarchyCountSnapshot(current, {
      revision: 13,
      captured_at: '2026-07-31T14:00:00.000000000Z',
      task_count: 2, open_task_count: 2, completed_task_count: 0, cancelled_task_count: 0, lists: [], folders: [],
    })).toBe(true)
    expect(shouldApplyHierarchyCountSnapshot(current, {
      captured_at: '2026-07-31T17:00:00.000000000Z',
      task_count: 3, open_task_count: 3, completed_task_count: 0, cancelled_task_count: 0, lists: [], folders: [],
    })).toBe(false)
    expect(hierarchyCountSnapshotCursor(current, {
      revision: 13, captured_at: '2026-07-31T14:00:00.000000000Z',
      task_count: 2, open_task_count: 2, completed_task_count: 0, cancelled_task_count: 0, lists: [], folders: [],
    })).toEqual({ revision: 13, captured_at: '2026-07-31T14:00:00.000000000Z' })
  })

  it('preserves newer counters when a delayed hierarchy response carries an older snapshot', () => {
    const current = list('shared')
    Object.assign(current, { task_count: 9, open_task_count: 7, completed_task_count: 1, cancelled_task_count: 1 })
    const delayed = list('shared')
    Object.assign(delayed, { task_count: 2, open_task_count: 2, completed_task_count: 0, cancelled_task_count: 0 })
    const newList = list('new')
    Object.assign(newList, { task_count: 1, open_task_count: 1 })

    const merged = preserveHierarchyCounts(
      { rootLists: [delayed, newList], folders: [] },
      { rootLists: [current], folders: [] },
    )

    expect(merged.rootLists[0]).toMatchObject({ task_count: 9, open_task_count: 7, completed_task_count: 1, cancelled_task_count: 1 })
    expect(merged.rootLists[1]).toMatchObject({ task_count: 1, open_task_count: 1 })
  })

  it('reconciles one operation through optimistic HTTP fallback and canonical WebSocket exactly once', () => {
    expect(taskHierarchyCountMutationDecision(undefined, false)).toBe('apply-optimistic')
    expect(taskHierarchyCountMutationDecision('optimistic', false)).toBe('none')
    expect(taskHierarchyCountMutationDecision('optimistic', true)).toBe('apply-canonical')
    expect(taskHierarchyCountMutationDecision('canonical', true)).toBe('none')
    expect(taskHierarchyCountMutationDecision('canonical', false)).toBe('none')

    const run = (snapshots: boolean[]) => {
      let state: 'optimistic' | 'canonical' | undefined
      return snapshots.map(hasSnapshot => {
        const decision = taskHierarchyCountMutationDecision(state, hasSnapshot)
        if (decision === 'apply-optimistic') state = 'optimistic'
        if (decision === 'apply-canonical') state = 'canonical'
        return decision
      })
    }
    expect(run([false, true, true])).toEqual(['apply-optimistic', 'apply-canonical', 'none'])
    expect(run([true, true, false])).toEqual(['apply-canonical', 'none', 'none'])
  })

  it('suppresses only pending or already reconciled local operation echoes', () => {
    expect(shouldIgnoreTaskOperationEcho('operation-1', true, false)).toBe(true)
    expect(shouldIgnoreTaskOperationEcho('operation-1', false, true)).toBe(true)
    expect(shouldIgnoreTaskOperationEcho('operation-remote', false, false)).toBe(false)
    expect(shouldIgnoreTaskOperationEcho(undefined, true, true)).toBe(false)
  })
})
