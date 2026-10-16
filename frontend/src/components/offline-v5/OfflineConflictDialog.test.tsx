import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfflineV5Conflict } from '@/offline-v5/types'

const conflicts = vi.fn(), resolveConflict = vi.fn()
vi.mock('./ClarinRuntimeProvider', () => ({ useClarinRuntime: () => ({ snapshot: { userId: 'user', accountId: 'account', conflictCount: 1 }, conflicts, resolveConflict }) }))
import OfflineConflictDialog from './OfflineConflictDialog'

const conflict = {
  operation_id: 'first', action: 'tasks.update', selection_id: 'selection', resource_id: 'task', status: 'conflict', fields: ['title'],
  local: { title: 'Mi título' }, server: { title: 'Título remoto' }, server_version: 3, created_at: '2026-10-20',
  operation: { action: 'tasks.update', payload: { title: 'Mi título' } },
  optimistic_entity: { entity_id: 'task', entity_type: 'task', value: { id: 'task', title: 'Mi título' } },
} as OfflineV5Conflict

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open') } })
  conflicts.mockResolvedValue([conflict]); resolveConflict.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

describe('explicit offline conflict review', () => {
  it('retries a failed read without claiming the saved conflicts are gone', async () => {
    conflicts.mockRejectedValueOnce(new Error('Lectura no disponible'))
    render(<OfflineConflictDialog onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Lectura no disponible')
    expect(screen.queryByText(/No quedan conflictos/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(await screen.findByText('Mi título')).toBeInTheDocument()
    expect(resolveConflict).not.toHaveBeenCalled()
  })
  it('requires a field decision and submits only that operation', async () => {
    render(<OfflineConflictDialog onClose={vi.fn()} />)
    await screen.findByText('Mi título')
    expect(screen.getByRole('button', { name: 'Guardar selección' })).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: /Versión del servidor/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar selección' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Guardar selección' }))
    await vi.waitFor(() => expect(resolveConflict).toHaveBeenCalledWith({ operation_id: 'first', choice: 'fields', fields: { title: 'server' } }))
    expect(await screen.findByText(/No quedan conflictos/)).toBeInTheDocument()
  })
  it('retains choices and both versions when saving fails', async () => {
    resolveConflict.mockRejectedValueOnce(new Error('No se pudo guardar'))
    render(<OfflineConflictDialog onClose={vi.fn()} />)
    await screen.findByText('Mi título')
    fireEvent.click(screen.getByRole('radio', { name: /Mi cambio local/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar selección' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Guardar selección' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo guardar')
    expect(screen.getByRole('radio', { name: /Mi cambio local/ })).toBeChecked()
    expect(screen.getByText('Título remoto')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Guardar selección' })).toBeEnabled()
  })
  it('closing a review never accepts or deletes its pending decision', async () => {
    const onClose = vi.fn()
    render(<OfflineConflictDialog onClose={onClose} />)
    await screen.findByText('Mi título')
    fireEvent.click(screen.getByRole('button', { name: 'Revisar después' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(resolveConflict).not.toHaveBeenCalled()
  })
})
