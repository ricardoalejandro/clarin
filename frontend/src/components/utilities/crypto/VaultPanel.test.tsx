import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { VaultPanel } from './VaultPanel'
import { UtilityDocumentProvider, type UtilityDocumentSession } from '../library/UtilityDocumentContext'

const request = vi.hoisted(() => vi.fn())
vi.mock('../library/libraryApi', () => ({ libraryRequest: request, jsonRequest: (method: string, value: unknown) => ({ method, body: JSON.stringify(value) }), operationId: () => 'synthetic-operation' }))
vi.mock('./usePkiJob', () => ({ usePkiJob: () => ({ busy: false, run: runJob, cancel: cancelJob }) }))
const cancelJob = vi.hoisted(() => vi.fn())
const runJob = vi.hoisted(() => vi.fn())
beforeEach(() => {
  request.mockImplementation((path: string) => Promise.resolve(path === '/vault/status' ? { configured: false } : { items: [], has_more: false }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); request.mockReset(); cancelJob.mockReset(); runJob.mockReset() })

it('explains missing server custody and disables mutation without preventing browsing', async () => {
  render(<VaultPanel onUse={vi.fn()} />)
  expect(await screen.findByText(/protección de claves aún no está configurada/)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Generar y guardar' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Importar archivo' })).toBeDisabled()
  expect(screen.getByRole('textbox', { name: 'Buscar claves por nombre o huella' })).toBeEnabled()
})

it('invalidates a previous signature when its input changes', async () => {
  const item = { id: 'synthetic-id', name: 'Signature', description: '', kind: 'ec', algorithm: 'ECDSA', bits: 256, metadata: { key_usage: ['sign', 'verify'] }, version: 1 }
  request.mockImplementation((path: string) => Promise.resolve(path === '/vault/status' ? { configured: true } : path.endsWith('/material') ? { material: 'synthetic-private-material' } : path === '/vault/synthetic-id' ? { item } : { items: [item], has_more: false }))
  runJob.mockResolvedValue('synthetic-jwt-result')
  const session: UtilityDocumentSession = { documentId: 'synthetic-document', initialState: { key_id: 'synthetic-id' }, readSlot: async () => null, setState: vi.fn(), setSlot: vi.fn(), getSlot: () => undefined, flush: async () => true }
  render(<UtilityDocumentProvider value={session}><VaultPanel onUse={vi.fn()} /></UtilityDocumentProvider>)
  const source = await screen.findByRole('textbox', { name: 'Contenido JWT / token' })
  fireEvent.change(source, { target: { value: '{"sub":"first"}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Firmar JWT' }))
  expect(await screen.findByRole('textbox', { name: 'Resultado' })).toHaveValue('synthetic-jwt-result')
  await waitFor(() => expect(source).toBeEnabled())
  fireEvent.change(source, { target: { value: '{"sub":"second"}' } })
  expect(screen.queryByRole('textbox', { name: 'Resultado' })).not.toBeInTheDocument()
})
it('debounces metadata search exactly 500ms and cancels the old request', async () => {
  render(<VaultPanel onUse={vi.fn()} />)
  await waitFor(() => expect(request).toHaveBeenCalledWith('/vault?q=', expect.anything()))
  const oldOptions = request.mock.calls.find(call => call[0] === '/vault?q=')![1]
  vi.useFakeTimers()
  fireEvent.change(screen.getByRole('textbox', { name: 'Buscar claves por nombre o huella' }), { target: { value: 'certificado' } })
  act(() => vi.advanceTimersByTime(499))
  expect(request.mock.calls.some(call => call[0] === '/vault?q=certificado')).toBe(false)
  await act(async () => { vi.advanceTimersByTime(1) })
  expect(request).toHaveBeenCalledWith('/vault?q=certificado', expect.anything())
  expect(oldOptions.signal.aborted).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: 'Buscar claves por nombre o huella' }), { target: { value: '' } })
  expect(request).toHaveBeenLastCalledWith('/vault?q=', expect.anything())
})
