import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OfflineDataGateway } from '@/offline-v3/gateway'
import { LocalServiceError, type OfflineTask, type SyncStatus } from '@/offline-v3/types'
import OfflineTasksView from './OfflineTasksView'

afterEach(cleanup)

const sync: SyncStatus = {
  state: 'waiting_network',
  server_reachability: 'unreachable',
  pending_count: 1,
  conflict_count: 0,
  outcome_unknown_count: 0,
  lease_expires_at: '2026-09-15T00:00:00Z',
  selection_revision: 1,
}

const task: OfflineTask = {
  id: '44444444-4444-4444-8444-444444444444',
  version: 1,
  title: 'Informe local',
  description: '',
  priority: 'medium',
  status: 'pending',
  list_id: '55555555-5555-4555-8555-555555555555',
  is_all_day: false,
  created_at: '2026-09-14T20:00:00Z',
  updated_at: '2026-09-14T20:00:00Z',
  local_confirmation: 'pending',
  can_complete: true,
}

function gateway(createTask: OfflineDataGateway['createTask']): OfflineDataGateway {
  return {
    resources: vi.fn(),
    taskLists: vi.fn().mockResolvedValue({
      items: [{ selection_id: '66666666-6666-4666-8666-666666666666', id: task.list_id, name: 'General', environment_id: '77777777-7777-4777-8777-777777777777', environment_name: 'General', statuses: [], can_create: true }],
      snapshot: { selection_revision: 1, head_version: 1, last_synced_at: '2026-09-14T20:00:00Z' },
    }),
    tasks: vi.fn().mockResolvedValue({ items: [], snapshot: { selection_revision: 1, head_version: 1, last_synced_at: '2026-09-14T20:00:00Z' } }),
    contacts: vi.fn(), contact: vi.fn(), programs: vi.fn(), program: vi.fn(), whiteboards: vi.fn(), whiteboardScene: vi.fn(),
    createTask,
    completeTask: vi.fn(), syncStatus: vi.fn(), triggerSync: vi.fn(),
  }
}

describe('OfflineTasksView idempotent retries', () => {
  it('reuses the operation and resource IDs when the local enqueue response was lost', async () => {
    const createTask = vi.fn()
      .mockRejectedValueOnce(new LocalServiceError(0, 'local_service_timeout', 'timeout'))
      .mockResolvedValueOnce({ operation_id: 'op', state: 'queued', local_task: task, pending_count: 1, sync })
    render(<OfflineTasksView gateway={gateway(createTask)} canCreate canComplete onSync={vi.fn()} />)

    const title = await screen.findByPlaceholderText(/Nueva tarea/)
    fireEvent.change(title, { target: { value: 'Informe local' } })
    fireEvent.click(screen.getByRole('button', { name: 'Crear localmente' }))

    expect(await screen.findByRole('button', { name: 'Reintentar sin duplicar' })).toBeVisible()
    expect(title).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar sin duplicar' }))

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(2))
    expect(createTask.mock.calls[1][0].operation_id).toBe(createTask.mock.calls[0][0].operation_id)
    expect(createTask.mock.calls[1][0].task_id).toBe(createTask.mock.calls[0][0].task_id)
    expect(await screen.findByText('Informe local')).toBeVisible()
  })

  it('reconciles a completed sync without clearing the creation draft', async () => {
    const currentGateway = gateway(vi.fn())
    const tasks = vi.mocked(currentGateway.tasks)
    const view = render(<OfflineTasksView gateway={currentGateway} canCreate canComplete onSync={vi.fn()} refreshToken="sync-1" />)

    const title = await screen.findByPlaceholderText(/Nueva tarea/)
    fireEvent.change(title, { target: { value: 'Borrador que no debe perderse' } })
    tasks.mockResolvedValueOnce({
      items: [task],
      snapshot: { selection_revision: 1, head_version: 2, last_synced_at: '2026-09-14T20:01:00Z' },
    })

    view.rerender(<OfflineTasksView gateway={currentGateway} canCreate canComplete onSync={vi.fn()} refreshToken="sync-2" />)

    expect(await screen.findByText('Informe local')).toBeVisible()
    expect(title).toHaveValue('Borrador que no debe perderse')
  })

  it('discards a late creation and its draft after switching identity gateways', async () => {
    let finish!: (value: unknown) => void
    const create = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const oldGateway = gateway(create as OfflineDataGateway['createTask'])
    const onSync = vi.fn()
    const view = render(<OfflineTasksView gateway={oldGateway} canCreate canComplete onSync={onSync} />)
    fireEvent.change(await screen.findByPlaceholderText(/Nueva tarea/), { target: { value: 'Datos de usuario anterior' } })
    fireEvent.click(screen.getByRole('button', { name: 'Crear localmente' }))
    await waitFor(() => expect(create).toHaveBeenCalledOnce())
    view.rerender(<OfflineTasksView gateway={gateway(vi.fn())} canCreate canComplete onSync={onSync} />)
    expect(await screen.findByPlaceholderText(/Nueva tarea/)).toHaveValue('')
    await act(async () => finish({ local_task: { ...task, title: 'Datos de usuario anterior' }, sync }))
    expect(screen.queryByText('Datos de usuario anterior')).not.toBeInTheDocument()
    expect(onSync).not.toHaveBeenCalled()
  })

  it('does not append an old page after selecting another list', async () => {
    const currentGateway = gateway(vi.fn())
    const initial = await currentGateway.taskLists()
    vi.mocked(currentGateway.taskLists).mockResolvedValue({ ...initial, items: [...initial.items, { ...initial.items[0], selection_id: '88888888-8888-4888-8888-888888888888', id: '99999999-9999-4999-8999-999999999999', name: 'Segunda' }] })
    let finish!: (value: Awaited<ReturnType<OfflineDataGateway['tasks']>>) => void
    vi.mocked(currentGateway.tasks).mockImplementation((_selection, cursor) => cursor
      ? new Promise(resolve => { finish = resolve })
      : Promise.resolve({ items: [{ ...task, title: _selection === initial.items[0].selection_id ? 'Lista anterior' : 'Lista actual' }], next_cursor: _selection === initial.items[0].selection_id ? task.id : undefined, snapshot: initial.snapshot }))
    render(<OfflineTasksView gateway={currentGateway} canCreate canComplete onSync={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cargar más' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Lista' }), { target: { value: '88888888-8888-4888-8888-888888888888' } })
    expect(await screen.findByText('Lista actual')).toBeVisible()
    await act(async () => finish({ items: [{ ...task, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Página antigua' }], snapshot: initial.snapshot }))
    expect(screen.queryByText('Página antigua')).not.toBeInTheDocument()
    expect(screen.queryByText('Lista anterior')).not.toBeInTheDocument()
  })

  it('does not publish a completion or sync update from a closed identity', async () => {
    const previous=gateway(vi.fn())
    const initial=await previous.taskLists()
    vi.mocked(previous.tasks).mockResolvedValue({items:[{...task,local_confirmation:'confirmed'}],snapshot:initial.snapshot})
    let finish!:(value:Awaited<ReturnType<OfflineDataGateway['completeTask']>>)=>void
    vi.mocked(previous.completeTask).mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
    const onSync=vi.fn()
    const view=render(<OfflineTasksView gateway={previous} canCreate canComplete onSync={onSync} />)
    fireEvent.click(await screen.findByRole('button',{name:'Completar Informe local'}))
    view.rerender(<OfflineTasksView gateway={gateway(vi.fn())} canCreate canComplete onSync={onSync} />)
    await screen.findByPlaceholderText(/Nueva tarea/)
    await act(async()=>finish({operation_id:'op',state:'queued',pending_count:1,local_task:{...task,status_category:'done'},sync}))
    expect(screen.queryByText('Informe local')).not.toBeInTheDocument()
    expect(onSync).not.toHaveBeenCalled()
  })

  it('does not present a failed read as an empty prepared list', async () => {
    const currentGateway = gateway(vi.fn())
    vi.mocked(currentGateway.tasks).mockRejectedValue(new Error('Copia no disponible'))
    render(<OfflineTasksView gateway={currentGateway} canCreate canComplete onSync={vi.fn()} />)
    expect(await screen.findByText('No se pudo abrir la copia de esta lista')).toBeVisible()
    expect(screen.queryByText('La lista está disponible y no contiene tareas')).not.toBeInTheDocument()
  })

  it('keeps read-only controls disabled and renders canonical done/urgent snapshots', async () => {
    const currentGateway = gateway(vi.fn())
    const initial = await currentGateway.taskLists()
    vi.mocked(currentGateway.taskLists).mockResolvedValue({ ...initial, items: initial.items.map(item => ({ ...item, can_create: false })) })
    vi.mocked(currentGateway.tasks).mockResolvedValue({ items: [{ ...task, status: undefined, status_category: 'done', priority: 'urgent', local_confirmation: 'confirmed' }], snapshot: initial.snapshot })
    render(<OfflineTasksView gateway={currentGateway} canCreate canComplete onSync={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'Tarea completada: Informe local' })).toBeDisabled()
    expect(screen.getByText('Urgente')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Crear localmente' })).not.toBeInTheDocument()
  })
})
