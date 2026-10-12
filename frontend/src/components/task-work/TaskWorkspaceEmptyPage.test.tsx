import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGet } from '@/lib/api'
import type { Task } from '@/types/task'
import TaskWorkspace from './TaskWorkspace'

const harness = vi.hoisted(() => ({ page: { tasks: [] as Task[] | null, total: 0, next_cursor: '' }, listener: (_: unknown) => {} }))
vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn(),
  subscribeWebSocket: vi.fn((listener: (event: unknown) => void) => { harness.listener = listener; return () => {} }),
}))
vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('@/components/offline-v5/ClarinRuntimeProvider', () => ({ useClarinRuntime: () => ({ isOffline: false, requireOnline: () => true }) }))
vi.mock('@/lib/taskLocationViewsApi', () => ({ collectTaskLocationViews: vi.fn(async () => ({ success: true, data: { views: [], feature_enabled: false } })) }))
vi.mock('./TaskHierarchyTree', () => ({ default: ({ onSelect }: { onSelect: (scope: { type: 'list'; id: string }) => void }) => <button onClick={() => onSelect({ type: 'list', id: 'mauritius' })}>Seleccionar Mauritius</button> }))
vi.mock('./TaskListView', () => ({ default: ({ tasks, onRefresh }: { tasks: Task[]; onRefresh: () => void }) => <div><button onClick={onRefresh}>Actualizar tareas</button>{tasks.length ? tasks.map(task => <div key={task.id}>{task.title}</div>) : <div>Lista vacía</div>}</div> }))
vi.mock('./TaskBoard', () => ({ default: () => null }))
vi.mock('./TaskDetailDrawer', () => ({ default: () => null }))
vi.mock('./TaskEditorModal', () => ({ default: () => null }))
vi.mock('./TaskGanttView', () => ({ default: () => null }))
vi.mock('./TaskCalendarView', () => ({ default: () => null }))
vi.mock('./TaskSummaryView', () => ({ default: () => null }))
vi.mock('./TaskStructureModal', () => ({ default: () => null }))
vi.mock('./TaskEnvironmentSwitcher', () => ({ default: () => null }))
vi.mock('./TaskEnvironmentWindow', () => ({ default: () => null }))
vi.mock('./TaskLocationViewBar', () => ({ default: () => null }))
vi.mock('./TaskViewCustomization', () => ({ default: () => null }))
vi.mock('./TaskFilters', async importOriginal => ({ ...await importOriginal<typeof import('./TaskFilters')>(), default: () => null, TaskFilterChips: () => null }))

const permissions = { can_view: true, can_edit: true, can_manage_access: true }
const environment = { id: 'env', name: 'QA Work', permissions, task_count: 1, open_task_count: 1 }
const list = { id: 'mauritius', name: 'Mauritius', environment_id: 'env', workflow_id: 'flow', permissions }
const task = { id: 'task', title: 'Tarea de otra lista', environment_id: 'env', list_id: 'zambia', status: 'pending', status_detail: { category: 'not_started' }, version: 1 } as Task

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', '/dashboard/tasks')
  harness.page = { tasks: [task], total: 1, next_cursor: '' }
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.mocked(apiGet).mockReset()
  vi.mocked(apiGet).mockImplementation(async url => {
    const path = String(url)
    if (path.startsWith('/api/tasks/environments')) return { success: true, data: { environments: [environment] } }
    if (path === '/api/me') return { success: true, data: { user: { id: 'actor', account_id: 'account' } } }
    if (path === '/api/account/users') return { success: true, data: { users: [] } }
    if (path.startsWith('/api/tasks/folders')) return { success: true, data: { folders: [] } }
    if (path.startsWith('/api/tasks/lists')) return { success: true, data: { lists: [list] } }
    if (path.startsWith('/api/tasks/workflows')) return { success: true, data: { workflows: [] } }
    if (path.startsWith('/api/tasks?')) return { success: true, data: harness.page }
    return { success: true, data: {} }
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Work canonical empty pages', () => {
  it('clears the previous list when a legacy server returns tasks:null for Mauritius', async () => {
    render(<TaskWorkspace />)
    expect(await screen.findByText(task.title)).toBeVisible()
    harness.page = { tasks: null, total: 0, next_cursor: '' }
    fireEvent.click(screen.getByRole('button', { name: 'Seleccionar Mauritius' }))
    await waitFor(() => expect(vi.mocked(apiGet).mock.calls.some(([url]) => String(url).includes('list_id=mauritius'))).toBe(true))
    await waitFor(() => expect(screen.queryByText(task.title)).not.toBeInTheDocument())
    expect(screen.getByText('Lista vacía')).toBeVisible()
    expect(screen.queryByText(/not iterable/)).not.toBeInTheDocument()
  })

  it('removes the last visible task on a complete empty refresh without preserving old rows', async () => {
    render(<TaskWorkspace />)
    expect(await screen.findByText(task.title)).toBeVisible()
    harness.page = { tasks: null, total: 0, next_cursor: '' }
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar tareas' }))
    await waitFor(() => expect(screen.queryByText(task.title)).not.toBeInTheDocument())
    expect(screen.getByText('Lista vacía')).toBeVisible()
    expect(screen.queryByText(/not iterable/)).not.toBeInTheDocument()
  })

  it('does not replace an empty selected list with a late response for the previous scope', async () => {
    render(<TaskWorkspace />)
    expect(await screen.findByText(task.title)).toBeVisible()
    let finish!: (value: { success: boolean; data: typeof harness.page }) => void
    vi.mocked(apiGet).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar tareas' }))
    harness.page = { tasks: null, total: 0, next_cursor: '' }
    fireEvent.click(screen.getByRole('button', { name: 'Seleccionar Mauritius' }))
    await waitFor(() => expect(screen.queryByText(task.title)).not.toBeInTheDocument())
    await act(async () => finish({ success: true, data: { tasks: [task], total: 1, next_cursor: '' } }))
    expect(screen.queryByText(task.title)).not.toBeInTheDocument()
    expect(screen.getByText('Lista vacía')).toBeVisible()
  })
})
