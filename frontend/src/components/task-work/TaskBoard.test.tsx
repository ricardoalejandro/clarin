import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { apiPost } from '@/lib/api'
import type { Task, TaskList, TaskPriority, TaskWorkflowStatus } from '@/types/task'
import TaskBoard from './TaskBoard'

vi.mock('@/lib/api', () => ({ apiPost: vi.fn() }))

const status = {
  id: 'status-open',
  account_id: 'account-1',
  workflow_id: 'workflow-1',
  name: 'Por hacer',
  color: '#64748B',
  category: 'not_started',
  sort_order: 0,
  is_default: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
} as TaskWorkflowStatus

const list = {
  id: 'list-1',
  account_id: 'account-1',
  workflow_id: status.workflow_id,
  name: 'Bandeja general',
  color: '#10B981',
  icon: 'inbox',
  sort_order: 0,
  created_by: 'user-1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  task_count: 4,
  open_task_count: 4,
  completed_task_count: 0,
  cancelled_task_count: 0,
  permissions: { level: 'edit', can_view: true, can_comment: true, can_edit: true, can_delete: true, can_manage_access: false },
} as TaskList

function task(priority: TaskPriority, index: number): Task {
  return {
    id: `task-${priority}`,
    account_id: 'account-1',
    created_by: 'user-1',
    assigned_to: 'user-1',
    assigned_to_name: 'Ricardo Rojas',
    title: `Tarea ${index}`,
    description: '',
    type: 'reminder',
    priority,
    status: 'pending',
    status_id: status.id,
    status_detail: status,
    list_id: list.id,
    list_name: list.name,
    sort_order: (index + 1) * 1024,
    version: 1,
    recurrence_rule: '',
    notes: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    permissions: { level: 'edit', can_view: true, can_comment: true, can_edit: true, can_delete: true, can_manage_access: false },
  }
}

const tasks = (['low', 'medium', 'high', 'urgent'] as TaskPriority[]).map(task)

const props = {
  tasks,
  statuses: [status],
  allStatuses: [status],
  lists: [list],
  users: [{ id: 'user-1', display_name: 'Ricardo Rojas', username: 'ricardo' }],
  currentUserId: 'user-1',
  defaultListId: list.id,
  collapsedStatusIds: [],
  onCollapsedStatusIdsChange: vi.fn(),
  onTasksChange: vi.fn(),
  onCanonicalTask: vi.fn(() => true),
  onCanonicalTasks: vi.fn((value: Task[]) => value),
  onOperation: vi.fn(),
  onTaskCreated: vi.fn(),
  onDragStateChange: vi.fn(),
  onOpen: vi.fn(),
  onEdit: vi.fn(),
  onCreateSubtask: vi.fn(),
  onCreateFull: vi.fn(),
  onConfigureStatuses: vi.fn(),
  onStar: vi.fn(),
  onQuickUpdate: vi.fn(async () => undefined),
  onRefresh: vi.fn(),
  onError: vi.fn(),
  canCreate: false,
  canManageStructure: false,
}

describe('TaskBoard semantic visibility', () => {
  beforeAll(() => {
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows all priorities and marks the inspector task without selecting it', () => {
    render(<TaskBoard {...props} activeTaskId="task-medium" />)

    expect(screen.getByLabelText('Prioridad: Baja')).toBeInTheDocument()
    expect(screen.getByLabelText('Prioridad: Media')).toBeInTheDocument()
    expect(screen.getByLabelText('Prioridad: Alta')).toBeInTheDocument()
    expect(screen.getByLabelText('Prioridad: Urgente')).toBeInTheDocument()

    const activeCard = document.querySelector('[data-task-id="task-medium"]')
    expect(activeCard).toHaveAttribute('aria-current', 'true')
    expect(activeCard).toHaveAttribute('data-task-active', 'true')
    expect(activeCard?.querySelector('[data-task-active-indicator]')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Seleccionar Tarea 1' })).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Abrir tarea Tarea 1' }))
    expect(props.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-medium' }), expect.any(HTMLElement))

    fireEvent.click(screen.getByRole('checkbox', { name: 'Seleccionar Tarea 1' }))
    expect(screen.getByRole('checkbox', { name: 'Quitar Tarea 1' })).toHaveAttribute('aria-checked', 'true')
    expect(activeCard).toHaveAttribute('aria-current', 'true')
  })

  it('creates a quick task with an all-day due date and no implicit start or 17:00 time', async () => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dueAt = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 23, 59, 0, 0).toISOString()
    vi.mocked(apiPost).mockResolvedValue({
      success: true,
      data: { task: { ...task('medium', 5), id: 'task-new', title: 'Entrega rápida', due_at: dueAt, is_all_day: true } },
    })
    render(<TaskBoard {...props} canCreate />)

    fireEvent.click(screen.getByRole('button', { name: 'Agregar tarea' }))
    fireEvent.change(screen.getByPlaceholderText('Nombre de la tarea…'), { target: { value: 'Entrega rápida' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fecha de entrega: Sin fecha' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mañana' }))
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Crear' }))

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))
    expect(apiPost).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({
      start_at: '',
      due_at: dueAt,
      is_all_day: true,
    }))
    expect((vi.mocked(apiPost).mock.calls[0]?.[1] as { due_at: string }).due_at).not.toContain('T17:00')
  })
})
