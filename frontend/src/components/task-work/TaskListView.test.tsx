import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Task, TaskWorkflowStatus } from '@/types/task'
import TaskListView from './TaskListView'

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  apiGet: apiMocks.get,
  apiPost: apiMocks.post,
  apiPut: apiMocks.put,
}))

const status = {
  id: 'status-open',
  account_id: 'account-1',
  workflow_id: 'workflow-1',
  name: 'Por hacer',
  category: 'not_started',
  color: '#64748B',
  sort_order: 0,
} as TaskWorkflowStatus

const doneStatus = {
  ...status,
  id: 'status-done',
  name: 'Completada',
  category: 'done',
  sort_order: 1,
  color: '#10B981',
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

const childTask = {
  ...task,
  id: 'child-1',
  title: 'Preparar materiales',
  parent_task_id: task.id,
  status_detail: status,
  subtask_count: 0,
  subtask_done: 0,
} as Task

const props = {
  tasks: [task],
  statuses: [status, doneStatus],
  lists: [],
  folders: [],
  users: [],
  groupBy: 'none' as const,
  groupDirection: 'asc' as const,
  collapsedGroupKeys: [],
  subtaskDisplayMode: 'collapsed' as const,
  subtaskScope: 'account-1:user-1:environment-1:list:list-1',
  onGroupingChange: vi.fn(),
  onOpen: vi.fn(),
  onStatus: vi.fn(),
  onStar: vi.fn(),
  onAddSubtask: vi.fn(),
  onRenameTask: vi.fn(),
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
    apiMocks.get.mockResolvedValue({ success: true, data: { tasks: [] } })
    apiMocks.put.mockResolvedValue({ success: true, data: { task: childTask } })
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
    expect(document.querySelector('[data-task-list-row="task-1"]')).toHaveClass('min-h-12', '[@media(pointer:coarse)]:min-h-14')
    expect(document.querySelector('[data-task-list-row="task-1"] [data-task-completion-control]')).toHaveAccessibleName('Marcar como finalizada')
    expect(document.querySelector('[data-task-status-picker]')).toHaveClass('min-h-9')
    expect(screen.getByRole('button', { name: `Destacar ${task.title}` })).toBeInTheDocument()
  })

  it('keeps fine-pointer controls mounted without geometry changes and reveals them for selection, focus and touch', () => {
    render(<TaskListView {...props} />)

    const row = document.querySelector(`[data-task-list-row="${task.id}"]`)
    const grip = row?.querySelector('[data-task-row-grip]')
    const completionSlot = row?.querySelector('[data-task-row-completion]')
    const completion = completionSlot?.querySelector('[data-task-completion-control]')
    const actions = row?.querySelector('[data-task-row-actions]')
    expect(grip).toHaveClass('pointer-events-none', 'opacity-0', 'group-hover:pointer-events-auto', 'group-focus-within:opacity-100', '[@media(pointer:coarse)]:opacity-100', '[@media(pointer:coarse)]:w-11')
    expect(completion).toHaveClass('pointer-events-none', 'opacity-0', '[@media(pointer:coarse)]:pointer-events-auto', '[@media(pointer:coarse)]:h-11', '[@media(pointer:coarse)]:w-11')
    expect(actions).toHaveClass('absolute', 'pointer-events-none', 'opacity-0', '[@media(pointer:coarse)]:opacity-100')
    expect(screen.getByRole('button', { name: `Agregar subtarea a ${task.title}` })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `Cambiar nombre de ${task.title}` })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: `Abrir tarea ${task.title}` }), { ctrlKey: true })

    expect(row?.querySelector('[data-task-row-grip]')).toBe(grip)
    expect(row?.querySelector('[data-task-row-completion]')).toBe(completionSlot)
    expect(row?.querySelector('[data-task-row-completion] [data-task-completion-control]')).toBe(completion)
    expect(row?.querySelector('[data-task-row-actions]')).toBe(actions)
    expect(grip).toHaveClass('pointer-events-auto', 'opacity-100')
    expect(completion).toHaveClass('pointer-events-auto', 'opacity-100')
    expect(actions).toHaveAttribute('data-task-row-controls-pinned', 'true')
  })

  it('isolates add-subtask pointer and click ownership from opening, selecting and dragging the row', () => {
    render(<TaskListView {...props} />)
    const add = screen.getByRole('button', { name: `Agregar subtarea a ${task.title}` })

    fireEvent.pointerDown(add)
    fireEvent.click(add)

    expect(props.onAddSubtask).toHaveBeenCalledTimes(1)
    expect(props.onAddSubtask).toHaveBeenCalledWith(task, add)
    expect(props.onOpen).not.toHaveBeenCalled()
    expect(document.querySelector('[data-task-list-selection-toolbar]')).not.toBeInTheDocument()
  })

  it('uses one persistent coarse-pointer action trigger with a portaled, keyboard-dismissible menu', async () => {
    render(<TaskListView {...props} />)
    const trigger = screen.getByRole('button', { name: `Acciones de ${task.title}` })

    expect(trigger).toHaveClass('[@media(pointer:coarse)]:flex')
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu', { name: `Acciones de ${task.title}` })
    expect(menu).toHaveStyle({ zIndex: '100' })
    expect(within(menu).getByRole('menuitem', { name: 'Agregar subtarea' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Cambiar nombre' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Destacar tarea' })).toBeInTheDocument()
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Agregar subtarea' })).toHaveFocus())
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(within(menu).getByRole('menuitem', { name: 'Cambiar nombre' })).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'End' })
    expect(within(menu).getByRole('menuitem', { name: 'Destacar tarea' })).toHaveFocus()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu', { name: `Acciones de ${task.title}` })).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(props.onOpen).not.toHaveBeenCalled()
  })

  it('renames inline with one write across Enter and blur and pins pending feedback to the row', async () => {
    let resolveRename: (() => void) | undefined
    const onRenameTask = vi.fn(() => new Promise<void>(resolve => { resolveRename = resolve }))
    render(<TaskListView {...props} onRenameTask={onRenameTask} />)

    fireEvent.click(screen.getByRole('button', { name: `Cambiar nombre de ${task.title}` }))
    const input = screen.getByRole('textbox', { name: `Nuevo nombre de ${task.title}` })
    fireEvent.change(input, { target: { value: '  Nombre canónico nuevo  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)

    await waitFor(() => expect(onRenameTask).toHaveBeenCalledTimes(1))
    expect(onRenameTask).toHaveBeenCalledWith(task, 'Nombre canónico nuevo')
    expect(input).toBeDisabled()
    expect(document.querySelector(`[data-task-list-row="${task.id}"]`)).toHaveAttribute('data-task-row-pending', 'true')
    expect(document.querySelector('[data-task-row-actions]')).toHaveAttribute('data-task-row-controls-pinned', 'true')

    await act(async () => { resolveRename?.(); await Promise.resolve() })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: `Nuevo nombre de ${task.title}` })).not.toBeInTheDocument())
  })

  it('restores the canonical title with Escape and never writes an empty name', async () => {
    render(<TaskListView {...props} />)

    fireEvent.click(screen.getByRole('button', { name: `Cambiar nombre de ${task.title}` }))
    let input = screen.getByRole('textbox', { name: `Nuevo nombre de ${task.title}` })
    fireEvent.change(input, { target: { value: 'Nombre descartado' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(props.onRenameTask).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: `Nuevo nombre de ${task.title}` })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: `Abrir tarea ${task.title}` })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: `Cambiar nombre de ${task.title}` }))
    input = screen.getByRole('textbox', { name: `Nuevo nombre de ${task.title}` })
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)

    expect(await screen.findByRole('alert')).toHaveTextContent('Escribe un nombre')
    expect(props.onRenameTask).not.toHaveBeenCalled()
    expect(input).toHaveValue('   ')
  })

  it('keeps the rename draft and exposes a retryable error when the write rejects', async () => {
    const onRenameTask = vi.fn()
      .mockRejectedValueOnce(new Error('La tarea cambió en otra sesión.'))
      .mockResolvedValueOnce(undefined)
    render(<TaskListView {...props} onRenameTask={onRenameTask} />)

    fireEvent.click(screen.getByRole('button', { name: `Cambiar nombre de ${task.title}` }))
    const input = screen.getByRole('textbox', { name: `Nuevo nombre de ${task.title}` })
    fireEvent.change(input, { target: { value: 'Borrador recuperable' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByRole('alert')).toHaveTextContent('La tarea cambió en otra sesión.')
    expect(input).toHaveValue('Borrador recuperable')
    expect(input).not.toBeDisabled()

    fireEvent.change(input, { target: { value: 'Borrador reintentado' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onRenameTask).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: `Nuevo nombre de ${task.title}` })).not.toBeInTheDocument())
  })

  it('keeps the active inspector marker independent from selection and exposes priority', () => {
    render(<TaskListView {...props} activeTaskId={task.id} />)

    const row = document.querySelector(`[data-task-list-row="${task.id}"]`)
    expect(row).toHaveAttribute('aria-current', 'true')
    expect(row).toHaveAttribute('data-task-active', 'true')
    expect(row).not.toHaveClass('ring-emerald-200')
    expect(screen.getByLabelText('Prioridad: Media')).toBeInTheDocument()

    fireEvent.click(row!, { ctrlKey: true })
    expect(row).toHaveClass('ring-emerald-200')
    expect(row).toHaveAttribute('aria-current', 'true')
  })

  it('renders each priority permanently instead of hiding low and medium tasks', () => {
    const priorities = ['low', 'medium', 'high', 'urgent'] as const
    const tasks = priorities.map((priority, index) => ({ ...task, id: `task-${priority}`, title: `Tarea ${index}`, priority }))
    render(<TaskListView {...props} tasks={tasks} />)

    expect(screen.getByLabelText('Prioridad: Baja')).toBeInTheDocument()
    expect(screen.getByLabelText('Prioridad: Media')).toBeInTheDocument()
    expect(screen.getByLabelText('Prioridad: Alta')).toBeInTheDocument()
    expect(screen.getByLabelText('Prioridad: Urgente')).toBeInTheDocument()
  })

  it('loads children only when their accessible accordion opens and keeps them outside sortable rows', async () => {
    apiMocks.get.mockResolvedValue({ success: true, data: { tasks: [childTask] } })
    const parent = { ...task, subtask_count: 1, subtask_done: 0 }
    render(<TaskListView {...props} tasks={[parent]} />)

    const trigger = screen.getByRole('button', { name: `Expandir subtareas de ${parent.title}` })
    const region = document.getElementById(`task-subtasks-${parent.id}`)
    expect(region).not.toBeNull()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(region).toHaveAttribute('aria-hidden', 'true')
    expect(region).toHaveAttribute('inert')
    expect(apiMocks.get).not.toHaveBeenCalled()

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => expect(screen.getByText(childTask.title)).toBeInTheDocument())
    expect(apiMocks.get).toHaveBeenCalledWith(`/api/tasks/${parent.id}/children`, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(document.querySelectorAll('[data-task-list-row]')).toHaveLength(1)
    expect(document.querySelector('[data-task-subtask-row="child-1"]')).toBeInTheDocument()
  })

  it('allows an inline child rename without ever offering a second subtask level', async () => {
    apiMocks.get.mockResolvedValue({ success: true, data: { tasks: [childTask] } })
    const parent = { ...task, subtask_count: 1, subtask_done: 0 }
    render(<TaskListView {...props} tasks={[parent]} />)

    fireEvent.click(screen.getByRole('button', { name: `Expandir subtareas de ${parent.title}` }))
    const childRow = await waitFor(() => {
      const row = document.querySelector<HTMLElement>(`[data-task-subtask-row="${childTask.id}"]`)
      expect(row).not.toBeNull()
      return row!
    })

    expect(within(childRow).queryByRole('button', { name: `Agregar subtarea a ${childTask.title}` })).not.toBeInTheDocument()
    fireEvent.click(within(childRow).getByRole('button', { name: `Acciones de ${childTask.title}` }))
    const childMenu = screen.getByRole('menu', { name: `Acciones de ${childTask.title}` })
    expect(within(childMenu).queryByRole('menuitem', { name: 'Agregar subtarea' })).not.toBeInTheDocument()
    fireEvent.click(within(childMenu).getByRole('menuitem', { name: 'Cambiar nombre' }))
    const input = within(childRow).getByRole('textbox', { name: `Nuevo nombre de ${childTask.title}` })
    fireEvent.change(input, { target: { value: 'Subtarea renombrada' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(props.onRenameTask).toHaveBeenCalledWith(childTask, 'Subtarea renombrada'))
    expect(props.onAddSubtask).not.toHaveBeenCalledWith(childTask, expect.anything())
  })

  it('reserves the disclosure column for every root and renders children in a quiet aligned group', async () => {
    apiMocks.get.mockResolvedValue({ success: true, data: { tasks: [childTask] } })
    const parent = { ...task, id: 'parent-aligned', title: 'Tarea con subtareas', subtask_count: 1, subtask_done: 0 }
    const ordinary = { ...task, id: 'ordinary-aligned', title: 'Tarea sin subtareas' }
    render(<TaskListView {...props} tasks={[parent, ordinary]} subtaskDisplayMode="expanded" />)

    await screen.findByText(childTask.title)
    const parentRow = document.querySelector('[data-task-list-row="parent-aligned"]')
    const ordinaryRow = document.querySelector('[data-task-list-row="ordinary-aligned"]')
    expect(parentRow?.querySelector('[data-task-disclosure-slot]')).toBeInTheDocument()
    expect(ordinaryRow?.querySelector('[data-task-disclosure-slot]')).toBeInTheDocument()
    expect(parentRow?.querySelector('[data-task-subtask-summary]')).toHaveTextContent('0/1')
    expect(document.querySelector('[data-task-subtask-group]')).toHaveClass('border-slate-200', 'bg-slate-50/80')
    expect(document.querySelector('[data-task-subtask-row="child-1"]')).toHaveClass('grid')
    expect(document.querySelector('[data-task-subtask-row="child-1"]')).not.toHaveClass('border-emerald-100', 'bg-emerald-50/20')
  })

  it('caps expanded parent loading at four concurrent requests', async () => {
    const pending: Array<() => void> = []
    apiMocks.get.mockImplementation(() => new Promise(resolve => pending.push(() => resolve({ success: true, data: { tasks: [] } }))))
    const parents = Array.from({ length: 5 }, (_, index) => ({ ...task, id: `parent-${index + 1}`, title: `Tarea ${index + 1}`, subtask_count: 1 }))
    render(<TaskListView {...props} tasks={parents} subtaskDisplayMode="expanded" />)

    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledTimes(4))
    pending[0]()
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledTimes(5))
  })

  it('cancels active work and clears the waiting queue when all accordions collapse', async () => {
    const pending: Array<() => void> = []
    apiMocks.get.mockImplementation(() => new Promise(resolve => pending.push(() => resolve({ success: true, data: { tasks: [] } }))))
    const parents = Array.from({ length: 5 }, (_, index) => ({ ...task, id: `parent-${index + 1}`, title: `Tarea ${index + 1}`, subtask_count: 1 }))
    const view = render(<TaskListView {...props} tasks={parents} subtaskDisplayMode="expanded" />)
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledTimes(4))

    view.rerender(<TaskListView {...props} tasks={parents} subtaskDisplayMode="collapsed" />)
    pending[0]()
    await Promise.resolve()
    await Promise.resolve()
    expect(apiMocks.get).toHaveBeenCalledTimes(4)
  })

  it('rolls back a conflicting child completion and reloads its canonical children', async () => {
    apiMocks.get.mockResolvedValue({ success: true, data: { tasks: [childTask] } })
    apiMocks.put.mockResolvedValue({ success: false, status: 409, error: 'conflict' })
    const parent = { ...task, subtask_count: 1, subtask_done: 0, progress_mode: 'automatic' as const, progress: 0 }
    render(<TaskListView {...props} tasks={[parent]} statuses={[status, doneStatus]} />)

    fireEvent.click(screen.getByRole('button', { name: `Expandir subtareas de ${parent.title}` }))
    await screen.findByText(childTask.title)
    const childRow = document.querySelector<HTMLElement>(`[data-task-subtask-row="${childTask.id}"]`)
    fireEvent.click(within(childRow!).getByRole('button', { name: 'Marcar como finalizada' }))

    await waitFor(() => expect(props.onError).toHaveBeenCalledWith(expect.stringContaining('cambió en otra sesión')))
    expect(document.querySelector('[data-task-subtask-summary]')).toHaveTextContent('0/1')
    expect(apiMocks.put).toHaveBeenCalledWith(`/api/tasks/${childTask.id}`, expect.objectContaining({ status_id: doneStatus.id, version: 1, operation_id: expect.any(String) }))
    expect(apiMocks.get).toHaveBeenCalledTimes(2)
  })
})
