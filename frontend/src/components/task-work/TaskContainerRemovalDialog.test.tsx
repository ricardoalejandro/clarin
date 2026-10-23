import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { api, apiGet, apiPost } from '@/lib/api'
import TaskContainerRemovalDialog from './TaskContainerRemovalDialog'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import type { TaskContainerRemovalPreview } from './taskContainerRemoval'

vi.mock('@/lib/api', () => ({ api: vi.fn(), apiGet: vi.fn(), apiPost: vi.fn() }))
const item = { id: 'list-1', name: 'Proyecto', environment_id: 'env-1' }
const counts = { lists: 0, tasks: 2, subtasks: 3, open_tasks: 1, completed_tasks: 1, cancelled_tasks: 0, events: 1, whiteboards: 1 }
const preview = (overrides: Partial<TaskContainerRemovalPreview> = {}): TaskContainerRemovalPreview => ({ type: 'list', id: item.id, name: item.name, environment_id: 'env-1', lifecycle: 'active', mode: 'trash_all', preview_token: 'p1', counts, requires_name: true, requires_destination: false, requires_event_cancellation: false, requires_access_confirmation: false, can_execute: true, blockers: [], ...overrides })
const response = (value = preview()) => ({ success: true, data: { preview: value } })

beforeEach(() => {
  vi.mocked(api).mockResolvedValue(response())
  vi.mocked(apiGet).mockResolvedValue({ success: true, data: { lists: [] } })
  vi.mocked(apiPost).mockResolvedValue({ success: true })
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers() })

describe('container removal dialog', () => {
  it('prepares the real inventory, gates typed confirmation and submits one logical write', async () => {
    const saved = vi.fn()
    render(<TaskContainerRemovalDialog item={item} type="list" onClose={vi.fn()} onSaved={saved} />)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByRole('alertdialog').parentElement).toHaveStyle({ zIndex: String(TASK_OVERLAY_LAYERS.confirmation) })
    expect(screen.getByRole('button', { name: 'Mover todo a Papelera' })).toBeDisabled()
    fireEvent.change(await screen.findByLabelText('Nombre para confirmar'), { target: { value: 'Proyecto' } })
    expect(screen.getByRole('region', { name: 'Contenido afectado' })).toHaveTextContent('Subtareas3')
    fireEvent.click(screen.getByRole('button', { name: 'Mover todo a Papelera' }))
    fireEvent.click(screen.getByRole('button', { name: /Papelera|Eliminando/ }))
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))
    expect(apiPost).toHaveBeenCalledWith('/api/tasks/lists/list-1/remove', expect.objectContaining({ mode: 'trash_all', preview_token: 'p1', confirmation_name: 'Proyecto', operation_id: expect.any(String) }))
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ type: 'list', id: item.id, action: 'trashed' }))
  })

  it('requires explicit event cancellation and access confirmation', async () => {
    vi.mocked(api).mockResolvedValue(response(preview({ requires_name: false, requires_event_cancellation: true, requires_access_confirmation: true, access_change_summary: 'El destino tiene otra audiencia.' })))
    render(<TaskContainerRemovalDialog item={item} type="list" onClose={vi.fn()} onSaved={vi.fn()} />)
    const eventCheckbox = await screen.findByLabelText(/Confirmo cancelar/)
    const action = screen.getByRole('button', { name: 'Mover todo a Papelera' })
    expect(action).toBeDisabled()
    fireEvent.click(eventCheckbox)
    expect(action).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/Revisé y confirmo/))
    expect(action).toBeEnabled()
    fireEvent.click(action)
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cancel_future_events: true, confirm_access_changes: true })))
  })

  it('refreshes a conflicting preview and requires fresh confirmation while preserving the chosen option', async () => {
    vi.mocked(apiPost).mockResolvedValue({ success: false, status: 409, data: { code: 'removal_preview_changed' } })
    vi.mocked(api).mockResolvedValueOnce(response()).mockResolvedValueOnce(response(preview({ preview_token: 'p2', counts: { ...counts, tasks: 8 } })))
    render(<TaskContainerRemovalDialog item={item} type="list" onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('Nombre para confirmar'), { target: { value: 'Proyecto' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mover todo a Papelera' }))
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2))
    expect(await screen.findByLabelText('Nombre para confirmar')).toHaveValue('')
    expect(screen.getByRole('radio', { name: /Eliminar todo junto/ })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Mover todo a Papelera' })).toBeDisabled()
    expect(screen.getByText(/El contenido o los permisos cambiaron/)).toBeInTheDocument()
    expect(apiPost).toHaveBeenCalledTimes(1)
  })

  it('retries an uncertain network result with the same operation ID and preview token', async () => {
    vi.mocked(apiPost).mockResolvedValueOnce({ success: false, error: 'Error de conexión' }).mockResolvedValueOnce({ success: true })
    render(<TaskContainerRemovalDialog item={item} type="list" onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(await screen.findByLabelText('Nombre para confirmar'), { target: { value: 'Proyecto' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mover todo a Papelera' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar la operación' }))
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2))
    expect(vi.mocked(apiPost).mock.calls[0][1]).toEqual(vi.mocked(apiPost).mock.calls[1][1])
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('stages a concrete preservation destination and keeps it after a conflict without carrying old access confirmation', async () => {
    vi.mocked(api).mockImplementation(async (_path, options) => {
      const input = JSON.parse(String(options?.body || '{}')) as { mode: 'trash_all' | 'preserve_contents'; destination_list_id?: string }
      return response(preview({ mode: input.mode, destination_list_id: input.destination_list_id, requires_name: false, requires_destination: input.mode === 'preserve_contents', requires_access_confirmation: input.mode === 'preserve_contents', can_execute: input.mode === 'trash_all' || Boolean(input.destination_list_id) }))
    })
    vi.mocked(apiGet).mockResolvedValue({ success: true, data: { lists: [{ id: 'target', name: 'Destino elegido', environment_id: 'env-1', lifecycle: 'active' }] } })
    vi.mocked(apiPost).mockResolvedValueOnce({ success: false, status: 409, data: { code: 'removal_preview_changed' } }).mockResolvedValueOnce({ success: true })
    render(<TaskContainerRemovalDialog item={item} type="list" onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('radio', { name: /Conservar el contenido/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Lista de destino' }))
    fireEvent.click(await screen.findByRole('option', { name: /Destino elegido/ }))
    fireEvent.click(await screen.findByLabelText(/Revisé y confirmo/))
    expect(apiPost).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Conservar y eliminar' }))
    await screen.findByText(/El contenido o los permisos cambiaron/)
    expect(screen.getByRole('radio', { name: /Conservar el contenido/ })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Lista de destino' })).toHaveTextContent('Destino elegido')
    expect(screen.getByLabelText(/Revisé y confirmo/)).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Conservar y eliminar' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/Revisé y confirmo/))
    fireEvent.click(screen.getByRole('button', { name: 'Conservar y eliminar' }))
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2))
    expect(vi.mocked(apiPost).mock.calls[1][1]).toEqual(expect.objectContaining({ mode: 'preserve_contents', destination_list_id: 'target', confirm_access_changes: true }))
  })

  it('does not repeat a committed mutation when refreshing the workspace fails', async () => {
    const saved = vi.fn().mockRejectedValueOnce(new Error('refresh')).mockResolvedValueOnce(undefined)
    const close = vi.fn()
    render(<TaskContainerRemovalDialog item={item} type="list" onClose={close} onSaved={saved} />)
    fireEvent.change(await screen.findByLabelText('Nombre para confirmar'), { target: { value: 'Proyecto' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mover todo a Papelera' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('La eliminación ya se guardó')
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar vista' }))
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(2))
    expect(apiPost).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('aborts previous previews and rejects responses that arrive after changing mode', async () => {
    let resolveOld!: (value: ReturnType<typeof response>) => void
    vi.mocked(api).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve as typeof resolveOld })).mockResolvedValueOnce(response(preview({ mode: 'preserve_contents', requires_name: false, requires_destination: true, can_execute: false })))
    render(<TaskContainerRemovalDialog item={item} type="list" onClose={vi.fn()} onSaved={vi.fn()} />)
    const oldSignal = vi.mocked(api).mock.calls[0][1]?.signal
    fireEvent.click(screen.getByRole('radio', { name: /Conservar el contenido/ }))
    await screen.findByRole('button', { name: 'Lista de destino' })
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => resolveOld(response()))
    expect(screen.queryByLabelText('Nombre para confirmar')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Conservar y eliminar' })).toBeDisabled()
  })

  it('traps keyboard focus and restores it when closed', async () => {
    const close = vi.fn()
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus()
    const rendered = render(<TaskContainerRemovalDialog item={item} type="list" onClose={close} onSaved={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cerrar eliminación' })).toHaveFocus())
    const dialog = screen.getByRole('alertdialog')
    const last = within(dialog).getByRole('button', { name: 'Cancelar' })
    last.focus(); fireEvent.keyDown(window, { key: 'Tab' })
    expect(screen.getByRole('button', { name: 'Cerrar eliminación' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
    rendered.unmount()
    expect(trigger).toHaveFocus(); trigger.remove()
  })
})
