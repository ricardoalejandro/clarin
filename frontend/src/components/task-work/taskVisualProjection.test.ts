import { describe, expect, it } from 'vitest'
import type { Task, TaskPriority, TaskStatusCategory, TaskWorkflowStatus } from '@/types/task'
import {
  beginTaskVisualMutation,
  extendTaskVisualMutation,
  projectTaskVisualUpdate,
  projectTaskVisualUpdates,
  reconcileTaskVisualMutation,
  rollbackTaskVisualMutation,
  taskLegacyStatusForCategory,
  type TaskVisualMutationLedger,
} from './taskVisualProjection'

function workflowStatus(id: string, category: TaskStatusCategory, workflowID = 'workflow-1'): TaskWorkflowStatus {
  return {
    id,
    account_id: 'account-1',
    workflow_id: workflowID,
    name: id,
    color: '#64748B',
    category,
    sort_order: 0,
    is_default: category === 'not_started',
    created_at: '2026-08-24T00:00:00.000Z',
    updated_at: '2026-08-24T00:00:00.000Z',
  }
}

const statuses = [
  workflowStatus('todo', 'not_started'),
  workflowStatus('doing', 'active'),
  workflowStatus('done', 'done'),
  workflowStatus('cancelled', 'cancelled'),
]

function task(id = 'task-a', version = 5): Task {
  return {
    id,
    account_id: 'account-1',
    created_by: 'user-1',
    assigned_to: 'user-1',
    title: `Tarea ${id}`,
    description: '',
    type: 'reminder',
    priority: 'medium',
    status: 'pending',
    status_id: 'todo',
    status_detail: statuses[0],
    progress: 34,
    recurrence_rule: '',
    notes: '',
    version,
    created_at: '2026-08-24T00:00:00.000Z',
    updated_at: '2026-08-24T00:00:00.000Z',
  }
}

describe('task visual projection', () => {
  it('projects every priority without replacing identity color or status', () => {
    const priorities: TaskPriority[] = ['low', 'medium', 'high', 'urgent']
    for (const priority of priorities) {
      const source = { ...task(), color: '#10B981', resolved_color: '#10B981' }
      const projected = projectTaskVisualUpdate(source, { priority }, statuses)
      expect(projected).toMatchObject({ priority, color: '#10B981', resolved_color: '#10B981', status_id: 'todo' })
    }
  })

  it('projects status detail, legacy status and progress consistently', () => {
    expect(projectTaskVisualUpdate(task(), { status_id: 'doing' }, statuses)).toMatchObject({
      status_id: 'doing',
      status_detail: statuses[1],
      status: 'pending',
      progress: 34,
    })
    expect(projectTaskVisualUpdate(task(), { status_id: 'done' }, statuses)).toMatchObject({ status: 'completed', progress: 100 })
    expect(projectTaskVisualUpdate(task(), { status_id: 'cancelled' }, statuses)).toMatchObject({ status: 'cancelled', progress: 34 })

    const completed = { ...task(), status: 'completed' as const, status_id: 'done', status_detail: statuses[2], progress: 100 }
    expect(projectTaskVisualUpdate(completed, { status_id: 'todo' }, statuses)).toMatchObject({ status: 'pending', progress: 0 })
    expect(taskLegacyStatusForCategory('active')).toBe('pending')
  })

  it('refuses an unknown or cross-workflow status while still projecting priority', () => {
    const foreign = workflowStatus('foreign', 'active', 'workflow-2')
    expect(projectTaskVisualUpdate(task(), { priority: 'urgent', status_id: foreign.id }, [...statuses, foreign])).toMatchObject({
      priority: 'urgent',
      status_id: 'todo',
    })
    expect(projectTaskVisualUpdate(task(), { status_id: 'missing' }, statuses).status_id).toBe('todo')
  })
})

describe('task visual mutation ledger', () => {
  it('keeps unrelated same-version echoes from erasing an active projection', () => {
    const started = beginTaskVisualMutation({}, task(), { priority: 'urgent' }, statuses, 'operation-a')
    const echo = { ...task(), priority: 'low' as const }
    const reconciled = reconcileTaskVisualMutation(started.ledger, started.task, echo, 'another-operation')
    expect(reconciled.accepted).toBe(false)
    expect(reconciled.task.priority).toBe('urgent')
    expect(reconciled.ledger['task-a']?.operationId).toBe('operation-a')
  })

  it('settles the matching HTTP operation and rejects an older late response', () => {
    const started = beginTaskVisualMutation({}, task(), { status_id: 'done' }, statuses, 'operation-a')
    const canonical = { ...started.task, version: 6 }
    const settled = reconcileTaskVisualMutation(started.ledger, started.task, canonical, 'operation-a')
    expect(settled).toMatchObject({ accepted: true, settledOperation: true, task: { version: 6, status_id: 'done' } })
    expect(settled.ledger['task-a']).toBeUndefined()

    const stale = reconcileTaskVisualMutation(settled.ledger, settled.task, { ...task(), priority: 'low' }, 'old-operation')
    expect(stale.accepted).toBe(false)
    expect(stale.task.version).toBe(6)
  })

  it('accepts a newer authoritative WebSocket version even with a different operation id', () => {
    const started = beginTaskVisualMutation({}, task(), { priority: 'urgent' }, statuses, 'operation-local')
    const canonical = { ...task(), priority: 'high' as const, version: 7 }
    const reconciled = reconcileTaskVisualMutation(started.ledger, started.task, canonical, 'operation-remote')
    expect(reconciled).toMatchObject({ accepted: true, settledOperation: false, task: { priority: 'high', version: 7 } })
    expect(reconciled.ledger['task-a']).toBeUndefined()
  })

  it('rolls back only the active operation and never overwrites a newer canonical version', () => {
    const started = beginTaskVisualMutation({}, task(), { priority: 'urgent' }, statuses, 'operation-a')
    expect(rollbackTaskVisualMutation(started.ledger, started.task, 'task-a', 'wrong-operation')).toMatchObject({
      rolledBack: false,
      task: { priority: 'urgent' },
    })
    expect(rollbackTaskVisualMutation(started.ledger, started.task, 'task-a', 'operation-a')).toMatchObject({
      rolledBack: true,
      task: { priority: 'medium' },
    })
    expect(rollbackTaskVisualMutation(started.ledger, { ...started.task, priority: 'high', version: 8 }, 'task-a', 'operation-a')).toMatchObject({
      rolledBack: false,
      task: { priority: 'high', version: 8 },
    })
  })

  it('isolates inverted A/B outcomes by task id', () => {
    const startedA = beginTaskVisualMutation({}, task('task-a'), { priority: 'urgent' }, statuses, 'operation-a')
    const startedB = beginTaskVisualMutation(startedA.ledger, task('task-b'), { priority: 'low' }, statuses, 'operation-b')

    const failedA = rollbackTaskVisualMutation(startedB.ledger, startedA.task, 'task-a', 'operation-a')
    expect(failedA.task.priority).toBe('medium')
    expect(failedA.ledger['task-b']?.optimistic.priority).toBe('low')

    const canonicalB = { ...startedB.task, version: 6 }
    const settledB = reconcileTaskVisualMutation(failedA.ledger, startedB.task, canonicalB, 'operation-b')
    expect(settledB.task.priority).toBe('low')
    expect(settledB.ledger).toEqual({} satisfies TaskVisualMutationLedger)
  })

  it('keeps queued projections visible without replacing the active rollback owner', () => {
    const started = beginTaskVisualMutation({}, task(), { status_id: 'doing' }, statuses, 'operation-a')
    const extended = extendTaskVisualMutation(
      started.ledger,
      'task-a',
      [{ priority: 'urgent' }, { status_id: 'done' }],
      statuses,
    )

    expect(extended).not.toBeNull()
    expect(extended?.entry).toMatchObject({ operationId: 'operation-a', baseVersion: 5 })
    expect(extended?.entry.before).toMatchObject({ priority: 'medium', status_id: 'todo' })
    expect(extended?.task).toMatchObject({ priority: 'urgent', status_id: 'done', progress: 100 })
    expect(rollbackTaskVisualMutation(extended!.ledger, extended!.task, 'task-a', 'operation-a')).toMatchObject({
      rolledBack: true,
      task: { priority: 'medium', status_id: 'todo', version: 5 },
    })
  })

  it('projects queued visual intents in their original order', () => {
    expect(projectTaskVisualUpdates(task(), [
      { status_id: 'done' },
      { priority: 'high' },
      { status_id: 'doing' },
    ], statuses)).toMatchObject({ priority: 'high', status_id: 'doing', status: 'pending', progress: 0 })
  })
})
