'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

export type TaskWindowMode = 'docked' | 'floating' | 'maximized'
export type TaskWindowResizeEdge = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
export type TaskWindowGeometry = { x: number; y: number; width: number; height: number }
export type TaskWindowViewport = { width: number; height: number }

type RestorableTaskWindowMode = Exclude<TaskWindowMode, 'maximized'>
type Options = {
  storageKey: string
  storageScope?: string
  defaultMode: RestorableTaskWindowMode
  defaultWidth: number
  defaultHeight: number
  minWidth?: number
  minHeight?: number
  align?: 'center' | 'right'
}

export interface TaskWindowPreference {
  version: typeof TASK_WINDOW_PREFERENCE_VERSION
  mode: TaskWindowMode
  restoreMode: RestorableTaskWindowMode
  preferredGeometry: TaskWindowGeometry
}

export const TASK_WINDOW_PREFERENCE_VERSION = 3
export const TASK_WINDOW_MARGIN = 16
const DEFAULT_DESKTOP_VIEWPORT = { width: 1440, height: 900 }
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

function currentViewport(): TaskWindowViewport {
  return {
    width: typeof window === 'undefined' ? DEFAULT_DESKTOP_VIEWPORT.width : window.innerWidth,
    height: typeof window === 'undefined' ? DEFAULT_DESKTOP_VIEWPORT.height : window.innerHeight,
  }
}

export function taskWindowScopedStorageKey(storageKey: string, storageScope = 'shared') {
  const base = storageKey.replace(/:v\d+$/, '')
  return `${base}:v${TASK_WINDOW_PREFERENCE_VERSION}:${encodeURIComponent(storageScope || 'shared')}`
}

export function defaultTaskWindowGeometry({
  defaultWidth,
  defaultHeight,
  align,
  viewport,
}: {
  defaultWidth: number
  defaultHeight: number
  align: 'center' | 'right'
  viewport: TaskWindowViewport
}): TaskWindowGeometry {
  // Keep a desktop-sized preference even when the first open happens on mobile.
  // The effective rect is clamped separately and never overwrites this value.
  const referenceWidth = Math.max(DEFAULT_DESKTOP_VIEWPORT.width, viewport.width)
  const referenceHeight = Math.max(DEFAULT_DESKTOP_VIEWPORT.height, viewport.height)
  const x = align === 'center'
    ? Math.max(TASK_WINDOW_MARGIN, (referenceWidth - defaultWidth) / 2)
    : Math.max(TASK_WINDOW_MARGIN, referenceWidth - defaultWidth - 32)
  return {
    x,
    y: Math.max(TASK_WINDOW_MARGIN, Math.min(48, referenceHeight - defaultHeight - TASK_WINDOW_MARGIN)),
    width: defaultWidth,
    height: defaultHeight,
  }
}

export function clampTaskWindowGeometry(
  geometry: TaskWindowGeometry,
  viewport: TaskWindowViewport,
  minWidth = 440,
  minHeight = 460,
): TaskWindowGeometry {
  const maxWidth = Math.max(320, viewport.width - TASK_WINDOW_MARGIN * 2)
  const maxHeight = Math.max(420, viewport.height - TASK_WINDOW_MARGIN * 2)
  const width = clamp(geometry.width, Math.min(minWidth, maxWidth), maxWidth)
  const height = clamp(geometry.height, Math.min(minHeight, maxHeight), maxHeight)
  return {
    x: clamp(geometry.x, TASK_WINDOW_MARGIN, viewport.width - width - TASK_WINDOW_MARGIN),
    y: clamp(geometry.y, TASK_WINDOW_MARGIN, viewport.height - height - TASK_WINDOW_MARGIN),
    width,
    height,
  }
}

export function parseTaskWindowPreference(raw: string | null): TaskWindowPreference | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<TaskWindowPreference>
    const geometry = value.preferredGeometry
    if (value.version !== TASK_WINDOW_PREFERENCE_VERSION
      || !value.mode || !['docked', 'floating', 'maximized'].includes(value.mode)
      || !value.restoreMode || !['docked', 'floating'].includes(value.restoreMode)
      || !geometry || !Object.values(geometry).every(Number.isFinite)
      || geometry.width <= 0 || geometry.height <= 0) return null
    return value as TaskWindowPreference
  } catch {
    return null
  }
}

export function parseLegacyTaskWindowMode(raw: string | null): Pick<TaskWindowPreference, 'mode' | 'restoreMode'> | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as { mode?: TaskWindowMode; restoreMode?: RestorableTaskWindowMode }
    if (!value.mode || !['docked', 'floating', 'maximized'].includes(value.mode)) return null
    const restoreMode = value.restoreMode && ['docked', 'floating'].includes(value.restoreMode)
      ? value.restoreMode
      : value.mode === 'maximized' ? 'floating' : value.mode
    return { mode: value.mode, restoreMode }
  } catch {
    return null
  }
}

export default function useTaskWindow({ storageKey, storageScope, defaultMode, defaultWidth, defaultHeight, minWidth = 440, minHeight = 460, align = 'right' }: Options) {
  const scopedStorageKey = useMemo(() => taskWindowScopedStorageKey(storageKey, storageScope), [storageKey, storageScope])
  const defaults = useCallback(() => defaultTaskWindowGeometry({ defaultWidth, defaultHeight, align, viewport: currentViewport() }), [align, defaultHeight, defaultWidth])
  const [mode, setModeState] = useState<TaskWindowMode>(defaultMode)
  const [preferredGeometry, setPreferredGeometry] = useState<TaskWindowGeometry>(defaults)
  const [viewport, setViewport] = useState<TaskWindowViewport>(currentViewport)
  const [hydratedStorageKey, setHydratedStorageKey] = useState('')
  const restoreModeRef = useRef<RestorableTaskWindowMode>(defaultMode)
  const effectiveGeometry = useMemo(
    () => clampTaskWindowGeometry(preferredGeometry, viewport, minWidth, minHeight),
    [minHeight, minWidth, preferredGeometry, viewport],
  )
  const effectiveGeometryRef = useRef(effectiveGeometry)
  effectiveGeometryRef.current = effectiveGeometry

  useEffect(() => {
    const preference = parseTaskWindowPreference(localStorage.getItem(scopedStorageKey))
    if (preference) {
      restoreModeRef.current = preference.restoreMode
      setModeState(preference.mode)
      setPreferredGeometry(preference.preferredGeometry)
    } else {
      const legacyBase = storageKey.replace(/:v\d+$/, '')
      const legacyCandidates = Array.from(new Set([storageKey, legacyBase, `${legacyBase}:v2`, `${legacyBase}:v1`]))
      const legacy = legacyCandidates.map(key => parseLegacyTaskWindowMode(localStorage.getItem(key))).find(Boolean)
      restoreModeRef.current = legacy?.restoreMode || defaultMode
      setModeState(legacy?.mode || defaultMode)
      // Legacy geometry is intentionally discarded: viewport clamping in the
      // old contract could persist a tiny mobile/zoom rectangle permanently.
      setPreferredGeometry(defaults())
    }
    setHydratedStorageKey(scopedStorageKey)
  }, [defaultMode, defaults, scopedStorageKey, storageKey])

  useEffect(() => {
    if (hydratedStorageKey !== scopedStorageKey) return
    const preference: TaskWindowPreference = {
      version: TASK_WINDOW_PREFERENCE_VERSION,
      mode,
      restoreMode: restoreModeRef.current,
      preferredGeometry,
    }
    localStorage.setItem(scopedStorageKey, JSON.stringify(preference))
  }, [hydratedStorageKey, mode, preferredGeometry, scopedStorageKey])

  useEffect(() => {
    const resize = () => setViewport(currentViewport())
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  const isMobile = viewport.width < 768
  const effectiveMode: TaskWindowMode = isMobile ? 'maximized' : mode
  const isModal = effectiveMode === 'maximized'
  const setMode = useCallback((next: TaskWindowMode) => {
    if (next !== 'maximized') restoreModeRef.current = next
    setModeState(next)
  }, [])
  const toggleMaximized = useCallback(() => setModeState(current => {
    if (current === 'maximized') return restoreModeRef.current
    restoreModeRef.current = current
    return 'maximized'
  }), [])
  const resetGeometry = useCallback(() => setPreferredGeometry(defaults()), [defaults])

  const pointerSession = useCallback((event: ReactPointerEvent, moveValue: (dx: number, dy: number) => void) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const move = (pointer: PointerEvent) => {
      pointer.preventDefault()
      moveValue(pointer.clientX - startX, pointer.clientY - startY)
    }
    const end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }, [])

  const beginDrag = useCallback((event: ReactPointerEvent) => {
    if (effectiveMode !== 'floating' || (event.target as HTMLElement).closest('button,a,input,textarea,select,[data-no-window-drag]')) return
    const start = effectiveGeometryRef.current
    pointerSession(event, (dx, dy) => setPreferredGeometry(
      clampTaskWindowGeometry({ ...start, x: start.x + dx, y: start.y + dy }, currentViewport(), minWidth, minHeight),
    ))
  }, [effectiveMode, minHeight, minWidth, pointerSession])

  const beginResize = useCallback((edge: TaskWindowResizeEdge, event: ReactPointerEvent) => {
    if (effectiveMode !== 'floating') return
    const start = effectiveGeometryRef.current
    const size = currentViewport()
    pointerSession(event, (dx, dy) => {
      let { x, y, width, height } = start
      if (edge.includes('e')) width = clamp(start.width + dx, Math.min(minWidth, size.width), size.width - start.x - TASK_WINDOW_MARGIN)
      if (edge.includes('s')) height = clamp(start.height + dy, Math.min(minHeight, size.height), size.height - start.y - TASK_WINDOW_MARGIN)
      if (edge.includes('w')) {
        width = clamp(start.width - dx, Math.min(minWidth, size.width), start.x + start.width - TASK_WINDOW_MARGIN)
        x = start.x + start.width - width
      }
      if (edge.includes('n')) {
        height = clamp(start.height - dy, Math.min(minHeight, size.height), start.y + start.height - TASK_WINDOW_MARGIN)
        y = start.y + start.height - height
      }
      setPreferredGeometry(clampTaskWindowGeometry({ x, y, width, height }, size, minWidth, minHeight))
    })
  }, [effectiveMode, minHeight, minWidth, pointerSession])

  const panelStyle = useMemo<CSSProperties>(() => {
    if (effectiveMode === 'docked') return { top: 0, right: 0, width: 'min(672px, 100vw)', height: '100dvh' }
    if (effectiveMode === 'maximized') return isMobile ? { inset: 0, width: '100vw', height: '100dvh' } : { inset: TASK_WINDOW_MARGIN }
    return { left: effectiveGeometry.x, top: effectiveGeometry.y, width: effectiveGeometry.width, height: effectiveGeometry.height }
  }, [effectiveGeometry, effectiveMode, isMobile])

  return { effectiveMode, isMobile, isModal, panelStyle, setMode, toggleMaximized, resetGeometry, beginDrag, beginResize }
}
