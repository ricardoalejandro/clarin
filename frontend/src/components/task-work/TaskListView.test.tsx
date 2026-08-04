import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Task, TaskWorkflowStatus } from '@/types/task'
import TaskListView from './TaskListView'

const status = {
  id: 'status-open',
  account_id: 'account-1',
  workflow_id: 'workflow-1',
  name: 'Por hacer',
  category: 'not_started',
  color: '#64748B',
  sort_order: 0,
} as TaskWorkflowStatus

const task = {
  id: 'task-1',
  account_id: 'account-1',
  title: 'Una tarea operativa muy importante',
  priority: 'normal',
  status_id: status.id,
  status_detail: status,
  list_id: 'list-1',
  list_name: 'Propaganda',
  assigned_to_name: 'Ricardo Rojas',
  version: 1,
  subtask_count: 0,
  subtask_done: 0,
  permissions: { can_view: true, can_edit: true, can_delete: true },
} as unknown as Task

const props = {
  tasks: [task],
  statuses: [status],
  lists: [],
  folders: [],
  users: [],
  groupBy: 'none' as const,
  groupDirection: 'asc' as const,
  collapsedGroupKeys: [],
  onGroupingChange: vi.fn(),
  onOpen: vi.fn(),
  onStatus: vi.fn(),
  onStar: vi.fn(),
  onCanonicalTasks: vi.fn(value => value),
  onRefresh: vi.fn(),
  onError: vi.fn(),
}

describe('TaskListView compact interaction', () => {
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

  it('does not reserve a permanent toolbar row and shows actions only after selection', () => {
    render(<TaskListView {...props} />)
    expect(screen.queryByText('Agrupar por')).not.toBeInTheDocument()
    expect(document.querySelector('[data-task-list-selection-toolbar]')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: `Abrir tarea ${task.title}` }), { ctrlKey: true })
    expect(document.querySelector('[data-task-list-selection-toolbar]')).toBeInTheDocument()
    expect(document.querySelector('[data-task-list-selection-toolbar]')?.textContent).toMatch(/^1tarea seleccionada/)
    expect(props.onOpen).not.toHaveBeenCalled()
  })

  it('renders dense rows and keeps completion, status and star as separate controls', () => {
    render(<TaskListView {...props} />)
    expect(document.querySelector('[data-task-list-row="task-1"]')).toHaveClass('min-h-14', 'py-1.5')
    expect(screen.getByRole('button', { name: `Completar ${task.title}` })).toBeInTheDocument()
    expect(document.querySelector('[data-task-status-picker]')).toHaveClass('min-h-9')
    expect(screen.getByRole('button', { name: `Destacar ${task.title}` })).toBeInTheDocument()
  })
})
