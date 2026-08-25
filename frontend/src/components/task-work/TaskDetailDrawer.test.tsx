import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Task, TaskAttachment } from '@/types/task'
import TaskDetailDrawer from './TaskDetailDrawer'

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  delete: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  upload: vi.fn(),
  subscribe: vi.fn((_listener: (raw: unknown) => void) => () => {}),
}))
const accessPanelMocks = vi.hoisted(() => ({
  callbacks: new Map<string, (changed?: Task, operationID?: string) => void>(),
}))

vi.mock('@/lib/api', () => ({
  apiDelete: apiMocks.delete,
  apiGet: apiMocks.get,
  apiPatch: apiMocks.patch,
  apiPost: apiMocks.post,
  apiPut: apiMocks.put,
  apiUpload: apiMocks.upload,
  subscribeWebSocket: apiMocks.subscribe,
}))

vi.mock('./TaskAccessPanel', () => ({
  default: ({ task: panelTask, onChanged }: { task: Task; onChanged: (changed?: Task, operationID?: string) => void }) => {
    accessPanelMocks.callbacks.set(panelTask.id, onChanged)
    return null
  },
}))

vi.mock('./useTaskDetailWindow', () => ({
  default: () => ({
    beginDrag: vi.fn(),
    beginResize: vi.fn(),
    effectiveMode: 'docked',
    isMobile: false,
    isModal: false,
    panelStyle: { inset: '0 0 0 auto', width: '880px' },
    resetGeometry: vi.fn(),
    setMode: vi.fn(),
    toggleMaximized: vi.fn(),
  }),
}))

const task = {
  id: 'task-1',
  account_id: 'account-1',
  created_by: 'user-1',
  assigned_to: 'user-1',
  title: 'Preparar guardias',
  description: 'Coordinar el equipo.',
  priority: 'medium',
  status_id: 'status-1',
  status_detail: { id: 'status-1', workflow_id: 'workflow-1', name: 'Por hacer', category: 'not_started', color: '#64748B', sort_order: 0 },
  list_id: 'list-1',
  list_name: 'Seguridad',
  version: 1,
  subtask_count: 0,
  subtask_done: 0,
  progress_mode: 'manual',
  progress: 0,
  collaborator_ids: [],
  permissions: { can_view: true, can_comment: true, can_edit: true, can_delete: true, can_administer: true },
} as unknown as Task

function mockTaskDetailAPI(tasks: Task[], children: Record<string, Task[]> = {}) {
  apiMocks.get.mockImplementation(async (endpoint: string) => {
    const taskMatch = endpoint.match(/^\/api\/tasks\/([^/?]+)$/)
    if (taskMatch) return { success: true, data: { task: tasks.find(item => item.id === taskMatch[1]) } }
    const childrenMatch = endpoint.match(/^\/api\/tasks\/([^/]+)\/children$/)
    if (childrenMatch) return { success: true, data: { tasks: children[childrenMatch[1]] || [] } }
    if (endpoint.includes('/comments?')) return { success: true, data: { comments: [], has_more: false, next_offset: 0 } }
    if (endpoint.endsWith('/activity')) return { success: true, data: { activity: [] } }
    if (endpoint.endsWith('/attachments')) return { success: true, data: { attachments: [] } }
    if (endpoint.endsWith('/dependencies')) return { success: true, data: { dependencies: [] } }
    return { success: false, error: `Unexpected endpoint ${endpoint}` }
  })
  apiMocks.put.mockImplementation(async (_endpoint: string, body: Record<string, unknown>) => ({
    success: true,
    data: {
      task: {
        ...tasks[0],
        ...body,
        version: Number(tasks[0]?.version || 0) + 1,
        progress: body.progress_mode === 'automatic' ? 0 : body.manual_progress ?? tasks[0]?.progress,
      },
      operation_id: 'operation-1',
    },
  }))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

function attachment(id: string, taskID: string, filename: string): TaskAttachment {
  return {
    id,
    account_id: 'account-1',
    task_id: taskID,
    media_asset_id: `asset-${id}`,
    filename,
    content_type: 'image/png',
    media_type: 'image',
    size_bytes: 128,
    url: `/api/media/${id}`,
    created_at: '2026-08-24T00:00:00.000Z',
  }
}

describe('TaskDetailDrawer simplified full-editor access', () => {
  beforeAll(() => {
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    HTMLElement.prototype.scrollTo = vi.fn()
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    accessPanelMocks.callbacks.clear()
    apiMocks.subscribe.mockImplementation((_listener: (raw: unknown) => void) => () => {})
  })

  it('removes the redundant properties action and keeps one accessible pencil entry', async () => {
    mockTaskDetailAPI([task])
    const onEdit = vi.fn()
    render(<TaskDetailDrawer
      taskId={task.id}
      inFlowDocked
      allTasks={[task]}
      users={[]}
      lists={[]}
      folders={[]}
      workflows={[]}
      onClose={vi.fn()}
      onEdit={onEdit}
      onOpenTask={vi.fn()}
      onCreateSubtask={vi.fn()}
      onChanged={vi.fn()}
      onDeleted={vi.fn(() => true)}
    />)

    await screen.findByDisplayValue(task.title)
    expect(screen.getByRole('complementary', { name: 'Detalle de tarea' })).toHaveAttribute('data-backdrop-mode', 'docked')
    expect(screen.getByText('Propiedades')).toBeInTheDocument()
    expect(screen.queryByText('Más opciones')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Crear con detalles' })).toBeInTheDocument()
    const fullEditorButtons = screen.getAllByRole('button', { name: 'Editar todas las propiedades' })
    expect(fullEditorButtons).toHaveLength(1)
    expect(fullEditorButtons[0]).toHaveAttribute('title', 'Editar todas las propiedades')

    fireEvent.click(fullEditorButtons[0])
    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1))
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }))
  })

  it('uses one date-range field and completes through the preferred done status', async () => {
    const doneStatus = { ...task.status_detail!, id: 'status-done', name: 'Finalizada', category: 'done' as const, sort_order: 2, is_default: true }
    mockTaskDetailAPI([task])
    render(<TaskDetailDrawer
      taskId={task.id}
      allTasks={[task]}
      users={[{ id: 'user-1', display_name: 'Usuario', username: 'usuario' }]}
      lists={[{ id: 'list-1', workflow_id: 'workflow-1', name: 'Seguridad' } as never]}
      folders={[]}
      workflows={[{ id: 'workflow-1', is_default: true, statuses: [task.status_detail!, doneStatus] } as never]}
      onClose={vi.fn()}
      onEdit={vi.fn()}
      onOpenTask={vi.fn()}
      onCreateSubtask={vi.fn()}
      onChanged={vi.fn()}
      onDeleted={vi.fn(() => true)}
    />)

    await screen.findByDisplayValue(task.title)
    expect(document.querySelectorAll('[data-task-date-range-trigger]')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /Fechas de la tarea:/ }))
    expect(screen.getByRole('dialog', { name: 'Editar Fechas de la tarea' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editar Fechas de la tarea' })).not.toBeInTheDocument())
    expect(screen.getByRole('dialog', { name: 'Detalle de tarea' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Marcar como finalizada' }))

    await waitFor(() => expect(apiMocks.put).toHaveBeenCalledWith('/api/tasks/task-1', expect.objectContaining({
      status_id: 'status-done',
      version: 1,
      operation_id: expect.any(String),
    })))
  })

  it('creates a real child with the selected quick fields and canonical reconciliation envelope', async () => {
    const child = { ...task, id: 'child-1', title: 'Confirmar cobertura', parent_task_id: task.id, version: 1 }
    mockTaskDetailAPI([task])
    apiMocks.post.mockResolvedValue({ success: true, data: { task: child, operation_id: 'child-operation', hierarchy_counts: { task_count: 2 } } })
    const onChanged = vi.fn()
    render(<TaskDetailDrawer
      taskId={task.id}
      allTasks={[task]}
      users={[{ id: 'user-1', display_name: 'Usuario', username: 'usuario' }]}
      lists={[{ id: 'list-1', workflow_id: 'workflow-1', name: 'Seguridad' } as never]}
      folders={[]}
      workflows={[{ id: 'workflow-1', is_default: true, statuses: [{ ...task.status_detail!, is_default: true }] } as never]}
      onClose={vi.fn()}
      onEdit={vi.fn()}
      onOpenTask={vi.fn()}
      onCreateSubtask={vi.fn()}
      onChanged={onChanged}
      onDeleted={vi.fn(() => true)}
    />)

    const title = await screen.findByRole('textbox', { name: 'Nombre de la subtarea' })
    fireEvent.focus(title)
    fireEvent.change(title, { target: { value: 'Confirmar cobertura' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith('/api/tasks/task-1/children', expect.objectContaining({
      title: 'Confirmar cobertura',
      assigned_to: 'user-1',
      status_id: 'status-1',
      priority: 'medium',
      operation_id: expect.any(String),
      confirm_grants: false,
    })))
    expect(onChanged).toHaveBeenCalledWith(child, 'child-operation', { task_count: 2 })
    expect(title).toHaveValue('')
  })

  it('uses the task workflow as truth when its list catalog is hidden', async () => {
    const unrelatedDone = { ...task.status_detail!, id: 'other-done', workflow_id: 'other-workflow', name: 'Finalizada ajena', category: 'done' as const, sort_order: 2 }
    const sharedTask = { ...task, status_detail: { ...task.status_detail!, workflow_id: 'shared-workflow' } }
    mockTaskDetailAPI([sharedTask])
    render(<TaskDetailDrawer taskId={sharedTask.id} allTasks={[sharedTask]} users={[]} lists={[]} folders={[]} workflows={[{ id: 'other-workflow', is_default: true, statuses: [unrelatedDone] } as never]} onClose={vi.fn()} onEdit={vi.fn()} onOpenTask={vi.fn()} onCreateSubtask={vi.fn()} onChanged={vi.fn()} onDeleted={vi.fn(() => true)} />)

    await screen.findByDisplayValue(sharedTask.title)
    expect(screen.getByRole('button', { name: 'Marcar como finalizada' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Por hacer/i }))
    expect(screen.getByRole('listbox', { name: 'Seleccionar estado' })).not.toHaveTextContent('Finalizada ajena')
  })

  it('hydrates a direct-navigation child draft and resets it after the full editor succeeds', async () => {
    mockTaskDetailAPI([task])
    const commonProps = {
      taskId: task.id,
      allTasks: [] as Task[],
      users: [{ id: 'user-1', display_name: 'Usuario', username: 'usuario' }],
      lists: [{ id: 'list-1', workflow_id: 'workflow-1', name: 'Seguridad' } as never],
      folders: [],
      workflows: [{ id: 'workflow-1', is_default: true, statuses: [{ ...task.status_detail!, is_default: true }] } as never],
      onClose: vi.fn(),
      onEdit: vi.fn(),
      onOpenTask: vi.fn(),
      onCreateSubtask: vi.fn(),
      onChanged: vi.fn(),
      onDeleted: vi.fn(() => true),
    }
    const { rerender } = render(<TaskDetailDrawer {...commonProps} subtaskDraftResetToken={0} />)

    const title = await screen.findByRole('textbox', { name: 'Nombre de la subtarea' })
    fireEvent.focus(title)
    fireEvent.change(title, { target: { value: 'Borrador para editor completo' } })
    const composer = document.querySelector<HTMLElement>('[data-task-quick-subtask-composer]')!
    expect(within(composer).getByRole('button', { name: /Por hacer/i })).toBeInTheDocument()
    expect(within(composer).getByRole('button', { name: /Usuario/i })).toBeInTheDocument()

    rerender(<TaskDetailDrawer {...commonProps} subtaskDraftResetToken={1} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Nombre de la subtarea' })).toHaveValue(''))
  })

  it('uses one validated manual percentage field and writes once on Enter or blur', async () => {
    mockTaskDetailAPI([{ ...task, manual_progress: 20, progress: 20 }])
    render(<TaskDetailDrawer taskId={task.id} allTasks={[task]} users={[]} lists={[]} folders={[]} workflows={[]} onClose={vi.fn()} onEdit={vi.fn()} onOpenTask={vi.fn()} onCreateSubtask={vi.fn()} onChanged={vi.fn()} onDeleted={vi.fn(() => true)} />)

    const input = await screen.findByRole('spinbutton', { name: 'Porcentaje manual' })
    expect(document.querySelector('input[type="range"]')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '75%' })).not.toBeInTheDocument()

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '75' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    await waitFor(() => expect(apiMocks.put).toHaveBeenCalledTimes(1))
    expect(apiMocks.put).toHaveBeenLastCalledWith('/api/tasks/task-1', expect.objectContaining({ progress_mode: 'manual', manual_progress: 75 }))

    fireEvent.change(input, { target: { value: '10.5' } })
    fireEvent.blur(input)
    expect(await screen.findByRole('alert')).toHaveTextContent('entero')
    expect(apiMocks.put).toHaveBeenCalledTimes(1)

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue(75)
    expect(apiMocks.put).toHaveBeenCalledTimes(1)
  })

  it('preserves manual progress through automatic mode and renders completed tasks at 100%', async () => {
    const manualTask = { ...task, manual_progress: 37, progress: 37 }
    mockTaskDetailAPI([manualTask])
    const view = render(<TaskDetailDrawer taskId={task.id} allTasks={[manualTask]} users={[]} lists={[]} folders={[]} workflows={[]} onClose={vi.fn()} onEdit={vi.fn()} onOpenTask={vi.fn()} onCreateSubtask={vi.fn()} onChanged={vi.fn()} onDeleted={vi.fn(() => true)} />)
    await screen.findByRole('spinbutton', { name: 'Porcentaje manual' })

    fireEvent.click(screen.getByRole('button', { name: 'Automático' }))
    await waitFor(() => expect(apiMocks.put).toHaveBeenCalledWith('/api/tasks/task-1', expect.objectContaining({ progress_mode: 'automatic', manual_progress: 37 })))
    fireEvent.click(screen.getByRole('button', { name: 'Manual' }))
    expect(await screen.findByRole('spinbutton', { name: 'Porcentaje manual' })).toHaveValue(37)

    view.unmount()
    apiMocks.put.mockClear()
    const completed: Task = { ...task, manual_progress: 37, progress: 100, status: 'completed', status_detail: { ...task.status_detail!, category: 'done' as const } }
    mockTaskDetailAPI([completed])
    render(<TaskDetailDrawer taskId={task.id} allTasks={[completed]} users={[]} lists={[]} folders={[]} workflows={[]} onClose={vi.fn()} onEdit={vi.fn()} onOpenTask={vi.fn()} onCreateSubtask={vi.fn()} onChanged={vi.fn()} onDeleted={vi.fn(() => true)} />)
    expect(await screen.findByText('100% completado')).toBeInTheDocument()
    expect(screen.queryByRole('spinbutton', { name: 'Porcentaje manual' })).not.toBeInTheDocument()
  })

  it('returns from a subtask to its parent on Escape, restores focus, then closes from the parent', async () => {
    const child = { ...task, id: 'task-child', title: 'Revisar materiales', parent_task_id: task.id }
    mockTaskDetailAPI([task, child], { [task.id]: [child] })
    const onClose = vi.fn()
    function Harness() {
      const [taskID, setTaskID] = useState(task.id)
      return <TaskDetailDrawer taskId={taskID} allTasks={[task, child]} users={[]} lists={[]} folders={[]} workflows={[]} onClose={onClose} onEdit={vi.fn()} onOpenTask={setTaskID} onCreateSubtask={vi.fn()} onChanged={vi.fn()} onDeleted={vi.fn(() => true)} />
    }
    render(<Harness />)

    const childLink = await screen.findByRole('button', { name: /Revisar materiales/ })
    fireEvent.click(childLink)
    await screen.findByDisplayValue('Revisar materiales')
    const preventedEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    preventedEscape.preventDefault()
    window.dispatchEvent(preventedEscape)
    expect(screen.getByDisplayValue('Revisar materiales')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    await screen.findByDisplayValue(task.title)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /Revisar materiales/ })))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('aborts the A read session and rejects its late payload after navigating to B', async () => {
    const second = { ...task, id: 'task-2', title: 'Segunda tarea', version: 4 }
    const firstRead = deferred<{ success: boolean; data: { task: Task } }>()
    const secondRead = deferred<{ success: boolean; data: { task: Task } }>()
    const signals = new Map<string, AbortSignal | undefined>()
    apiMocks.get.mockImplementation((endpoint: string, options?: { signal?: AbortSignal }) => {
      const taskMatch = endpoint.match(/^\/api\/tasks\/([^/?]+)$/)
      if (taskMatch) {
        signals.set(taskMatch[1], options?.signal)
        return taskMatch[1] === task.id ? firstRead.promise : secondRead.promise
      }
      if (endpoint.endsWith('/children')) return Promise.resolve({ success: true, data: { tasks: [] } })
      if (endpoint.includes('/comments?')) return Promise.resolve({ success: true, data: { comments: [], has_more: false, next_offset: 0 } })
      if (endpoint.endsWith('/activity')) return Promise.resolve({ success: true, data: { activity: [] } })
      if (endpoint.endsWith('/attachments')) return Promise.resolve({ success: true, data: { attachments: [] } })
      if (endpoint.endsWith('/dependencies')) return Promise.resolve({ success: true, data: { dependencies: [] } })
      return Promise.resolve({ success: false, error: `Unexpected endpoint ${endpoint}` })
    })
    const common = { allTasks: [task, second], users: [], lists: [], folders: [], workflows: [], onClose: vi.fn(), onEdit: vi.fn(), onOpenTask: vi.fn(), onCreateSubtask: vi.fn(), onChanged: vi.fn(), onDeleted: vi.fn(() => true) }
    const view = render(<TaskDetailDrawer taskId={task.id} {...common} />)
    await screen.findByDisplayValue(task.title)
    view.rerender(<TaskDetailDrawer taskId={second.id} {...common} />)
    await screen.findByDisplayValue(second.title)
    expect(signals.get(task.id)?.aborted).toBe(true)

    await act(async () => { secondRead.resolve({ success: true, data: { task: { ...second, title: 'Segunda canónica' } } }); await Promise.resolve() })
    expect(screen.getByDisplayValue('Segunda canónica')).toBeInTheDocument()
    await act(async () => { firstRead.resolve({ success: true, data: { task: { ...task, title: 'A atrasada' } } }); await Promise.resolve() })
    expect(screen.getByDisplayValue('Segunda canónica')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('A atrasada')).not.toBeInTheDocument()
  })

  it('keeps a late write failure and its title draft scoped to A while B is visible', async () => {
    const second = { ...task, id: 'task-2', title: 'Segunda tarea', version: 2 }
    mockTaskDetailAPI([task, second])
    const write = deferred<{ success: boolean; error: string; status: number }>()
    apiMocks.put.mockReturnValue(write.promise)
    const onChanged = vi.fn()
    const common = { allTasks: [task, second], users: [], lists: [], folders: [], workflows: [], onClose: vi.fn(), onEdit: vi.fn(), onOpenTask: vi.fn(), onCreateSubtask: vi.fn(), onChanged, onDeleted: vi.fn(() => true) }
    const view = render(<TaskDetailDrawer taskId={task.id} {...common} />)
    const title = await screen.findByRole('textbox', { name: 'Título de la tarea' })
    fireEvent.focus(title)
    fireEvent.change(title, { target: { value: 'Borrador A' } })
    fireEvent.blur(title)
    await waitFor(() => expect(apiMocks.put).toHaveBeenCalledTimes(1))

    view.rerender(<TaskDetailDrawer taskId={second.id} {...common} />)
    await screen.findByDisplayValue(second.title)
    await act(async () => { write.resolve({ success: false, error: 'Fallo tardío de A', status: 503 }); await Promise.resolve() })
    expect(screen.queryByText('Fallo tardío de A')).not.toBeInTheDocument()
    expect(screen.getByDisplayValue(second.title)).toBeInTheDocument()

    view.rerender(<TaskDetailDrawer taskId={task.id} {...common} />)
    expect(await screen.findByDisplayValue('Borrador A')).toBeInTheDocument()
    expect(await screen.findByText('Fallo tardío de A')).toBeInTheDocument()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('reconciles a successful late write for A without replacing the visible task B', async () => {
    const second = { ...task, id: 'task-2', title: 'Segunda tarea', version: 2 }
    mockTaskDetailAPI([task, second])
    const write = deferred<{ success: boolean; data: { task: Task; operation_id: string } }>()
    apiMocks.put.mockReturnValue(write.promise)
    const onChanged = vi.fn()
    const common = { allTasks: [task, second], users: [], lists: [], folders: [], workflows: [], onClose: vi.fn(), onEdit: vi.fn(), onOpenTask: vi.fn(), onCreateSubtask: vi.fn(), onChanged, onDeleted: vi.fn(() => true) }
    const view = render(<TaskDetailDrawer taskId={task.id} {...common} />)
    const title = await screen.findByRole('textbox', { name: 'Título de la tarea' })
    fireEvent.focus(title)
    fireEvent.change(title, { target: { value: 'A guardada' } })
    fireEvent.blur(title)
    await waitFor(() => expect(apiMocks.put).toHaveBeenCalledTimes(1))

    view.rerender(<TaskDetailDrawer taskId={second.id} {...common} />)
    await screen.findByDisplayValue(second.title)
    await act(async () => {
      write.resolve({ success: true, data: { task: { ...task, title: 'A guardada', version: 2 }, operation_id: 'write-A' } })
      await Promise.resolve()
    })

    expect(screen.getByDisplayValue(second.title)).toBeInTheDocument()
    expect(screen.queryByDisplayValue('A guardada')).not.toBeInTheDocument()
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ id: task.id, title: 'A guardada', version: 2 }), 'write-A', undefined)

    view.rerender(<TaskDetailDrawer taskId={task.id} {...common} />)
    expect(await screen.findByDisplayValue('A guardada')).toBeInTheDocument()
    expect(screen.queryByText(/No se pudo guardar/)).not.toBeInTheDocument()
  })

  it('rejects an auxiliary A attachment refresh after navigating A → B → A', async () => {
    const second = { ...task, id: 'task-2', title: 'Segunda tarea', version: 2 }
    const fresh = attachment('attachment-fresh', task.id, 'vigente.png')
    const staleRefresh = deferred<{ success: boolean; data: { attachments: TaskAttachment[] } }>()
    let deferNextARefresh = false
    let initialARead = true
    let socketListener: ((raw: unknown) => void) | undefined
    apiMocks.subscribe.mockImplementation((listener: (raw: unknown) => void) => {
      socketListener = listener
      return () => {}
    })
    apiMocks.get.mockImplementation((endpoint: string) => {
      const taskMatch = endpoint.match(/^\/api\/tasks\/([^/?]+)$/)
      if (taskMatch) return Promise.resolve({ success: true, data: { task: taskMatch[1] === task.id ? task : second } })
      if (endpoint.endsWith('/children')) return Promise.resolve({ success: true, data: { tasks: [] } })
      if (endpoint.includes('/comments?')) return Promise.resolve({ success: true, data: { comments: [], has_more: false, next_offset: 0 } })
      if (endpoint.endsWith('/activity')) return Promise.resolve({ success: true, data: { activity: [] } })
      if (endpoint.endsWith('/dependencies')) return Promise.resolve({ success: true, data: { dependencies: [] } })
      if (endpoint === `/api/tasks/${task.id}/attachments`) {
        if (deferNextARefresh) {
          deferNextARefresh = false
          return staleRefresh.promise
        }
        if (initialARead) {
          initialARead = false
          return Promise.resolve({ success: true, data: { attachments: [] } })
        }
        return Promise.resolve({ success: true, data: { attachments: [fresh] } })
      }
      if (endpoint === `/api/tasks/${second.id}/attachments`) return Promise.resolve({ success: true, data: { attachments: [] } })
      return Promise.resolve({ success: false, error: `Unexpected endpoint ${endpoint}` })
    })
    const common = { allTasks: [task, second], users: [], lists: [], folders: [], workflows: [], onClose: vi.fn(), onEdit: vi.fn(), onOpenTask: vi.fn(), onCreateSubtask: vi.fn(), onChanged: vi.fn(), onDeleted: vi.fn(() => true) }
    const view = render(<TaskDetailDrawer taskId={task.id} {...common} />)
    await screen.findByDisplayValue(task.title)

    deferNextARefresh = true
    act(() => socketListener?.({ event: 'task_update', data: { action: 'attachment_added', task_id: task.id } }))
    await waitFor(() => expect(deferNextARefresh).toBe(false))

    view.rerender(<TaskDetailDrawer taskId={second.id} {...common} />)
    await screen.findByDisplayValue(second.title)
    view.rerender(<TaskDetailDrawer taskId={task.id} {...common} />)
    await screen.findByText('vigente.png')

    await act(async () => {
      staleRefresh.resolve({ success: true, data: { attachments: [] } })
      await Promise.resolve()
    })
    expect(screen.getByText('vigente.png')).toBeInTheDocument()
  })

  it('keeps every file in a multi-upload bound to A after B becomes active', async () => {
    const second = { ...task, id: 'task-2', title: 'Segunda tarea', version: 2 }
    mockTaskDetailAPI([task, second])
    const firstUpload = deferred<{ success: boolean; data: { attachment: TaskAttachment } }>()
    apiMocks.upload
      .mockReturnValueOnce(firstUpload.promise)
      .mockResolvedValueOnce({ success: true, data: { attachment: attachment('attachment-2', task.id, 'dos.png') } })
    const common = { allTasks: [task, second], users: [], lists: [], folders: [], workflows: [], onClose: vi.fn(), onEdit: vi.fn(), onOpenTask: vi.fn(), onCreateSubtask: vi.fn(), onChanged: vi.fn(), onDeleted: vi.fn(() => true) }
    const view = render(<TaskDetailDrawer taskId={task.id} {...common} />)
    await screen.findByDisplayValue(task.title)
    const input = document.querySelector<HTMLInputElement>('input[type="file"][multiple]')!
    const first = new File(['one'], 'uno.png', { type: 'image/png' })
    const secondFile = new File(['two'], 'dos.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [first, secondFile] } })
    await waitFor(() => expect(apiMocks.upload).toHaveBeenCalledTimes(1))

    view.rerender(<TaskDetailDrawer taskId={second.id} {...common} />)
    await screen.findByDisplayValue(second.title)
    await act(async () => {
      firstUpload.resolve({ success: true, data: { attachment: attachment('attachment-1', task.id, 'uno.png') } })
      await Promise.resolve()
    })
    await waitFor(() => expect(apiMocks.upload).toHaveBeenCalledTimes(2))
    expect(apiMocks.upload.mock.calls.map(call => call[0])).toEqual([
      `/api/tasks/${task.id}/attachments/upload`,
      `/api/tasks/${task.id}/attachments/upload`,
    ])
    expect(screen.getByDisplayValue(second.title)).toBeInTheDocument()
  })

  it('restores a late comment attachment only in the A draft', async () => {
    const second = { ...task, id: 'task-2', title: 'Segunda tarea', version: 2 }
    mockTaskDetailAPI([task, second])
    const uploadResult = deferred<{ success: boolean; data: { attachment: TaskAttachment } }>()
    apiMocks.upload.mockReturnValue(uploadResult.promise)
    const common = { allTasks: [task, second], users: [], lists: [], folders: [], workflows: [], onClose: vi.fn(), onEdit: vi.fn(), onOpenTask: vi.fn(), onCreateSubtask: vi.fn(), onChanged: vi.fn(), onDeleted: vi.fn(() => true) }
    const view = render(<TaskDetailDrawer taskId={task.id} {...common} />)
    await screen.findByDisplayValue(task.title)
    fireEvent.click(screen.getByRole('button', { name: /^Actividad/ }))
    const attachButton = screen.getByTitle('Adjuntar archivo')
    const input = attachButton.parentElement?.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).toBeTruthy()
    fireEvent.change(input!, { target: { files: [new File(['draft'], 'borrador.png', { type: 'image/png' })] } })
    await waitFor(() => expect(apiMocks.upload).toHaveBeenCalledTimes(1))

    view.rerender(<TaskDetailDrawer taskId={second.id} {...common} />)
    await screen.findByDisplayValue(second.title)
    await act(async () => {
      uploadResult.resolve({ success: true, data: { attachment: attachment('attachment-draft', task.id, 'borrador.png') } })
      await uploadResult.promise
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByRole('button', { name: /^borrador\.png/ })).not.toBeInTheDocument()

    view.rerender(<TaskDetailDrawer taskId={task.id} {...common} />)
    await screen.findByDisplayValue(task.title)
    fireEvent.click(screen.getByRole('button', { name: /^Actividad/ }))
    expect(await screen.findByRole('button', { name: /^borrador\.png/ })).toBeInTheDocument()
  })

  it('stores a late TaskAccessPanel result for A without replacing visible B', async () => {
    const second = { ...task, id: 'task-2', title: 'Segunda tarea', version: 2 }
    mockTaskDetailAPI([task, second])
    const onChanged = vi.fn()
    const common = { allTasks: [task, second], users: [], lists: [], folders: [], workflows: [], onClose: vi.fn(), onEdit: vi.fn(), onOpenTask: vi.fn(), onCreateSubtask: vi.fn(), onChanged, onDeleted: vi.fn(() => true) }
    const view = render(<TaskDetailDrawer taskId={task.id} {...common} />)
    await screen.findByDisplayValue(task.title)
    const lateAChange = accessPanelMocks.callbacks.get(task.id)
    expect(lateAChange).toBeTypeOf('function')

    view.rerender(<TaskDetailDrawer taskId={second.id} {...common} />)
    await screen.findByDisplayValue(second.title)
    act(() => lateAChange?.({ ...task, title: 'A acceso tardío', version: 3 }, 'access-A'))

    expect(screen.getByDisplayValue(second.title)).toBeInTheDocument()
    expect(screen.queryByDisplayValue('A acceso tardío')).not.toBeInTheDocument()
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ id: task.id, title: 'A acceso tardío' }), 'access-A')
  })
})
