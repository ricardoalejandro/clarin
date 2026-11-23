import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, apiGet, apiPost } from '@/lib/api'
import type { Task } from '@/types/task'
import TaskWorkspace from './TaskWorkspace'

const harness = vi.hoisted(() => ({ page: { tasks: [] as Task[] | null, total: 0, next_cursor: '' }, listener: (_: unknown) => {} }))
vi.mock('@/lib/api', () => ({
  api: vi.fn(), apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn(),
  subscribeWebSocket: vi.fn((listener: (event: unknown) => void) => { harness.listener = listener; return () => {} }),
}))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('@/components/offline-v5/ClarinRuntimeProvider', () => ({ useClarinRuntime: () => ({ isOffline: false, requireOnline: () => true }) }))
vi.mock('@/lib/taskLocationViewsApi', () => ({ collectTaskLocationViews: vi.fn(async () => ({ success: true, data: { views: [], feature_enabled: false } })) }))
vi.mock('./TaskHierarchyTree', () => ({ default: ({ onSelect }: { onSelect: (scope: { type: 'list'; id: string }) => void }) => <button onClick={() => onSelect({ type: 'list', id: 'mauritius' })}>Seleccionar Mauritius</button> }))
vi.mock('./TaskListView', () => ({ default: ({ tasks, onCanonicalTasks }: any) => <div><button onClick={() => onCanonicalTasks(tasks.map((task: Task) => ({ ...task, status: 'completed', status_id: 'done', status_detail: { category: 'done' }, version: 2 })), 'updated')}>Completar QA</button>{tasks.map((task: Task) => <span key={task.id}>{task.title}</span>)}</div> }))
vi.mock('./TaskBoard', () => ({ default: () => null }))
vi.mock('./TaskDetailDrawer', () => ({ default: () => null }))
vi.mock('./TaskEditorModal', () => ({ default: () => null }))
vi.mock('./TaskGanttView', () => ({ default: () => null }))
vi.mock('./TaskCalendarView', () => ({ default: () => null }))
vi.mock('./TaskSummaryView', () => ({ default: () => null }))
vi.mock('./TaskStructureModal', () => ({ default: () => null }))
vi.mock('./TaskEnvironmentSwitcher', () => ({ default: ({ active, onRemove, onConfigure, onSelect, environments }: any) => <aside aria-label="Entornos QA"><span>{active ? `Activo ${active.name}` : 'Sin Entornos'}</span>{active && <><button onClick={() => onConfigure(active)}>Administrar actual QA</button><button onClick={() => onRemove(active)}>Eliminar actual QA</button></>}{environments.map((item: any) => <button key={item.id} onClick={() => onSelect(item)}>Seleccionar {item.name} QA</button>)}</aside> }))
vi.mock('./TaskEnvironmentWindow', () => ({ default: ({ open, environment }: any) => open ? <section aria-label="Administración QA">Abiertas canónicas {environment?.open_task_count}</section> : null }))
vi.mock('./TaskLocationViewBar', () => ({ default: () => null }))
vi.mock('./TaskViewCustomization', () => ({ default: () => null }))
vi.mock('./TaskFilters', async importOriginal => ({ ...await importOriginal<typeof import('./TaskFilters')>(), default: () => null, TaskFilterChips: () => null }))


const permissions = { level: 'full', can_view: true, can_edit: true, can_manage_access: true }
const environment = { id: 'env', account_id: 'account', name: 'QA Work', is_default: false, permissions, task_count: 1, open_task_count: 1 }
const general = { ...environment, id: 'general', name: 'General', is_default: true, task_count: 0, open_task_count: 0 }
const list = { id: 'mauritius', name: 'Mauritius', environment_id: 'env', workflow_id: 'flow', permissions }
const task = { id: 'task', title: 'Tarea original QA', environment_id: 'env', list_id: 'mauritius', status: 'pending', status_id: 'active', status_detail: { category: 'active' }, version: 1 } as Task
let index: Array<typeof environment>
let nextIndexRead: Promise<any> | undefined
let oldIndexSignal: AbortSignal | undefined

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('clarin:tasks:account:actor:active-environment:v1', 'env')
  window.history.replaceState({}, '', '/dashboard/tasks')
  index = [environment, general]
  nextIndexRead = undefined
  oldIndexSignal = undefined
  harness.page = { tasks: [task], total: 1, next_cursor: '' }
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.mocked(apiGet).mockReset()
  vi.mocked(apiGet).mockImplementation(async (url, options) => {
    const path = String(url)
    if (path.startsWith('/api/tasks/environments?')) {
      if (nextIndexRead) { const read = nextIndexRead; nextIndexRead = undefined; oldIndexSignal = options?.signal as AbortSignal; return read }
      return { success: true, data: { environments: index } }
    }
    if (path.startsWith('/api/tasks/environments/')) return { success: false, status: 404 }
    if (path === '/api/me') return { success: true, data: { user: { id: 'actor', account_id: 'account' } } }
    if (path === '/api/account/users') return { success: true, data: { users: [] } }
    if (path.startsWith('/api/tasks/folders')) return { success: true, data: { folders: [] } }
    if (path.startsWith('/api/tasks/lists')) return { success: true, data: { lists: [list] } }
    if (path.startsWith('/api/tasks/workflows')) return { success: true, data: { workflows: [] } }
    if (path.startsWith('/api/tasks?')) return { success: true, data: harness.page }
    return { success: true, data: {} }
  })
  vi.mocked(api).mockResolvedValue({ success: true, data: { preview: { type: 'environment', id: 'env', name: environment.name, environment_id: 'env', lifecycle: 'active', mode: 'trash_all', preview_token: 'canonical', counts: { folders: 2, lists: 3, tasks: 1, subtasks: 0, open_tasks: 1, completed_tasks: 0, cancelled_tasks: 0, events: 0, whiteboards: 1 }, requires_name: true, requires_event_cancellation: false, requires_access_confirmation: false, can_execute: true, blockers: [] } } })
  vi.mocked(apiPost).mockImplementation(async () => { index = [general]; harness.page = { tasks: [], total: 0, next_cursor: '' }; return { success: true, data: { result: { type: 'environment', id: 'env', environment_id: 'env', action: 'trashed', mode: 'trash_all' } } } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('refreshes the open environment inspector from canonical inventory after task completion without F5', async () => {
  render(<TaskWorkspace />)
  await screen.findByText(task.title)
  fireEvent.click(screen.getByRole('button', { name: 'Administrar actual QA' }))
  expect(await screen.findByRole('region', { name: 'Administración QA' })).toHaveTextContent('Abiertas canónicas 1')
  index = [{ ...environment, open_task_count: 0 }, general]
  fireEvent.click(screen.getByRole('button', { name: 'Completar QA' }))
  await waitFor(() => expect(screen.getByRole('region', { name: 'Administración QA' })).toHaveTextContent('Abiertas canónicas 0'), { timeout: 3000 })
  expect(screen.getByText('Activo QA Work')).toBeVisible()
})

it('removes a populated environment through the canonical preview and falls back to General without a reload', async () => {
  render(<TaskWorkspace />)
  await screen.findByText(task.title)
  fireEvent.click(screen.getByRole('button', { name: 'Eliminar actual QA' }))
  fireEvent.change(await screen.findByLabelText('Nombre para confirmar'), { target: { value: environment.name } })
  fireEvent.click(screen.getByRole('button', { name: 'Mover todo a Papelera' }))
  expect(await screen.findByText('Activo General')).toBeVisible()
  expect(screen.queryByText('Activo QA Work')).not.toBeInTheDocument()
  expect(screen.queryByText(task.title)).not.toBeInTheDocument()
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  expect(apiPost).toHaveBeenCalledTimes(1)
  expect(apiPost).toHaveBeenCalledWith('/api/tasks/environments/env/remove', expect.objectContaining({ confirmation_name: environment.name, preview_token: 'canonical', mode: 'trash_all' }))
})

it('rejects an older inventory completion after a minimal removal tombstone and closes its environment inspector', async () => {
  render(<TaskWorkspace />)
  await screen.findByText(task.title)
  fireEvent.click(screen.getByRole('button', { name: 'Administrar actual QA' }))
  await screen.findByRole('region', { name: 'Administración QA' })
  let finish!: (value: any) => void
  nextIndexRead = new Promise(resolve => { finish = resolve })
  fireEvent.click(screen.getByRole('button', { name: 'Completar QA' }))
  await waitFor(() => expect(oldIndexSignal).toBeDefined(), { timeout: 3000 })
  index = [general]; harness.page = { tasks: [], total: 0, next_cursor: '' }
  await act(async () => harness.listener({ event: 'task_update', data: { action: 'environment_trashed', environment_id: 'env', operation_id: 'remote', structure_changed: true } }))
  expect(await screen.findByText('Activo General')).toBeVisible()
  expect(oldIndexSignal?.aborted).toBe(true)
  await act(async () => finish({ success: true, data: { environments: [environment, general] } }))
  expect(screen.queryByText('Activo QA Work')).not.toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Administración QA' })).not.toBeInTheDocument()
  expect(apiPost).not.toHaveBeenCalled()
})

it('shows an empty authorized environment index when the removed environment has no fallback', async () => {
  render(<TaskWorkspace />)
  await screen.findByText(task.title)
  index = []; harness.page = { tasks: [], total: 0, next_cursor: '' }
  await act(async () => harness.listener({ event: 'task_update', data: { action: 'environment_trashed', environment_id: 'env' } }))
  expect(await screen.findByText('Sin Entornos')).toBeVisible()
  expect(screen.queryByText(task.title)).not.toBeInTheDocument()
})
