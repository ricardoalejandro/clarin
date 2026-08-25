import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task, TaskGanttData, TaskWorkflowStatus } from '@/types/task'
import TaskGanttView from './TaskGanttView'

const status = {
  id: 'status-progress',
  account_id: 'account-1',
  workflow_id: 'workflow-1',
  name: 'En curso',
  category: 'active',
  color: '#2563EB',
  sort_order: 1,
  is_default: false,
  created_at: '',
  updated_at: '',
} as TaskWorkflowStatus

function ganttTask(version = 3): Task {
  return {
    id: 'gantt-task-1',
    account_id: 'account-1',
    created_by: 'user-1',
    assigned_to: 'user-1',
    title: 'Tarea proyectada',
    description: '',
    type: 'reminder',
    priority: 'medium',
    status: 'pending',
    status_id: status.id,
    status_detail: status,
    start_at: '2026-08-20T09:00:00.000Z',
    due_at: '2026-08-24T09:00:00.000Z',
    version,
    recurrence_rule: '',
    notes: '',
    created_at: '',
    updated_at: '',
    permissions: { level: 'edit', can_view: true, can_edit: true, can_comment: true, can_delete: false, can_manage_access: false },
  }
}

function ganttData(task: Task): TaskGanttData {
  return { tasks: [task], dependencies: [], critical_task_ids: [], slack_minutes: {}, unscheduled_count: 0 }
}

beforeEach(() => {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TaskGanttView task inspector projection', () => {
  it('keeps an equal-version projection, marks the open task and exposes priority and status', () => {
    const canonical = ganttTask(3)
    const projected = { ...canonical, priority: 'urgent' as const }
    const onOpen = vi.fn()
    const { container } = render(<TaskGanttView data={ganttData(canonical)} activeTaskId={canonical.id} taskProjection={projected} onOpen={onOpen} onMove={vi.fn()} />)

    const row = container.querySelector(`[data-task-gantt-row="${canonical.id}"]`)
    expect(row).not.toBeNull()
    expect(row).toHaveAttribute('aria-current', 'true')
    expect(container.querySelectorAll('[aria-current="true"]')).toHaveLength(1)
    expect(screen.getByLabelText('Prioridad: Urgente')).toBeInTheDocument()
    expect(screen.getByLabelText('Estado: En curso')).toBeInTheDocument()

    const bar = row?.querySelector<HTMLElement>(`[data-task-gantt-bar="${canonical.id}"]`)
    expect(bar).not.toBeNull()
    fireEvent.keyDown(bar!, { key: ' ' })
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: canonical.id, priority: 'urgent' }), bar)
  })

  it('does not let an older projection replace a newer canonical inventory', () => {
    const canonical = { ...ganttTask(5), priority: 'high' as const }
    const stale = { ...ganttTask(4), priority: 'low' as const }
    render(<TaskGanttView data={ganttData(canonical)} taskProjection={stale} onOpen={vi.fn()} onMove={vi.fn()} />)

    expect(screen.getByLabelText('Prioridad: Alta')).toBeInTheDocument()
    expect(screen.queryByLabelText('Prioridad: Baja')).not.toBeInTheDocument()
  })
})
