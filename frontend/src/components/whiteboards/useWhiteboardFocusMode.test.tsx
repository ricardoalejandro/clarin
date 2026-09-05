import { act, cleanup, fireEvent, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { WHITEBOARD_FOCUS_HISTORY_KEY, whiteboardFocusHistoryMarker } from '@/lib/whiteboardFocusMode'
import { useWhiteboardFocusMode } from '@/hooks/useWhiteboardFocusMode'

function fixture(blocked = vi.fn(() => false)) {
  const app = document.createElement('div')
  const dashboard = document.createElement('aside')
  const workspace = document.createElement('main')
  const editor = document.createElement('section')
  const moreButton = document.createElement('button')
  moreButton.textContent = 'Más acciones'
  editor.append(moreButton)
  workspace.append(editor)
  app.append(dashboard, workspace)
  document.body.append(app)
  const refresh = vi.fn()
  const editorAPI = { refresh } as unknown as ExcalidrawImperativeAPI
  const hook = renderHook(() => useWhiteboardFocusMode({
    boardID: 'board-1',
    ready: true,
    rootRef: { current: editor },
    fallbackFocusRef: { current: moreButton },
    editorAPI,
    isInteractionBlocked: blocked,
  }))
  return { ...hook, app, blocked, dashboard, editor, moreButton, refresh }
}

describe('useWhiteboardFocusMode', () => {
  afterEach(() => {
    cleanup()
    window.history.replaceState({}, '', '/dashboard/whiteboards/board-1')
    document.body.replaceChildren()
  })

  it('pushes one same-route history entry, isolates Clarin and restores on browser Back', async () => {
    const route = '/dashboard/tasks?work_view=view-1'
    const initialState = { __NA: true, workState: 'preserved' }
    window.history.replaceState(initialState, '', route)
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const rendered = fixture()

    act(() => {
      rendered.moreButton.focus()
      rendered.result.current.enter(rendered.moreButton)
    })

    expect(rendered.result.current.active).toBe(true)
    expect(window.location.pathname + window.location.search).toBe(route)
    expect(whiteboardFocusHistoryMarker(window.history.state, 'board-1')).toEqual(expect.objectContaining({ boardID: 'board-1' }))
    expect(window.history.state).toMatchObject(initialState)
    await waitFor(() => expect(rendered.dashboard).toHaveAttribute('inert'))
    expect(rendered.editor).not.toHaveAttribute('inert')

    act(() => { rendered.result.current.exit() })
    expect(historyBack).toHaveBeenCalledTimes(1)
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: initialState }))
    })

    expect(rendered.result.current.active).toBe(false)
    await waitFor(() => expect(rendered.dashboard).not.toHaveAttribute('inert'))
    await waitFor(() => expect(rendered.moreButton).toHaveFocus())
    await waitFor(() => expect(rendered.refresh).toHaveBeenCalled())
  })

  it('re-enters on browser Forward and clears only its marker before real navigation', () => {
    window.history.replaceState({ __NA: true }, '', '/dashboard/whiteboards/board-1')
    const rendered = fixture()
    act(() => { rendered.result.current.enter(rendered.moreButton) })
    const focusedState = window.history.state
    const marker = focusedState[WHITEBOARD_FOCUS_HISTORY_KEY]

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: { __NA: true } }))
      window.dispatchEvent(new PopStateEvent('popstate', { state: focusedState }))
    })
    expect(rendered.result.current.active).toBe(true)
    expect(whiteboardFocusHistoryMarker(focusedState, 'board-1')).toEqual(marker)

    act(() => { rendered.result.current.clearBeforeNavigation() })
    expect(rendered.result.current.active).toBe(false)
    expect(window.history.state).toEqual({ __NA: true })
  })

  it('cleans its marker on a real page exit without touching unrelated history state', () => {
    const initialState = { __NA: true, workState: 'preserved' }
    window.history.replaceState(initialState, '', '/dashboard/tasks?work_view=view-1')
    const rendered = fixture()
    act(() => { rendered.result.current.enter(rendered.moreButton) })

    act(() => { window.dispatchEvent(new Event('pagehide')) })

    expect(window.history.state).toEqual(initialState)
    expect(rendered.result.current.active).toBe(true)
    act(() => { window.dispatchEvent(new Event('pageshow')) })
    expect(rendered.result.current.active).toBe(false)
  })

  it('restores locally when its history marker is no longer the current entry', () => {
    const initialState = { __NA: true, workState: 'preserved' }
    window.history.replaceState(initialState, '', '/dashboard/tasks?work_view=view-1')
    const rendered = fixture()
    act(() => { rendered.result.current.enter(rendered.moreButton) })
    window.history.replaceState(initialState, '', window.location.href)

    act(() => { rendered.result.current.exit() })

    expect(rendered.result.current.active).toBe(false)
    expect(window.history.state).toEqual(initialState)
  })

  it('toggles with Ctrl/Cmd Shift F and ignores repeats, composition and blocked layers', () => {
    window.history.replaceState({}, '', '/dashboard/whiteboards/board-1')
    const blocked = vi.fn(() => true)
    const rendered = fixture(blocked)

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true, shiftKey: true })
    expect(rendered.result.current.active).toBe(false)

    blocked.mockReturnValue(false)
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true, shiftKey: true, repeat: true })
    fireEvent.keyDown(document, { key: 'f', metaKey: true, shiftKey: true, isComposing: true })
    expect(rendered.result.current.active).toBe(false)

    fireEvent.keyDown(document, { key: 'f', metaKey: true, shiftKey: true })
    expect(rendered.result.current.active).toBe(true)
    expect(rendered.result.current.announcement).toContain('Control o Comando')
    expect(rendered.result.current.announcement).not.toContain('Escape')

    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    fireEvent.keyDown(document, { key: 'f', ctrlKey: true, shiftKey: true })
    expect(historyBack).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape to the editor without restoring the focused view', () => {
    window.history.replaceState({}, '', '/dashboard/whiteboards/board-1')
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const blocked = vi.fn(() => false)
    const rendered = fixture(blocked)
    act(() => { rendered.result.current.enter(rendered.moreButton) })

    const input = document.createElement('input')
    const canvas = document.createElement('div')
    rendered.editor.append(input, canvas)
    const editorEscape = vi.fn()
    canvas.addEventListener('keydown', editorEscape)

    fireEvent.keyDown(canvas, { key: 'Escape' })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(historyBack).not.toHaveBeenCalled()
    expect(rendered.result.current.active).toBe(true)
    expect(editorEscape).toHaveBeenCalledTimes(1)
  })
})
