import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiBlob, apiDelete, apiGet, apiPost, apiPut } from '@/lib/api'
import type { TaskAttachment, TaskAttachmentComment, TaskAttachmentPreview } from '@/types/task'
import TaskAttachmentViewer from './TaskAttachmentViewer'

vi.mock('@/lib/api', () => ({
  apiBlob: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  subscribeWebSocket: vi.fn(() => () => undefined),
}))

vi.mock('./TaskUserCombobox', () => ({
  default: () => <div data-testid="user-combobox" />,
}))

const pdfRuntime = vi.hoisted(() => ({ load: vi.fn() }))

vi.mock('./taskPdfRuntime', () => ({
  loadTaskPdfRuntime: pdfRuntime.load,
}))

const mockedApiGet = vi.mocked(apiGet)
const mockedApiBlob = vi.mocked(apiBlob)
const mockedApiPost = vi.mocked(apiPost)
const mockedApiPut = vi.mocked(apiPut)
const mockedApiDelete = vi.mocked(apiDelete)

function attachment(id: string): TaskAttachment {
  return {
    id,
    account_id: 'account-1',
    task_id: `task-${id}`,
    media_asset_id: `asset-${id}`,
    filename: `${id}.pdf`,
    content_type: 'application/pdf',
    media_type: 'document',
    size_bytes: 128,
    url: `/api/tasks/task-${id}/attachments/${id}/download`,
    created_at: '2026-07-31T00:00:00Z',
  }
}

function preview(attachmentId: string, kind: TaskAttachmentPreview['kind'], status: TaskAttachmentPreview['status']): TaskAttachmentPreview {
  return {
    id: `preview-${attachmentId}`,
    account_id: 'account-1',
    task_id: `task-${attachmentId}`,
    attachment_id: attachmentId,
    kind,
    status,
    url: status === 'ready' ? `/api/tasks/task-${attachmentId}/attachments/${attachmentId}/preview/download` : undefined,
    page_count: 0,
    version: 1,
    created_at: '2026-07-31T00:00:00Z',
    updated_at: '2026-07-31T00:00:00Z',
  }
}

function anchoredComment(attachmentId: string): TaskAttachmentComment {
  return {
    id: `comment-${attachmentId}`,
    account_id: 'account-1',
    task_id: `task-${attachmentId}`,
    attachment_id: attachmentId,
    author_id: 'user-1',
    author_name: 'Ricardo',
    body: 'Punto importante',
    anchor: { kind: 'pdf', page: 1, x: .4, y: .6 },
    version: 1,
    created_at: '2026-07-31T00:00:00Z',
    updated_at: '2026-07-31T00:00:00Z',
    can_edit: true,
    can_delete: true,
    can_resolve: true,
    mentions: [],
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('TaskAttachmentViewer session lifecycle', () => {
  it('aborts every request from the previous task and never renders its stale preview', async () => {
    const oldSignals: AbortSignal[] = []
    mockedApiGet.mockImplementation((endpoint, options) => {
      if (endpoint.includes('/task-old/')) {
        if (options?.signal) oldSignals.push(options.signal)
        return new Promise(() => undefined)
      }
      if (endpoint.endsWith('/preview')) {
        return Promise.resolve({ success: true, data: { preview: preview('new', 'unsupported', 'unsupported') } })
      }
      return Promise.resolve({ success: true, data: { comments: [] } })
    })

    const view = render(<TaskAttachmentViewer taskId="task-old" attachment={attachment('old')} users={[]} onClose={vi.fn()} />)
    await waitFor(() => expect(oldSignals).toHaveLength(2))

    view.rerender(<TaskAttachmentViewer taskId="task-new" attachment={attachment('new')} users={[]} onClose={vi.fn()} />)

    await screen.findByText('Este formato no tiene vista previa')
    expect(oldSignals.every(signal => signal.aborted)).toBe(true)
    expect(screen.queryByText('old.pdf')).not.toBeInTheDocument()
    expect(screen.getByText('new.pdf')).toBeInTheDocument()
  })

  it('turns a direct preview that exceeds 30 seconds into a recoverable error', async () => {
    vi.useFakeTimers()
    const blobSignals: AbortSignal[] = []
    mockedApiGet.mockImplementation(endpoint => endpoint.endsWith('/preview')
      ? Promise.resolve({ success: true, data: { preview: preview('slow', 'pdf', 'ready') } })
      : Promise.resolve({ success: true, data: { comments: [] } }))
    mockedApiBlob.mockImplementation((_endpoint, options) => {
      if (options?.signal) blobSignals.push(options.signal)
      return new Promise(() => undefined)
    })

    render(<TaskAttachmentViewer taskId="task-slow" attachment={attachment('slow')} users={[]} onClose={vi.fn()} />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })

    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos abrir la vista previa')
    expect(screen.getByRole('alert')).toHaveTextContent('tardó demasiado')
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeEnabled()
    expect(screen.getByRole('link', { name: 'Descargar original' })).toHaveAttribute('href', '/api/tasks/task-slow/attachments/slow/download')
    expect(blobSignals).toHaveLength(1)
    expect(blobSignals[0].aborted).toBe(true)
  })

  it('starts the 30 second deadline before preview metadata returns', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    mockedApiGet.mockImplementation((_endpoint, options) => {
      if (options?.signal) signals.push(options.signal)
      return new Promise(() => undefined)
    })

    render(<TaskAttachmentViewer taskId="task-metadata" attachment={attachment('metadata')} users={[]} onClose={vi.fn()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })

    expect(screen.getByRole('alert')).toHaveTextContent('tardó demasiado')
    expect(signals).toHaveLength(2)
    expect(signals.every(signal => signal.aborted)).toBe(true)
  })

  it('restarts the 8 and 30 second deadlines when a ready PDF changes page', async () => {
    vi.useFakeTimers()
    const stalledRender = { promise: new Promise<void>(() => undefined), cancel: vi.fn() }
    const pdfPage = {
      getViewport: vi.fn(() => ({ width: 120, height: 160 })),
      render: vi.fn()
        .mockReturnValueOnce({ promise: Promise.resolve(), cancel: vi.fn() })
        .mockReturnValueOnce(stalledRender),
    }
    const documentProxy = {
      numPages: 2,
      getPage: vi.fn().mockResolvedValue(pdfPage),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    pdfRuntime.load.mockResolvedValue({
      getDocument: vi.fn(() => ({
        promise: Promise.resolve(documentProxy),
        destroy: vi.fn().mockResolvedValue(undefined),
      })),
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
    mockedApiGet.mockImplementation(endpoint => endpoint.endsWith('/preview')
      ? Promise.resolve({ success: true, data: { preview: preview('pages', 'pdf', 'ready') } })
      : Promise.resolve({ success: true, data: { comments: [] } }))
    mockedApiBlob.mockResolvedValue({
      success: true,
      blob: { arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) } as Blob,
    })

    render(<TaskAttachmentViewer taskId="task-pages" attachment={attachment('pages')} users={[]} onClose={vi.fn()} />)
    await act(async () => {
      for (let index = 0; index < 12; index++) await Promise.resolve()
    })
    expect(screen.getByText('Página 1 de 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' }))
    await act(async () => {
      for (let index = 0; index < 4; index++) await Promise.resolve()
    })
    expect(documentProxy.getPage).toHaveBeenLastCalledWith(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(7_999) })
    expect(screen.queryByText('Está tardando más de lo habitual. Puedes seguir esperando o descargar el original.')).not.toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(screen.getByText('Está tardando más de lo habitual. Puedes seguir esperando o descargar el original.')).toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(22_000) })
    expect(screen.getByRole('alert')).toHaveTextContent('La página tardó demasiado en renderizarse')
    expect(stalledRender.cancel).toHaveBeenCalledTimes(1)
  })

  it('does not let a late TXT decode overwrite the next attachment session', async () => {
    let resolveText!: (value: string) => void
    mockedApiGet.mockImplementation(endpoint => {
      if (endpoint.includes('/task-text/') && endpoint.endsWith('/preview')) return Promise.resolve({ success: true, data: { preview: preview('text', 'text', 'ready') } })
      if (endpoint.includes('/task-next/') && endpoint.endsWith('/preview')) return Promise.resolve({ success: true, data: { preview: preview('next', 'unsupported', 'unsupported') } })
      return Promise.resolve({ success: true, data: { comments: [] } })
    })
    mockedApiBlob.mockResolvedValue({
      success: true,
      blob: { text: () => new Promise<string>(resolve => { resolveText = resolve }) } as Blob,
    })
    const view = render(<TaskAttachmentViewer taskId="task-text" attachment={attachment('text')} users={[]} onClose={vi.fn()} />)
    await waitFor(() => expect(mockedApiBlob).toHaveBeenCalledTimes(1))

    view.rerender(<TaskAttachmentViewer taskId="task-next" attachment={attachment('next')} users={[]} onClose={vi.fn()} />)
    await screen.findByText('Este formato no tiene vista previa')
    await act(async () => { resolveText('CONTENIDO ANTIGUO') })

    expect(screen.queryByText('CONTENIDO ANTIGUO')).not.toBeInTheDocument()
  })

  it('requeues a failed Word conversion only after an explicit retry', async () => {
    let previewReads = 0
    mockedApiGet.mockImplementation(endpoint => {
      if (!endpoint.endsWith('/preview')) return Promise.resolve({ success: true, data: { comments: [] } })
      previewReads++
      const state = previewReads === 1 ? preview('word', 'word_pdf', 'failed') : preview('word', 'word_pdf', 'pending')
      if (state.status === 'failed') state.error = 'Conversión fallida'
      return Promise.resolve({ success: true, data: { preview: state } })
    })
    mockedApiPost.mockResolvedValue({
      success: true,
      data: { preview: preview('word', 'word_pdf', 'pending') },
    })

    render(<TaskAttachmentViewer taskId="task-word" attachment={attachment('word')} users={[]} onClose={vi.fn()} />)
    await screen.findByText('Conversión fallida')
    expect(mockedApiPost).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Reintentar conversión' }))

    await waitFor(() => expect(mockedApiPost).toHaveBeenCalledTimes(1))
    expect(mockedApiPost.mock.calls[0][0]).toBe('/api/tasks/task-word/attachments/word/preview/retry')
    await screen.findByText('Convirtiendo documento')
  })

  it('owns Escape while it is the top layer and closes only the viewer', async () => {
    mockedApiGet.mockImplementation(endpoint => endpoint.endsWith('/preview')
      ? Promise.resolve({ success: true, data: { preview: preview('escape', 'unsupported', 'unsupported') } })
      : Promise.resolve({ success: true, data: { comments: [] } }))
    const onClose = vi.fn()
    render(<TaskAttachmentViewer taskId="task-escape" attachment={attachment('escape')} users={[]} onClose={onClose} />)
    await screen.findByText('Este formato no tiene vista previa')

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape to a picker rendered above the viewer', async () => {
    mockedApiGet.mockImplementation(endpoint => endpoint.endsWith('/preview')
      ? Promise.resolve({ success: true, data: { preview: preview('picker', 'unsupported', 'unsupported') } })
      : Promise.resolve({ success: true, data: { comments: [] } }))
    const onClose = vi.fn()
    render(<TaskAttachmentViewer taskId="task-picker" attachment={attachment('picker')} users={[]} onClose={onClose} />)
    await screen.findByText('Este formato no tiene vista previa')
    const picker = document.createElement('div')
    picker.dataset.taskUserComboboxPortal = 'true'
    document.body.appendChild(picker)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
    picker.remove()
  })

  it('focuses the dialog, traps focus and restores the previous control', async () => {
    mockedApiGet.mockImplementation(endpoint => endpoint.endsWith('/preview')
      ? Promise.resolve({ success: true, data: { preview: preview('focus', 'unsupported', 'unsupported') } })
      : Promise.resolve({ success: true, data: { comments: [] } }))
    const origin = document.createElement('button')
    origin.textContent = 'Origen'
    document.body.appendChild(origin)
    origin.focus()
    const view = render(<TaskAttachmentViewer taskId="task-focus" attachment={attachment('focus')} users={[]} onClose={vi.fn()} />)
    const dialog = await screen.findByRole('dialog', { name: 'Vista previa de focus.pdf' })
    await waitFor(() => expect(dialog).toHaveFocus())

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(dialog.contains(document.activeElement)).toBe(true)

    view.unmount()
    expect(origin).toHaveFocus()
    origin.remove()
  })

  it('exposes the anchored comments drawer on mobile-sized layouts', async () => {
    mockedApiGet.mockImplementation(endpoint => endpoint.endsWith('/preview')
      ? Promise.resolve({ success: true, data: { preview: preview('mobile', 'unsupported', 'unsupported') } })
      : Promise.resolve({ success: true, data: { comments: [anchoredComment('mobile')] } }))
    render(<TaskAttachmentViewer taskId="task-mobile" attachment={attachment('mobile')} users={[]} onClose={vi.fn()} />)
    await screen.findByText('Este formato no tiene vista previa')

    fireEvent.click(screen.getByRole('button', { name: 'Abrir comentarios anclados' }))
    const drawer = document.querySelector('[data-task-attachment-mobile-comments]')
    expect(drawer).toBeInTheDocument()
    expect(screen.getAllByText('Punto importante').length).toBeGreaterThan(0)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('[data-task-attachment-mobile-comments]')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Vista previa de mobile.pdf' })).toBeInTheDocument()
  })

  it('never publishes a root comment without a usable type-specific anchor', async () => {
    mockedApiGet.mockImplementation(endpoint => endpoint.endsWith('/preview')
      ? Promise.resolve({ success: true, data: { preview: preview('anchor', 'unsupported', 'unsupported') } })
      : Promise.resolve({ success: true, data: { comments: [] } }))
    render(<TaskAttachmentViewer taskId="task-anchor" attachment={attachment('anchor')} users={[]} onClose={vi.fn()} />)
    await screen.findByText('Este formato no tiene vista previa')
    fireEvent.click(screen.getByRole('button', { name: 'Abrir comentarios anclados' }))
    const drawer = document.querySelector('[data-task-attachment-mobile-comments]') as HTMLElement
    const mobileComposer = screen.getAllByPlaceholderText('Comenta sobre este punto…').at(-1)!
    fireEvent.change(mobileComposer, { target: { value: 'Comentario sin punto' } })
    expect(within(drawer).getByRole('button', { name: 'Publicar comentario' })).toBeDisabled()
    expect(mockedApiPost).not.toHaveBeenCalled()
  })

  it('resolves a root once, moves it into the collapsed resolved section and reopens it', async () => {
    const original = anchoredComment('resolve')
    const resolved = { ...original, version: 2, resolved_at: '2026-08-01T01:00:00Z', resolved_by_name: 'Ricardo', can_edit: false, can_delete: false }
    mockedApiGet.mockImplementation(endpoint => endpoint.endsWith('/preview')
      ? Promise.resolve({ success: true, data: { preview: preview('resolve', 'unsupported', 'unsupported') } })
      : Promise.resolve({ success: true, data: { comments: [original] } }))
    mockedApiPut
      .mockResolvedValueOnce({ success: true, data: { comment: resolved, operation_id: 'operation-resolve' } })
      .mockResolvedValueOnce({ success: true, data: { comment: { ...original, version: 3 }, operation_id: 'operation-reopen' } })

    render(<TaskAttachmentViewer taskId="task-resolve" attachment={attachment('resolve')} users={[]} onClose={vi.fn()} />)
    await screen.findByText('Punto importante')
    const resolveButton = screen.getByRole('button', { name: 'Resolver comentario' })
    fireEvent.click(resolveButton)
    fireEvent.click(resolveButton)

    await waitFor(() => expect(mockedApiPut).toHaveBeenCalledTimes(1))
    const resolvedToggle = await screen.findByRole('button', { name: /Resueltos\s+1/ })
    expect(screen.queryByText('Punto importante')).not.toBeInTheDocument()
    fireEvent.click(resolvedToggle)
    expect(await screen.findByText('Punto importante')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Responder' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Reabrir comentario' }))
    await waitFor(() => expect(mockedApiPut).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: 'Resolver comentario' })).toBeEnabled()
  })

  it('preserves an edit draft and refreshes canonical comments after a version conflict', async () => {
    const original = anchoredComment('conflict')
    let commentReads = 0
    mockedApiGet.mockImplementation(endpoint => {
      if (endpoint.endsWith('/preview')) return Promise.resolve({ success: true, data: { preview: preview('conflict', 'unsupported', 'unsupported') } })
      commentReads++
      return Promise.resolve({ success: true, data: { comments: [{ ...original, version: commentReads > 1 ? 2 : 1 }] } })
    })
    mockedApiPut.mockResolvedValue({ success: false, status: 409, error: 'Conflicto de versión' })

    render(<TaskAttachmentViewer taskId="task-conflict" attachment={attachment('conflict')} users={[]} onClose={vi.fn()} />)
    await screen.findByText('Punto importante')
    fireEvent.click(screen.getByRole('button', { name: 'Acciones de comentario de Ricardo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Editar' }))
    const editor = screen.getByRole('textbox', { name: 'Editar comentario anclado' })
    fireEvent.change(editor, { target: { value: 'Borrador que debe permanecer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await screen.findByText('Este hilo cambió en otra sesión. Actualizamos su versión; revisa el contenido y reintenta.')
    expect(screen.getByRole('textbox', { name: 'Editar comentario anclado' })).toHaveValue('Borrador que debe permanecer')
    expect(commentReads).toBe(2)
  })

  it('replaces a deleted root with a tombstone when the server preserves its replies', async () => {
    const original = anchoredComment('delete')
    const tombstone = { ...original, body: '', deleted: true, version: 2, can_edit: false, can_delete: false }
    mockedApiGet.mockImplementation(endpoint => endpoint.endsWith('/preview')
      ? Promise.resolve({ success: true, data: { preview: preview('delete', 'unsupported', 'unsupported') } })
      : Promise.resolve({ success: true, data: { comments: [original] } }))
    mockedApiDelete.mockResolvedValue({ success: true, data: { comment: tombstone, deleted_comment_id: original.id, operation_id: 'operation-delete' } })

    render(<TaskAttachmentViewer taskId="task-delete" attachment={attachment('delete')} users={[]} onClose={vi.fn()} />)
    await screen.findByText('Punto importante')
    fireEvent.click(screen.getByRole('button', { name: 'Acciones de comentario de Ricardo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Eliminar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }))

    expect(await screen.findByText('Comentario eliminado')).toBeInTheDocument()
    expect(screen.queryByText('Punto importante')).not.toBeInTheDocument()
    expect(mockedApiDelete).toHaveBeenCalledTimes(1)
  })
})
