import { describe, expect, it } from 'vitest'
import type { Task, TaskMyWorkItem, TaskMyWorkMutation, TaskMyWorkResponse } from '@/types/task'
import { applyTaskMyWorkMutationOrder, reorderTaskMyWorkItems, taskMyWorkBeforeTaskID, taskMyWorkShouldRefresh } from './taskMyWorkState'

const item = (id: string, status: Task['status'] = 'pending'): TaskMyWorkItem => ({
  position: Number(id) * 1024,
  added_at: '2026-09-01T10:00:00Z',
  task: { id, status, title: `Tarea ${id}`, priority: 'medium' } as Task,
})

describe('Mi trabajo state', () => {
  it('reorders one personal focus list and derives the stable server anchor', () => {
    const current = [item('1'), item('2'), item('3')]
    const next = reorderTaskMyWorkItems(current, '3', '1')
    expect(next.map(row => row.task.id)).toEqual(['3', '1', '2'])
    expect(taskMyWorkBeforeTaskID(next, '3')).toBe('1')
    expect(reorderTaskMyWorkItems(current, '2', '2')).toBe(current)
  })

  it('accepts the canonical mutation order and separates closed work', () => {
    const data = {
      focus_items: [item('1'), item('2')],
      completed_items: [item('3', 'completed')],
      suggestions: [],
      summary: {
        business_date: '2026-09-01', timezone: 'America/Lima', reset_at: '2026-09-02T00:00:00-05:00',
        revision: 4, focus_count: 2, completed_count: 1, suggestion_count: 0,
        overdue_suggestion_count: 0, due_today_suggestion_count: 0, previous_suggestion_count: 0,
        maximum_daily_task_count: 200,
      },
    } satisfies TaskMyWorkResponse
    const mutation = { business_date: '2026-09-01', revision: 5, ordered_task_ids: ['2', '3', '1'], focus_count: 2, completed_count: 1 } as TaskMyWorkMutation
    const next = applyTaskMyWorkMutationOrder(data, mutation)
    expect(next.focus_items.map(row => row.task.id)).toEqual(['2', '1'])
    expect(next.completed_items.map(row => row.task.id)).toEqual(['3'])
    expect(next.summary.revision).toBe(5)
  })

  it('refreshes only for task changes and private Mi trabajo events', () => {
    expect(taskMyWorkShouldRefresh({ event: 'task_update', data: { action: 'my_work_added' } })).toBe(true)
    expect(taskMyWorkShouldRefresh({ event: 'task_update', data: { action: 'updated', task_id: '1' } })).toBe(true)
    expect(taskMyWorkShouldRefresh({ event: 'chat_update', data: { task_id: '1' } })).toBe(false)
  })
})
