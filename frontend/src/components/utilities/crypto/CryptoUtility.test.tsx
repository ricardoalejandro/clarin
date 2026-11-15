import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import CryptoUtility from './CryptoUtility'
import { UtilityDocumentProvider, type UtilityDocumentSession } from '../library/UtilityDocumentContext'
import { libraryRequest, UtilityRequestError } from '../library/libraryApi'

const realtime = vi.hoisted(() => ({ listeners: new Set<(message: unknown) => void>() }))
vi.mock('@/lib/api', () => ({ api: vi.fn(), apiBlob: vi.fn(), subscribeWebSocket: (listener: (message: unknown) => void) => { realtime.listeners.add(listener); return () => realtime.listeners.delete(listener) } }))
vi.mock('../library/libraryApi', async importOriginal => ({ ...await importOriginal<typeof import('../library/libraryApi')>(), libraryRequest: vi.fn() }))

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false } })
})
afterAll(() => {
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})
afterEach(() => { cleanup(); vi.mocked(libraryRequest).mockReset(); vi.clearAllMocks() })

const selectedKey = { id: 'selected-key', name: 'Clave seleccionada', description: '', kind: 'aes' as const, algorithm: 'AES-GCM', bits: 256, metadata: {}, version: 1, public_data: '', created_at: '', updated_at: '' }
const missingKeyNotice = 'La clave guardada ya no está disponible. Puedes elegir otra en Mis claves.'
function vaultEvent(id = selectedKey.id, kind = 'vault') {
  act(() => { for (const listener of realtime.listeners) listener({ event: 'utility_updated', data: { kind, id } }) })
}

function renderSelectedKey() {
  const setState = vi.fn()
  const session: UtilityDocumentSession = { documentId: 'synthetic', initialState: { key_id: selectedKey.id }, setState, setSlot: vi.fn(), getSlot: () => undefined, readSlot: async () => null, flush: async () => true }
  render(<UtilityDocumentProvider value={session}><CryptoUtility /></UtilityDocumentProvider>)
  return setState
}

function mockSelectedKey(material: () => Promise<unknown> = async () => ({ material: '' })) {
  let deleted = false
  vi.mocked(libraryRequest).mockImplementation((path, options) => {
    if (options?.method === 'DELETE') { deleted = true; return Promise.resolve({ deleted: true }) as never }
    if (path === '/vault/status') return Promise.resolve({ configured: true }) as never
    if (path.startsWith('/vault?q=')) return Promise.resolve({ items: deleted ? [] : [selectedKey], has_more: false }) as never
    if (path.endsWith('/material')) return material() as never
    return Promise.resolve({ item: selectedKey }) as never
  })
}

it('encodes and decodes Unicode and preserves the draft when switching internal tools', async () => {
  render(<CryptoUtility />)
  fireEvent.click(screen.getByRole('button', { name: 'Base64' }))
  expect(screen.getByRole('button', { name: 'Base64' })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.change(screen.getByRole('textbox', { name: 'Texto (UTF-8)' }), { target: { value: 'á' } })
  fireEvent.click(screen.getByRole('button', { name: 'Codificar' }))
  expect(await screen.findByRole('textbox', { name: 'Texto codificado' })).toHaveValue('w6E=')
  fireEvent.change(screen.getByRole('combobox', { name: 'Operación' }), { target: { value: 'decode' } })
  const encoded = screen.getByRole('textbox', { name: 'Entrada en Base64' })
  expect(encoded).toHaveValue('á')
  fireEvent.change(encoded, { target: { value: 'w6E=' } })
  fireEvent.click(screen.getByRole('button', { name: 'Decodificar' }))
  expect(await screen.findByRole('textbox', { name: 'Texto decodificado' })).toHaveValue('á')
  fireEvent.click(screen.getByRole('button', { name: 'Claves' }))
  fireEvent.click(screen.getByRole('button', { name: 'Base64' }))
  expect(screen.getByRole('textbox', { name: 'Entrada en Base64' })).toHaveValue('w6E=')
  expect(screen.getByRole('textbox', { name: 'Texto decodificado' })).toHaveValue('á')
})

it('persists public preferences while keeping typed keys and plaintext out of ordinary autosave', () => {
  const setState = vi.fn(), setSlot = vi.fn()
  const session: UtilityDocumentSession = { documentId: 'synthetic', initialState: {}, setState, setSlot, getSlot: () => undefined, readSlot: async () => null, flush: async () => true }
  const view = render(<UtilityDocumentProvider value={session}><CryptoUtility /></UtilityDocumentProvider>)
  fireEvent.change(screen.getByRole('textbox', { name: 'Texto para cifrar (UTF-8)' }), { target: { value: 'synthetic-private-input' } })
  fireEvent.change(screen.getByLabelText('Clave AES de 256 bits (Base64)'), { target: { value: 'synthetic-secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Base64' }))
  expect(JSON.stringify(setState.mock.calls)).not.toContain('synthetic-private-input')
  expect(JSON.stringify(setState.mock.calls)).not.toContain('synthetic-secret')
  expect(setSlot).not.toHaveBeenCalled()
  expect(setState).toHaveBeenCalledWith({ active: 'base64' })
  view.unmount()
})

it('keeps one primary action in the shared toolbar and preserves drafts through navigation and help', async () => {
  const view = render(<CryptoUtility />)
  const toolbar = view.container.querySelector('[data-crypto-primary-actions]')!
  expect(toolbar.querySelectorAll('button')).toHaveLength(2)
  expect(screen.getAllByRole('button', { name: 'Cifrar' })).toHaveLength(1)
  fireEvent.change(screen.getByRole('combobox', { name: 'Herramienta de criptografía' }), { target: { value: 'base64' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Texto (UTF-8)' }), { target: { value: 'Conservar ñ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Codificar' }))
  expect(await screen.findByRole('textbox', { name: 'Texto codificado' })).toHaveValue('Q29uc2VydmFyIMOx')
  const information = screen.getByRole('button', { name: 'Información de criptografía' })
  fireEvent.click(information)
  fireEvent.click(information)
  fireEvent.change(screen.getByRole('combobox', { name: 'Herramienta de criptografía' }), { target: { value: 'hash' } })
  expect(toolbar.querySelectorAll('button')).toHaveLength(2)
  expect(screen.queryByRole('button', { name: 'Codificar' })).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('combobox', { name: 'Herramienta de criptografía' }), { target: { value: 'base64' } })
  expect(screen.getByRole('textbox', { name: 'Texto (UTF-8)' })).toHaveValue('Conservar ñ')
  expect(screen.getByRole('textbox', { name: 'Texto codificado' })).toHaveValue('Q29uc2VydmFyIMOx')
  expect(screen.getAllByRole('button', { name: 'Codificar' })).toHaveLength(1)
})

it('clears a confirmed deleted key reference so document preferences can still autosave', async () => {
  vi.mocked(libraryRequest).mockRejectedValueOnce(new UtilityRequestError('No disponible', 404))
  const setState = vi.fn()
  const session: UtilityDocumentSession = { documentId: 'synthetic', initialState: { key_id: 'deleted-key' }, setState, setSlot: vi.fn(), getSlot: () => undefined, readSlot: async () => null, flush: async () => true }
  render(<UtilityDocumentProvider value={session}><CryptoUtility /></UtilityDocumentProvider>)
  await waitFor(() => expect(setState).toHaveBeenCalledWith({ key_id: '' }))
  expect(screen.getByText('La clave guardada ya no está disponible. Puedes elegir otra en Mis claves.')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Base64' }))
  expect(setState).toHaveBeenCalledWith({ active: 'base64' })
})

it('preserves the saved key reference after a temporary service failure', async () => {
  vi.mocked(libraryRequest).mockRejectedValueOnce(new UtilityRequestError('Reintenta', 503))
  const setState = vi.fn()
  const session: UtilityDocumentSession = { documentId: 'synthetic', initialState: { key_id: 'existing-key' }, setState, setSlot: vi.fn(), getSlot: () => undefined, readSlot: async () => null, flush: async () => true }
  render(<UtilityDocumentProvider value={session}><CryptoUtility /></UtilityDocumentProvider>)
  await waitFor(() => expect(libraryRequest).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'Base64' }))
  expect(setState).toHaveBeenCalledWith({ active: 'base64' })
  expect(setState).not.toHaveBeenCalledWith({ key_id: '' })
})

it('clears the cipher selection after deleting the key that was explicitly chosen from the vault', async () => {
  mockSelectedKey()
  const setState = renderSelectedKey()
  expect(await screen.findByRole('checkbox', { name: /Usar la clave seleccionada/ })).toHaveAccessibleName(/Clave seleccionada · AES-GCM/)
  fireEvent.click(screen.getByRole('button', { name: 'Mis claves' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Usar esta clave' }))
  expect(screen.getByRole('checkbox', { name: /Usar la clave seleccionada/ })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: /Usar la clave seleccionada/ })).toHaveAccessibleName(/Clave seleccionada · AES-GCM/)
  expect(JSON.stringify(setState.mock.calls)).not.toContain(selectedKey.name)
  fireEvent.click(screen.getByRole('button', { name: 'Mis claves' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Eliminar' }))
  fireEvent.click(screen.getByRole('button', { name: 'Eliminar definitivamente' }))
  await screen.findByText('Entrada eliminada. La limpieza física se procesará automáticamente.')
  fireEvent.click(screen.getByRole('button', { name: 'Cifrado' }))
  expect(screen.queryByRole('checkbox', { name: /Usar la clave seleccionada/ })).not.toBeInTheDocument()
  expect(screen.getByLabelText('Clave AES de 256 bits (Base64)')).toBeEnabled()
  expect(screen.getByText(missingKeyNotice)).toBeVisible()
  expect(setState).toHaveBeenCalledWith({ key_id: '' })
  expect(vi.mocked(libraryRequest).mock.calls.some(([path]) => path.endsWith('/material'))).toBe(false)
})

it.each([404, 503])('reconciles a material read failure with status %s without clearing a temporary failure', async status => {
  mockSelectedKey(async () => { throw new UtilityRequestError('No disponible', status) })
  const setState = renderSelectedKey()
  await screen.findByRole('checkbox', { name: /Usar la clave seleccionada/ })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cifrar' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Cifrar' }))
  if (status === 404) {
    expect(await screen.findByText(missingKeyNotice)).toBeVisible()
    await waitFor(() => expect(setState).toHaveBeenCalledWith({ key_id: '' }))
    expect(screen.queryByRole('checkbox', { name: /Usar la clave seleccionada/ })).not.toBeInTheDocument()
  } else {
    expect(await screen.findByText('No se pudo completar la operación. Puedes reintentar.')).toBeVisible()
    expect(setState).not.toHaveBeenCalledWith({ key_id: '' })
    expect(screen.getByRole('checkbox', { name: /Usar la clave seleccionada/ })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Cifrar' })).toBeEnabled()
  }
})

it('ignores a material 404 from a cipher operation that was already cancelled by newer input', async () => {
  let rejectMaterial!: (error: unknown) => void
  mockSelectedKey(() => new Promise((_, reject) => { rejectMaterial = reject }))
  const setState = renderSelectedKey()
  await screen.findByRole('checkbox', { name: /Usar la clave seleccionada/ })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cifrar' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Cifrar' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Texto para cifrar (UTF-8)' }), { target: { value: 'Entrada posterior' } })
  await act(async () => { rejectMaterial(new UtilityRequestError('Eliminada', 404)) })
  expect(setState).not.toHaveBeenCalledWith({ key_id: '' })
  expect(screen.getByRole('checkbox', { name: /Usar la clave seleccionada/ })).toBeChecked()
  expect(screen.queryByText(missingKeyNotice)).not.toBeInTheDocument()
})

it('reconciles a deleted current vault reference while Hash remains active and keeps saving its preferences', async () => {
  mockSelectedKey()
  const preferences: Record<string, unknown> = { key_id: selectedKey.id, active: 'hash' }
  const setState = vi.fn(patch => Object.assign(preferences, patch))
  const session: UtilityDocumentSession = { documentId: 'synthetic', initialState: { ...preferences }, setState, setSlot: vi.fn(), getSlot: () => undefined, readSlot: async () => null, flush: async () => true }
  render(<UtilityDocumentProvider value={session}><CryptoUtility /></UtilityDocumentProvider>)
  await waitFor(() => expect(libraryRequest).toHaveBeenCalledTimes(1))
  vaultEvent('another-key')
  vaultEvent(selectedKey.id, 'document')
  expect(libraryRequest).toHaveBeenCalledTimes(1)
  vi.mocked(libraryRequest).mockRejectedValueOnce(new UtilityRequestError('Eliminada', 404))
  vaultEvent()
  expect(await screen.findByText(missingKeyNotice)).toBeVisible()
  await waitFor(() => expect(preferences.key_id).toBe(''))
  fireEvent.change(screen.getByRole('combobox', { name: 'Algoritmo' }), { target: { value: 'SHA-512' } })
  await waitFor(() => expect(preferences).toMatchObject({ key_id: '', active: 'hash', hash_algorithm: 'SHA-512' }))
  expect(screen.getByRole('button', { name: 'Hash y HMAC' })).toHaveAttribute('aria-pressed', 'true')
})

it('aborts superseded vault updates, ignores late metadata and preserves selection after a 503', async () => {
  mockSelectedKey()
  const setState = renderSelectedKey()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cifrar' })).toBeEnabled())
  let resolveOld!: (value: unknown) => void
  let resolveNew!: (value: unknown) => void
  vi.mocked(libraryRequest).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  vaultEvent()
  const oldSignal = vi.mocked(libraryRequest).mock.calls.at(-1)![1]!.signal!
  vi.mocked(libraryRequest).mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve }))
  vaultEvent()
  expect(oldSignal.aborted).toBe(true)
  await act(async () => { resolveNew({ item: { ...selectedKey, algorithm: 'AES actualizada' } }) })
  expect(screen.getByRole('checkbox', { name: /AES actualizada/ })).toBeChecked()
  await act(async () => { resolveOld({ item: { ...selectedKey, algorithm: 'Respuesta obsoleta' } }) })
  expect(screen.queryByRole('checkbox', { name: /Respuesta obsoleta/ })).not.toBeInTheDocument()
  vi.mocked(libraryRequest).mockRejectedValueOnce(new UtilityRequestError('Temporal', 503))
  await act(async () => { vaultEvent() })
  expect(screen.getByRole('checkbox', { name: /AES actualizada/ })).toBeChecked()
  expect(setState).not.toHaveBeenCalledWith({ key_id: '' })
  expect(screen.queryByText(missingKeyNotice)).not.toBeInTheDocument()
})

it('cancels a vault refresh when choosing another key and releases its subscription on unmount', async () => {
  const nextKey = { ...selectedKey, id: 'next-key', name: 'Otra clave', algorithm: 'AES segunda' }
  let rejectOld!: (error: unknown) => void
  mockSelectedKey()
  const setState = vi.fn()
  const session: UtilityDocumentSession = { documentId: 'synthetic', initialState: { key_id: selectedKey.id }, setState, setSlot: vi.fn(), getSlot: () => undefined, readSlot: async () => null, flush: async () => true }
  const view = render(<UtilityDocumentProvider value={session}><CryptoUtility /></UtilityDocumentProvider>)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cifrar' })).toBeEnabled())
  vi.mocked(libraryRequest).mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject }))
  vaultEvent()
  const oldSignal = vi.mocked(libraryRequest).mock.calls.at(-1)![1]!.signal!
  vi.mocked(libraryRequest).mockImplementation((path) => Promise.resolve(path === '/vault/status' ? { configured: true } : path.startsWith('/vault?q=') ? { items: [nextKey], has_more: false } : { item: nextKey }) as never)
  fireEvent.click(screen.getByRole('button', { name: 'Mis claves' }))
  fireEvent.click(await screen.findByRole('button', { name: /Otra clave/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Usar esta clave' }))
  await waitFor(() => expect(setState).toHaveBeenCalledWith({ key_id: nextKey.id }))
  expect(oldSignal.aborted).toBe(true)
  await act(async () => { rejectOld(new UtilityRequestError('Eliminada', 404)) })
  expect(screen.getByRole('checkbox', { name: /AES segunda/ })).toBeChecked()
  expect(setState).not.toHaveBeenCalledWith({ key_id: '' })
  vi.mocked(libraryRequest).mockImplementationOnce(() => new Promise(() => {}))
  vaultEvent(nextKey.id)
  const activeSignal = vi.mocked(libraryRequest).mock.calls.at(-1)![1]!.signal!
  view.unmount()
  expect(activeSignal.aborted).toBe(true)
  expect(realtime.listeners.size).toBe(0)
  const callCount = vi.mocked(libraryRequest).mock.calls.length
  vaultEvent(nextKey.id)
  expect(libraryRequest).toHaveBeenCalledTimes(callCount)
})
