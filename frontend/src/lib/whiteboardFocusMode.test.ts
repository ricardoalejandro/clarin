import { afterEach, describe, expect, it } from 'vitest'
import {
  WHITEBOARD_FOCUS_HISTORY_KEY,
  WHITEBOARD_OVERLAY_LAYERS,
  isWhiteboardFocusShortcut,
  isolateWhiteboardFocusSurface,
  whiteboardFocusAppStateOwnsEscape,
  whiteboardFocusHistoryMarker,
  whiteboardFocusTargetIsWritable,
  whiteboardOverlayIsAbove,
  withWhiteboardFocusHistoryMarker,
  withoutWhiteboardFocusHistoryMarker,
} from './whiteboardFocusMode'

describe('whiteboardFocusMode', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('adds and removes only its own browser-history marker', () => {
    const original = { __NA: true, work: { selected: 'view-1' } }
    const marker = { boardID: 'board-1', token: 'focus-1' }
    const focused = withWhiteboardFocusHistoryMarker(original, marker)

    expect(focused).toEqual({
      ...original,
      [WHITEBOARD_FOCUS_HISTORY_KEY]: marker,
    })
    expect(whiteboardFocusHistoryMarker(focused, 'board-1')).toEqual(marker)
    expect(whiteboardFocusHistoryMarker(focused, 'board-2')).toBeNull()
    expect(withoutWhiteboardFocusHistoryMarker(focused)).toEqual(original)
    expect(withoutWhiteboardFocusHistoryMarker(original)).toBe(original)
  })

  it('recognizes only the collision-free Ctrl/Cmd Shift F shortcut', () => {
    const keyboard = {
      altKey: false,
      ctrlKey: true,
      isComposing: false,
      key: 'F',
      metaKey: false,
      repeat: false,
      shiftKey: true,
    }
    expect(isWhiteboardFocusShortcut(keyboard)).toBe(true)
    expect(isWhiteboardFocusShortcut({ ...keyboard, ctrlKey: false, metaKey: true })).toBe(true)
    expect(isWhiteboardFocusShortcut({ ...keyboard, metaKey: true })).toBe(false)
    expect(isWhiteboardFocusShortcut({ ...keyboard, shiftKey: false })).toBe(false)
    expect(isWhiteboardFocusShortcut({ ...keyboard, repeat: true })).toBe(false)
    expect(isWhiteboardFocusShortcut({ ...keyboard, isComposing: true })).toBe(false)
    expect(isWhiteboardFocusShortcut({ ...keyboard, altKey: true })).toBe(false)
    expect(isWhiteboardFocusShortcut({ ...keyboard, key: 'G' })).toBe(false)
  })

  it('gives writable fields and transient Excalidraw surfaces first Escape ownership', () => {
    const input = document.createElement('input')
    const canvas = document.createElement('div')
    expect(whiteboardFocusTargetIsWritable(input)).toBe(true)
    expect(whiteboardFocusTargetIsWritable(canvas)).toBe(false)
    expect(whiteboardFocusAppStateOwnsEscape({ openMenu: 'canvas' })).toBe(true)
    expect(whiteboardFocusAppStateOwnsEscape({ openPopup: 'fontFamily' })).toBe(true)
    expect(whiteboardFocusAppStateOwnsEscape({ openSidebar: { name: 'default', tab: 'library' } })).toBe(true)
    expect(whiteboardFocusAppStateOwnsEscape({ openMenu: null, openPopup: null, openDialog: null, openSidebar: null })).toBe(false)
  })

  it('isolates every external sibling and restores pre-existing inert state exactly', () => {
    const app = document.createElement('div')
    const dashboardSidebar = document.createElement('aside')
    const workspace = document.createElement('main')
    const workHeader = document.createElement('header')
    const editor = document.createElement('section')
    const preservedModal = document.createElement('div')
    preservedModal.setAttribute('inert', '')
    workspace.append(workHeader, editor)
    app.append(dashboardSidebar, workspace)
    document.body.append(app, preservedModal)

    const restore = isolateWhiteboardFocusSurface(editor)
    expect(workHeader).toHaveAttribute('inert')
    expect(dashboardSidebar).toHaveAttribute('inert')
    expect(preservedModal).toHaveAttribute('inert')
    expect(editor).not.toHaveAttribute('inert')

    restore()
    expect(workHeader).not.toHaveAttribute('inert')
    expect(dashboardSidebar).not.toHaveAttribute('inert')
    expect(preservedModal).toHaveAttribute('inert')
  })

  it('keeps the focused surface below its popover and dialogs', () => {
    expect(WHITEBOARD_OVERLAY_LAYERS.focusSurface).toBe(250)
    expect(whiteboardOverlayIsAbove('focusPopover', 'focusSurface')).toBe(true)
    expect(whiteboardOverlayIsAbove('dialog', 'focusPopover')).toBe(true)
  })
})
