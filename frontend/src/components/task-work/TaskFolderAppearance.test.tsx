import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { api, apiDelete, apiPost, apiPut } from '@/lib/api'
import type { TaskFolder, TaskList } from '@/types/task'
import { TaskAppearanceDialog, taskContainerArchiveState } from './TaskContainerAppearance'

vi.mock('@/lib/api', () => ({ api: vi.fn(), apiGet: vi.fn(), apiDelete: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn() }))
const base = { account_id: 'account-1', environment_id: 'environment-1', description: '', color: '#10B981', sort_order: 1024, created_by: 'user-1', created_at: '2026-08-02T00:00:00Z', updated_at: '2026-08-02T00:00:00Z', task_count: 0, open_task_count: 0, completed_task_count: 0, cancelled_task_count: 0 }
beforeEach(() => {
  vi.mocked(api).mockResolvedValue({ success: true, data: { preview: { type: 'list', id: 'list-ernesto', name: 'Ernesto', environment_id: base.environment_id, lifecycle: 'active', mode: 'trash_all', preview_token: 'p1', counts: { lists: 0, tasks: 31, subtasks: 0, open_tasks: 0, completed_tasks: 31, cancelled_tasks: 0, events: 0, whiteboards: 0 }, requires_name: true, can_execute: true, blockers: [] } } })
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

describe('task container appearance and removal', () => {
  it('offers both removal choices for 31 completed tasks instead of blocking with an empty-list rule', async () => {
    const list = { ...base, id: 'list-ernesto', name: 'Ernesto', icon: 'list', is_default: false, task_count: 31, completed_task_count: 31, capabilities: { level: 'full', can_archive: true, can_trash: false } } as TaskList
    render(<TaskAppearanceDialog item={list} type="list" onClose={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Archivar como histórico' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar…' }))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByRole('radio', { name: /Eliminar todo junto/ })).toBeInTheDocument()
    expect(within(dialog).getByRole('radio', { name: /Conservar el contenido/ })).toBeInTheDocument()
    expect(await within(dialog).findByLabelText('Nombre para confirmar')).toBeInTheDocument()
    expect(apiDelete).not.toHaveBeenCalled()
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('keeps historical archive as a separate action', async () => {
    vi.mocked(apiPost).mockResolvedValue({ success: true })
    const onSaved = vi.fn()
    const list = { ...base, id: 'list-history', name: 'Histórico', icon: 'list', task_count: 2, completed_task_count: 2 } as TaskList
    expect(taskContainerArchiveState(list)).toMatchObject({ kind: 'ready' })
    render(<TaskAppearanceDialog item={list} type="list" onClose={vi.fn()} onSaved={onSaved} onError={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Archivar como histórico' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Archivar como histórico' }))
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/tasks/lists/list-history/archive', expect.any(Object)))
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ action: 'archived' }))
  })

  it('keeps a truthful explanation when open tasks prevent historical archive', () => {
    const list = { ...base, id: 'list-occupied', name: 'Ocupada', icon: 'list', task_count: 3, open_task_count: 1, completed_task_count: 1, cancelled_task_count: 1 } as TaskList
    render(<TaskAppearanceDialog item={list} type="list" onClose={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Archivar' }))
    expect(within(screen.getByRole('alertdialog')).getByRole('status')).toHaveTextContent('1 abiertas, 1 completadas y 1 canceladas')
  })

  it('keeps the fixed folder icon out of update payloads', async () => {
    vi.mocked(apiPut).mockResolvedValue({ success: true })
    const folder = { ...base, id: 'folder-1', name: 'Mauritius', icon: 'rocket', lists: [] } as TaskFolder
    render(<TaskAppearanceDialog item={folder} type="folder" onClose={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} />)
    expect(screen.getByLabelText('Icono fijo de carpeta')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Icono de carpeta/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1))
    expect(vi.mocked(apiPut).mock.calls[0][1]).not.toHaveProperty('icon')
  })

  it('keeps the configurable icon payload for lists and protects the default list', async () => {
    vi.mocked(apiPut).mockResolvedValue({ success: true })
    const list = { ...base, id: 'list-1', name: 'Zambia', icon: 'rocket', is_default: true } as TaskList
    render(<TaskAppearanceDialog item={list} type="list" onClose={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Icono de lista/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Eliminar…' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1))
    expect(vi.mocked(apiPut).mock.calls[0][1]).toMatchObject({ icon: 'rocket' })
  })
})