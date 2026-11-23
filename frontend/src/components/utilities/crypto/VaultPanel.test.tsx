import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { VaultPanel } from './VaultPanel'
import { UtilityDocumentProvider, type UtilityDocumentSession } from '../library/UtilityDocumentContext'

const request = vi.hoisted(() => vi.fn())
vi.mock('../library/libraryApi', () => ({ libraryRequest: request, jsonRequest: (method: string, value: unknown) => ({ method, body: JSON.stringify(value) }), operationId: () => 'synthetic-operation' }))
vi.mock('./usePkiJob', () => ({ usePkiJob: () => ({ busy: false, run: runJob, cancel: cancelJob }) }))
const cancelJob = vi.hoisted(() => vi.fn())
const runJob = vi.hoisted(() => vi.fn())
function session(documentId = 'draft', initialState: Record<string, unknown> = {}): UtilityDocumentSession {
  return { documentId, initialState, readSlot: async () => null, setState: vi.fn(), setSlot: vi.fn(), getSlot: () => undefined, flush: async () => true }
}
function renderVault(document = session()) {
  return render(<UtilityDocumentProvider value={document}><VaultPanel onUse={vi.fn()} /></UtilityDocumentProvider>)
}
beforeEach(() => {
  request.mockImplementation((path: string) => Promise.resolve(path === '/vault/status' ? { configured: false } : { items: [], has_more: false }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); request.mockReset(); cancelJob.mockReset(); runJob.mockReset() })

it('explains missing server custody and disables mutation without preventing browsing', async () => {
  renderVault()
  expect(await screen.findByText(/protección de claves aún no está configurada/)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Nueva clave' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Importar clave o certificado' })).toBeDisabled()
  expect(screen.getByRole('textbox', { name: 'Buscar claves por nombre o huella' })).toBeEnabled()
})

it('invalidates a previous signature when its input changes', async () => {
  const item = { id: 'synthetic-id', name: 'Signature', description: '', kind: 'ec', algorithm: 'ECDSA', bits: 256, metadata: { key_usage: ['sign', 'verify'] }, version: 1 }
  request.mockImplementation((path: string) => Promise.resolve(path === '/vault/status' ? { configured: true } : path.endsWith('/material') ? { material: 'synthetic-private-material' } : path === '/documents/synthetic-document/vault/synthetic-id' ? { item } : { items: [item], has_more: false }))
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
  request.mockImplementation((path: string) => Promise.resolve(path === '/vault/status' ? { configured: true } : path === '/documents/draft/vault/entry' ? { item } : { items: [item], has_more: false }))
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
  request.mockImplementation((path: string, options?: { method?: string }) => Promise.resolve(path === '/vault/status' ? { configured: true } : path.endsWith('/material') ? options?.method === 'PUT' ? { item } : { material: '{"privateKey":"synthetic","certificates":[]}' } : path === '/documents/draft/vault/entry' ? { item } : { items: [item], has_more: false }))
  runJob.mockResolvedValue('synthetic-csr')
  const session: UtilityDocumentSession = { documentId: 'draft', initialState: { key_id: 'entry' }, readSlot: async () => null, setState: vi.fn(), setSlot: vi.fn(), getSlot: () => undefined, flush: async () => true }
  render(<UtilityDocumentProvider value={session}><VaultPanel onUse={vi.fn()} /></UtilityDocumentProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Certificados y CSR' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Nombre común (CN)' }), { target: { value: 'test.invalid' } })
  fireEvent.click(screen.getByRole('button', { name: 'Crear y guardar CSR' }))
  await waitFor(() => expect(request.mock.calls.filter(([path]) => path === '/documents/draft/vault/entry')).toHaveLength(2))
  expect(await screen.findByRole('button', { name: 'Certificado de prueba' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Certificados y CSR' })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('textbox', { name: 'Nombre común (CN)' })).toHaveValue('test.invalid')
  expect(screen.getByRole('textbox', { name: 'Resultado' })).toHaveValue('synthetic-csr')
})
it('debounces metadata search exactly 500ms and cancels the old request', async () => {
  request.mockImplementation((path: string) => path === '/documents/draft/vault?q=' ? new Promise(() => {}) : Promise.resolve(path === '/vault/status' ? { configured: true } : { items: [], has_more: false }))
  renderVault()
  await waitFor(() => expect(request).toHaveBeenCalledWith('/documents/draft/vault?q=', expect.anything()))
  const oldOptions = request.mock.calls.find(call => call[0] === '/documents/draft/vault?q=')![1]
  vi.useFakeTimers()
  fireEvent.change(screen.getByRole('textbox', { name: 'Buscar claves por nombre o huella' }), { target: { value: 'certificado' } })
  act(() => vi.advanceTimersByTime(499))
  expect(request.mock.calls.some(call => call[0] === '/documents/draft/vault?q=certificado')).toBe(false)
  await act(async () => { vi.advanceTimersByTime(1) })
  expect(request).toHaveBeenCalledWith('/documents/draft/vault?q=certificado', expect.anything())
  expect(oldOptions.signal.aborted).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: 'Buscar claves por nombre o huella' }), { target: { value: '' } })
  expect(request).toHaveBeenLastCalledWith('/documents/draft/vault?q=', expect.anything())
})

it('starts a new document empty and aborts late metadata from the previous document', async () => {
  let completeOld!: (value: unknown) => void
  request.mockImplementation((path: string) => path === '/documents/first/vault?q='
    ? new Promise(resolve => { completeOld = resolve })
    : Promise.resolve(path === '/vault/status' ? { configured: true } : { items: [], has_more: false }))
  const view = renderVault(session('first'))
  await waitFor(() => expect(completeOld).toBeTypeOf('function'))
  const signal = request.mock.calls.find(([path]) => path === '/documents/first/vault?q=')![1].signal
  view.rerender(<UtilityDocumentProvider value={session('second')}><VaultPanel onUse={vi.fn()} /></UtilityDocumentProvider>)
  await screen.findByText('Este documento todavía no tiene claves.')
  expect(signal.aborted).toBe(true)
  await act(async () => { completeOld({ items: [{ id: 'old', name: 'Clave de otro documento' }], has_more: false }) })
  expect(screen.queryByText('Clave de otro documento')).not.toBeInTheDocument()
  expect(request.mock.calls.some(([path]) => path === '/vault' || path.startsWith('/vault?'))).toBe(false)
})

it('imports legacy by CAS as an independent copy before offering Use and never reads legacy secrets', async () => {
  const old = { id: 'old-key', name: 'Anterior', kind: 'aes', algorithm: 'AES-GCM', version: 7, metadata: {} }
  const copy = { ...old, id: 'copy-key', document_id: 'draft', version: 1 }
  const use = vi.fn()
  request.mockImplementation((path: string, options?: RequestInit) => Promise.resolve(path === '/vault/status' ? { configured: true }
    : path === '/vault/legacy' ? { items: [old], has_more: false }
      : path.endsWith('/import-legacy') ? { item: copy }
        : path.endsWith('/copy-key') ? { item: copy }
          : { items: options?.method ? [copy] : [], has_more: false }))
  render(<UtilityDocumentProvider value={session()}><VaultPanel onUse={use} /></UtilityDocumentProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Claves anteriores' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Importar copia de Anterior' }))
  expect(await screen.findByText(/Copia independiente importada/)).toBeVisible()
  const imported = request.mock.calls.find(([path]) => path.endsWith('/import-legacy'))!
  expect(JSON.parse(imported[1].body)).toEqual({ source_id: 'old-key', source_version: 7, operation_id: 'synthetic-operation' })
  expect(use).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('button', { name: 'Usar esta clave' }))
  expect(use).toHaveBeenCalledWith(expect.objectContaining({ id: 'copy-key' }))
  expect(request.mock.calls.some(([path]) => path.endsWith('/material'))).toBe(false)
})

it('offers import for a previously selected legacy key and keeps its reference on import conflict', async () => {
  const previous = { id: 'legacy-selected', name: 'Anterior seleccionada', kind: 'aes', algorithm: 'AES-GCM', metadata: {}, version: 4 }
  const document = session('draft', { key_id: previous.id })
  request.mockImplementation((path: string) => path === '/documents/draft/vault/legacy-selected'
    ? Promise.reject(Object.assign(new Error('Sin propiedad'), { status: 404 }))
    : path === '/vault/legacy/legacy-selected' ? Promise.resolve({ item: previous })
      : path.endsWith('/import-legacy') ? Promise.reject(Object.assign(new Error('La versión cambió. Actualiza y reintenta.'), { status: 409 }))
        : Promise.resolve(path === '/vault/status' ? { configured: true } : { items: [], has_more: false }))
  renderVault(document)
  fireEvent.click(await screen.findByRole('button', { name: 'Importar en esta hoja' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('La versión cambió')
  expect(document.setState).not.toHaveBeenCalledWith({ key_id: '' })
  expect(screen.getByRole('region', { name: 'Clave anterior seleccionada' })).toBeVisible()
  expect(request.mock.calls.some(([path]) => path.endsWith('/material'))).toBe(false)
})
