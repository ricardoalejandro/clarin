import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import ImportCSVModal from '@/components/ImportCSVModal'
vi.mock('@/lib/api', () => ({ api: vi.fn() }))
const tags = [{ id: 'first', name: 'Campaña junio', color: '#2563EB' }, { id: 'second', name: 'Grupo tarde', color: '#16A34A' }]
beforeEach(() => { vi.useFakeTimers(); vi.mocked(api).mockReset(); vi.mocked(api).mockResolvedValue({ success: true, data: { success: true, tags, can_create: false } }) })
afterEach(() => { cleanup(); vi.useRealTimers() })
const settleSearch = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(500) }) }
describe('ImportCSVModal shared tag selection', () => {
 it('uses bounded lookup, replaces the import choice and clears it without assigning entities', async () => {
  const { rerender } = render(<ImportCSVModal open onClose={vi.fn()} onSuccess={vi.fn()} />)
  expect(api).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Usar etiqueta' }))
  const input = screen.getByRole('combobox')
  fireEvent.change(input, { target: { value: 'camp' } }); await settleSearch()
  expect(api).toHaveBeenCalledWith('/api/tags/search?context_type=lead_import&q=camp&limit=20', expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }))
  fireEvent.click(screen.getByRole('option', { name: tags[0].name }))
  rerender(<ImportCSVModal open onClose={vi.fn()} onSuccess={vi.fn()} />)
  expect(screen.getByRole('button', { name: 'Quitar etiqueta Campaña junio' })).toBeInTheDocument()
  fireEvent.change(input, { target: { value: 'grupo' } }); await settleSearch()
  fireEvent.click(screen.getByRole('option', { name: tags[1].name }))
  expect(screen.queryByRole('button', { name: 'Quitar etiqueta Campaña junio' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Quitar etiqueta Grupo tarde' }))
  expect(screen.getByText(/Selecciona una etiqueta existente/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Sin etiqueta' }))
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(vi.mocked(api).mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true)
 }, 10000)
 it('lets Escape dismiss the picker before the owning modal', async () => {
  const close = vi.fn()
  render(<ImportCSVModal open onClose={close} onSuccess={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Usar etiqueta' }))
  const input = screen.getByRole('combobox')
  fireEvent.change(input, { target: { value: 'camp' } }); await settleSearch()
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(close).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(close).toHaveBeenCalledTimes(1)
 })
 it('does not add the lead-import choice to the contact Excel workflow', () => {
  render(<ImportCSVModal open defaultType="contacts" onClose={vi.fn()} onSuccess={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Usar etiqueta' })).not.toBeInTheDocument()
  expect(api).not.toHaveBeenCalled()
 })
})
