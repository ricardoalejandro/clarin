import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiGet } from '@/lib/api'
import type { TaskFolder, TaskList } from '@/types/task'
import { mergeTaskCatalogPage, TaskRemoteListPicker } from './TaskRemoteHierarchyPicker'

vi.mock('@/lib/api', () => ({ apiGet: vi.fn() }))

const list: TaskList = {
  id: 'list-general',
  account_id: 'account-1',
  environment_id: 'environment-1',
  name: 'Bandeja general',
  color: '#10B981',
  icon: 'inbox',
  sort_order: 0,
  created_by: 'user-1',
  created_at: '',
  updated_at: '',
  task_count: 0,
  open_task_count: 0,
  completed_task_count: 0,
  cancelled_task_count: 0,
  is_default: true,
  permissions: { level: 'full', can_view: true, can_comment: true, can_edit: true, can_delete: true, can_manage_access: true },
}

const folder: TaskFolder = {
  id: 'folder-1',
  account_id: 'account-1',
  environment_id: 'environment-1',
  name: 'Campañas',
  color: '#8B5CF6',
  icon: 'folder',
  sort_order: 1,
  created_by: 'user-1',
  created_at: '',
  updated_at: '',
  task_count: 0,
  open_task_count: 0,
  completed_task_count: 0,
  cancelled_task_count: 0,
  lists: [],
}

describe('TaskRemoteHierarchyPicker', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('merges cursor pages canonically without duplicating destinations', () => {
    expect(mergeTaskCatalogPage([list], [{ ...list, name: 'General actualizada' }])).toEqual([
      expect.objectContaining({ id: list.id, name: 'General actualizada' }),
    ])
  })

  it('starts remote list search exactly at 500 ms and preserves its stable cursor', async () => {
    vi.useFakeTimers()
    vi.mocked(apiGet).mockImplementation(async url => {
      if (String(url).includes('/folders?')) return { success: true, status: 200, data: { folders: [folder], next_cursor: String(url).includes('cursor=') ? undefined : 'folder-cursor-1' } }
      if (String(url).includes('search=Camp')) return { success: true, status: 200, data: { lists: [{ ...list, id: 'list-campaign', name: 'Campaña agosto', folder_id: folder.id }], next_cursor: 'list-cursor-1' } }
      return { success: true, status: 200, data: { lists: [list] } }
    })

    render(<TaskRemoteListPicker environmentId="environment-1" value={list.id} initialLists={[list]} initialFolders={[]} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Bandeja general/i }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('button', { name: /Cargar más nombres de carpeta/i })).toBeInTheDocument()
    vi.mocked(apiGet).mockClear()

    fireEvent.click(screen.getByRole('button', { name: /Cargar más nombres de carpeta/i }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(String(vi.mocked(apiGet).mock.calls.at(-1)?.[0])).toContain('limit=200&cursor=folder-cursor-1')
    vi.mocked(apiGet).mockClear()

    const input = screen.getByPlaceholderText('Buscar listas…')
    fireEvent.change(input, { target: { value: 'Camp' } })
    expect(input).toHaveValue('Camp')
    await act(async () => { vi.advanceTimersByTime(499) })
    expect(apiGet).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); await Promise.resolve() })

    expect(apiGet).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(apiGet).mock.calls[0][0])).toContain('scope=all&limit=50&search=Camp')
    expect(screen.getByRole('button', { name: /Cargar más listas/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Cargar más listas/i }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(String(vi.mocked(apiGet).mock.calls.at(-1)?.[0])).toContain('cursor=list-cursor-1')
  })
})
