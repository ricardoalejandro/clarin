import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  props: null as any,
  elements: [] as any[],
  files: {} as Record<string, any>,
  appState: { viewBackgroundColor: '#ffffff' } as Record<string, any>,
  upload: vi.fn(),
  events: null as any,
  frames: [] as FrameRequestCallback[],
}))

vi.mock('@excalidraw/excalidraw', async () => {
  const { useEffect } = await import('react')
  const api = {
    getSceneElementsIncludingDeleted: () => harness.elements,
    getAppState: () => harness.appState,
    getFiles: () => harness.files,
    updateScene: (next: any) => {
      if (next.elements) harness.elements = next.elements
      if (next.appState) harness.appState = { ...harness.appState, ...next.appState }
      harness.props.onChange(harness.elements, harness.appState, harness.files)
    },
    addFiles: (files: any[]) => {
      for (const file of files) harness.files[file.id] = file
      harness.props.onChange(harness.elements, harness.appState, harness.files)
    },
  }
  const Excalidraw = (props: any) => {
    harness.props = props
    useEffect(() => {
      harness.elements = props.initialData.elements
      harness.files = props.initialData.files
      harness.appState = props.initialData.appState
      props.excalidrawAPI(api)
    }, [])
    return null
  }
  const MainMenu = ({ children }: { children?: ReactNode }) => <>{children}</>
  MainMenu.Item = () => null
  MainMenu.Group = MainMenu
  MainMenu.DefaultItems = { SaveAsImage: () => null, ToggleTheme: () => null, ChangeCanvasBackground: () => null }
  return { Excalidraw, MainMenu, CaptureUpdateAction: { NEVER: 'never' }, getVisibleSceneBounds: () => null, reconcileElements: (_: any, remote: any) => remote, serializeAsJSON: JSON.stringify }
})

vi.mock('@/lib/whiteboardExcalidrawAdapter', async () => {
  const { buildWhiteboardSavePayload } = await import('@/lib/whiteboards')
  return { restoreClarinWhiteboardScene: (value: any) => value, buildExcalidrawWhiteboardSavePayload: buildWhiteboardSavePayload }
})

vi.mock('@/lib/whiteboardsApi', () => ({
  connectWhiteboardRoom: (input: any) => {
    harness.events = input
    return { sendPatch: () => null, close: () => {}, sendCursor: () => {}, retryNow: () => {} }
  },
  uploadWhiteboardGuestAsset: (...args: any[]) => harness.upload(...args),
  downloadWhiteboardGuestAsset: vi.fn(), listWhiteboardGuestAssets: vi.fn(), requestWhiteboardGuestCollabTicket: vi.fn(),
}))

vi.mock('@/lib/whiteboardMedia', async importOriginal => ({
  ...await importOriginal<object>(),
  rasterizeWhiteboardFiles: async (files: any) => files,
  dataURLToBlob: () => new Blob(['image'], { type: 'image/png' }),
}))

vi.mock('@/hooks/useWhiteboardAssetHydration', () => {
  const request = vi.fn()
  return { useWhiteboardAssetHydration: () => ({ progress: { phase: 'complete' }, request, retry: vi.fn() }), whiteboardAssetHydrationMessage: () => null }
})

vi.mock('@/hooks/useWhiteboardFontPreload', () => ({
  useWhiteboardFontPreload: () => ({ progress: { phase: 'complete' }, retry: vi.fn() }),
  whiteboardFontPreloadFirstPassComplete: () => true, whiteboardFontPreloadMessage: () => null,
}))

vi.mock('@/hooks/useWhiteboardPresentation', () => {
  const noop = () => {}
  const handle = () => false
  const presentation = { controlState: 'unavailable', state: {}, handleConnectionChange: noop, handleRealtimeEvent: handle, getSelfActorID: () => null }
  return { useWhiteboardPresentation: () => presentation }
})
vi.mock('./WhiteboardPresentationControls', () => ({ WhiteboardPresentationButton: () => null, WhiteboardPresentationOverlay: () => null }))

import GuestWhiteboardEditor from './GuestWhiteboardEditor'

const image = (id: string, version = 1, isDeleted = false) => ({ id, type: 'image', fileId: id, version, versionNonce: version, isDeleted })
const file = (id: string) => ({ id, mimeType: 'image/png', dataURL: 'data:image/png;base64,a', created: 1 })
const rectangle = (version = 1) => ({ id: 'shape', type: 'rectangle', version, versionNonce: version, x: version })

function edit(elements: any[], files = harness.files) {
  act(() => {
    harness.elements = elements
    harness.files = files
    harness.props.onChange(elements, harness.appState, files)
  })
}

async function openEditor() {
  render(<GuestWhiteboardEditor shareLinkID="share" />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar ahora' })).toBeInTheDocument())
  act(() => { for (const frame of harness.frames.splice(0)) frame(0) })
}

function manualSave() { fireEvent.click(screen.getByRole('button', { name: 'Guardar ahora' })) }

describe('guest editor save interleavings', () => {
  const writes: any[] = []
  let responseGate: (() => Promise<void>) | null = null
  let firstFailure: { status: number; code: string; missing_file_ids?: string[] } | null = null
  beforeEach(() => {
    writes.length = 0
    responseGate = null
    firstFailure = null
    harness.elements = []
    harness.files = {}
    harness.frames = []
    harness.props = null
    harness.upload.mockReset().mockResolvedValue({ success: true, data: { asset: { id: 'stored' } } })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { harness.frames.push(callback); return harness.frames.length })
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      if (!options?.method) return { ok: true, status: 200, json: async () => ({ session: { id: 'guest', display_name: 'QA', access_level: 'edit' }, allow_export: true, scene: { board_id: 'board', sequence: 0, scene: { elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} } } }) }
      const payload = JSON.parse(options.body)
      writes.push(payload)
      if (responseGate) await responseGate()
      if (writes.length === 1 && firstFailure) return { ok: false, status: firstFailure.status, json: async () => ({ ...firstFailure, error: 'Guardado pendiente' }) }
      return { ok: true, status: 200, json: async () => ({ result: { scene: { board_id: 'board', sequence: writes.length, scene: payload.scene } } }) }
    }))
  })

  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('prepares and saves only the image capture whose upload completed', async () => {
    let finish!: () => void
    harness.upload.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ success: true, data: { asset: { id: 'a' } } }) }))
    await openEditor()
    edit([image('a')], { a: file('a') })
    manualSave()
    await waitFor(() => expect(harness.upload).toHaveBeenCalledTimes(1))
    edit([image('a'), image('b')], { a: file('a'), b: file('b') })
    await act(async () => finish())
    await waitFor(() => expect(writes.length).toBe(1))
    expect(writes[0].scene.elements.map((element: any) => element.id)).toEqual(['a'])
    expect(screen.getByRole('button', { name: 'Guardar ahora' })).not.toBeDisabled()
    manualSave()
    await waitFor(() => expect(writes.length).toBe(2))
    expect(harness.upload.mock.calls.map(call => call[1])).toEqual(['a', 'b'])
    expect(writes[1].scene.elements).toHaveLength(2)
  })

  it('keeps a gesture made immediately after the REST ACK pending without waiting for a frame', async () => {
    await openEditor()
    edit([rectangle()])
    manualSave()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar ahora' })).toBeDisabled())
    expect(writes).toHaveLength(1)
    edit([rectangle(2)])
    expect(screen.getByRole('button', { name: 'Guardar ahora' })).not.toBeDisabled()
    manualSave()
    await waitFor(() => expect(writes.length).toBe(2))
    expect(writes[1].scene.elements[0].version).toBe(2)
  })

  it('uploads an image inserted after sending the previous scene, instead of trusting hydration', async () => {
    let finish!: () => void
    responseGate = () => new Promise<void>(resolve => { finish = resolve })
    await openEditor()
    edit([rectangle()])
    manualSave()
    await waitFor(() => expect(writes.length).toBe(1))
    edit([rectangle(), image('b')], { b: file('b') })
    responseGate = null
    await act(async () => finish())
    manualSave()
    await waitFor(() => expect(writes.length).toBe(2))
    expect(harness.upload.mock.calls.map(call => call[1])).toEqual(['b'])
  })

  it('uploads the file again when undo resurrects an image after its deletion was acknowledged', async () => {
    await openEditor()
    edit([image('a')], { a: file('a') })
    manualSave()
    await waitFor(() => expect(writes.length).toBe(1))
    edit([image('a', 2, true)])
    manualSave()
    await waitFor(() => expect(writes.length).toBe(2))
    edit([image('a', 3)])
    manualSave()
    await waitFor(() => expect(writes.length).toBe(3))
    expect(harness.upload.mock.calls.map(call => call[1])).toEqual(['a', 'a'])
  })

  it('prepares a new operation only after an explicit uncommitted missing-asset rejection', async () => {
    firstFailure = { status: 422, code: 'whiteboard_assets_missing', missing_file_ids: ['a'] }
    await openEditor()
    edit([image('a')], { a: file('a') })
    manualSave()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reintentar guardado' })).toBeInTheDocument())
    manualSave()
    await waitFor(() => expect(writes.length).toBe(2))
    expect(harness.upload.mock.calls.map(call => call[1])).toEqual(['a', 'a'])
    expect(writes[1].operation_id).not.toBe(writes[0].operation_id)
  })

  it('retains the exact operation and payload after an unknown outcome while later edits stay queued', async () => {
    firstFailure = { status: 503, code: 'whiteboard_internal_error' }
    await openEditor()
    edit([rectangle()])
    manualSave()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reintentar guardado' })).toBeInTheDocument())
    edit([rectangle(2)])
    manualSave()
    await waitFor(() => expect(writes.length).toBe(2))
    expect(writes[1]).toEqual(writes[0])
    manualSave()
    await waitFor(() => expect(writes.length).toBe(3))
    expect(writes[2].scene.elements[0].version).toBe(2)
    expect(writes[2].operation_id).not.toBe(writes[0].operation_id)
  })
  it('keeps an editable guest scene open during transient rate feedback', async () => {
    await openEditor()
    edit([rectangle(2)])
    act(() => {
      harness.events.onIssue({ kind: 'rate_limited', retryable: true, message: 'Colaboración temporalmente limitada', rateLimit: { event: 'cursor.update', scope: 'connection', retry_after_ms: 1_000 } })
      harness.events.onEvent({ event: 'error', code: 'rate_limited', error: 'Demasiados eventos de colaboración' })
    })
    expect(screen.getByRole('button', { name: 'Guardar ahora' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(harness.elements).toEqual([rectangle(2)])
    act(() => harness.events.onIssue(null))
    expect(screen.queryByText(/Colaboración temporalmente limitada/)).not.toBeInTheDocument()
    manualSave()
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].scene.elements).toEqual([rectangle(2)])
  })

})
