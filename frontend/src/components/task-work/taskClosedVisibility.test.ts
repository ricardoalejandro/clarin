import { describe, expect, it } from 'vitest'
import type { Task, TaskFilters } from '@/types/task'
import { shouldPreserveConcurrentTask, taskMatchesClosedVisibility, taskQueryFiltersForView } from './taskClosedVisibility'

const filters = (overrides: Partial<TaskFilters> = {}): TaskFilters => ({
  include_closed: false, status_ids: [], assigned_to_ids: [], collaborator_ids: [], priorities: [], types: [], creator_ids: [],
  due: '', created_from: '', created_to: '', completed_from: '', completed_to: '', ...overrides,
})
const task = (statusID: string, category: 'not_started' | 'active' | 'done' | 'cancelled'): Task => ({
  id: statusID, account_id: 'account', created_by: 'user', assigned_to: 'user', title: statusID, description: '', type: 'reminder', priority: 'medium', status: category === 'done' ? 'completed' : category === 'cancelled' ? 'cancelled' : 'pending', status_id: statusID,
  status_detail: { id: statusID, account_id: 'account', workflow_id: 'workflow', name: statusID, color: '#10B981', category, sort_order: 1, is_default: false, created_at: '', updated_at: '' }, recurrence_rule: '', notes: '', created_at: '', updated_at: '',
})

describe('closed task visibility', () => {
  it('hides completed and cancelled tasks by default in operational views', () => {
    expect(taskMatchesClosedVisibility(task('done', 'done'), filters(), 'list')).toBe(false)
    expect(taskMatchesClosedVisibility(task('cancelled', 'cancelled'), filters(), 'board')).toBe(false)
    expect(taskMatchesClosedVisibility(task('open', 'active'), filters(), 'calendar')).toBe(true)
  })

  it('keeps history in summary and honours Mostrar cerradas', () => {
    expect(taskMatchesClosedVisibility(task('done', 'done'), filters(), 'summary')).toBe(true)
    expect(taskMatchesClosedVisibility(task('done', 'done'), filters({ include_closed: true }), 'gantt')).toBe(true)
    expect(taskQueryFiltersForView(filters(), 'summary').include_closed).toBe(true)
  })

  it('gives an explicit status selection precedence over include_closed=false', () => {
    expect(taskMatchesClosedVisibility(task('done', 'done'), filters({ status_ids: ['done'] }), 'list')).toBe(true)
    expect(taskMatchesClosedVisibility(task('cancelled', 'cancelled'), filters({ status_ids: ['done'] }), 'list')).toBe(false)
  })

  it('does not resurrect a task closed while an open-work request was in flight', () => {
    expect(shouldPreserveConcurrentTask({ ...task('done', 'done'), version: 8 }, 7, false, false, filters(), 'board')).toBe(false)
    expect(shouldPreserveConcurrentTask({ ...task('open', 'active'), version: 8 }, 7, false, false, filters(), 'board')).toBe(true)
    expect(shouldPreserveConcurrentTask({ ...task('open', 'active'), version: 8 }, 7, true, false, filters(), 'board')).toBe(false)
  })
})
