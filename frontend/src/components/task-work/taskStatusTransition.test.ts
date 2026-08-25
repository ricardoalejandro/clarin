import { describe, expect, it } from 'vitest'
import type { Task, TaskWorkflowStatus } from '@/types/task'
import { preferredStatusForCategory, taskCompletionTransition, taskStatusCategory } from './taskStatusTransition'

const status = (id: string, category: TaskWorkflowStatus['category'], sortOrder: number, isDefault = false): TaskWorkflowStatus => ({
  id,
  account_id: 'account',
  workflow_id: 'workflow',
  name: id,
  color: '#64748B',
  category,
  sort_order: sortOrder,
  is_default: isDefault,
  created_at: '',
  updated_at: '',
})

const statuses = [
  status('todo-secondary', 'not_started', 1),
  status('todo-default', 'not_started', 9, true),
  status('doing', 'active', 2, true),
  status('done-secondary', 'done', 1),
  status('done-default', 'done', 8, true),
  status('cancelled', 'cancelled', 10, true),
]

const task = (statusID: string, legacyStatus: Task['status'] = 'pending'): Pick<Task, 'status' | 'status_id' | 'status_detail'> => ({
  status: legacyStatus,
  status_id: statusID,
  status_detail: statuses.find(item => item.id === statusID),
})

describe('task status transitions', () => {
  it('prefers the default status before sort order', () => {
    expect(preferredStatusForCategory(statuses, 'done')?.id).toBe('done-default')
  })

  it('completes open work and reopens terminal work', () => {
    expect(taskCompletionTransition(task('doing'), statuses)).toMatchObject({ action: 'complete', target: { id: 'done-default' } })
    expect(taskCompletionTransition(task('done-default', 'completed'), statuses)).toMatchObject({ action: 'reopen', target: { id: 'todo-default' } })
    expect(taskCompletionTransition(task('cancelled', 'cancelled'), statuses)).toMatchObject({ action: 'reopen', target: { id: 'todo-default' } })
  })

  it('falls back to legacy status and disables a missing destination', () => {
    expect(taskStatusCategory({ status: 'overdue' }, [])).toBe('active')
    expect(taskCompletionTransition(task('doing'), statuses.filter(item => item.category !== 'done'))).toBeNull()
  })
})
