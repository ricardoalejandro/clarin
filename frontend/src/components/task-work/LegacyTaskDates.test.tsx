import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '@/types/task'
import TaskFormModal from '../TaskFormModal'
import TaskInlineCard from '../TaskInlineCard'

const task = { id: 'task-legacy', title: 'Pendiente', account_id: 'account-1', type: 'reminder', status: 'pending', priority: 'medium', assigned_to: 'user-1', due_at: new Date(2026, 7, 25, 17, 45).toISOString() } as Task
const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async (url: string) => ({ json: async () => url === '/api/me' ? { success: true, user: { id: 'user-1' } } : url === '/api/account/users' ? { success: true, users: [] } : { success: true, subtasks: [], task } }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const card = (overrides = {}) => {
  const props = { task, isExpanded: true, onExpand: vi.fn(), onCollapse: vi.fn(), onComplete: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(), onOpenFullEdit: vi.fn(), ...overrides }
  render(<TaskInlineCard {...props} />)
  return props
}

describe('legacy inline task dates', () => {
  it('does not update incomplete years and commits Enter plus blur only once with existing time', () => {
    const props = card()
    const date = screen.getByRole('textbox', { name: 'Fecha de la tarea' })
    fireEvent.change(date, { target: { value: '03/04/196' } }); fireEvent.keyDown(date, { key: 'Enter' })
    expect(props.onUpdate).not.toHaveBeenCalled()
    expect(date).toHaveValue('03/04/196')
    fireEvent.change(date, { target: { value: '03/04/1965' } }); fireEvent.keyDown(date, { key: 'Enter' }); fireEvent.blur(date)
    expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith(task.id, { due_at: new Date(1965, 3, 3, 17, 45).toISOString() })
  })
  it('calendar cancellation neither updates nor collapses the owning card', async () => {
    const props = card()
    fireEvent.click(screen.getByRole('button', { name: 'Fecha de la tarea: 25/08/2026' }))
    fireEvent.click(document.querySelector('[data-date-key="2026-08-27"]') as HTMLElement)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(props.onUpdate).not.toHaveBeenCalled(); expect(props.onCollapse).not.toHaveBeenCalled()
  })
  it('keeps an invalid draft open on outside click and clears an optional date once', () => {
    const props = card()
    const date = screen.getByRole('textbox', { name: 'Fecha de la tarea' })
    fireEvent.change(date, { target: { value: '31/04/2028' } }); fireEvent.mouseDown(document.body)
    expect(props.onCollapse).not.toHaveBeenCalled(); expect(props.onUpdate).not.toHaveBeenCalled()
    fireEvent.change(date, { target: { value: '' } }); fireEvent.keyDown(date, { key: 'Enter' })
    expect(props.onUpdate).toHaveBeenCalledExactlyOnceWith(task.id, { due_at: '' })
  })
})

describe('legacy task form dates', () => {
  it('saves a latest typed date while preserving the existing independent time', async () => {
    render(<TaskFormModal isOpen task={task} onClose={vi.fn()} onSave={vi.fn()} />)
    const date = screen.getByRole('textbox', { name: 'Fecha' })
    fireEvent.change(date, { target: { value: '29/02/2028' } })
    fireEvent.click(screen.getByRole('button', { name: /Guardar/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(true))
    const [, options] = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT')!
    expect(JSON.parse(options.body)).toMatchObject({ due_at: new Date(2028, 1, 29, 17, 45).toISOString() })
  })
  it('blocks malformed dates without a request', () => {
    render(<TaskFormModal isOpen task={task} onClose={vi.fn()} onSave={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Fecha' }), { target: { value: '31/04/2028' } })
    expect(screen.getByRole('button', { name: /Guardar/ })).toBeDisabled()
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false)
  })
})
