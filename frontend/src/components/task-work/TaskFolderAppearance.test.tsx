import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { apiDelete, apiPost, apiPut } from '@/lib/api'
import type { TaskFolder, TaskList } from '@/types/task'
import { TaskAppearanceDialog, taskContainerArchiveState, taskContainerTrashState } from './TaskContainerAppearance'

vi.mock('@/lib/api', () => ({
  apiDelete: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}))

const base = {
  account_id: 'account-1',
  environment_id: 'environment-1',
  description: '',
  color: '#10B981',
  sort_order: 1024,
  created_by: 'user-1',
  created_at: '2026-08-02T00:00:00Z',
  updated_at: '2026-08-02T00:00:00Z',
  task_count: 0,
  open_task_count: 0,
  completed_task_count: 0,
  cancelled_task_count: 0,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('task container icon rules', () => {
	it('allows historical archive for closed tasks while keeping Trash blocked', () => {
		const list = { ...base, id: 'list-history', name: 'Histórico', icon: 'list', is_default: false, task_count: 2, completed_task_count: 1, cancelled_task_count: 1 } as TaskList
		expect(taskContainerArchiveState(list)).toMatchObject({ kind: 'ready' })
		expect(taskContainerTrashState(list)).toMatchObject({ kind: 'blocked' })
	})

  it('recommends Archive for 31 completed tasks and never sends DELETE from the blocked Trash flow', async () => {
    vi.mocked(apiPost).mockResolvedValue({ success: true })
    const onSaved = vi.fn()
    const list = {
      ...base,
      id: 'list-ernesto',
      name: 'Ernesto',
      icon: 'list',
      is_default: false,
      task_count: 31,
      completed_task_count: 31,
      capabilities: { level: 'full', can_archive: true, can_trash: false },
    } as TaskList
    render(<TaskAppearanceDialog item={list} type="list" onClose={vi.fn()} onSaved={onSaved} onError={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Archivar como histórico' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mover a Papelera' }))
    let dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByRole('heading', { name: 'Ernesto no se movió a Papelera' })).toBeInTheDocument()
    expect(within(dialog).getByRole('status')).toHaveTextContent('31 tareas (0 abiertas, 31 completadas y 0 canceladas)')
    expect(within(dialog).queryByRole('button', { name: 'Mover a Papelera' })).not.toBeInTheDocument()
    expect(apiDelete).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar como histórico' }))
    dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByRole('heading', { name: 'Archivar lista' })).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archivar como histórico' }))

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))
    expect(vi.mocked(apiPost).mock.calls[0][0]).toBe('/api/tasks/lists/list-ernesto/archive')
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ type: 'list', id: 'list-ernesto', action: 'archived' })))
    expect(apiDelete).not.toHaveBeenCalled()
  })

  it('moves a truly empty list to Trash once after exact-name confirmation', async () => {
    vi.mocked(apiDelete).mockResolvedValue({ success: true })
    const onSaved = vi.fn()
    const list = {
      ...base,
      id: 'list-empty',
      name: 'Vacía',
      icon: 'list',
      is_default: false,
      capabilities: { level: 'full', can_archive: true, can_trash: true },
    } as TaskList
    render(<TaskAppearanceDialog item={list} type="list" onClose={vi.fn()} onSaved={onSaved} onError={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Mover a Papelera' }))
    const dialog = screen.getByRole('alertdialog')
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Vacía' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mover a Papelera' }))

    await waitFor(() => expect(apiDelete).toHaveBeenCalledTimes(1))
    expect(apiDelete).toHaveBeenCalledWith('/api/tasks/lists/list-empty', expect.objectContaining({ confirmation_name: 'Vacía' }))
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ type: 'list', id: 'list-empty', action: 'trashed' }))
  })

  it('keeps the Trash confirmation open with retry feedback after a server conflict', async () => {
    vi.mocked(apiDelete).mockResolvedValue({ success: false, error: 'La lista cambió. Reintenta.' })
    const onSaved = vi.fn()
    const list = {
      ...base,
      id: 'list-conflict',
      name: 'Conflicto',
      icon: 'list',
      is_default: false,
      capabilities: { level: 'full', can_archive: true, can_trash: true },
    } as TaskList
    render(<TaskAppearanceDialog item={list} type="list" onClose={vi.fn()} onSaved={onSaved} onError={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Mover a Papelera' }))
    const dialog = screen.getByRole('alertdialog')
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Conflicto' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mover a Papelera' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('La lista cambió. Reintenta.')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('explains why a non-empty list cannot be archived instead of hiding the action', () => {
    const list = { ...base, id: 'list-occupied', name: 'Ocupada', icon: 'list', is_default: false, task_count: 3, open_task_count: 1, completed_task_count: 1, cancelled_task_count: 1 } as TaskList
    expect(taskContainerArchiveState(list)).toMatchObject({ kind: 'blocked' })
    render(<TaskAppearanceDialog item={list} type="list" onClose={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mover a Papelera' }))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByRole('status')).toHaveTextContent('1 abiertas, 1 completadas y 1 canceladas')
    expect(within(dialog).queryByRole('button', { name: 'Mover a Papelera' })).not.toBeInTheDocument()
  })

  it('shows the fixed folder icon and never sends an icon update', async () => {
    vi.mocked(apiPut).mockResolvedValue({ success: true })
    const folder = { ...base, id: 'folder-1', name: 'Mauritius', icon: 'rocket', lists: [] } as TaskFolder
    render(<TaskAppearanceDialog item={folder} type="folder" onClose={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} />)

    expect(screen.getByLabelText('Icono fijo de carpeta')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Icono de carpeta/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1))
    const [, payload] = vi.mocked(apiPut).mock.calls[0]
    expect(payload).not.toHaveProperty('icon')
  })

  it('keeps the configurable icon picker and payload for lists', async () => {
    vi.mocked(apiPut).mockResolvedValue({ success: true })
    const list = { ...base, id: 'list-1', name: 'Zambia', icon: 'rocket', is_default: false } as TaskList
    render(<TaskAppearanceDialog item={list} type="list" onClose={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} />)

    expect(screen.getByRole('button', { name: /Icono de lista/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1))
    const [, payload] = vi.mocked(apiPut).mock.calls[0]
    expect(payload).toMatchObject({ icon: 'rocket' })
  })
})
