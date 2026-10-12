import { describe, expect, it } from 'vitest'
import { TaskAccessReconciliation } from './taskAccessReconciliation'

const task = { id: 'task-1', list_id: 'list-1', folder_id: 'folder-1', environment_id: 'environment-1' }

describe('task access reconciliation', () => {
  it('rejects a late task mutation despite its newer version', () => {
    const access = new TaskAccessReconciliation()
    access.revoke('task', task.id)
    const newer = { ...task, version: 9 }
    expect(access.canAccept(newer)).toBe(false)
  })
  it('requires a read started after revocation and fences a subsequent revocation again', () => {
    const access = new TaskAccessReconciliation()
    const oldRead = access.epoch
    access.revoke('task', task.id)
    expect(access.confirmRead(task, oldRead)).toBe(false)
    expect(access.canAccept(task)).toBe(false)
    expect(access.confirmRead(task, access.epoch)).toBe(true)
    expect(access.canAccept(task)).toBe(true)
    access.revoke('task', task.id)
    expect(access.canAccept(task)).toBe(false)
  })
  it.each(['list', 'folder', 'environment'] as const)('fences late descendants of a revoked %s, including moved known tasks', target => {
    const access = new TaskAccessReconciliation()
    access.revoke(target, task[`${target}_id`], [task])
    expect(access.canAccept(task)).toBe(false)
    expect(access.canAccept({ ...task, id: 'new-task' })).toBe(false)
    expect(access.canAccept({ id: task.id, list_id: 'other', folder_id: 'other', environment_id: 'other' })).toBe(false)
    expect(access.canAccept({ id: 'other', list_id: 'other', folder_id: 'other', environment_id: 'other' })).toBe(true)
  })
  it('applies a root-task tombstone to its subtasks', () => {
    const access = new TaskAccessReconciliation()
    access.revoke('task', task.id)
    expect(access.canAccept({ ...task, id: 'subtask', parent_task_id: task.id })).toBe(false)
  })
})
