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
  expect(screen.getByRole('button', { name: 'Nueva clave' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Importar clave o certificado' })).toBeDisabled()
  expect(screen.getByRole('textbox', { name: 'Buscar claves por nombre o huella' })).toBeEnabled()
})

it('invalidates a previous signature when its input changes', async () => {
  const item = { id: 'synthetic-id', name: 'Signature', description: '', kind: 'ec', algorithm: 'ECDSA', bits: 256, metadata: { key_usage: ['sign', 'verify'] }, version: 1 }
  request.mockImplementation((path: string) => Promise.resolve(path === '/vault/status' ? { configured: true } : path.endsWith('/material') ? { material: 'synthetic-private-material' } : path === '/vault/synthetic-id' ? { item } : { items: [item], has_more: false }))
  runJob.mockResolvedValue('synthetic-jwt-result')
  const session: UtilityDocumentSession = { documentId: 'synthetic-document', initialState: { key_id: 'synthetic-id' }, readSlot: async () => null, setState: vi.fn(), setSlot: vi.fn(), getSlot: () => undefined, flush: async () => true }
  render(<UtilityDocumentProvider value={session}><VaultPanel onUse={vi.fn()} /></UtilityDocumentProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'JWT' }))
  const source = screen.getByRole('textbox', { name: 'Contenido JWT / token' })
  fireEvent.change(source, { target: { value: '{"sub":"first"}' } })
  fireEvent.click(screen.getByRole('button', { name: 'Firmar JWT' }))
  expect(await screen.findByRole('textbox', { name: 'Resultado' })).toHaveValue('synthetic-jwt-result')
  await waitFor(() => expect(source).toBeEnabled())
  fireEvent.change(source, { target: { value: '{"sub":"second"}' } })
  expect(screen.queryByRole('textbox', { name: 'Resultado' })).not.toBeInTheDocument()
})

it('shows creation on demand and retains an import draft without autosaving its password', async () => {
  request.mockImplementation((path: string) => Promise.resolve(path === '/vault/status' ? { configured: true } : { items: [], has_more: false }))
  const setState = vi.fn(), setSlot = vi.fn()
  const session: UtilityDocumentSession = { documentId: 'draft', initialState: {}, readSlot: async () => null, setState, setSlot, getSlot: () => undefined, flush: async () => true }
  render(<UtilityDocumentProvider value={session}><VaultPanel onUse={vi.fn()} /></UtilityDocumentProvider>)
  expect(screen.queryByRole('textbox', { name: 'Nombre' })).not.toBeInTheDocument()
  const importing = await screen.findByRole('button', { name: 'Importar clave o certificado' })
  await waitFor(() => expect(importing).toBeEnabled())
  fireEvent.click(importing)
  fireEvent.change(screen.getByRole('textbox', { name: 'Nombre' }), { target: { value: 'Conservar borrador' } })
  fireEvent.change(screen.getByLabelText(/Contraseña de importación/), { target: { value: 'synthetic-password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cerrar opciones de creación' }))
  expect(screen.queryByRole('textbox', { name: 'Nombre' })).not.toBeInTheDocument()
  fireEvent.click(importing)
  expect(screen.getByRole('textbox', { name: 'Nombre' })).toHaveValue('Conservar borrador')
  expect(screen.getByLabelText(/Contraseña de importación/)).toHaveValue('synthetic-password')
  expect(setSlot).not.toHaveBeenCalled()
  expect(JSON.stringify(setState.mock.calls)).not.toContain('synthetic-password')
  expect(request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it('keeps CSR and JWT fields when their sections are closed and reopened', async () => {
  const item = { id: 'entry', name: 'Firma', description: '', kind: 'ec', algorithm: 'ECDSA', metadata: {}, version: 1 }
  request.mockImplementation((path: string) => Promise.resolve(path === '/vault/status' ? { configured: true } : path === '/vault/entry' ? { item } : { items: [item], has_more: false }))
  const session: UtilityDocumentSession = { documentId: 'draft', initialState: { key_id: 'entry' }, readSlot: async () => null, setState: vi.fn(), setSlot: vi.fn(), getSlot: () => undefined, flush: async () => true }
  render(<UtilityDocumentProvider value={session}><VaultPanel onUse={vi.fn()} /></UtilityDocumentProvider>)
  const certificates = await screen.findByRole('button', { name: 'Certificados y CSR' })
  fireEvent.click(certificates)
  fireEvent.change(screen.getByRole('textbox', { name: 'Nombre común (CN)' }), { target: { value: 'test.invalid' } })
  fireEvent.click(certificates)
  expect(screen.queryByRole('textbox', { name: 'Nombre común (CN)' })).not.toBeInTheDocument()
  fireEvent.click(certificates)
  expect(screen.getByRole('textbox', { name: 'Nombre común (CN)' })).toHaveValue('test.invalid')
  const jwt = screen.getByRole('button', { name: 'JWT' })
  fireEvent.click(jwt)
  fireEvent.change(screen.getByRole('textbox', { name: 'Contenido JWT / token' }), { target: { value: '{"sub":"draft"}' } })
  fireEvent.click(jwt)
  fireEvent.click(jwt)
  expect(screen.getByRole('textbox', { name: 'Contenido JWT / token' })).toHaveValue('{"sub":"draft"}')
})

it('keeps the certificate section and its draft open after saving a CSR refreshes the selected entry', async () => {
  const item = { id: 'entry', name: 'Firma', description: '', kind: 'ec', algorithm: 'ECDSA', metadata: {}, version: 1 }
  request.mockImplementation((path: string, options?: { method?: string }) => Promise.resolve(path === '/vault/status' ? { configured: true } : path.endsWith('/material') ? options?.method === 'PUT' ? { item } : { material: '{"privateKey":"synthetic","certificates":[]}' } : path === '/vault/entry' ? { item } : { items: [item], has_more: false }))
  runJob.mockResolvedValue('synthetic-csr')
  const session: UtilityDocumentSession = { documentId: 'draft', initialState: { key_id: 'entry' }, readSlot: async () => null, setState: vi.fn(), setSlot: vi.fn(), getSlot: () => undefined, flush: async () => true }
  render(<UtilityDocumentProvider value={session}><VaultPanel onUse={vi.fn()} /></UtilityDocumentProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Certificados y CSR' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Nombre común (CN)' }), { target: { value: 'test.invalid' } })
  fireEvent.click(screen.getByRole('button', { name: 'Crear y guardar CSR' }))
  await waitFor(() => expect(request.mock.calls.filter(([path]) => path === '/vault/entry')).toHaveLength(2))
  expect(await screen.findByRole('button', { name: 'Certificado de prueba' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Certificados y CSR' })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('textbox', { name: 'Nombre común (CN)' })).toHaveValue('test.invalid')
  expect(screen.getByRole('textbox', { name: 'Resultado' })).toHaveValue('synthetic-csr')
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
