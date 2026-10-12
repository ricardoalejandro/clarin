import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentImageLoadError } from '@/lib/documents/resourceErrors'
import DocumentEditorPage from './page'

const mocks = vi.hoisted(() => ({
  api: vi.fn(), upload: vi.fn(), load: vi.fn(), fonts: vi.fn(), createCanvas: vi.fn(),
  push: vi.fn(), scope: 'active:qa', id: 'fixture-a', listeners: new Set<() => void>(),
}))

vi.mock('next/navigation', () => ({ useParams: () => ({ id: mocks.id }), useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/lib/api', () => ({ api: mocks.api, apiUpload: mocks.upload }))
vi.mock('@/lib/authScope', () => ({
  getAuthScope: () => mocks.scope,
  isAuthIdentityChanging: (value: string) => value.startsWith('changing:'),
  subscribeAuthScope: (listener: () => void) => { mocks.listeners.add(listener); return () => { mocks.listeners.delete(listener) } },
}))

// This test owns the page lifecycle and command availability. Real Fabric
// decoding, image budgets and canvas pixels are covered at the adapter/browser layers.
vi.mock('@/lib/fabric', () => ({
  createEditorCanvas: mocks.createCanvas,
  ensureFontsLoaded: mocks.fonts,
  loadTemplateToCanvas: mocks.load,
  ensurePageAtBottom: vi.fn(),
  canvasToTemplateJson: () => ({ version: 3, fabricJson: { objects: [] } }),
  applyDocumentBackground: vi.fn(async () => undefined),
  zoomToFit: () => 1,
  resizeCanvas: vi.fn(),
  setupShortcuts: () => () => undefined,
  CanvasHistory: class {
    canUndo = false
    canRedo = false
    busy = false
    init() {}
    save() {}
  },
  SYSTEM_FONTS: ['Arial'], GOOGLE_FONTS: [], DYNAMIC_FIELD_CATEGORIES: [], PAGE_SIZES: {}, GRID_SIZES: [10],
  MM_TO_PX: 2, GUIDE_COLOR: '#10b981', MARGIN_COLOR: '#f59e0b',
}))

const fixture = (id: string) => ({
  id, name: `Ficha ${id}`, revision: 1, page_width: 210, page_height: 297,
  page_orientation: 'portrait', fields_used: [],
  canvas_json: { version: 3, fabricJson: { objects: [] }, background: { color: '#ffffff' } },
})
const failedImages = () => new DocumentImageLoadError([
  { name: 'Logo CATM (2).png', reason: 'unavailable' },
  { name: 'NA_logo_Escuela de Filosofía.png', reason: 'unavailable' },
])
const writes = () => mocks.api.mock.calls.filter(([, options]) => options?.method && options.method !== 'GET')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => {
  mocks.scope = 'active:qa'; mocks.id = 'fixture-a'; mocks.listeners.clear()
  mocks.api.mockReset().mockImplementation(async (path: string) => path.startsWith('/api/document-templates/')
    ? { success: true, data: { template: fixture(path.split('/').at(-1)!) } }
    : { success: true, data: { fields: [] } })
  mocks.upload.mockReset(); mocks.push.mockReset()
  mocks.load.mockReset().mockResolvedValue({ color: '#ffffff' })
  mocks.fonts.mockReset().mockResolvedValue(undefined)
  mocks.createCanvas.mockReset().mockImplementation(() => ({
    width: 800, height: 600, __pageWidth: 420, __pageHeight: 594,
    __pageRect: { set: vi.fn() }, viewportTransform: [1, 0, 0, 1, 0, 0],
    on: vi.fn(), off: vi.fn(), dispose: vi.fn(), renderAll: vi.fn(), requestRenderAll: vi.fn(),
    getObjects: () => [], getActiveObjects: () => [], getActiveObject: () => undefined,
    getZoom: () => 1, calcOffset: vi.fn(), setCursor: vi.fn(),
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('document image loading lifecycle', () => {
  it('shows both failed resources, prevents writes and enables editing only after a successful retry', async () => {
    mocks.load.mockRejectedValueOnce(failedImages())
    render(<DocumentEditorPage />)

    // The first editor render also loads the real Fabric runtime through a cold dynamic import.
    const alert = await screen.findByRole('alert', {}, { timeout: 5000 })
    expect(alert).toHaveTextContent(/2 imágenes/)
    expect(screen.getByText('Logo CATM (2).png')).toBeVisible()
    expect(screen.getByText('NA_logo_Escuela de Filosofía.png')).toBeVisible()
    expect(screen.getByText('Carga incompleta')).toBeVisible()
    const save = screen.getByRole('button', { name: /^Guardar$/ })
    expect(save).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Exportar$/ })).toBeDisabled()
    fireEvent.click(save)
    fireEvent.keyDown(document, { key: 's', ctrlKey: true })
    expect(writes()).toHaveLength(0)
    expect(mocks.upload).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /^Reintentar/ }))
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Guardar$/ })).not.toBeDisabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Carga incompleta')).not.toBeInTheDocument()
    expect(writes()).toHaveLength(0)
  })

  it('ignores an obsolete image failure after a new template finishes loading', async () => {
    const old = deferred<{ color: string }>()
    mocks.load.mockReturnValueOnce(old.promise)
    const view = render(<DocumentEditorPage />)
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1))
    const signal = mocks.load.mock.calls[0][4] as AbortSignal

    mocks.id = 'fixture-b'
    view.rerender(<DocumentEditorPage />)
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Guardar$/ })).not.toBeDisabled())
    expect(signal.aborted).toBe(true)
    await act(async () => { old.reject(failedImages()) })

    expect(screen.getByLabelText('Nombre de la plantilla')).toHaveValue('Ficha fixture-b')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Guardar$/ })).not.toBeDisabled()
    expect(writes()).toHaveLength(0)
  })

  it('ignores a late initialization failure outside hydration after changing templates', async () => {
    const oldFonts = deferred<void>()
    mocks.fonts.mockReturnValueOnce(oldFonts.promise)
    const view = render(<DocumentEditorPage />)
    await waitFor(() => expect(mocks.fonts).toHaveBeenCalledTimes(1))
    mocks.id = 'fixture-b'
    view.rerender(<DocumentEditorPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^Guardar$/ })).not.toBeDisabled())
    await act(async () => { oldFonts.reject(new Error('Obsolete font failure')) })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Nombre de la plantilla')).toHaveValue('Ficha fixture-b')
  })

  it('aborts pending hydration and removes the previous account immediately', async () => {
    const old = deferred<{ color: string }>()
    mocks.load.mockReturnValueOnce(old.promise)
    render(<DocumentEditorPage />)
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1))
    const signal = mocks.load.mock.calls[0][4] as AbortSignal
    act(() => { mocks.scope = 'changing:other'; mocks.listeners.forEach(listener => listener()) })
    expect(signal.aborted).toBe(true)
    expect(screen.queryByLabelText('Nombre de la plantilla')).not.toBeInTheDocument()
    await act(async () => { old.reject(failedImages()) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(writes()).toHaveLength(0)
  })
})
