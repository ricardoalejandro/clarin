import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { AppState, ExcalidrawImperativeAPI, OnUserFollowedPayload } from '@excalidraw/excalidraw/types'
import type { WhiteboardRealtimeRoom } from '@/lib/whiteboardsApi'
import { useWhiteboardPresentation } from '@/hooks/useWhiteboardPresentation'

function presentationFixture() {
  return {
    presentation_id: 'presentation-1',
    actor: { id: 'presenter-1', kind: 'user', display_name: 'Ana', access: 'edit' },
    started_at: '2026-08-17T10:00:00Z',
  }
}

function editorFixture() {
  let followListener: ((payload: OnUserFollowedPayload) => void) | null = null
  let scrollListener: (() => void) | null = null
  let appState = {
    width: 800,
    height: 600,
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
    userToFollow: null,
    followedBy: new Set(),
  } as unknown as AppState
  const updateScene = vi.fn((update: { appState?: Partial<AppState> }) => {
    const previousFollow = appState.userToFollow
    appState = { ...appState, ...(update.appState || {}) } as AppState
    if (previousFollow !== appState.userToFollow) {
      if (previousFollow) followListener?.({ userToFollow: previousFollow, action: 'UNFOLLOW' })
      if (appState.userToFollow) followListener?.({ userToFollow: appState.userToFollow, action: 'FOLLOW' })
    }
  })
  const api = {
    getAppState: () => appState,
    updateScene,
    onUserFollow: (listener: (payload: OnUserFollowedPayload) => void) => {
      followListener = listener
      return () => { followListener = null }
    },
    onScrollChange: (listener: () => void) => {
      scrollListener = listener
      return () => { scrollListener = null }
    },
  } as unknown as ExcalidrawImperativeAPI
  return {
    api,
    updateScene,
    getAppState: () => appState,
    follow: (socketId: string, username = '') => updateScene({ appState: { userToFollow: { socketId, username } } as Partial<AppState> }),
    unfollow: () => updateScene({ appState: { userToFollow: null } as Partial<AppState> }),
    scroll: () => scrollListener?.(),
  }
}

function roomFixture() {
  return {
    isOpen: vi.fn(() => true),
    requestSync: vi.fn(),
    sendPatch: vi.fn(),
    sendCursor: vi.fn(),
    sendPresence: vi.fn(),
    startPresentation: vi.fn(),
    stopPresentation: vi.fn(),
    sendFollow: vi.fn(() => true),
    sendViewport: vi.fn(() => true),
    close: vi.fn(),
  } as unknown as WhiteboardRealtimeRoom
}

describe('useWhiteboardPresentation', () => {
  afterEach(cleanup)

  it('connects invitation consent, native avatar follow and viewport replay without capture', async () => {
    const editor = editorFixture()
    const room = roomFixture()
    const roomRef = { current: room }
    const runWithTransientSceneSuppressed = (update: () => void) => update()
    const { result } = renderHook(() => useWhiteboardPresentation({
      editorAPI: editor.api,
      roomRef,
      canPresent: true,
      runWithTransientSceneSuppressed,
    }))

    act(() => {
      result.current.handleRealtimeEvent({ event: 'room.ready', actor: { id: 'viewer-1', kind: 'user', display_name: 'Luis', access: 'edit' } })
      result.current.handleRealtimeEvent({ event: 'presentation.snapshot', data: { presentation: presentationFixture() } })
    })
    expect(result.current.showInvitation).toBe(true)

    act(() => result.current.acceptInvitation())
    expect(room.sendFollow).toHaveBeenCalledWith('presenter-1', 'FOLLOW')
    expect(editor.updateScene).toHaveBeenCalledWith(expect.objectContaining({ captureUpdate: CaptureUpdateAction.NEVER }))

    act(() => {
      result.current.handleRealtimeEvent({
        event: 'follow.change',
        actor: { id: 'viewer-2', kind: 'guest', display_name: 'Marta', access: 'view' },
        data: { target_actor_id: 'viewer-1', action: 'FOLLOW' },
      })
    })
    await waitFor(() => expect(room.sendViewport).toHaveBeenCalled())

    act(() => {
      result.current.handleRealtimeEvent({
        event: 'viewport.update',
        actor: presentationFixture().actor,
        data: { bounds: [100, 50, 500, 350] },
      })
    })
    expect(editor.updateScene).toHaveBeenLastCalledWith(expect.objectContaining({ captureUpdate: CaptureUpdateAction.NEVER }))

    act(() => editor.scroll())
    expect(room.sendViewport).toHaveBeenCalledWith(expect.any(Array))
  })

  it('suppresses self-follow synchronously and preserves one remote unfollow', () => {
    const editor = editorFixture()
    const room = roomFixture()
    const roomRef = { current: room }
    const { result } = renderHook(() => useWhiteboardPresentation({
      editorAPI: editor.api,
      roomRef,
      canPresent: true,
      runWithTransientSceneSuppressed: update => update(),
    }))

    act(() => {
      result.current.handleRealtimeEvent({
        event: 'room.ready',
        actor: { id: 'viewer-1', kind: 'user', display_name: 'Luis', access: 'edit' },
      })
      editor.follow('viewer-1', 'Luis')
    })

    expect(result.current.getSelfActorID()).toBe('viewer-1')
    expect(room.sendFollow).not.toHaveBeenCalled()
    expect(editor.getAppState().userToFollow).toBeNull()
    expect(editor.updateScene).toHaveBeenLastCalledWith(expect.objectContaining({ captureUpdate: CaptureUpdateAction.NEVER }))

    act(() => {
      result.current.handleConnectionChange('closed')
      result.current.handleRealtimeEvent({
        event: 'room.ready',
        actor: { id: 'viewer-2', kind: 'user', display_name: 'Luis', access: 'edit' },
      })
    })
    expect(result.current.getSelfActorID()).toBe('viewer-2')

    act(() => editor.follow('presenter-1', 'Ana'))
    expect(room.sendFollow).toHaveBeenLastCalledWith('presenter-1', 'FOLLOW')
    vi.mocked(room.sendFollow).mockClear()

    act(() => editor.unfollow())
    expect(room.sendFollow).toHaveBeenCalledTimes(1)
    expect(room.sendFollow).toHaveBeenCalledWith('presenter-1', 'UNFOLLOW')
  })
})
