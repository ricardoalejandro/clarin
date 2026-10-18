import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { Program } from '@/types/program'
import { ProgramLifecycleDialog } from './ProgramLifecycleDialog'
vi.mock('@/lib/api', () => ({ api: vi.fn() }))
const program = { id: 'p1', account_id: 'a1', name: 'Grupo', status: 'active', updated_at: 'v1' } as Program
afterEach(cleanup)
beforeEach(() => { vi.mocked(api).mockReset() })
it('blocks a retained confirmation while mobile and completes an already sent request once', async () => {
  let resolve!: (value: unknown) => void
  vi.mocked(api).mockImplementation(() => new Promise(done => { resolve = done }) as never)
  const props = { program, action: 'complete' as const, onClose: vi.fn(), onSaved: vi.fn() }
  const view = render(<ProgramLifecycleDialog {...props} />)
  const confirm = screen.getByRole('button', { name: 'Concluir programa' })
  view.rerender(<ProgramLifecycleDialog {...props} suspended />)
  fireEvent.click(confirm)
  expect(api).not.toHaveBeenCalled()
  view.rerender(<ProgramLifecycleDialog {...props} />)
  fireEvent.click(confirm); fireEvent.click(confirm)
  view.rerender(<ProgramLifecycleDialog {...props} suspended />)
  await act(async () => resolve({ success: true, data: { ...program, status: 'completed' } }))
  expect(api).toHaveBeenCalledTimes(1)
  expect(props.onSaved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'completed' }))
  const payload = JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))
  expect(payload).toMatchObject({ status: 'completed', expected_updated_at: 'v1' })
  expect(payload).not.toHaveProperty('completed_at')
})
it('preserves a failure for retry and blocks blind retries after a conflict', async () => {
  vi.mocked(api).mockResolvedValueOnce({ success: false, error: 'Error de red' }).mockResolvedValueOnce({ success: false, status: 409, error: 'Versión nueva', data: { program: { ...program, status: 'completed' } } })
  const onCanonical = vi.fn()
  render(<ProgramLifecycleDialog program={program} action="complete" onClose={vi.fn()} onSaved={vi.fn()} onCanonical={onCanonical} />)
  fireEvent.click(screen.getByRole('button', { name: 'Concluir programa' }))
  await screen.findByText('Error de red')
  fireEvent.click(screen.getByRole('button', { name: 'Concluir programa' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Concluir programa' })).toBeDisabled())
  expect(onCanonical).toHaveBeenCalledOnce()
})
it('releases the pending state after a thrown transport error and permits an explicit retry', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ success: true, data: { ...program, status: 'completed' } })
  const onSaved = vi.fn()
  render(<ProgramLifecycleDialog program={program} action="complete" onClose={vi.fn()} onSaved={onSaved} />)
  fireEvent.click(screen.getByRole('button', { name: 'Concluir programa' }))
  await screen.findByText(/No se pudo conectar/)
  fireEvent.click(screen.getByRole('button', { name: 'Concluir programa' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
  expect(api).toHaveBeenCalledTimes(2)
})
it('ignores completion from a previous program after switching the confirmation target', async () => {
  let resolve!: (value: unknown) => void
  vi.mocked(api).mockImplementationOnce(() => new Promise(done => { resolve = done }) as never)
  const onSaved = vi.fn()
  const props = { action: 'complete' as const, onClose: vi.fn(), onSaved }
  const view = render(<ProgramLifecycleDialog {...props} program={program} />)
  fireEvent.click(screen.getByRole('button', { name: 'Concluir programa' }))
  view.rerender(<ProgramLifecycleDialog {...props} program={{ ...program, id: 'p2', name: 'Otro grupo' }} />)
  await act(async () => resolve({ success: true, data: { ...program, status: 'completed' } }))
  expect(onSaved).not.toHaveBeenCalled()
  expect(props.onClose).not.toHaveBeenCalled()
  expect(screen.getByText('Otro grupo')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Concluir programa' })).toBeEnabled()
})
it('reconciles an in-flight completion through the current filter callback after resizing', async () => {
  let resolve!: (value: unknown) => void
  vi.mocked(api).mockImplementationOnce(() => new Promise(done => { resolve = done }) as never)
  const oldScope = vi.fn(), newScope = vi.fn()
  const props = { program, action: 'complete' as const, onClose: vi.fn() }
  const view = render(<ProgramLifecycleDialog {...props} onSaved={oldScope} />)
  fireEvent.click(screen.getByRole('button', { name: 'Concluir programa' }))
  view.rerender(<ProgramLifecycleDialog {...props} suspended onSaved={newScope} />)
  await act(async () => resolve({ success: true, data: { ...program, status: 'completed' } }))
  expect(oldScope).not.toHaveBeenCalled()
  expect(newScope).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'completed' }))
})
