import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UtilitiesLibrary } from './UtilitiesLibrary'
import { libraryRequest, readDocumentSlot, UtilityRequestError, type UtilityDocument } from './libraryApi'

const router = vi.hoisted(() => ({ push: vi.fn() }))
const realtime = vi.hoisted(() => ({ listener: undefined as ((message: unknown) => void) | undefined }))
const editorBehavior = vi.hoisted(() => ({ modelBacked: false, dirtyOnDeactivate: false, setState: undefined as ((state: Record<string, unknown>) => void) | undefined }))
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
    useEffect(() => { editorBehavior.setState = session?.setState; return () => { editorBehavior.setState = undefined } }, [session])
    useEffect(() => session?.registerBeforeDeactivate?.(() => { if (editorBehavior.dirtyOnDeactivate) session.setState({ rememberedView: true }) }), [session])
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
  vi.clearAllMocks(); vi.stubGlobal('Blob', NodeBlob); editorBehavior.modelBacked = false; editorBehavior.dirtyOnDeactivate = false; editorBehavior.setState = undefined
  document = { id: 'document-a', type: 'qr', title: 'Saved QR', folder_id: null, favorite: false, version: 1, config: {}, slots: [{ slot: 'source', bytes: 5, version: 1 }], created_at: '2026-11-14', updated_at: '2026-11-14' }
  vi.mocked(readDocumentSlot).mockResolvedValue({ blob: new Blob(['saved'], { type: 'text/plain' }), version: 1 })
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
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('utility library orchestration', () => {
  it('uses one save command for Ctrl/Cmd+S and the visible button without opening browser save or duplicating an in-flight write', async () => {
    const original = request.getMockImplementation()!
    let finish!: (result: unknown) => void
    request.mockImplementation((path, options): Promise<any> => path.endsWith('/content/source') && options?.method === 'PUT'
      ? new Promise(resolve => { finish = resolve }) : original(path, options))
    render(<UtilitiesLibrary />)
    const source = await screen.findByRole('textbox', { name: 'Test document source' })
    await waitFor(() => expect(source).toHaveValue('saved'))
    fireEvent.change(source, { target: { value: 'save now' } })
    const input = source as HTMLTextAreaElement
    input.focus(); input.setSelectionRange(2, 4); input.scrollTop = 18
    const status = screen.getByRole('button', { name: 'Estado del guardado' })
    const statusWidth = status.style.width
    expect(fireEvent.keyDown(source, { key: 's', ctrlKey: true })).toBe(false)
    await waitFor(() => expect(request.mock.calls.filter(([path, options]) => path.endsWith('/content/source') && options?.method === 'PUT')).toHaveLength(1))
    expect(fireEvent.keyDown(source, { key: 's', metaKey: true })).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Guardar documento' }))
    expect(request.mock.calls.filter(([path, options]) => path.endsWith('/content/source') && options?.method === 'PUT')).toHaveLength(1)
    await act(async () => { finish({ document: { ...document, slots: [{ slot: 'source', bytes: 8, version: 2 }] }, content: { slot: 'source', bytes: 8, version: 2 } }); await Promise.resolve() })
    const confirmation = await screen.findByText('Documento guardado.')
    expect(confirmation.closest('[data-utility-workspace-header]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Cerrar confirmación' })).not.toBeInTheDocument()
    expect(status.style.width).toBe(statusWidth)
    expect(input).toHaveFocus()
    expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(4)
    expect(input.scrollTop).toBe(18)
    fireEvent.click(screen.getByRole('button', { name: 'Guardar documento' }))
    expect(request.mock.calls.filter(([path, options]) => path.endsWith('/content/source') && options?.method === 'PUT')).toHaveLength(1)
    const outside = window.document.createElement('textarea'); window.document.body.appendChild(outside)
    expect(fireEvent.keyDown(outside, { key: 's', ctrlKey: true })).toBe(true)
    outside.remove()
    expect(source).toHaveValue('save now')
    fireEvent.change(source, { target: { value: 'new pending edit' } })
    expect(screen.queryByText('Documento guardado.')).not.toBeInTheDocument()
  })

  it('restarts the two-second header confirmation on repeated saves and releases its timer on unmount', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, top: 0, right: 1200, bottom: 650, width: 1200, height: 650, x: 0, y: 0, toJSON: () => ({}) }))
    const { unmount } = render(<UtilitiesLibrary />)
    const source = await screen.findByRole('textbox', { name: 'Test document source' })
    await waitFor(() => expect(source).toHaveValue('saved'))
    const status = screen.getByRole('button', { name: 'Estado del guardado' })
    expect(status).toHaveStyle({ width: '160px' })
    vi.useFakeTimers()
    await act(async () => { fireEvent.keyDown(source, { key: 's', ctrlKey: true }); await vi.advanceTimersByTimeAsync(0) })
    expect(status).toHaveAttribute('title', 'Documento guardado.')
    await act(async () => { await vi.advanceTimersByTimeAsync(1999) })
    expect(status).toHaveAttribute('title', 'Documento guardado.')
    await act(async () => { fireEvent.keyDown(source, { key: 's', metaKey: true }); await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1999) })
    expect(status).toHaveAttribute('title', 'Documento guardado.')
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(status).toHaveAttribute('title', 'Guardado')
    expect(status).toHaveStyle({ width: '160px' })
    expect(request.mock.calls.some(([, options]) => options?.method === 'PUT' || options?.method === 'PATCH')).toBe(false)
    await act(async () => { fireEvent.keyDown(source, { key: 's', ctrlKey: true }); await vi.advanceTimersByTimeAsync(0) })
    expect(status).toHaveAttribute('title', 'Documento guardado.')
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the confirmation when changing documents and cannot revive it when returning', async () => {
    const original = request.getMockImplementation()!
    const second = { ...document, id: 'document-b', title: 'Saved B' }
    request.mockImplementation((path, options): Promise<any> => {
      if (path === '/workspace' && options?.method !== 'PUT') return Promise.resolve({ workspace: { open_ids: ['document-a', 'document-b'], active_id: 'document-a', version: 1 } })
      if (path === '/documents/document-b') return Promise.resolve({ document: second })
      return original(path, options)
    })
    vi.mocked(readDocumentSlot).mockImplementation(async id => ({ blob: new Blob([id === 'document-a' ? 'saved A' : 'saved B'], { type: 'text/plain' }), version: 1 }))
    render(<UtilitiesLibrary />)
    const source = await screen.findByRole('textbox', { name: 'Test document source' })
    await waitFor(() => expect(source).toHaveValue('saved A'))
    const status = screen.getByRole('button', { name: 'Estado del guardado' })
    expect(status).toHaveStyle({ width: 'var(--utility-control-size)' })
    vi.useFakeTimers()
    await act(async () => { fireEvent.keyDown(source, { key: 's', ctrlKey: true }); await vi.advanceTimersByTimeAsync(0) })
    expect(status).toHaveAttribute('title', 'Documento guardado.')
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    for (const [title, text] of [['Saved B', 'saved B'], ['Saved QR', 'saved A'], ['Saved B', 'saved B']]) {
      await act(async () => { fireEvent.click(screen.getByRole('tab', { name: title })); await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByRole('textbox', { name: 'Test document source' })).toHaveValue(text)
      expect(status).toHaveAttribute('title', 'Guardado')
    }
    await act(async () => { fireEvent.keyDown(screen.getByRole('textbox', { name: 'Test document source' }), { key: 's', ctrlKey: true }); await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(status).toHaveAttribute('title', 'Documento guardado.')
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(status).toHaveAttribute('title', 'Guardado')
    expect(status).toHaveStyle({ width: 'var(--utility-control-size)' })
  })

  it('keeps the general document notice independent from manual save confirmations and their expiry', async () => {
    render(<UtilitiesLibrary />)
    const source = await screen.findByRole('textbox', { name: 'Test document source' })
    await waitFor(() => expect(source).toHaveValue('saved'))
    act(() => realtime.listener?.({ event: 'utility_updated', data: { kind: 'deleted', id: 'already-closed-document' } }))
    const notice = await screen.findByText('El documento fue eliminado en otra sesión.')
    const status = screen.getByRole('button', { name: 'Estado del guardado' })
    await waitFor(() => expect(status).toHaveAttribute('title', 'Guardado'))
    vi.useFakeTimers()
    await act(async () => { fireEvent.keyDown(source, { key: 's', ctrlKey: true }); await vi.advanceTimersByTimeAsync(0) })
    expect(status).toHaveAttribute('title', 'Documento guardado.')
    expect(notice).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(status).toHaveAttribute('title', 'Guardado')
    expect(notice).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar confirmación' }))
    expect(notice).not.toBeInTheDocument()
  })

  it.each([{ code: 409, label: 'Conflicto de versión' }, { code: 503, label: 'No se pudo guardar' }])('does not retain a success confirmation after an edited draft fails with $code', async ({ code, label }) => {
    const original = request.getMockImplementation()!
    request.mockImplementation((path, options): Promise<any> => path.endsWith('/content/source') && options?.method === 'PUT'
      ? Promise.reject(new UtilityRequestError('El guardado falló', code)) : original(path, options))
    render(<UtilitiesLibrary />)
    const source = await screen.findByRole('textbox', { name: 'Test document source' })
    await waitFor(() => expect(source).toHaveValue('saved'))
    fireEvent.keyDown(source, { key: 's', ctrlKey: true })
    await screen.findByText('Documento guardado.')
    fireEvent.change(source, { target: { value: 'preserve this draft' } })
    expect(screen.queryByText('Documento guardado.')).not.toBeInTheDocument()
    fireEvent.keyDown(source, { key: 's', ctrlKey: true })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Estado del guardado' })).toHaveAttribute('title', label))
    expect(screen.queryByText('Documento guardado.')).not.toBeInTheDocument()
    expect(source).toHaveValue('preserve this draft')
    expect(screen.getByRole('button', { name: 'Guardar una copia' })).toBeInTheDocument()
  })

  it('renames a closed library row without opening it or reading its content', async () => {
    const original = request.getMockImplementation()!
    let closed = { ...document, id: 'closed', title: 'Closed document', slots: [] }
    request.mockImplementation((path, options): Promise<any> => {
      if (path.startsWith('/documents?')) return Promise.resolve({ documents: [document, closed], has_more: false })
      if (path === '/documents/closed' && options?.method === 'PATCH') { closed = { ...closed, title: JSON.parse(options.body as string).title, version: 2 }; return Promise.resolve({ document: closed }) }
      return original(path, options)
    })
    render(<UtilitiesLibrary />)
    const source = await screen.findByRole('textbox', { name: 'Test document source' })
    await waitFor(() => expect(source).toHaveValue('saved'))
    fireEvent.click(screen.getByRole('button', { name: 'Abrir biblioteca' }))
    fireEvent.click(screen.getByRole('button', { name: 'Acciones de Closed document' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Renombrar documento' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Nombre' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Renombrar documento' })).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Mis documentos' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Acciones de Closed document' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Acciones de Closed document' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Renombrar documento' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Nombre' }), { target: { value: 'Renamed without opening' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    await screen.findByRole('button', { name: 'Acciones de Renamed without opening' })
    expect(screen.getByRole('textbox', { name: 'Test document source' })).toBe(source)
    expect(source).toHaveValue('saved')
    expect(screen.queryByRole('tab', { name: 'Renamed without opening' })).not.toBeInTheDocument()
    expect(request.mock.calls.filter(([path]) => path === '/documents/closed')).toHaveLength(1)
    expect(vi.mocked(readDocumentSlot).mock.calls.every(([id]) => id === 'document-a')).toBe(true)
  })

  it('requires confirmation to delete a closed row and preserves the active draft', async () => {
    const original = request.getMockImplementation()!
    const closed = { ...document, id: 'closed', title: 'Closed document', slots: [] }
    let deleted = false
    request.mockImplementation((path, options): Promise<any> => {
      if (path.startsWith('/documents?')) return Promise.resolve({ documents: deleted ? [document] : [document, closed], has_more: false })
      if (path.startsWith('/documents/closed?version=') && options?.method === 'DELETE') { deleted = true; return Promise.resolve({ deleted: true, cleanup_pending: true, workspace: { open_ids: ['document-a'], active_id: 'document-a', version: 2 } }) }
      return original(path, options)
    })
    render(<UtilitiesLibrary />)
    const source = await screen.findByRole('textbox', { name: 'Test document source' })
    await waitFor(() => expect(source).toHaveValue('saved'))
    fireEvent.change(source, { target: { value: 'active unsaved work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Abrir biblioteca' }))
    fireEvent.click(screen.getByRole('button', { name: 'Acciones de Closed document' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Eliminar documento' }))
    expect(deleted).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar definitivamente' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Acciones de Closed document' })).not.toBeInTheDocument())
    expect(source).toHaveValue('active unsaved work')
    expect(request.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(1)
    expect(vi.mocked(readDocumentSlot).mock.calls.every(([id]) => id === 'document-a')).toBe(true)
  })

  it('replays an uncertain metadata acknowledgement before applying a revised name', async () => {
    const original = request.getMockImplementation()!
    const writes: string[] = []
    request.mockImplementation(async (path, options): Promise<any> => {
      if (path === '/documents/document-a' && options?.method === 'PATCH') {
        writes.push(options.body as string)
        if (writes.length === 1) throw new UtilityRequestError('Conexión interrumpida')
      }
      return original(path, options)
    })
    render(<UtilitiesLibrary />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Test document source' })).toHaveValue('saved'))
    fireEvent.click(screen.getByRole('button', { name: 'Acciones del documento' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Renombrar documento' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Nombre' }), { target: { value: 'First name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar' })).toBeEnabled())
    expect(screen.getByRole('dialog', { name: 'Renombrar documento' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Nombre' }), { target: { value: 'Revised name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    await screen.findByRole('tab', { name: 'Revised name' })
    expect(writes).toHaveLength(3)
    expect(writes[1]).toBe(writes[0])
    expect(JSON.parse(writes[2])).toMatchObject({ base_version: 2, title: 'Revised name' })
    expect(JSON.parse(writes[2]).operation_id).not.toBe(JSON.parse(writes[0]).operation_id)
  })

  it('reconciles a committed rename with a lost acknowledgement before autosaving newer configuration', async () => {
    const original = request.getMockImplementation()!
    let committed: unknown
    let renameBody: string | undefined
    const writes: { title?: string; config?: Record<string, unknown>; base_version: number; operation_id: string }[] = []
    request.mockImplementation(async (path, options): Promise<any> => {
      if (path !== '/documents/document-a' || options?.method !== 'PATCH') return original(path, options)
      const input = JSON.parse(options.body as string)
      writes.push(input)
      if (input.title) {
        if (committed) { expect(options.body).toBe(renameBody); return committed }
        renameBody = options.body as string
        committed = await original(path, options)
        throw new UtilityRequestError('Se perdió la confirmación del guardado.')
      }
      expect(input.base_version).toBe(2)
      return original(path, options)
    })
    render(<UtilitiesLibrary />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Test document source' })).toHaveValue('saved'))
    fireEvent.click(screen.getByRole('button', { name: 'Acciones del documento' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Renombrar documento' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Nombre' }), { target: { value: 'Committed rename' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    const beforeRetry = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(beforeRetry)
    expect(beforeRetry.defaultPrevented).toBe(true)
    vi.useFakeTimers()
    act(() => editorBehavior.setState?.({ wordWrap: true }))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(writes).toHaveLength(3)
    expect(writes[1]).toEqual(writes[0])
    expect(writes[2]).toMatchObject({ base_version: 2, config: { wordWrap: true } })
    expect(document.title).toBe('Committed rename')
    expect(screen.queryByText('Conflicto de versión')).not.toBeInTheDocument()
  })

  it.each(['retry', 'shortcut'])('replays an uncertain metadata-only mutation without fetching an older snapshot on %s', async action => {
    const original = request.getMockImplementation()!
    let first = true
    const writes: string[] = []
    request.mockImplementation(async (path, options): Promise<any> => {
      if (path === '/documents/document-a' && options?.method === 'PATCH') {
        writes.push(options.body as string)
        if (first) { first = false; throw new UtilityRequestError('Confirmación pendiente de conexión.') }
      }
      return original(path, options)
    })
    render(<UtilitiesLibrary />)
    const source = await screen.findByRole('textbox', { name: 'Test document source' })
    await waitFor(() => expect(source).toHaveValue('saved'))
    fireEvent.click(screen.getByRole('button', { name: 'Acciones del documento' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Renombrar documento' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Nombre' }), { target: { value: 'Confirmed retry title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    const readsBefore = request.mock.calls.filter(([path, options]) => path === '/documents/document-a' && !options?.method).length
    if (action === 'retry') fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    else fireEvent.keyDown(source, { key: 's', ctrlKey: true })
    await screen.findByRole('tab', { name: 'Confirmed retry title' })
    expect(request.mock.calls.filter(([path, options]) => path === '/documents/document-a' && !options?.method)).toHaveLength(readsBefore)
    expect(writes).toHaveLength(2)
    expect(writes[1]).toBe(writes[0])
    expect(screen.getByRole('textbox', { name: 'Test document source' })).toBe(source)
    await waitFor(() => {
      const afterRetry = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(afterRetry)
      expect(afterRetry.defaultPrevented).toBe(false)
    })
  })

  it('flushes view state captured by deactivation before fetching a canonical read-retry snapshot', async () => {
    const original = request.getMockImplementation()!
    const sequence: string[] = []
    vi.mocked(readDocumentSlot).mockRejectedValueOnce(new UtilityRequestError('No se pudo leer el contenido.', 503))
    request.mockImplementation(async (path, options): Promise<any> => {
      if (path === '/documents/document-a' && options?.method === 'PATCH') {
        const result = await original(path, options)
        sequence.push(`patch:${document.version}`)
        return result
      }
      if (path === '/documents/document-a' && !options?.method) sequence.push(`get:${document.version}`)
      return original(path, options)
    })
    render(<UtilitiesLibrary />)
    await screen.findByRole('button', { name: 'Reintentar' })
    sequence.length = 0
    editorBehavior.dirtyOnDeactivate = true
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Test document source' })).toHaveValue('saved'))
    expect(sequence).toEqual(['patch:2', 'get:2'])
    expect(document.config).toMatchObject({ rememberedView: true })
  })

  it.each([false, true])('keeps the conflict draft protected while copying before a canonical reload (reload fails: %s)', async reloadFails => {
    const original = request.getMockImplementation()!
    const copy = { ...document, id: 'copy', title: 'Saved QR · copia', slots: [] as UtilityDocument['slots'] }
    let copySaved = false
    const sequence: string[] = []
    request.mockImplementation(async (path, options): Promise<any> => {
      if (path === '/documents' && options?.method === 'POST') return { document: copy }
      if (path === '/documents/document-a/content/source' && options?.method === 'PUT') throw new UtilityRequestError('Existe otra versión guardada.', 409)
      if (path === '/documents/copy/content/source' && options?.method === 'PUT') {
        expect(await (options.body as Blob).text()).toBe('protected local draft')
        sequence.push('copy-saved'); copySaved = true
        return { document: { ...copy, slots: [{ slot: 'source', version: 1, bytes: 21 }] }, content: { slot: 'source', version: 1, bytes: 21 } }
      }
      if (path === '/documents/document-a' && copySaved) {
        sequence.push('canonical-read')
        if (reloadFails) throw new UtilityRequestError('La conexión no permite cargar la versión guardada.', 503)
      }
      return original(path, options)
    })
    render(<UtilitiesLibrary />)
    const source = await screen.findByRole('textbox', { name: 'Test document source' })
    await waitFor(() => expect(source).toHaveValue('saved'))
    fireEvent.change(source, { target: { value: 'protected local draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar documento' }))
    await screen.findByRole('button', { name: 'Guardar copia y cargar versión guardada' })
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar copia y cargar versión guardada' }))
    await waitFor(() => expect(sequence).toEqual(['copy-saved', 'canonical-read']))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar documento' })).toBeEnabled())
    if (reloadFails) {
      expect(screen.getByRole('textbox', { name: 'Test document source' })).toHaveValue('protected local draft')
      expect(screen.getByRole('tab', { name: 'Saved QR · copia' })).toBeInTheDocument()
      expect(screen.getByText(/La copia está guardada y disponible/)).toBeInTheDocument()
    }
    else {
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Test document source' })).toHaveValue('saved'))
      expect(screen.getByRole('tab', { name: 'Saved QR · copia' })).toBeInTheDocument()
    }
  })

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
    fireEvent.click(screen.getByRole('button', { name: 'Abrir biblioteca' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Abrir biblioteca' }))
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
    vi.mocked(readDocumentSlot).mockImplementation(async id => ({ blob: new Blob([id === 'document-a' ? 'saved A' : 'saved B'], { type: 'text/plain' }), version: 1 }))
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

  it('keeps one editor mounted while docking, overlaying and closing the library', async () => {
    let width = 1200
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, top: 0, right: width, bottom: 650, width, height: 650, x: 0, y: 0, toJSON: () => ({}) }))
    render(<UtilitiesLibrary />)
    const source = await screen.findByRole('textbox', { name: 'Test document source' })
    await waitFor(() => expect(source).toHaveValue('saved'))
    fireEvent.change(source, { target: { value: 'unchanged while resizing the shelves' } })
    expect(screen.queryByRole('complementary', { name: 'Mis documentos' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Abrir biblioteca' }))
    expect(screen.getByRole('complementary', { name: 'Mis documentos' })).toHaveStyle({ width: '224px' })
    expect(screen.getByLabelText('Biblioteca personal de Utilitarios')).toHaveAttribute('data-library-layout', 'wide')
    expect(screen.getByRole('textbox', { name: 'Test document source' })).toBe(source)
    fireEvent.click(screen.getByRole('button', { name: /Saved QR.*Códigos QR/ }))
    expect(screen.getByRole('complementary', { name: 'Mis documentos' })).toBeInTheDocument()
    const dockedSearch = screen.getByRole('textbox', { name: 'Buscar documentos por nombre o contenido' }) as HTMLInputElement
    fireEvent.change(dockedSearch, { target: { value: 'Saved' } })
    dockedSearch.focus(); dockedSearch.setSelectionRange(1, 3)
    width = 900
    act(() => window.dispatchEvent(new Event('resize')))
    expect(window.document.querySelector('[data-utility-library-overlay]')?.parentElement).toBe(window.document.body)
    expect(source.closest('[inert]')).not.toBeNull()
    const overlaySearch = screen.getByRole('textbox', { name: 'Buscar documentos por nombre o contenido' }) as HTMLInputElement
    expect(overlaySearch).toHaveFocus()
    expect(overlaySearch.selectionStart).toBe(1); expect(overlaySearch.selectionEnd).toBe(3)
    width = 1200
    act(() => window.dispatchEvent(new Event('resize')))
    const restoredSearch = screen.getByRole('textbox', { name: 'Buscar documentos por nombre o contenido' }) as HTMLInputElement
    expect(restoredSearch).toHaveFocus()
    expect(restoredSearch.selectionStart).toBe(1); expect(restoredSearch.selectionEnd).toBe(3)
    width = 900
    act(() => window.dispatchEvent(new Event('resize')))
    fireEvent.keyDown(window.document, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: 'Mis documentos' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Test document source' })).toBe(source)
    expect(source).toHaveValue('unchanged while resizing the shelves')
    expect(source.closest('[inert]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Abrir biblioteca' })).toHaveFocus()
    expect(window.document.querySelectorAll('[data-utility-workspace-header]')).toHaveLength(1)
  })

  it('gives only the focused library overlay one Escape owner ahead of underlying global panels', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, top: 0, right: 900, bottom: 650, width: 900, height: 650, x: 0, y: 0, toJSON: () => ({}) }))
    const underlyingEscape = vi.fn()
    window.document.addEventListener('keydown', underlyingEscape)
    const outside = window.document.createElement('button')
    outside.textContent = 'Underlying panel'
    window.document.body.append(outside)
    try {
      render(<UtilitiesLibrary />)
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Test document source' })).toHaveValue('saved'))
      for (const focus of ['search', 'header']) {
        fireEvent.click(screen.getByRole('button', { name: 'Abrir biblioteca' }))
        const target = focus === 'search' ? screen.getByRole('textbox', { name: 'Buscar documentos por nombre o contenido' }) : screen.getByRole('button', { name: 'Cerrar biblioteca' })
        target.focus()
        expect(fireEvent.keyDown(target, { key: 'Escape' })).toBe(false)
        expect(screen.queryByRole('complementary', { name: 'Mis documentos' })).not.toBeInTheDocument()
        expect(underlyingEscape).not.toHaveBeenCalled()
        expect(screen.getByRole('button', { name: 'Abrir biblioteca' })).toHaveFocus()
      }
      fireEvent.click(screen.getByRole('button', { name: 'Abrir biblioteca' }))
      outside.focus()
      expect(fireEvent.keyDown(outside, { key: 'Escape' })).toBe(true)
      expect(underlyingEscape).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('complementary', { name: 'Mis documentos' })).toBeInTheDocument()
      underlyingEscape.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'Acciones de Saved QR' }))
      const renameAction = screen.getByRole('menuitem', { name: 'Renombrar documento' })
      renameAction.focus()
      fireEvent.keyDown(renameAction, { key: 'Escape' })
      expect(screen.queryByRole('menu', { name: 'Acciones de Saved QR' })).not.toBeInTheDocument()
      expect(screen.getByRole('complementary', { name: 'Mis documentos' })).toBeInTheDocument()
      expect(underlyingEscape).not.toHaveBeenCalled()
    } finally {
      window.document.removeEventListener('keydown', underlyingEscape)
      outside.remove()
    }
  })

  it('opens complete save details and filters through portals while Escape keeps the underlying library available', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    render(<UtilitiesLibrary />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Test document source' })).toHaveValue('saved'))
    const status = screen.getByRole('button', { name: 'Estado del guardado' })
    status.focus(); fireEvent.click(status)
    expect(screen.getByRole('dialog', { name: 'Estado del documento y las pestañas' }).parentElement).toBe(window.document.body)
    expect(screen.getByText('Pestañas confirmadas en el servidor.')).toBeInTheDocument()
    fireEvent.keyDown(window.document, { key: 'Escape' })
    expect(status).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Abrir biblioteca' }))
    const filter = screen.getByRole('button', { name: 'Filtrar documentos' })
    filter.focus(); fireEvent.click(filter)
    expect(screen.getByRole('dialog', { name: 'Filtros de documentos' }).parentElement).toBe(window.document.body)
    fireEvent.change(screen.getByRole('combobox', { name: 'Filtrar por tipo' }), { target: { value: 'json' } })
    await waitFor(() => expect(request.mock.calls.some(([path]) => path.includes('type=json'))).toBe(true))
    fireEvent.keyDown(window.document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Filtros de documentos' })).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Mis documentos' })).toBeInTheDocument()
    fireEvent.keyDown(window.document, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: 'Mis documentos' })).not.toBeInTheDocument()
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
    vi.mocked(readDocumentSlot).mockImplementation(async id => ({ blob: new Blob([id === 'document-a' ? storedA : 'saved B'], { type: 'text/plain' }), version: id === 'document-a' ? document.slots[0].version : 1 }))
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
