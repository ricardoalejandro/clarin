import { beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '@/types/task'
import {
  createTaskListSubtaskState,
  readTaskSubtaskDisplayMode,
  reconcileParentAfterChildStatus,
  taskListSubtaskReducer,
  taskSubtaskDisplayStorageKey,
  taskSubtaskParentExpanded,
} from './taskListSubtasks'

const child = (id: string, category: 'not_started' | 'done', version = 1) => ({
  id,
  parent_task_id: 'parent-1',
  version,
  status_detail: { category },
} as Task)

describe('taskListSubtaskReducer', () => {
  beforeEach(() => localStorage.clear())

  it('persists the global preference in the exact account, user, environment and view scope', () => {
    const scope = 'account-1:user-1:environment-1:list:list-1'
    expect(readTaskSubtaskDisplayMode(scope)).toBe('collapsed')
    localStorage.setItem(taskSubtaskDisplayStorageKey(scope), 'expanded')
    expect(readTaskSubtaskDisplayMode(scope)).toBe('expanded')
    expect(readTaskSubtaskDisplayMode('account-1:user-2:environment-1:list:list-1')).toBe('collapsed')
  })

  it('keeps the global preference separate from temporary individual expansion', () => {
    let state = createTaskListSubtaskState('collapsed')
    expect(taskSubtaskParentExpanded(state, 'parent-1')).toBe(false)
    state = taskListSubtaskReducer(state, { type: 'toggle-parent', parentID: 'parent-1' })
    expect(taskSubtaskParentExpanded(state, 'parent-1')).toBe(true)
    state = taskListSubtaskReducer(state, { type: 'set-mode', mode: 'expanded' })
    expect(state.expansionOverrides).toEqual({})
    expect(taskSubtaskParentExpanded(state, 'parent-2')).toBe(true)
  })

  it('rejects stale and cancelled load completions while retaining cached children', () => {
    let state = createTaskListSubtaskState()
    state = taskListSubtaskReducer(state, { type: 'load-started', parentID: 'parent-1', requestID: 4 })
    state = taskListSubtaskReducer(state, { type: 'load-succeeded', parentID: 'parent-1', requestID: 3, items: [child('stale', 'done')] })
    expect(state.cache['parent-1'].phase).toBe('loading')
    state = taskListSubtaskReducer(state, { type: 'load-succeeded', parentID: 'parent-1', requestID: 4, items: [child('child-1', 'not_started')] })
    expect(state.cache['parent-1'].items.map(item => item.id)).toEqual(['child-1'])
    state = taskListSubtaskReducer(state, { type: 'load-started', parentID: 'parent-1', requestID: 5 })
    state = taskListSubtaskReducer(state, { type: 'load-cancelled', parentID: 'parent-1', requestID: 5 })
    expect(state.cache['parent-1']).toMatchObject({ phase: 'ready', items: [{ id: 'child-1' }] })
  })

  it('reconciles children by canonical version and updates automatic parent progress', () => {
    let state = createTaskListSubtaskState()
    state = taskListSubtaskReducer(state, { type: 'load-started', parentID: 'parent-1', requestID: 1 })
    state = taskListSubtaskReducer(state, { type: 'load-succeeded', parentID: 'parent-1', requestID: 1, items: [child('child-1', 'not_started', 2)] })
    state = taskListSubtaskReducer(state, { type: 'reconcile-child', child: child('child-1', 'done', 1) })
    expect(state.cache['parent-1'].items[0].status_detail?.category).toBe('not_started')
    state = taskListSubtaskReducer(state, { type: 'reconcile-child', child: child('child-1', 'done', 3) })
    expect(state.cache['parent-1'].items[0].status_detail?.category).toBe('done')

    const parent = { id: 'parent-1', subtask_count: 2, subtask_done: 0, progress_mode: 'automatic', progress: 0 } as Task
    expect(reconcileParentAfterChildStatus(parent, child('child-1', 'not_started'), child('child-1', 'done'))).toMatchObject({ subtask_done: 1, progress: 50 })
  })
})
