'use client'

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import {
  isWhiteboardFocusShortcut,
  isolateWhiteboardFocusSurface,
  whiteboardFocusHistoryMarker,
  withWhiteboardFocusHistoryMarker,
  withoutWhiteboardFocusHistoryMarker,
  type WhiteboardFocusHistoryMarker,
} from '@/lib/whiteboardFocusMode'

const WHITEBOARD_FOCUS_ACTIVE_ANNOUNCEMENT = 'Pizarra maximizada. Usa Control o Comando más Mayúsculas más F para volver a la vista normal.'

export interface UseWhiteboardFocusModeOptions {
  boardID: string
  ready: boolean
  rootRef: RefObject<HTMLElement>
  fallbackFocusRef: RefObject<HTMLElement>
  editorAPI: ExcalidrawImperativeAPI | null
  isInteractionBlocked: () => boolean
}

function createFocusToken() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `focus-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function useWhiteboardFocusMode({
  boardID,
  ready,
  rootRef,
  fallbackFocusRef,
  editorAPI,
  isInteractionBlocked,
}: UseWhiteboardFocusModeOptions) {
  const initialMarker = typeof window === 'undefined'
    ? null
    : whiteboardFocusHistoryMarker(window.history.state, boardID)
  const [active, setActive] = useState(Boolean(initialMarker))
  const [announcement, setAnnouncement] = useState(initialMarker
    ? WHITEBOARD_FOCUS_ACTIVE_ANNOUNCEMENT
    : '')
  const activeRef = useRef(active)
  const markerRef = useRef<WhiteboardFocusHistoryMarker | null>(initialMarker)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const editorAPIRef = useRef(editorAPI)
  const interactionBlockedRef = useRef(isInteractionBlocked)

  activeRef.current = active
  editorAPIRef.current = editorAPI
  interactionBlockedRef.current = isInteractionBlocked

  const applyActiveState = useCallback((next: boolean, marker: WhiteboardFocusHistoryMarker | null) => {
    activeRef.current = next
    markerRef.current = marker
    setActive(next)
    setAnnouncement(next
      ? WHITEBOARD_FOCUS_ACTIVE_ANNOUNCEMENT
      : 'Vista normal de la pizarra restaurada.')
  }, [])

  const enter = useCallback((returnFocus?: HTMLElement | null) => {
    if (!ready || activeRef.current || typeof window === 'undefined') return false
    const marker = { boardID, token: createFocusToken() }
    returnFocusRef.current = returnFocus
      || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      || fallbackFocusRef.current
    try {
      window.history.pushState(
        withWhiteboardFocusHistoryMarker(window.history.state, marker),
        '',
      )
      applyActiveState(true, marker)
      return true
    } catch {
      applyActiveState(true, null)
      return true
    }
  }, [applyActiveState, boardID, fallbackFocusRef, ready])

  const clearOwnedHistoryMarker = useCallback(() => {
    if (typeof window === 'undefined') return
    const current = whiteboardFocusHistoryMarker(window.history.state, boardID)
    const owned = current && markerRef.current
      && current.token === markerRef.current.token
      && current.boardID === markerRef.current.boardID
    if (!owned) return
    try {
      window.history.replaceState(
        withoutWhiteboardFocusHistoryMarker(window.history.state),
        '',
      )
    } catch {
      // Navigation is already underway; a denied cleanup must not interrupt it.
    }
  }, [boardID])

  const replaceCurrentHistoryAndExit = useCallback(() => {
    clearOwnedHistoryMarker()
    applyActiveState(false, null)
  }, [applyActiveState, clearOwnedHistoryMarker])

  const exit = useCallback(() => {
    if (!activeRef.current || typeof window === 'undefined') return false
    const current = whiteboardFocusHistoryMarker(window.history.state, boardID)
    const owned = current && markerRef.current
      && current.token === markerRef.current.token
      && current.boardID === markerRef.current.boardID
    if (owned) {
      try {
        window.history.back()
        return true
      } catch {
        replaceCurrentHistoryAndExit()
        return true
      }
    }
    replaceCurrentHistoryAndExit()
    return true
  }, [boardID, replaceCurrentHistoryAndExit])

  const toggle = useCallback((returnFocus?: HTMLElement | null) => (
    activeRef.current ? exit() : enter(returnFocus)
  ), [enter, exit])

  const clearBeforeNavigation = useCallback(() => {
    clearOwnedHistoryMarker()
    if (activeRef.current || markerRef.current) applyActiveState(false, null)
  }, [applyActiveState, clearOwnedHistoryMarker])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const marker = whiteboardFocusHistoryMarker(window.history.state, boardID)
    if (Boolean(marker) === activeRef.current && marker?.token === markerRef.current?.token) return
    applyActiveState(Boolean(marker), marker)
  }, [applyActiveState, boardID])

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const marker = whiteboardFocusHistoryMarker(event.state, boardID)
      applyActiveState(Boolean(marker), marker)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [applyActiveState, boardID])

  useEffect(() => {
    const onPageHide = () => clearOwnedHistoryMarker()
    const onPageShow = () => {
      const marker = whiteboardFocusHistoryMarker(window.history.state, boardID)
      if (Boolean(marker) === activeRef.current && marker?.token === markerRef.current?.token) return
      applyActiveState(Boolean(marker), marker)
    }
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [applyActiveState, boardID, clearOwnedHistoryMarker])

  useEffect(() => {
    if (!ready) return
    const onShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isWhiteboardFocusShortcut(event) || interactionBlockedRef.current()) return
      event.preventDefault()
      event.stopImmediatePropagation()
      toggle(document.activeElement instanceof HTMLElement ? document.activeElement : fallbackFocusRef.current)
    }
    document.addEventListener('keydown', onShortcut, true)
    return () => {
      document.removeEventListener('keydown', onShortcut, true)
    }
  }, [fallbackFocusRef, ready, toggle])

  useEffect(() => {
    if (!active || !ready) return
    const root = rootRef.current
    if (!root) return
    const releaseIsolation = isolateWhiteboardFocusSurface(root)
    const enterFrame = requestAnimationFrame(() => {
      editorAPIRef.current?.refresh()
      if (!root.contains(document.activeElement)) fallbackFocusRef.current?.focus({ preventScroll: true })
    })
    return () => {
      cancelAnimationFrame(enterFrame)
      releaseIsolation()
      requestAnimationFrame(() => {
        editorAPIRef.current?.refresh()
        const target = returnFocusRef.current || fallbackFocusRef.current
        if (target?.isConnected) target.focus({ preventScroll: true })
      })
    }
  }, [active, fallbackFocusRef, ready, rootRef])

  return {
    active,
    announcement,
    enter,
    exit,
    toggle,
    clearBeforeNavigation,
  }
}
