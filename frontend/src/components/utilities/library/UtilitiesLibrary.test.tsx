import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UtilitiesLibrary } from './UtilitiesLibrary'
import { libraryRequest, readDocumentSlot, type UtilityDocument } from './libraryApi'

const router = vi.hoisted(() => ({ push: vi.fn() }))
const realtime = vi.hoisted(() => ({ listener: undefined as ((message: unknown) => void) | undefined }))
const editorBehavior = vi.hoisted(() => ({ modelBacked: false }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('@/lib/authScope', () => ({ getAuthScope: () => 'test-scope', subscribeAuthScope: () => () => {} }))
vi.mock('@/lib/api', () => ({ api: vi.fn(), apiBlob: vi.fn(), subscribeWebSocket: (listener: (message: unknown) => void) => { realtime.listener = listener; return () => { realtime.listener = undefined } }, getOnlineSessionTiming: () => null, subscribeOnlineSessionNotice: () => () => {} }))
vi.mock('./libraryApi', async original => ({ ...await original<typeof import('./libraryApi')>(), libraryRequest: vi.fn(), readDocumentSlot: vi.fn() }))
vi.mock('../UtilityWorkspace', async () => {
  const { useUtilityDocumentText, useUtilityDocument } = await import('./UtilityDocumentContext')
  const { useRef, useEffect } = await import('react')
  return { UtilityWorkspace: function MockWorkspace() {
    const [source, setSource] = useUtilityDocumentText('source'), session = useUtilityDocument(), model = useRef(source)
    model.current = source
    useEffect(() => () => { model.current = '' }, [])
    return <textarea aria-label="Test document source" value={source} onChange={event => {
      model.current = event.target.value; setSource(event.target.value)
      if (editorBehavior.modelBacked) session?.setSlot('source', () => model.current)
    }} />
  } }
})
const request = vi.mocked(libraryRequest)
let document: UtilityDocument
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('Blob', NodeBlob); editorBehavior.modelBacked = false
  document = { id: 'document-a', type: 'qr', title: 'Saved QR', folder_id: null, favorite: false, version: 1, config: {}, slots: [{ slot: 'source', bytes: 5, version: 1 }], created_at: '2026-11-14', updated_at: '2026-11-14' }
  vi.mocked(readDocumentSlot).mockResolvedValue(new Blob(['saved'], { type: 'text/plain' }))
  request.mockImplementation(async (path, options): Promise<any> => {
    if (path === '/workspace' && options?.method === 'PUT') { const input = JSON.parse(options.body as string); return { workspace: { open_ids: input.open_ids, active_id: input.active_id, version: 2 } } }
    if (path === '/workspace') return { workspace: { open_ids: ['document-a'], active_id: 'document-a', version: 1 } }
    if (path === '/folders') return { folders: [] }
    if (path.startsWith('/documents?')) return { documents: [document], has_more: false }
    if (path === '/documents/document-a') {
      if (options?.method === 'PATCH') { const { base_version: _, operation_id: __, ...changes } = JSON.parse(options.body as string); document = { ...document, ...changes, version: document.version + 1 } }
      return { document }
    }
    if (options?.method === 'PUT' || path.endsWith('/changes')) {
      document = { ...document, version: document.version + 1, slots: [{ slot: 'source', bytes: 7, version: 2 }] }
      return { document, content: document.slots[0] }
    }
    throw new Error(`Unexpected ${path}`)
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('utility library orchestration', () => {
  it('saves changes at two seconds, never marks them saved before the response', async () => {
    render(<UtilitiesLibrary />)
    const source = await screen.findByRole('textbox', { name: 'Test document source' })
    await waitFor(() => expect(source).toHaveValue('saved'))
    vi.useFakeTimers()
    fireEvent.change(source, { target: { value: 'updated' } })
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Cambios pendientes')
    const writes = () => request.mock.calls.filter(([, options]) => options?.method === 'PUT' || options?.method === 'PATCH')
    await act(async () => { await vi.advanceTimersByTimeAsync(1999) })
    expect(writes()).toHaveLength(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(writes()).toHaveLength(1)
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Guardado')
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('updated')
  })

  it('starts exactly one library search after 500ms and cancels the preceding query', async () => {
    render(<UtilitiesLibrary />)
    await screen.findByRole('textbox', { name: 'Test document source' })
    vi.useFakeTimers()
    const search = screen.getByRole('textbox', { name: 'Buscar documentos por nombre o contenido' })
    fireEvent.change(search, { target: { value: 'first' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(499) })
    expect(request.mock.calls.filter(([path]) => path.includes('q=first'))).toHaveLength(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    const first = request.mock.calls.find(([path]) => path.includes('q=first'))!
    expect(first).toBeTruthy()
    fireEvent.change(search, { target: { value: 'second' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(first[1]!.signal!.aborted).toBe(true)
    expect(request.mock.calls.filter(([path]) => path.includes('q=second'))).toHaveLength(1)
  })

  it('flushes within five seconds even while the user keeps typing', async () => {
    render(<UtilitiesLibrary />)
    const source = await screen.findByRole('textbox', { name: 'Test document source' })
    await waitFor(() => expect(source).toHaveValue('saved'))
    vi.useFakeTimers()
    fireEvent.change(source, { target: { value: 'text 0' } })
    for (let second = 1; second <= 4; second++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      fireEvent.change(source, { target: { value: `text ${second}` } })
    }
    const writes = () => request.mock.calls.filter(([, options]) => options?.method === 'PUT' || options?.method === 'PATCH')
    await act(async () => { await vi.advanceTimersByTimeAsync(999) })
    expect(writes()).toHaveLength(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(writes()).toHaveLength(1)
  })

  it('closing a saved tab keeps its document and sends no DELETE', async () => {
    render(<UtilitiesLibrary />)
    await screen.findByRole('textbox', { name: 'Test document source' })
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar pestaña Saved QR' }))
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Saved QR' })).not.toBeInTheDocument())
    expect(request.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false)
    expect(screen.getByRole('button', { name: /Saved QR.*Códigos QR/ })).toBeInTheDocument()
  })

  it('protects an unsaved draft when the same user deletes the document in another session', async () => {
    render(<UtilitiesLibrary />)
    const source = await screen.findByRole('textbox', { name: 'Test document source' })
    await waitFor(() => expect(source).toHaveValue('saved'))
    vi.useFakeTimers()
    fireEvent.change(source, { target: { value: 'unsaved work' } })
    act(() => realtime.listener?.({ event: 'utility_updated', data: { kind: 'deleted', id: 'document-a' } }))
    expect(source).toHaveValue('unsaved work')
    expect(screen.getByText(/fue eliminado en otra sesión/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Guardar una copia' })).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(request.mock.calls.some(([, options]) => options?.method === 'PATCH' || options?.method === 'PUT')).toBe(false)
  })

  it('disposes memory-only drafts before history caching and restores only the saved server copy', async () => {
    render(<UtilitiesLibrary />)
    const source = await screen.findByRole('textbox', { name: 'Test document source' })
    await waitFor(() => expect(source).toHaveValue('saved'))
    vi.useFakeTimers()
    fireEvent.change(source, { target: { value: 'memory-only secret draft' } })
    await act(async () => {
      const event = new Event('pagehide')
      Object.defineProperty(event, 'persisted', { value: true })
      window.dispatchEvent(event)
      await Promise.resolve(); await Promise.resolve()
    })
    expect(screen.getByRole('textbox', { name: 'Test document source' })).toHaveValue('saved')
    expect(request.mock.calls.some(([, options]) => options?.method === 'PATCH' || options?.method === 'PUT')).toBe(false)
  })

  it('protects pending tab preferences on reload and waits for them before internal navigation', async () => {
    const original = request.getMockImplementation()!
    let finish!: (result: unknown) => void
    request.mockImplementation((path, options): Promise<any> => path === '/workspace' && options?.method === 'PUT'
      ? new Promise(resolve => { finish = resolve }) : original(path, options))
    render(<UtilitiesLibrary />)
    await screen.findByRole('textbox', { name: 'Test document source' })
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar pestaña Saved QR' }))
    await waitFor(() => expect(screen.getByText('Guardando pestañas…')).toBeInTheDocument())
    const before = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(before)
    expect(before.defaultPrevented).toBe(true)
    const link = window.document.createElement('a'); link.href = '/dashboard/contacts'; link.textContent = 'Salir de utilitarios'
    window.document.body.appendChild(link)
    fireEvent.click(link)
    expect(router.push).not.toHaveBeenCalled()
    await act(async () => { finish({ workspace: { open_ids: [], active_id: null, version: 2 } }); await Promise.resolve(); await Promise.resolve() })
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/dashboard/contacts'))
    link.remove()
  })

  it('reconciles a lost workspace acknowledgement without overwriting another window', async () => {
    const original = request.getMockImplementation()!
    let writing = false, puts = 0
    request.mockImplementation((path, options): Promise<any> => {
      if (path === '/workspace' && options?.method === 'PUT') { writing = true; puts++; return Promise.reject(new Error('Connection lost after commit')) }
      if (path === '/workspace' && writing) return Promise.resolve({ workspace: { open_ids: [], active_id: null, version: 2 } })
      return original(path, options)
    })
    render(<UtilitiesLibrary />)
    await screen.findByRole('textbox', { name: 'Test document source' })
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar pestaña Saved QR' }))
    await waitFor(() => expect(puts).toBe(1))
    await waitFor(() => expect(screen.queryByText('Guardando pestañas…')).not.toBeInTheDocument())
    expect(puts).toBe(1)
    expect(screen.queryByRole('button', { name: 'Guardar pestañas de esta ventana' })).not.toBeInTheDocument()
    const before = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(before)
    expect(before.defaultPrevented).toBe(false)
  })

  it('requires a deliberate retry when another window saved different tabs', async () => {
    const original = request.getMockImplementation()!
    let puts = 0
    request.mockImplementation((path, options): Promise<any> => {
      if (path === '/workspace' && options?.method === 'PUT') {
        if (++puts === 1) return Promise.reject(new Error('Connection unavailable'))
        return Promise.resolve({ workspace: { open_ids: [], active_id: null, version: 6 } })
      }
      if (path === '/workspace' && puts) return Promise.resolve({ workspace: { open_ids: ['other-document'], active_id: 'other-document', version: 5 } })
      return original(path, options)
    })
    render(<UtilitiesLibrary />)
    await screen.findByRole('textbox', { name: 'Test document source' })
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar pestaña Saved QR' }))
    const retry = await screen.findByRole('button', { name: 'Guardar pestañas de esta ventana' })
    expect(puts).toBe(1)
    fireEvent.click(retry)
    await waitFor(() => expect(puts).toBe(2))
    const last = request.mock.calls.filter(([path, options]) => path === '/workspace' && options?.method === 'PUT').at(-1)!
    expect(JSON.parse(last[1]!.body as string)).toMatchObject({ open_ids: [], active_id: null, base_version: 5 })
  })

  it.each(['close', 'realtime-delete'])('opens a neighboring tab from complete canonical content after %s, never from a lightweight list row', async action => {
    const original = request.getMockImplementation()!
    const second = { ...document, id: 'document-b', title: 'Saved B' }
    request.mockImplementation((path, options): Promise<any> => {
      if (path === '/workspace' && options?.method !== 'PUT') return Promise.resolve({ workspace: { open_ids: ['document-a', 'document-b'], active_id: 'document-a', version: 1 } })
      if (path === '/documents/document-b') return Promise.resolve({ document: second })
      if (path.startsWith('/documents?')) return Promise.resolve({ documents: [{ ...document, slots: [] }, { ...second, slots: [] }], has_more: false })
      return original(path, options)
    })
    vi.mocked(readDocumentSlot).mockImplementation(async id => new Blob([id === 'document-a' ? 'saved A' : 'saved B'], { type: 'text/plain' }))
    render(<UtilitiesLibrary />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Test document source' })).toHaveValue('saved A'))
    const listReads = () => request.mock.calls.filter(([path]) => path.startsWith('/documents?')).length
    const before = listReads()
    act(() => realtime.listener?.({ event: 'utility_updated', data: { kind: 'folder', id: 'folder-a' } }))
    await waitFor(() => expect(listReads()).toBeGreaterThan(before))
    const readsBefore = request.mock.calls.filter(([path]) => path === '/documents/document-b').length
    if (action === 'close') fireEvent.click(screen.getByRole('button', { name: 'Cerrar pestaña Saved QR' }))
    else act(() => realtime.listener?.({ event: 'utility_updated', data: { kind: 'deleted', id: 'document-a' } }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Test document source' })).toHaveValue('saved B'))
    expect(request.mock.calls.filter(([path]) => path === '/documents/document-b')).toHaveLength(readsBefore + 1)
  })

  it('keeps creation and secondary document actions operational in compact menus', async () => {
    const original = request.getMockImplementation()!
    request.mockImplementation((path, options): Promise<any> => path === '/documents' && options?.method === 'POST'
      ? Promise.resolve({ document: { ...document, id: 'new-document', type: 'qr', title: 'New QR', slots: [] } }) : original(path, options))
    render(<UtilitiesLibrary />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Test document source' })).toHaveValue('saved'))
    fireEvent.click(screen.getByRole('button', { name: 'Acciones del documento' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Añadir a favoritos' }))
    await waitFor(() => expect(request.mock.calls.some(([path, options]) => path === '/documents/document-a' && options?.method === 'PATCH' && JSON.parse(options.body as string).favorite === true)).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo documento' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Códigos QR' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'New QR' })).toBeInTheDocument())
    const created = request.mock.calls.find(([path, options]) => path === '/documents' && options?.method === 'POST')!
    expect(JSON.parse(created[1]!.body as string)).toMatchObject({ type: 'qr', folder_id: null })
  })

  it('adopts the authoritative deletion workspace version without trying to save a deleted draft again', async () => {
    const original = request.getMockImplementation()!
    request.mockImplementation((path, options): Promise<any> => {
      if (path.startsWith('/documents/document-a?version=') && options?.method === 'DELETE') return Promise.resolve({ deleted: true, cleanup_pending: true, workspace: { open_ids: [], active_id: null, version: 2 } })
      return original(path, options)
    })
    render(<UtilitiesLibrary />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Test document source' })).toHaveValue('saved'))
    fireEvent.click(screen.getByRole('button', { name: 'Acciones del documento' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Eliminar documento' }))
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar definitivamente' }))
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Saved QR' })).not.toBeInTheDocument())
    const savedWorkspace = request.mock.calls.find(([path, options]) => path === '/workspace' && options?.method === 'PUT')!
    expect(JSON.parse(savedWorkspace[1]!.body as string).base_version).toBe(2)
    expect(screen.queryByRole('button', { name: 'Guardar pestañas de esta ventana' })).not.toBeInTheDocument()
    expect(request.mock.calls.some(([path, options]) => path.includes('/content/') && options?.method === 'PUT')).toBe(false)
  })

  it('preserves a late model edit while the destination request is pending and refuses duplicate transitions', async () => {
    editorBehavior.modelBacked = true
    const original = request.getMockImplementation()!
    const second = { ...document, id: 'document-b', title: 'Saved B' }
    let defer = false, finish!: (value: unknown) => void, destinationReads = 0, storedA = 'saved'
    request.mockImplementation(async (path, options): Promise<any> => {
      if (path === '/workspace' && options?.method !== 'PUT') return { workspace: { open_ids: ['document-a', 'document-b'], active_id: 'document-a', version: 1 } }
      if (path === '/documents/document-b') { if (defer) { destinationReads++; return new Promise(resolve => { finish = resolve }) } return { document: second } }
      if (path.endsWith('/content/source') && options?.method === 'PUT') storedA = await (options.body as Blob).text()
      return original(path, options)
    })
    vi.mocked(readDocumentSlot).mockImplementation(async id => new Blob([id === 'document-a' ? storedA : 'saved B'], { type: 'text/plain' }))
    render(<UtilitiesLibrary />)
    const source = await screen.findByRole('textbox', { name: 'Test document source' })
    await waitFor(() => expect(source).toHaveValue('saved'))
    defer = true
    fireEvent.click(screen.getByRole('tab', { name: 'Saved B' }))
    await waitFor(() => expect(destinationReads).toBe(1))
    expect(source.closest('[inert]')).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Saved B' }))
    expect(destinationReads).toBe(1)
    // Simulates a late editor/worker callback even though real user input is inert.
    fireEvent.change(source, { target: { value: 'late edit that must survive disposal' } })
    await act(async () => { defer = false; finish({ document: second }); await Promise.resolve(); await Promise.resolve() })
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Test document source' })).toHaveValue('saved B'))
    expect(storedA).toBe('late edit that must survive disposal')
    fireEvent.click(screen.getByRole('tab', { name: 'Saved QR' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Test document source' })).toHaveValue('late edit that must survive disposal'))
  })
})
