import { describe, expect, it } from 'vitest'
import type { Task, TaskList, TaskWorkflowStatus } from '@/types/task'
import { buildTaskListGroups, reorderTaskSelection, taskListCursor, taskListDropMutation } from './taskListGrouping'

const status = { id: 's1', workflow_id: 'w1', name: 'Por hacer', color: '#64748b', category: 'not_started', sort_order: 1 } as TaskWorkflowStatus
const list = { id: 'l1', name: 'Backlog', color: '#10b981' } as TaskList
const task = { id: 't1', status_id: 's1', list_id: 'l1', assigned_to: 'u1', assigned_to_name: 'Ricardo', priority: 'high', type: 'call' } as Task

describe('task list grouping', () => {
  it('builds all seven grouping modes including special empty groups', () => {
    for (const groupBy of ['none', 'status', 'list', 'assignee', 'priority', 'type'] as const) {
      expect(buildTaskListGroups([task], groupBy, 'asc', [status], [list])[0].tasks).toEqual([task])
    }
    expect(buildTaskListGroups([{ ...task, due_at: undefined }], 'due', 'asc', [status], [list]).at(-1)?.label).toBe('Sin fecha')
  })

  it('reorders a selected set before one stable anchor without changing relative selection order', () => {
    const rows = ['a', 'b', 'c', 'd'].map(id => ({ ...task, id }))
    expect(reorderTaskSelection(rows, ['c', 'a'], 'd').map(item => item.id)).toEqual(['b', 'c', 'a', 'd'])
    expect(reorderTaskSelection(rows, ['a', 'b'], 'b')).toBe(rows)
  })

  it('maps property drops without assigning an implicit due date', () => {
    const group = buildTaskListGroups([task], 'priority', 'asc', [status], [list])[0]
    expect(taskListDropMutation('priority', group)).toMatchObject({ endpoint: 'update', property: 'priority', value: 'high' })
    const noDate = buildTaskListGroups([task], 'due', 'asc', [status], [list]).find(item => item.key === 'none')!
    expect(taskListDropMutation('due', noDate)).toEqual({ endpoint: 'date', clear: true })
  })

  it('keeps cursor ownership stable', () => {
    expect(taskListCursor('idle')).toBe('pointer')
    expect(taskListCursor('handle')).toBe('grab')
    expect(taskListCursor('dragging')).toBe('grabbing')
    expect(taskListCursor('selecting')).toBe('pointer')
  })
})
