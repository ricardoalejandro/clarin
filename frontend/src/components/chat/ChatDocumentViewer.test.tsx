import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatDocumentDescriptor } from '@/utils/chatDocuments'

const mocks = vi.hoisted(() => ({
  apiBlob: vi.fn(),
  loadPdfRuntime: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ apiBlob: mocks.apiBlob }))
vi.mock('@/lib/pdfRuntime', () => ({ loadPdfRuntime: mocks.loadPdfRuntime }))

import ChatDocumentViewer, { CHAT_PDF_SLOW_MS, CHAT_PDF_TIMEOUT_MS } from './ChatDocumentViewer'

function descriptor(id = 'one'): ChatDocumentDescriptor {
  return {
    sessionId: `chat-1:${id}`,
    src: `/api/media/file/account/${id}.pdf`,
    filename: `${id}.pdf`,
    mimeType: 'application/pdf',
    size: 2048,
  }
}

function installReadyPdf(pageCount = 2) {
  const renderTask = { promise: Promise.resolve(), cancel: vi.fn() }
  const page = {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 120 * scale, height: 160 * scale })),
    render: vi.fn(() => renderTask),
  }
  const pdf = {
    numPages: pageCount,
    getPage: vi.fn().mockResolvedValue(page),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
  const loadingTask = { promise: Promise.resolve(pdf), destroy: vi.fn().mockResolvedValue(undefined) }
  const getDocument = vi.fn(() => loadingTask)
  mocks.loadPdfRuntime.mockResolvedValue({ getDocument })
  return { getDocument, loadingTask, page, pdf, renderTask }
}

beforeEach(() => {
  mocks.apiBlob.mockReset()
  mocks.loadPdfRuntime.mockReset()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:chat-pdf') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ChatDocumentViewer', () => {
  it('downloads, renders and navigates a multi-page PDF', async () => {
    const runtime = installReadyPdf(2)
    mocks.apiBlob.mockResolvedValue({
      success: true,
      blob: { arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) } as Blob,
    })

    render(<ChatDocumentViewer document={descriptor()} onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByLabelText('Página 1 de 2')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Página siguiente' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' }))
    await waitFor(() => expect(runtime.pdf.getPage).toHaveBeenLastCalledWith(2))

    fireEvent.click(screen.getByRole('button', { name: 'Acercar PDF' }))
    await waitFor(() => expect(runtime.page.getViewport).toHaveBeenLastCalledWith({ scale: 1.5 }))
    expect(screen.getByRole('link', { name: 'Descargar one.pdf' })).toHaveAttribute('download', 'one.pdf')
  })

  it('aborts and destroys its session, then restores focus after Escape', async () => {
    const runtime = installReadyPdf(1)
    mocks.apiBlob.mockResolvedValue({
      success: true,
      blob: { arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) } as Blob,
    })

    function Harness() {
      const [open, setOpen] = React.useState(false)
      return <><button type="button" onClick={() => setOpen(true)}>Abrir contrato</button>{open && <ChatDocumentViewer document={descriptor()} onClose={() => setOpen(false)} />}</>
    }

    const React = await import('react')
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Abrir contrato' })
    trigger.focus()
    fireEvent.click(trigger)
    await screen.findByRole('dialog', { name: 'Vista previa de one.pdf' })
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus())

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
    expect(runtime.pdf.destroy).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:chat-pdf')
    expect(document.body.style.overflow).toBe('')
  })

  it('rejects a late download after the viewer switches documents', async () => {
    let resolveFirst!: (value: { success: boolean; blob: Blob }) => void
    const firstRequest = new Promise<{ success: boolean; blob: Blob }>(resolve => { resolveFirst = resolve })
    const signals: AbortSignal[] = []
    mocks.apiBlob.mockImplementation((src: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) signals.push(options.signal)
      if (src.endsWith('/one.pdf')) return firstRequest
      return Promise.resolve({ success: true, blob: { arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)) } as Blob })
    })
    const runtime = installReadyPdf(1)
    const view = render(<ChatDocumentViewer document={descriptor('one')} onClose={vi.fn()} />)

    view.rerender(<ChatDocumentViewer document={descriptor('two')} onClose={vi.fn()} />)
    await waitFor(() => expect(runtime.getDocument).toHaveBeenCalledTimes(1))
    await act(async () => resolveFirst({ success: true, blob: { arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) } as Blob }))

    expect(signals[0].aborted).toBe(true)
    expect(runtime.getDocument).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog', { name: 'Vista previa de two.pdf' })).toBeInTheDocument()
  })

  it('shows slow and timeout recovery without leaving the request alive', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    mocks.apiBlob.mockImplementation((_src: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) signals.push(options.signal)
      return new Promise(() => undefined)
    })

    render(<ChatDocumentViewer document={descriptor()} onClose={vi.fn()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_PDF_SLOW_MS) })
    expect(screen.getByText(/Está tardando más de lo habitual/)).toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_PDF_TIMEOUT_MS - CHAT_PDF_SLOW_MS) })
    expect(screen.getByRole('alert')).toHaveTextContent('La vista previa tardó demasiado')
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(true)
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeEnabled()
    expect(screen.getByRole('link', { name: 'Descargar original' })).toHaveAttribute('href', descriptor().src)
  })
})
