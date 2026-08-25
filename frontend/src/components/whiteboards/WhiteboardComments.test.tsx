import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import {
  WhiteboardCommentPins,
  WhiteboardCommentsPanel,
  WhiteboardCommentsProvider,
  type WhiteboardCommentsProviderHandle,
} from './WhiteboardComments'
import {
  whiteboardCommentMarkerFromThread,
  type WhiteboardCommentThread,
} from '@/lib/whiteboardComments'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

const apiMocks = vi.hoisted(() => ({
  listWhiteboardCommentThreads: vi.fn(),
  createWhiteboardCommentThread: vi.fn(),
  replyToWhiteboardCommentThread: vi.fn(),
  updateWhiteboardComment: vi.fn(),
  deleteWhiteboardComment: vi.fn(),
  updateWhiteboardCommentThreadStatus: vi.fn(),
  listWhiteboardThreadComments: vi.fn(),
  listWhiteboardCommentMarkers: vi.fn(),
  getWhiteboardCommentThread: vi.fn(),
}))

vi.mock('@/lib/whiteboardCommentsApi', () => apiMocks)

function commentThread(overrides: Partial<WhiteboardCommentThread> = {}): WhiteboardCommentThread {
  return {
    id: 'thread-1',
    board_id: 'board-1',
    element_id: null,
    anchor_x: 100,
    anchor_y: 80,
    anchor_ratio_x: null,
    anchor_ratio_y: null,
    status: 'open',
    version: 1,
    created_by: 'user-1',
    created_by_name: 'Ana Pérez',
    comments: [{
      id: 'comment-1',
      thread_id: 'thread-1',
      author_id: 'user-1',
      author_name: 'Ana Pérez',
      body: 'Comentario inicial',
      version: 1,
      created_at: '2026-08-14T10:00:00Z',
      updated_at: '2026-08-14T10:00:00Z',
    }],
    created_at: '2026-08-14T10:00:00Z',
    updated_at: '2026-08-14T10:00:00Z',
    ...overrides,
  }
}

function editorAPI() {
  let pointerDown: ((activeTool: unknown, pointerDownState: any, event: any) => void) | null = null
  let openSidebar: { name: string; tab?: string } | null = null
  const api = {
    getAppState: vi.fn(() => ({
      selectedElementIds: {},
      zoom: { value: 1 },
      offsetLeft: 0,
      offsetTop: 0,
      scrollX: 0,
      scrollY: 0,
      openSidebar,
    })),
    getSceneElements: vi.fn(() => []),
    setActiveTool: vi.fn(),
    setCursor: vi.fn(),
    resetCursor: vi.fn(),
    onPointerDown: vi.fn((callback: typeof pointerDown) => {
      pointerDown = callback
      return vi.fn()
    }),
    toggleSidebar: vi.fn((toggle: { name: string; tab?: string; force?: boolean }) => {
      openSidebar = toggle.force === false ? null : { name: toggle.name, tab: toggle.tab }
    }),
    scrollToContent: vi.fn(),
    onChange: vi.fn(() => vi.fn()),
    onScrollChange: vi.fn(() => vi.fn()),
  } as unknown as ExcalidrawImperativeAPI
  return {
    api,
    pointer: () => pointerDown,
    setOpenSidebar: (value: { name: string; tab?: string } | null) => { openSidebar = value },
  }
}

function animationFrameHarness() {
  let nextID = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    const id = nextID
    nextID += 1
    callbacks.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
    callbacks.delete(id)
  })
  return {
    pending: () => callbacks.size,
    flush: () => {
      const queued = Array.from(callbacks.values())
      callbacks.clear()
      for (const callback of queued) callback(performance.now())
    },
  }
}

function installCommentPinLayout() {
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400,
    toJSON: () => ({}),
  })
}

describe('WhiteboardCommentsPanel', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    Object.values(apiMocks).forEach(mock => mock.mockReset())
    apiMocks.listWhiteboardCommentThreads.mockResolvedValue({
      success: true,
      data: { success: true, threads: [], next_cursor: null, counts: { open: 0, resolved: 0, all: 0 } },
    })
    apiMocks.listWhiteboardCommentMarkers.mockResolvedValue({
      success: true,
      data: { success: true, markers: [], next_cursor: null },
    })
    apiMocks.getWhiteboardCommentThread.mockImplementation(({ threadID }: { threadID: string }) => Promise.resolve({
      success: true,
      data: { success: true, thread: commentThread({ id: threadID }) },
    }))
  })

  it('loads the empty state and creates a Unicode comment at a chosen canvas point', async () => {
    const frames = animationFrameHarness()
    const editor = editorAPI()
    const canonical = commentThread({ comments: [{
      ...commentThread().comments[0],
      body: 'Hola 👍',
    }] })
    apiMocks.createWhiteboardCommentThread.mockResolvedValue({ success: true, data: { success: true, thread: canonical } })

    render(<WhiteboardCommentsProvider boardID="board-1" currentUserID="user-1" canComment editorAPI={editor.api}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    expect(await screen.findByText('No hay comentarios abiertos')).toBeInTheDocument()
    expect(editor.pointer()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Añadir' }))
    expect(await screen.findByText('Elige el punto del comentario')).toBeInTheDocument()
    expect(editor.pointer()).not.toBeNull()

    act(() => {
      editor.pointer()?.(
        { type: 'selection' },
        { hit: { element: null } },
        { button: 0, clientX: 100, clientY: 80, preventDefault: vi.fn(), stopPropagation: vi.fn() },
      )
    })

    expect(frames.pending()).toBe(1)
    act(() => frames.flush())
    expect(editor.api.toggleSidebar).toHaveBeenCalledWith({
      name: 'default',
      tab: 'comments',
      force: true,
    })
    const textarea = await screen.findByPlaceholderText('Escribe el primer comentario del hilo')
    fireEvent.change(textarea, { target: { value: 'Hola ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Añadir 👍' }))
    expect(textarea).toHaveValue('Hola 👍')
    fireEvent.click(screen.getByRole('button', { name: 'Publicar' }))

    await waitFor(() => expect(apiMocks.createWhiteboardCommentThread).toHaveBeenCalledTimes(1))
    expect(apiMocks.createWhiteboardCommentThread.mock.calls[0][0]).toMatchObject({
      boardID: 'board-1',
      body: 'Hola 👍',
      anchor: {
        element_id: null,
        anchor_x: 100,
        anchor_y: 80,
      },
    })
    expect(await screen.findByText('Hola 👍')).toBeInTheDocument()
  })

  it('cancels the deferred sidebar reopen when the provider unmounts', async () => {
    const frames = animationFrameHarness()
    const editor = editorAPI()
    const rendered = render(<WhiteboardCommentsProvider boardID="board-1" currentUserID="user-1" canComment editorAPI={editor.api}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    await screen.findByText('No hay comentarios abiertos')
    fireEvent.click(screen.getByRole('button', { name: 'Añadir' }))
    act(() => {
      editor.pointer()?.(
        { type: 'selection' },
        { hit: { element: null } },
        { button: 0, clientX: 100, clientY: 80, preventDefault: vi.fn(), stopPropagation: vi.fn() },
      )
    })
    expect(await screen.findByPlaceholderText('Escribe el primer comentario del hilo')).toBeInTheDocument()
    expect(frames.pending()).toBe(1)

    rendered.unmount()
    expect(frames.pending()).toBe(0)
    act(() => frames.flush())
    expect(editor.api.toggleSidebar).not.toHaveBeenCalled()
  })

  it('reopens an undocked draft with the latest editor API after the panel unmounts', async () => {
    const frames = animationFrameHarness()
    const firstEditor = editorAPI()
    const latestEditor = editorAPI()
    const surface = (api: ExcalidrawImperativeAPI, showPanel: boolean) => <WhiteboardCommentsProvider
      boardID="board-1"
      currentUserID="user-1"
      canComment
      editorAPI={api}
    >
      {showPanel ? <WhiteboardCommentsPanel /> : null}
    </WhiteboardCommentsProvider>
    const rendered = render(surface(firstEditor.api, true))

    await screen.findByText('No hay comentarios abiertos')
    fireEvent.click(screen.getByRole('button', { name: 'Añadir' }))
    act(() => {
      firstEditor.pointer()?.(
        { type: 'selection' },
        { hit: { element: null } },
        { button: 0, clientX: 100, clientY: 80, preventDefault: vi.fn(), stopPropagation: vi.fn() },
      )
    })
    const draft = await screen.findByPlaceholderText('Escribe el primer comentario del hilo')
    fireEvent.change(draft, { target: { value: 'Borrador durante reapertura' } })
    expect(draft).toHaveValue('Borrador durante reapertura')
    expect(frames.pending()).toBe(1)

    // Mirrors Excalidraw closing an undocked sidebar and refreshing its
    // imperative API while handling the same canvas pointer.
    rendered.rerender(surface(latestEditor.api, false))
    act(() => frames.flush())
    expect(firstEditor.api.toggleSidebar).not.toHaveBeenCalled()
    expect(latestEditor.api.toggleSidebar).toHaveBeenCalledWith({
      name: 'default',
      tab: 'comments',
      force: true,
    })
    expect(latestEditor.api.toggleSidebar).toHaveBeenCalledTimes(1)

    rendered.rerender(surface(latestEditor.api, true))
    expect(await screen.findByPlaceholderText('Escribe el primer comentario del hilo')).toHaveValue('Borrador durante reapertura')
  })

  it('reopens again when Excalidraw commits its outside-click close one frame late', async () => {
    const frames = animationFrameHarness()
    const editor = editorAPI()
    render(<WhiteboardCommentsProvider boardID="board-1" currentUserID="user-1" canComment editorAPI={editor.api}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    await screen.findByText('No hay comentarios abiertos')
    fireEvent.click(screen.getByRole('button', { name: 'Añadir' }))
    act(() => {
      editor.pointer()?.(
        { type: 'selection' },
        { hit: { element: null } },
        { button: 0, clientX: 100, clientY: 80, preventDefault: vi.fn(), stopPropagation: vi.fn() },
      )
    })

    act(() => frames.flush())
    expect(editor.api.toggleSidebar).toHaveBeenCalledTimes(1)
    editor.setOpenSidebar(null)
    act(() => frames.flush())
    expect(editor.api.toggleSidebar).toHaveBeenCalledTimes(2)
    act(() => frames.flush())
    expect(editor.api.toggleSidebar).toHaveBeenCalledTimes(2)
    expect(frames.pending()).toBe(0)
    expect(await screen.findByPlaceholderText('Escribe el primer comentario del hilo')).toBeInTheDocument()
  })

  it('captures a canvas point before Excalidraw pans for a comment-only member', async () => {
    const editor = editorAPI()
    const providerRef = createRef<WhiteboardCommentsProviderHandle>()
    apiMocks.createWhiteboardCommentThread.mockResolvedValue({
      success: true,
      data: { success: true, thread: commentThread() },
    })
    render(<WhiteboardCommentsProvider
      ref={providerRef}
      boardID="board-1"
      currentUserID="user-1"
      canComment
      editorAPI={editor.api}
    >
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    await screen.findByText('No hay comentarios abiertos')
    fireEvent.click(screen.getByRole('button', { name: 'Añadir' }))
    expect(providerRef.current?.captureViewModePlacement(100, 80)).toBe(true)

    const composer = await screen.findByPlaceholderText('Escribe el primer comentario del hilo')
    fireEvent.change(composer, { target: { value: 'Comentario con permiso Comentar' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publicar' }))
    await waitFor(() => expect(apiMocks.createWhiteboardCommentThread).toHaveBeenCalledTimes(1))
    expect(apiMocks.createWhiteboardCommentThread.mock.calls[0][0]).toMatchObject({
      boardID: 'board-1',
      body: 'Comentario con permiso Comentar',
      anchor: { element_id: null, anchor_x: 100, anchor_y: 80 },
    })
  })

  it('renders a truthful read-only state and keeps mutation controls disabled', async () => {
    render(<WhiteboardCommentsProvider
      boardID="board-1"
      currentUserID="user-2"
      canComment={false}
      disabledReason="Tu acceso permite ver, pero no comentar."
      editorAPI={null}
    >
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    expect(await screen.findByText('Tu acceso permite ver, pero no comentar.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Añadir' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Crear comentario' })).not.toBeInTheDocument()
  })

  it('shows load errors with an explicit retry without replacing a populated thread list', async () => {
    apiMocks.listWhiteboardCommentThreads
      .mockResolvedValueOnce({ success: true, data: { success: true, threads: [commentThread()], next_cursor: null } })
      .mockResolvedValueOnce({ success: false, status: 503, error: 'Temporalmente no disponible' })

    const { rerender } = render(<WhiteboardCommentsProvider boardID="board-1" currentUserID="user-1" canComment editorAPI={null} refreshKey={0}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    expect(await screen.findByText('Comentario inicial')).toBeInTheDocument()
    rerender(<WhiteboardCommentsProvider boardID="board-1" currentUserID="user-1" canComment editorAPI={null} refreshKey={1}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    await waitFor(() => expect(apiMocks.listWhiteboardCommentThreads).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Comentario inicial')).toBeInTheDocument()
  })

  it('shows only the initial load error, without a contradictory empty state', async () => {
    apiMocks.listWhiteboardCommentThreads.mockResolvedValue({
      success: false,
      status: 503,
      error: 'Temporalmente no disponible',
    })

    render(<WhiteboardCommentsProvider boardID="board-1" currentUserID="user-1" canComment editorAPI={null}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    expect(await screen.findByText('No se pudieron abrir los comentarios')).toBeInTheDocument()
    expect(screen.getByText('Temporalmente no disponible')).toBeInTheDocument()
    expect(screen.queryByText('No hay comentarios abiertos')).not.toBeInTheDocument()
  })

  it('keeps resolved threads immutable until they are reopened', async () => {
    apiMocks.listWhiteboardCommentThreads.mockResolvedValue({
      success: true,
      data: { success: true, threads: [commentThread({ status: 'resolved' })], next_cursor: null },
    })

    render(<WhiteboardCommentsProvider boardID="board-1" currentUserID="user-1" canComment editorAPI={null}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    fireEvent.click(await screen.findByRole('tab', { name: /Resueltos/ }))
    expect(await screen.findByText('Comentario inicial')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reabrir hilo' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Responder' })).not.toBeInTheDocument()
  })

  it('blocks duplicate keyboard submission and cancellation while a comment is pending', async () => {
    const editor = editorAPI()
    const commentsRef = createRef<WhiteboardCommentsProviderHandle>()
    const request = deferred<{
      success: boolean
      data: { success: boolean; thread: WhiteboardCommentThread }
    }>()
    apiMocks.createWhiteboardCommentThread.mockReturnValue(request.promise)

    render(<WhiteboardCommentsProvider ref={commentsRef} boardID="board-1" currentUserID="user-1" canComment editorAPI={editor.api}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    await screen.findByText('No hay comentarios abiertos')
    fireEvent.click(screen.getByRole('button', { name: 'Añadir' }))
    act(() => {
      editor.pointer()?.(
        { type: 'selection' },
        { hit: { element: null } },
        { button: 0, clientX: 100, clientY: 80, preventDefault: vi.fn(), stopPropagation: vi.fn() },
      )
    })

    const textarea = await screen.findByPlaceholderText('Escribe el primer comentario del hilo')
    fireEvent.change(textarea, { target: { value: 'Una sola vez' } })
    expect(commentsRef.current?.hasUnsavedDrafts()).toBe(true)
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(textarea, { key: 'Escape' })

    await waitFor(() => expect(apiMocks.createWhiteboardCommentThread).toHaveBeenCalledTimes(1))
    expect(commentsRef.current?.hasPendingMutations()).toBe(true)
    expect(textarea).toBeDisabled()
    expect(screen.getByPlaceholderText('Escribe el primer comentario del hilo')).toBeInTheDocument()

    request.resolve({ success: true, data: { success: true, thread: commentThread() } })
    expect(await screen.findByText('Comentario inicial')).toBeInTheDocument()
    expect(commentsRef.current?.hasPendingMutations()).toBe(false)
    expect(commentsRef.current?.hasUnsavedDrafts()).toBe(false)
    expect(commentsRef.current?.hasUnsavedWork()).toBe(false)
  })

  it('keeps a failed submitted body marked as unsaved after its request settles', async () => {
    const editor = editorAPI()
    const commentsRef = createRef<WhiteboardCommentsProviderHandle>()
    const request = deferred<{ success: boolean; status: number; error: string }>()
    apiMocks.createWhiteboardCommentThread.mockReturnValue(request.promise)

    render(<WhiteboardCommentsProvider ref={commentsRef} boardID="board-1" currentUserID="user-1" canComment editorAPI={editor.api}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    await screen.findByText('No hay comentarios abiertos')
    fireEvent.click(screen.getByRole('button', { name: 'Añadir' }))
    act(() => {
      editor.pointer()?.(
        { type: 'selection' },
        { hit: { element: null } },
        { button: 0, clientX: 100, clientY: 80, preventDefault: vi.fn(), stopPropagation: vi.fn() },
      )
    })
    const textarea = await screen.findByPlaceholderText('Escribe el primer comentario del hilo')
    fireEvent.change(textarea, { target: { value: 'No perder este borrador' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publicar' }))
    expect(commentsRef.current?.hasPendingMutations()).toBe(true)

    request.resolve({ success: false, status: 503, error: 'Temporalmente no disponible' })
    expect(await screen.findByText('Temporalmente no disponible')).toBeInTheDocument()
    expect(textarea).toHaveValue('No perder este borrador')
    expect(commentsRef.current?.hasPendingMutations()).toBe(false)
    expect(commentsRef.current?.hasUnsavedDrafts()).toBe(true)
    expect(commentsRef.current?.hasUnsavedWork()).toBe(true)
  })

  it('reloads canonical comments after a version conflict without losing the reply draft', async () => {
    const canonical = commentThread({
      version: 2,
      comments: [
        ...commentThread().comments,
        {
          ...commentThread().comments[0],
          id: 'comment-2',
          author_id: 'user-2',
          author_name: 'Bruno Díaz',
          body: 'Respuesta canónica',
          version: 1,
          created_at: '2026-08-14T10:01:00Z',
          updated_at: '2026-08-14T10:01:00Z',
        },
      ],
    })
    apiMocks.listWhiteboardCommentThreads
      .mockResolvedValueOnce({ success: true, data: { success: true, threads: [commentThread()], next_cursor: null } })
      .mockResolvedValueOnce({ success: true, data: { success: true, threads: [canonical], next_cursor: null } })
    apiMocks.replyToWhiteboardCommentThread.mockResolvedValue({
      success: false,
      status: 409,
      error: 'conflict',
    })

    render(<WhiteboardCommentsProvider boardID="board-1" currentUserID="user-1" canComment editorAPI={null}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    fireEvent.click(await screen.findByRole('button', { name: 'Responder' }))
    const textarea = screen.getByPlaceholderText('Escribe una respuesta')
    fireEvent.change(textarea, { target: { value: 'Mi respuesta pendiente' } })
    fireEvent.click(screen.getByRole('button', { name: 'Responder' }))

    await waitFor(() => expect(apiMocks.listWhiteboardCommentThreads).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Respuesta canónica')).toBeInTheDocument()
    expect(textarea).toHaveValue('Mi respuesta pendiente')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('El comentario cambió en otra sesión')
    expect(textarea).toHaveAttribute('aria-describedby', alert.id)
    expect(screen.queryByRole('button', { name: 'Recargar comentarios' })).not.toBeInTheDocument()
  })

  it('preserves a realtime thread received while the initial collection load is still pending', async () => {
    const request = deferred<{
      success: boolean
      data: { success: boolean; threads: WhiteboardCommentThread[]; next_cursor: null }
    }>()
    apiMocks.listWhiteboardCommentThreads.mockReturnValue(request.promise)
    const commentsRef = createRef<WhiteboardCommentsProviderHandle>()

    render(<WhiteboardCommentsProvider ref={commentsRef} boardID="board-1" currentUserID="user-1" canComment editorAPI={null}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    await waitFor(() => expect(apiMocks.listWhiteboardCommentThreads).toHaveBeenCalledTimes(1))
    act(() => commentsRef.current?.applyRealtimeEvent({
      action: 'upsert',
      board_id: 'board-1',
      thread: commentThread({ comments: [{ ...commentThread().comments[0], body: 'Llegó por realtime' }] }),
    }))
    expect(await screen.findByText('Llegó por realtime')).toBeInTheDocument()

    request.resolve({ success: true, data: { success: true, threads: [], next_cursor: null } })
    await waitFor(() => expect(screen.getByText('Llegó por realtime')).toBeInTheDocument())
  })

  it('reports a free-point focus target to the editor integration', async () => {
    const onFocusAnchor = vi.fn()
    apiMocks.listWhiteboardCommentThreads.mockResolvedValue({
      success: true,
      data: { success: true, threads: [commentThread()], next_cursor: null },
    })

    render(<WhiteboardCommentsProvider
      boardID="board-1"
      currentUserID="user-1"
      canComment
      editorAPI={null}
      onFocusAnchor={onFocusAnchor}
    >
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    fireEvent.click(await screen.findByRole('button', { name: 'Centrar este comentario en la pizarra' }))
    expect(onFocusAnchor).toHaveBeenCalledWith({
      threadID: 'thread-1',
      elementID: null,
      sceneX: 100,
      sceneY: 80,
      orphaned: false,
    })
  })

  it('reloads canonical threads when realtime degrades an oversized payload to refresh', async () => {
    const commentsRef = createRef<WhiteboardCommentsProviderHandle>()
    render(<WhiteboardCommentsProvider ref={commentsRef} boardID="board-1" currentUserID="user-1" canComment editorAPI={null}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    await waitFor(() => expect(apiMocks.listWhiteboardCommentThreads).toHaveBeenCalledTimes(1))
    act(() => commentsRef.current?.applyRealtimeEvent({ action: 'refresh', reason: 'realtime_payload_too_large' }))
    await waitFor(() => expect(apiMocks.listWhiteboardCommentThreads).toHaveBeenCalledTimes(2))
  })

  it('reconciles threads, counts and markers on reconnect without losing a draft', async () => {
    const initial = commentThread()
    const reconciled = commentThread({
      version: 2,
      comments: [...initial.comments, {
        ...initial.comments[0],
        id: 'comment-remote',
        author_id: 'user-2',
        body: 'Llegó durante la desconexión',
      }],
    })
    apiMocks.listWhiteboardCommentThreads
      .mockResolvedValueOnce({ success: true, data: { success: true, threads: [initial], next_cursor: null, counts: { open: 1, resolved: 0, all: 1 } } })
      .mockResolvedValue({ success: true, data: { success: true, threads: [reconciled], next_cursor: null, counts: { open: 2, resolved: 1, all: 3 } } })
    apiMocks.listWhiteboardCommentMarkers
      .mockResolvedValueOnce({ success: true, data: { success: true, markers: [], next_cursor: null } })
      .mockResolvedValue({ success: true, data: { success: true, markers: [{
        id: 'thread-2', board_id: 'board-1', element_id: null, anchor_x: 1, anchor_y: 2,
        anchor_ratio_x: null, anchor_ratio_y: null, version: 1, comment_count: 1,
        updated_at: '2026-08-14T11:00:00Z',
      }], next_cursor: null } })
    const commentsRef = createRef<WhiteboardCommentsProviderHandle>()
    const surface = (refreshKey: number) => <WhiteboardCommentsProvider
      ref={commentsRef}
      boardID="board-1"
      currentUserID="user-1"
      canComment
      editorAPI={null}
      refreshKey={refreshKey}
    ><WhiteboardCommentsPanel /></WhiteboardCommentsProvider>
    const rendered = render(surface(0))

    fireEvent.click(await screen.findByRole('button', { name: 'Responder' }))
    fireEvent.change(screen.getByPlaceholderText('Escribe una respuesta'), { target: { value: 'Borrador offline' } })
    rendered.rerender(surface(1))

    expect(await screen.findByText('Llegó durante la desconexión')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Escribe una respuesta')).toHaveValue('Borrador offline')
    await waitFor(() => expect(commentsRef.current?.getSummary()).toEqual({ open: 2, resolved: 1, all: 3 }))
    expect(apiMocks.listWhiteboardCommentMarkers).toHaveBeenCalledTimes(2)
  })

  it('adopts a canonical reconnect snapshot while replaying only the thread changed during its request', async () => {
    const stale = commentThread({
      id: 'thread-stale',
      comments: [{ ...commentThread().comments[0], id: 'comment-stale', thread_id: 'thread-stale', body: 'Debe desaparecer' }],
    })
    const active = commentThread({
      id: 'thread-active',
      comments: [{ ...commentThread().comments[0], id: 'comment-active', thread_id: 'thread-active', body: 'Versión inicial B' }],
    })
    const activeReply = commentThread({
      ...active,
      version: 2,
      updated_at: '2026-08-14T10:05:00Z',
      comments: [...active.comments, {
        ...active.comments[0],
        id: 'comment-active-reply',
        thread_id: 'thread-active',
        body: 'Respuesta concurrente B',
        version: 1,
      }],
    })
    const reconnect = deferred<any>()
    apiMocks.listWhiteboardCommentThreads
      .mockResolvedValueOnce({ success: true, data: { success: true, threads: [stale, active], next_cursor: null, counts: { open: 2, resolved: 0, all: 2 } } })
      .mockReturnValueOnce(reconnect.promise)
    apiMocks.listWhiteboardCommentMarkers
      .mockResolvedValueOnce({
        success: true,
        data: { success: true, markers: [whiteboardCommentMarkerFromThread(stale), whiteboardCommentMarkerFromThread(active)], next_cursor: null },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { success: true, markers: [whiteboardCommentMarkerFromThread(active)], next_cursor: null },
      })
    const commentsRef = createRef<WhiteboardCommentsProviderHandle>()
    const surface = (refreshKey: number) => <WhiteboardCommentsProvider
      ref={commentsRef}
      boardID="board-1"
      currentUserID="user-1"
      canComment
      editorAPI={null}
      refreshKey={refreshKey}
    ><WhiteboardCommentsPanel /></WhiteboardCommentsProvider>
    const rendered = render(surface(0))

    expect(await screen.findByText('Debe desaparecer')).toBeInTheDocument()
    rendered.rerender(surface(1))
    await waitFor(() => expect(apiMocks.listWhiteboardCommentThreads).toHaveBeenCalledTimes(2))
    act(() => commentsRef.current?.applyRealtimeEvent({
      action: 'comment.replied',
      board_id: 'board-1',
      thread: activeReply,
    }))
    await act(async () => {
      reconnect.resolve({
        success: true,
        data: { success: true, threads: [active], next_cursor: null, counts: { open: 1, resolved: 1, all: 2 } },
      })
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.queryByText('Debe desaparecer')).not.toBeInTheDocument())
    expect(screen.getByText('Respuesta concurrente B')).toBeInTheDocument()
    expect(commentsRef.current?.getSummary()).toEqual({ open: 1, resolved: 1, all: 2 })
    expect(apiMocks.listWhiteboardCommentThreads).toHaveBeenCalledTimes(2)
  })

  it('runs one canonical follow-up when an inventory event races a reconnect snapshot', async () => {
    const stale = commentThread({
      id: 'thread-offline-resolved',
      comments: [{ ...commentThread().comments[0], id: 'comment-offline', thread_id: 'thread-offline-resolved', body: 'Abierto antes de desconectar' }],
    })
    const created = commentThread({
      id: 'thread-created-during-reconnect',
      comments: [{ ...commentThread().comments[0], id: 'comment-created-race', thread_id: 'thread-created-during-reconnect', body: 'Creado durante reconexión' }],
    })
    const reconnect = deferred<any>()
    apiMocks.listWhiteboardCommentThreads
      .mockResolvedValueOnce({ success: true, data: { success: true, threads: [stale], next_cursor: null, counts: { open: 1, resolved: 0, all: 1 } } })
      .mockReturnValueOnce(reconnect.promise)
      .mockResolvedValueOnce({ success: true, data: { success: true, threads: [created], next_cursor: null, counts: { open: 1, resolved: 1, all: 2 } } })
    const commentsRef = createRef<WhiteboardCommentsProviderHandle>()
    const surface = (refreshKey: number) => <WhiteboardCommentsProvider
      ref={commentsRef}
      boardID="board-1"
      currentUserID="user-1"
      canComment
      editorAPI={null}
      refreshKey={refreshKey}
    ><WhiteboardCommentsPanel /></WhiteboardCommentsProvider>
    const rendered = render(surface(0))

    expect(await screen.findByText('Abierto antes de desconectar')).toBeInTheDocument()
    rendered.rerender(surface(1))
    await waitFor(() => expect(apiMocks.listWhiteboardCommentThreads).toHaveBeenCalledTimes(2))
    act(() => commentsRef.current?.applyRealtimeEvent({
      action: 'comment.thread_created',
      board_id: 'board-1',
      thread: created,
    }))
    await act(async () => {
      reconnect.resolve({
        success: true,
        data: { success: true, threads: [], next_cursor: null, counts: { open: 0, resolved: 1, all: 1 } },
      })
      await Promise.resolve()
    })

    await waitFor(() => expect(apiMocks.listWhiteboardCommentThreads).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(commentsRef.current?.getSummary()).toEqual({ open: 1, resolved: 1, all: 2 }))
    expect(screen.queryByText('Abierto antes de desconectar')).not.toBeInTheDocument()
    expect(screen.getByText('Creado durante reconexión')).toBeInTheDocument()
  })

  it('reloads after a version gap and restores exact counts after a missed resolve then reopen', async () => {
    const openV1 = commentThread({ id: 'thread-gap' })
    const reopenedV3 = commentThread({
      ...openV1,
      version: 3,
      updated_at: '2026-08-14T10:08:00Z',
    })
    apiMocks.listWhiteboardCommentThreads
      .mockResolvedValueOnce({ success: true, data: { success: true, threads: [openV1], next_cursor: null, counts: { open: 1, resolved: 0, all: 1 } } })
      .mockResolvedValueOnce({ success: true, data: { success: true, threads: [], next_cursor: null, counts: { open: 0, resolved: 1, all: 1 } } })
      .mockResolvedValueOnce({ success: true, data: { success: true, threads: [reopenedV3], next_cursor: null, counts: { open: 1, resolved: 0, all: 1 } } })
    apiMocks.listWhiteboardCommentMarkers
      .mockResolvedValueOnce({ success: true, data: { success: true, markers: [whiteboardCommentMarkerFromThread(openV1)], next_cursor: null } })
      .mockResolvedValueOnce({ success: true, data: { success: true, markers: [], next_cursor: null } })
      .mockResolvedValue({ success: true, data: { success: true, markers: [whiteboardCommentMarkerFromThread(reopenedV3)], next_cursor: null } })
    const commentsRef = createRef<WhiteboardCommentsProviderHandle>()
    const surface = (refreshKey: number) => <WhiteboardCommentsProvider
      ref={commentsRef}
      boardID="board-1"
      currentUserID="user-1"
      canComment
      editorAPI={null}
      refreshKey={refreshKey}
    ><WhiteboardCommentsPanel /></WhiteboardCommentsProvider>
    const rendered = render(surface(0))

    await screen.findByText('Comentario inicial')
    rendered.rerender(surface(1))
    await waitFor(() => expect(commentsRef.current?.getSummary()).toEqual({ open: 0, resolved: 1, all: 1 }))
    await waitFor(() => expect(apiMocks.listWhiteboardCommentMarkers).toHaveBeenCalledTimes(2))
    act(() => commentsRef.current?.applyRealtimeEvent({
      action: 'comment.reopened',
      board_id: 'board-1',
      thread: reopenedV3,
    }))

    await waitFor(() => expect(apiMocks.listWhiteboardCommentThreads).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(commentsRef.current?.getSummary()).toEqual({ open: 1, resolved: 0, all: 1 }))
    expect(screen.getByText('Comentario inicial')).toBeInTheDocument()
  })

  it('hydrates an absent draft-owned thread canonically without losing its text or double-counting status', async () => {
    const open = commentThread({ id: 'thread-draft-reconciled' })
    const resolved = commentThread({
      ...open,
      status: 'resolved',
      version: 2,
      updated_at: '2026-08-14T10:09:00Z',
    })
    apiMocks.listWhiteboardCommentThreads
      .mockResolvedValueOnce({ success: true, data: { success: true, threads: [open], next_cursor: null, counts: { open: 1, resolved: 0, all: 1 } } })
      .mockResolvedValueOnce({ success: true, data: { success: true, threads: [], next_cursor: null, counts: { open: 0, resolved: 1, all: 1 } } })
    apiMocks.listWhiteboardCommentMarkers
      .mockResolvedValueOnce({ success: true, data: { success: true, markers: [whiteboardCommentMarkerFromThread(open)], next_cursor: null } })
      .mockResolvedValueOnce({ success: true, data: { success: true, markers: [], next_cursor: null } })
    apiMocks.getWhiteboardCommentThread.mockResolvedValue({
      success: true,
      data: { success: true, thread: resolved },
    })
    const commentsRef = createRef<WhiteboardCommentsProviderHandle>()
    const surface = (refreshKey: number) => <WhiteboardCommentsProvider
      ref={commentsRef}
      boardID="board-1"
      currentUserID="user-1"
      canComment
      editorAPI={null}
      refreshKey={refreshKey}
    ><WhiteboardCommentsPanel /></WhiteboardCommentsProvider>
    const rendered = render(surface(0))

    fireEvent.click(await screen.findByRole('button', { name: 'Responder' }))
    fireEvent.change(screen.getByPlaceholderText('Escribe una respuesta'), {
      target: { value: 'Borrador preservado ante resolución remota' },
    })
    rendered.rerender(surface(1))

    await waitFor(() => expect(apiMocks.getWhiteboardCommentThread).toHaveBeenCalledWith({
      boardID: 'board-1',
      threadID: open.id,
      signal: expect.any(AbortSignal),
    }))
    await waitFor(() => expect(screen.queryByText('Comentario inicial')).not.toBeInTheDocument())
    expect(commentsRef.current?.hasUnsavedDrafts()).toBe(true)
    expect(commentsRef.current?.getSummary()).toEqual({ open: 0, resolved: 1, all: 1 })
    expect(apiMocks.listWhiteboardCommentThreads).toHaveBeenCalledTimes(2)
  })

  it('keeps a concurrent created marker when an older marker snapshot completes', async () => {
    installCommentPinLayout()
    const markerSnapshot = deferred<any>()
    apiMocks.listWhiteboardCommentMarkers.mockReturnValueOnce(markerSnapshot.promise)
    const created = commentThread({ id: 'thread-marker-created-race' })
    const commentsRef = createRef<WhiteboardCommentsProviderHandle>()
    const editor = editorAPI()
    const containerRef = createRef<HTMLDivElement>()
    render(<WhiteboardCommentsProvider ref={commentsRef} boardID="board-1" currentUserID="user-1" canComment editorAPI={editor.api}>
      <div ref={containerRef}><WhiteboardCommentPins containerRef={containerRef} /></div>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    await waitFor(() => expect(apiMocks.listWhiteboardCommentMarkers).toHaveBeenCalledTimes(1))
    act(() => commentsRef.current?.applyRealtimeEvent({
      action: 'comment.thread_created',
      board_id: 'board-1',
      thread: created,
    }))
    expect(await screen.findByRole('button', { name: /Abrir comentario 1, 1 mensaje/ })).toBeInTheDocument()
    await act(async () => {
      markerSnapshot.resolve({ success: true, data: { success: true, markers: [], next_cursor: null } })
      await Promise.resolve()
    })

    expect(await screen.findByRole('button', { name: /Abrir comentario 1, 1 mensaje/ })).toBeInTheDocument()
  })

  it('does not resurrect a marker resolved while a paginated marker snapshot is in flight', async () => {
    installCommentPinLayout()
    const open = commentThread({ id: 'thread-marker-resolved-race' })
    const resolved = commentThread({
      ...open,
      status: 'resolved',
      version: 2,
      updated_at: '2026-08-14T10:06:00Z',
    })
    const marker = {
      id: open.id,
      board_id: 'board-1',
      element_id: null,
      anchor_x: 100,
      anchor_y: 80,
      anchor_ratio_x: null,
      anchor_ratio_y: null,
      version: 1,
      comment_count: 1,
      updated_at: open.updated_at,
    }
    const secondMarkerPage = deferred<any>()
    apiMocks.listWhiteboardCommentThreads.mockResolvedValue({
      success: true,
      data: { success: true, threads: [open], next_cursor: null, counts: { open: 1, resolved: 0, all: 1 } },
    })
    apiMocks.listWhiteboardCommentMarkers
      .mockResolvedValueOnce({ success: true, data: { success: true, markers: [marker], next_cursor: 'marker-page-2' } })
      .mockReturnValueOnce(secondMarkerPage.promise)
    const commentsRef = createRef<WhiteboardCommentsProviderHandle>()
    const editor = editorAPI()
    const containerRef = createRef<HTMLDivElement>()
    render(<WhiteboardCommentsProvider ref={commentsRef} boardID="board-1" currentUserID="user-1" canComment editorAPI={editor.api}>
      <div ref={containerRef}><WhiteboardCommentPins containerRef={containerRef} /></div>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    await waitFor(() => expect(apiMocks.listWhiteboardCommentMarkers).toHaveBeenCalledTimes(2))
    act(() => commentsRef.current?.applyRealtimeEvent({
      action: 'comment.resolved',
      board_id: 'board-1',
      thread: resolved,
    }))
    await act(async () => {
      secondMarkerPage.resolve({ success: true, data: { success: true, markers: [], next_cursor: null } })
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.queryByRole('button', { name: /Abrir comentario/ })).not.toBeInTheDocument())
  })

  it('reconciles canonical counts for an unknown reopened realtime thread without increasing all', async () => {
    const commentsRef = createRef<WhiteboardCommentsProviderHandle>()
    const reopened = commentThread({ id: 'thread-reopened', version: 4 })
    apiMocks.listWhiteboardCommentThreads
      .mockResolvedValueOnce({ success: true, data: { success: true, threads: [], next_cursor: null, counts: { open: 2, resolved: 3, all: 5 } } })
      .mockResolvedValue({ success: true, data: { success: true, threads: [reopened], next_cursor: null, counts: { open: 3, resolved: 2, all: 5 } } })

    render(<WhiteboardCommentsProvider ref={commentsRef} boardID="board-1" currentUserID="user-1" canComment editorAPI={null}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    await waitFor(() => expect(commentsRef.current?.getSummary()).toEqual({ open: 2, resolved: 3, all: 5 }))
    act(() => commentsRef.current?.applyRealtimeEvent({
      action: 'comment.reopened',
      board_id: 'board-1',
      thread: reopened,
    }))
    expect(commentsRef.current?.getSummary().all).toBe(5)
    await waitFor(() => expect(commentsRef.current?.getSummary()).toEqual({ open: 3, resolved: 2, all: 5 }))
  })

  it('increments canonical inventory once for the real thread-created realtime action', async () => {
    const commentsRef = createRef<WhiteboardCommentsProviderHandle>()
    render(<WhiteboardCommentsProvider ref={commentsRef} boardID="board-1" currentUserID="user-1" canComment editorAPI={null}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)
    await waitFor(() => expect(apiMocks.listWhiteboardCommentThreads).toHaveBeenCalledTimes(1))

    const created = commentThread({ id: 'thread-realtime-created' })
    act(() => commentsRef.current?.applyRealtimeEvent({
      action: 'comment.thread_created',
      board_id: 'board-1',
      thread: created,
    }))
    act(() => commentsRef.current?.applyRealtimeEvent({
      action: 'comment.thread_created',
      board_id: 'board-1',
      thread: created,
    }))

    expect(commentsRef.current?.getSummary()).toEqual({ open: 1, resolved: 0, all: 1 })
    expect(apiMocks.listWhiteboardCommentThreads).toHaveBeenCalledTimes(1)
  })

  it('shows the canonical total and pages the rest of a long thread without duplicates', async () => {
    const initial = commentThread({
      comment_count: 7,
      comments_has_more: true,
      comments_next_cursor: 'cursor-5',
      comments: Array.from({ length: 5 }, (_, index) => ({
        ...commentThread().comments[0],
        id: `comment-${index + 1}`,
        body: `Mensaje ${index + 1}`,
        created_at: `2026-08-14T10:0${index}:00Z`,
        updated_at: `2026-08-14T10:0${index}:00Z`,
      })),
    })
    apiMocks.listWhiteboardCommentThreads.mockResolvedValue({
      success: true,
      data: { success: true, threads: [initial], next_cursor: null },
    })
    apiMocks.listWhiteboardThreadComments.mockResolvedValue({
      success: true,
      data: {
        success: true,
        comments: [
          { ...initial.comments[4] },
          { ...initial.comments[0], id: 'comment-6', body: 'Mensaje 6', created_at: '2026-08-14T10:05:00Z', updated_at: '2026-08-14T10:05:00Z' },
          { ...initial.comments[0], id: 'comment-7', body: 'Mensaje 7', created_at: '2026-08-14T10:06:00Z', updated_at: '2026-08-14T10:06:00Z' },
        ],
        next_cursor: null,
      },
    })

    render(<WhiteboardCommentsProvider boardID="board-1" currentUserID="user-1" canComment editorAPI={null}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    expect(await screen.findByText('7 mensajes')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cargar 2 mensajes restantes' }))
    expect(await screen.findByText('Mensaje 7')).toBeInTheDocument()
    expect(screen.getAllByText(/^Mensaje [1-7]$/)).toHaveLength(7)
    expect(screen.queryByRole('button', { name: /mensajes restantes/ })).not.toBeInTheDocument()
    expect(apiMocks.listWhiteboardThreadComments).toHaveBeenCalledWith({
      boardID: 'board-1',
      threadID: 'thread-1',
      cursor: 'cursor-5',
      limit: 100,
      signal: expect.any(AbortSignal),
    })
  })

  it('keeps a reply draft when the sidebar content unmounts and across remote filters', async () => {
    const openThread = commentThread()
    const resolvedThread = commentThread({ id: 'thread-2', status: 'resolved' })
    apiMocks.listWhiteboardCommentThreads.mockImplementation(({ status }: { status: string }) => Promise.resolve({
      success: true,
      data: {
        success: true,
        threads: status === 'resolved' ? [resolvedThread] : status === 'open' ? [openThread] : [openThread, resolvedThread],
        next_cursor: null,
        counts: { open: 1, resolved: 1, all: 2 },
      },
    }))

    const surface = (showPanel: boolean) => <WhiteboardCommentsProvider
      boardID="board-1"
      currentUserID="user-1"
      canComment
      editorAPI={null}
    >
      {showPanel ? <WhiteboardCommentsPanel /> : <div>Panel cerrado</div>}
    </WhiteboardCommentsProvider>
    const rendered = render(surface(true))

    fireEvent.click(await screen.findByRole('button', { name: 'Responder' }))
    fireEvent.change(screen.getByPlaceholderText('Escribe una respuesta'), {
      target: { value: 'Borrador que debe sobrevivir' },
    })
    fireEvent.click(screen.getByRole('tab', { name: /Resueltos/ }))
    expect(await screen.findByText('Comentario inicial')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Escribe una respuesta')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /Abiertos/ }))
    expect(await screen.findByPlaceholderText('Escribe una respuesta')).toHaveValue('Borrador que debe sobrevivir')

    rendered.rerender(surface(false))
    expect(screen.getByText('Panel cerrado')).toBeInTheDocument()
    rendered.rerender(surface(true))
    expect(await screen.findByPlaceholderText('Escribe una respuesta')).toHaveValue('Borrador que debe sobrevivir')
  })

  it('keeps a draft-owned thread reachable when a filter reload no longer includes it in the first page', async () => {
    const olderThread = commentThread()
    const newestThread = commentThread({
      id: 'thread-newest',
      comments: [{
        ...commentThread().comments[0],
        id: 'comment-newest',
        thread_id: 'thread-newest',
        body: 'Comentario más reciente',
      }],
    })
    const resolvedThread = commentThread({ id: 'thread-resolved', status: 'resolved' })
    let openLoads = 0
    apiMocks.listWhiteboardCommentThreads.mockImplementation(({ status }: { status: string }) => {
      if (status === 'resolved') {
        return Promise.resolve({
          success: true,
          data: { success: true, threads: [resolvedThread], next_cursor: null, counts: { open: 41, resolved: 1, all: 42 } },
        })
      }
      openLoads += 1
      return Promise.resolve({
        success: true,
        data: {
          success: true,
          threads: openLoads === 1 ? [olderThread] : [newestThread],
          next_cursor: openLoads === 1 ? null : 'older-open-page',
          counts: { open: 41, resolved: 1, all: 42 },
        },
      })
    })

    render(<WhiteboardCommentsProvider boardID="board-1" currentUserID="user-1" canComment editorAPI={null}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    fireEvent.click(await screen.findByRole('button', { name: 'Responder' }))
    fireEvent.change(screen.getByPlaceholderText('Escribe una respuesta'), {
      target: { value: 'Borrador del hilo paginado' },
    })
    fireEvent.click(screen.getByRole('tab', { name: /Resueltos/ }))
    await screen.findByRole('button', { name: 'Reabrir hilo' })
    fireEvent.click(screen.getByRole('tab', { name: /Abiertos/ }))

    expect(await screen.findByText('Comentario más reciente')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Escribe una respuesta')).toHaveValue('Borrador del hilo paginado')
    expect(screen.getByText('Comentario inicial')).toBeInTheDocument()
  })

  it('keeps the original edit version and body after a concurrent 409', async () => {
    const initial = commentThread()
    const concurrent = commentThread({
      version: 2,
      updated_at: '2026-08-14T10:02:00Z',
      comments: [{
        ...initial.comments[0],
        body: 'Cambio de otra sesión',
        version: 2,
        updated_at: '2026-08-14T10:02:00Z',
      }],
    })
    apiMocks.listWhiteboardCommentThreads
      .mockResolvedValueOnce({ success: true, data: { success: true, threads: [initial], next_cursor: null, counts: { open: 1, resolved: 0, all: 1 } } })
      .mockResolvedValue({ success: true, data: { success: true, threads: [concurrent], next_cursor: null, counts: { open: 1, resolved: 0, all: 1 } } })
    apiMocks.updateWhiteboardComment.mockResolvedValue({ success: false, status: 409, error: 'conflict' })
    const commentsRef = createRef<WhiteboardCommentsProviderHandle>()

    render(<WhiteboardCommentsProvider ref={commentsRef} boardID="board-1" currentUserID="user-1" canComment editorAPI={null}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    fireEvent.click(await screen.findByRole('button', { name: 'Editar' }))
    const textarea = screen.getByPlaceholderText('Edita tu comentario')
    fireEvent.change(textarea, { target: { value: 'Mi edición pendiente' } })
    act(() => commentsRef.current?.applyRealtimeEvent({ action: 'upsert', board_id: 'board-1', thread: concurrent }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() => expect(apiMocks.updateWhiteboardComment).toHaveBeenCalledWith(expect.objectContaining({
      commentID: 'comment-1',
      expectedVersion: 1,
      body: 'Mi edición pendiente',
    })))
    expect(await screen.findByPlaceholderText('Edita tu comentario')).toHaveValue('Mi edición pendiente')
    const alerts = await screen.findAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toHaveTextContent('El comentario cambió en otra sesión')
  })

  it('switches creation from Resueltos to Abiertos and focuses the canonical new thread', async () => {
    const editor = editorAPI()
    const onFocusAnchor = vi.fn()
    const resolved = commentThread({ status: 'resolved' })
    const created = commentThread({
      id: 'thread-new',
      comments: [{ ...commentThread().comments[0], id: 'comment-new', thread_id: 'thread-new', body: 'Nuevo abierto' }],
    })
    let createdPersisted = false
    apiMocks.listWhiteboardCommentThreads.mockImplementation(async ({ status }: { status: string }) => {
      await Promise.resolve()
      return {
        success: true,
        data: {
          success: true,
          threads: status === 'resolved' ? [resolved] : createdPersisted ? [created] : [],
          next_cursor: null,
          counts: { open: createdPersisted ? 1 : 0, resolved: 1, all: createdPersisted ? 2 : 1 },
        },
      }
    })
    apiMocks.createWhiteboardCommentThread.mockImplementation(() => {
      createdPersisted = true
      return Promise.resolve({ success: true, data: { success: true, thread: created } })
    })

    render(<WhiteboardCommentsProvider boardID="board-1" currentUserID="user-1" canComment editorAPI={editor.api} onFocusAnchor={onFocusAnchor}>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    fireEvent.click(await screen.findByRole('tab', { name: /Resueltos/ }))
    await screen.findByText('Comentario inicial')
    fireEvent.click(screen.getByRole('button', { name: 'Añadir' }))
    expect(screen.getByRole('tab', { name: /Abiertos/ })).toHaveAttribute('aria-selected', 'true')
    act(() => {
      editor.pointer()?.(
        { type: 'selection' },
        { hit: { element: null } },
        { button: 0, clientX: 30, clientY: 40, preventDefault: vi.fn(), stopPropagation: vi.fn() },
      )
    })
    fireEvent.change(await screen.findByPlaceholderText('Escribe el primer comentario del hilo'), { target: { value: 'Nuevo abierto' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publicar' }))

    await waitFor(() => expect(screen.getByText('Nuevo abierto')).toBeInTheDocument())
    expect(onFocusAnchor).toHaveBeenCalledWith(expect.objectContaining({ threadID: 'thread-new' }))
  })

  it('pages all lightweight markers and hydrates a missing thread when its pin is pressed', async () => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400,
      toJSON: () => ({}),
    })
    apiMocks.listWhiteboardCommentThreads.mockResolvedValue({
      success: true,
      data: { success: true, threads: [], next_cursor: null, counts: { open: 2, resolved: 0, all: 2 } },
    })
    const marker = {
      id: 'thread-marker', board_id: 'board-1', element_id: null, anchor_x: 100, anchor_y: 80,
      anchor_ratio_x: null, anchor_ratio_y: null, version: 1, comment_count: 1,
      updated_at: '2026-08-14T10:00:00Z',
    }
    apiMocks.listWhiteboardCommentMarkers
      .mockResolvedValueOnce({ success: true, data: { success: true, markers: [marker], next_cursor: 'next-markers' } })
      .mockResolvedValueOnce({ success: true, data: { success: true, markers: [{ ...marker, id: 'thread-marker-2', updated_at: '2026-08-14T09:00:00Z' }], next_cursor: null } })
    apiMocks.getWhiteboardCommentThread.mockResolvedValue({
      success: true,
      data: { success: true, thread: commentThread({ id: 'thread-marker', comments: [{ ...commentThread().comments[0], thread_id: 'thread-marker', body: 'Hilo hidratado' }] }) },
    })
    const editor = editorAPI()
    const containerRef = createRef<HTMLDivElement>()

    render(<WhiteboardCommentsProvider boardID="board-1" currentUserID="user-1" canComment editorAPI={editor.api}>
      <div ref={containerRef}><WhiteboardCommentPins containerRef={containerRef} /></div>
      <WhiteboardCommentsPanel />
    </WhiteboardCommentsProvider>)

    const pin = await screen.findByRole('button', { name: /Abrir comentario 1, 1 mensaje/ })
    await waitFor(() => expect(apiMocks.listWhiteboardCommentMarkers).toHaveBeenCalledTimes(2))
    fireEvent.click(pin)
    expect(await screen.findByText('Hilo hidratado')).toBeInTheDocument()
    expect(apiMocks.getWhiteboardCommentThread).toHaveBeenCalledWith({
      boardID: 'board-1',
      threadID: 'thread-marker',
      signal: expect.any(AbortSignal),
    })
    await waitFor(() => expect(document.activeElement).toHaveAttribute('aria-label', 'Centrar este comentario en la pizarra'))

    // Reopening from the same pin must restore focus even though the thread is
    // already active and React would otherwise skip an identical state value.
    pin.focus()
    expect(document.activeElement).toBe(pin)
    fireEvent.click(pin)
    await waitFor(() => expect(document.activeElement).toHaveAttribute('aria-label', 'Centrar este comentario en la pizarra'))
  })

  it('exposes canonical counts through the provider summary callback and handle', async () => {
    const commentsRef = createRef<WhiteboardCommentsProviderHandle>()
    const onSummaryChange = vi.fn()
    apiMocks.listWhiteboardCommentThreads.mockResolvedValue({
      success: true,
      data: { success: true, threads: [], next_cursor: null, counts: { open: 7, resolved: 3, all: 10 } },
    })
    render(<WhiteboardCommentsProvider
      ref={commentsRef}
      boardID="board-1"
      currentUserID="user-1"
      canComment
      editorAPI={null}
      onSummaryChange={onSummaryChange}
    ><WhiteboardCommentsPanel /></WhiteboardCommentsProvider>)

    await waitFor(() => expect(commentsRef.current?.getSummary()).toEqual({ open: 7, resolved: 3, all: 10 }))
    expect(onSummaryChange).toHaveBeenLastCalledWith({ open: 7, resolved: 3, all: 10 })
    expect(screen.getByRole('tab', { name: 'Abiertos 7' })).toBeInTheDocument()
  })
})
