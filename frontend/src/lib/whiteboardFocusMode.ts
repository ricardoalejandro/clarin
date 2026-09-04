import type { AppState } from '@excalidraw/excalidraw/types'

export const WHITEBOARD_FOCUS_SHORTCUT_LABEL = 'Ctrl/Cmd + Shift + F'
export const WHITEBOARD_FOCUS_ARIA_SHORTCUTS = 'Control+Shift+F Meta+Shift+F'
export const WHITEBOARD_FOCUS_HISTORY_KEY = '__clarin_whiteboard_focus__'

export const WHITEBOARD_OVERLAY_LAYERS = {
  focusSurface: 250,
  focusPopover: 300,
  dialog: 310,
} as const

export interface WhiteboardFocusHistoryMarker {
  boardID: string
  token: string
}

function historyStateObject(state: unknown): Record<string, unknown> {
  return state !== null && typeof state === 'object' && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {}
}

export function whiteboardFocusHistoryMarker(
  state: unknown,
  boardID?: string,
): WhiteboardFocusHistoryMarker | null {
  const value = historyStateObject(state)[WHITEBOARD_FOCUS_HISTORY_KEY]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const marker = value as Record<string, unknown>
  if (typeof marker.boardID !== 'string' || typeof marker.token !== 'string') return null
  if (!marker.boardID || !marker.token || (boardID && marker.boardID !== boardID)) return null
  return { boardID: marker.boardID, token: marker.token }
}

export function withWhiteboardFocusHistoryMarker(
  state: unknown,
  marker: WhiteboardFocusHistoryMarker,
) {
  return {
    ...historyStateObject(state),
    [WHITEBOARD_FOCUS_HISTORY_KEY]: marker,
  }
}

export function withoutWhiteboardFocusHistoryMarker(state: unknown) {
  const current = historyStateObject(state)
  if (!(WHITEBOARD_FOCUS_HISTORY_KEY in current)) return state
  const next = { ...current }
  delete next[WHITEBOARD_FOCUS_HISTORY_KEY]
  return next
}

export function isWhiteboardFocusShortcut(event: Pick<KeyboardEvent,
  'altKey' | 'ctrlKey' | 'isComposing' | 'key' | 'metaKey' | 'repeat' | 'shiftKey'
>) {
  return !event.repeat
    && !event.isComposing
    && !event.altKey
    && event.shiftKey
    && event.ctrlKey !== event.metaKey
    && event.key.toLocaleLowerCase('en') === 'f'
}

export function whiteboardFocusTargetIsWritable(target: EventTarget | null) {
  return Boolean(target instanceof HTMLElement
    && (target.matches('input, textarea, select') || target.isContentEditable))
}

export function whiteboardFocusAppStateOwnsEscape(appState: Partial<AppState> | null | undefined) {
  return Boolean(appState && (
    appState.openMenu
    || appState.openPopup
    || appState.openDialog
    || appState.openSidebar
    || appState.contextMenu
    || appState.editingTextElement
    || appState.editingLinearElement
    || appState.activeEmbeddable
  ))
}

interface InertMutation {
  element: HTMLElement
  alreadyInert: boolean
}

/**
 * Makes every sibling outside the path to the focused editor inert without
 * moving or recreating the editor. Only attributes introduced here are
 * removed on restore, so pre-existing modal isolation remains authoritative.
 */
export function isolateWhiteboardFocusSurface(root: HTMLElement) {
  const mutations: InertMutation[] = []
  let current: HTMLElement | null = root

  while (current && current !== document.body) {
    const parent: HTMLElement | null = current.parentElement
    if (!parent) break
    for (const sibling of Array.from(parent.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === current) continue
      const alreadyInert = sibling.hasAttribute('inert')
      mutations.push({ element: sibling, alreadyInert })
      if (!alreadyInert) sibling.setAttribute('inert', '')
    }
    current = parent
  }

  return () => {
    for (const mutation of mutations) {
      if (!mutation.alreadyInert) mutation.element.removeAttribute('inert')
    }
  }
}

export function whiteboardOverlayIsAbove(
  layer: keyof typeof WHITEBOARD_OVERLAY_LAYERS,
  owner: keyof typeof WHITEBOARD_OVERLAY_LAYERS,
) {
  return WHITEBOARD_OVERLAY_LAYERS[layer] > WHITEBOARD_OVERLAY_LAYERS[owner]
}
