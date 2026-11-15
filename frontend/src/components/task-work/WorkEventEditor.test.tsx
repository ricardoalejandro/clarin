import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiPost, apiPut } from '@/lib/api'
import type { TaskList, WorkEvent } from '@/types/task'
import WorkEventEditor from './WorkEventEditor'

vi.mock('@/lib/api', () => ({ apiPost: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }))
vi.mock('./TaskWorkWindowShell', () => ({ default: ({ open, children, footer }: { open: boolean; children: ReactNode; footer: ReactNode }) => open ? <div>{children}{footer}</div> : null }))
vi.mock('./TaskUserCombobox', () => ({ default: () => null }))
vi.mock('./TaskSelectPicker', () => ({ TaskListPicker: () => null }))
vi.mock('./TaskContainerAppearance', () => ({ TaskColorPicker: () => null, taskColorContrast: () => ({ textColor: '#000000' }) }))
const list = { id: 'list-1', name: 'General', color: '#10B981', is_default: true } as TaskList
const event = { id: 'event-1', title: 'Jornada', list_id: 'list-1', is_all_day: true, start_date: '2028-02-29', end_date_exclusive: '2028-03-01', timezone: 'America/Lima', attendees: [], capabilities: { can_edit: true }, version: 2 } as unknown as WorkEvent
const renderEvent = (value: WorkEvent = event) => render(<WorkEventEditor open event={value} lists={[list]} folders={[]} users={[]} currentUserID="user-1" onClose={vi.fn()} onSaved={vi.fn()} />)
beforeEach(() => { vi.mocked(apiPut).mockReset().mockResolvedValue({ success: true, data: { event } }); vi.mocked(apiPost).mockReset() })
afterEach(cleanup)

describe('Work event editable calendar dates', () => {
  it('opens and saves exact all-day dates and the exclusive end without UTC conversion', async () => {
    renderEvent()
    expect(screen.getByRole('textbox', { name: 'Comienza' })).toHaveValue('29/02/2028')
    expect(screen.getByRole('textbox', { name: 'Último día incluido' })).toHaveValue('29/02/2028')
    expect(screen.queryByRole('textbox', { name: /hora/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1))
    expect(apiPut).toHaveBeenCalledWith('/api/tasks/events/event-1', expect.objectContaining({ start_date: '2028-02-29', end_date_exclusive: '2028-03-01', is_all_day: true }))
    expect(vi.mocked(apiPut).mock.calls[0][1]).not.toHaveProperty('start_at')
  })
  it('saves the latest written endpoints immediately and rejects partial dates', async () => {
    renderEvent()
    const first = screen.getByRole('textbox', { name: 'Comienza' }), last = screen.getByRole('textbox', { name: 'Último día incluido' })
    fireEvent.change(first, { target: { value: '01/03/202' } })
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled()
    expect(apiPut).not.toHaveBeenCalled()
    fireEvent.change(first, { target: { value: '01/03/2028' } }); fireEvent.change(last, { target: { value: '03/03/2028' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1))
    expect(apiPut).toHaveBeenCalledWith('/api/tasks/events/event-1', expect.objectContaining({ start_date: '2028-03-01', end_date_exclusive: '2028-03-04' }))
  })
  it('keeps conversion to hours explicit and cancellation preserves all-day values', () => {
    renderEvent()
    fireEvent.click(screen.getByRole('button', { name: 'Asignar hora' }))
    const confirmation = screen.getByRole('dialog', { name: 'Asignar hora y duración' })
    fireEvent.change(within(confirmation).getByRole('textbox', { name: 'Comienza: hora' }), { target: { value: '15:30' } })
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Comienza' })).toHaveValue('29/02/2028')
    expect(screen.queryByRole('textbox', { name: 'Comienza: hora' })).not.toBeInTheDocument()
    expect(apiPut).not.toHaveBeenCalled()
  })
  it('keeps an existing timed interval and its hours when only dates are written', async () => {
    const start = new Date(2028, 1, 29, 9, 45).toISOString(), end = new Date(2028, 1, 29, 11, 15).toISOString()
    renderEvent({ ...event, is_all_day: false, start_at: start, end_at: end })
    fireEvent.change(screen.getByRole('textbox', { name: 'Comienza' }), { target: { value: '01/03/2028' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Termina' }), { target: { value: '01/03/2028' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1))
    expect(apiPut).toHaveBeenCalledWith('/api/tasks/events/event-1', expect.objectContaining({ start_at: new Date(2028, 2, 1, 9, 45).toISOString(), end_at: new Date(2028, 2, 1, 11, 15).toISOString(), is_all_day: false }))
  })
})
