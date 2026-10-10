import { describe, expect, it } from 'vitest'
import type { Task } from '@/types/task'
import { reconcileTaskMediaCounts } from './taskMediaRealtime'
const task = { id: 'task-a', attachment_count: 2, comment_count: 3 } as Task

describe('storage and task media event reconciliation', () => {
  it.each(['comment', 'comment_draft', undefined])('does not alter task badges for storage media scope %s', attachment_scope => {
    expect(reconcileTaskMediaCounts(task, { action: 'attachment_deleted', task_id: task.id, origin: 'storage', attachment_scope })).toBe(task)
    expect(reconcileTaskMediaCounts(task, { action: 'attachment_added', task_id: task.id, origin: 'storage', attachment_scope })).toBe(task)
  })
  it('updates only the matching task and never changes the comment count for media', () => {
    expect(reconcileTaskMediaCounts(task, { action: 'attachment_deleted', task_id: 'other', origin: 'storage', attachment_scope: 'task' })).toBe(task)
    expect(reconcileTaskMediaCounts(task, { action: 'attachment_deleted', task_id: task.id, origin: 'storage', attachment_scope: 'task' })).toMatchObject({ attachment_count: 1, comment_count: 3 })
    expect(reconcileTaskMediaCounts(task, { action: 'attachment_added', task_id: task.id, origin: 'storage', attachment_scope: 'task' })).toMatchObject({ attachment_count: 3 })
  })
  it('preserves ordinary event behavior and clamps removals', () => {
    expect(reconcileTaskMediaCounts(task, { action: 'attachment_added', task_id: task.id }).attachment_count).toBe(3)
    expect(reconcileTaskMediaCounts({ ...task, attachment_count: 0 }, { action: 'attachment_deleted', task_id: task.id }).attachment_count).toBe(0)
    expect(reconcileTaskMediaCounts(task, { action: 'comment_deleted', task_id: task.id }).comment_count).toBe(2)
  })
})
