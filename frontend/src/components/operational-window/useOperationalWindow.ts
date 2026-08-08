'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

export type OperationalWindowMode = 'docked' | 'floating' | 'maximized'
export type OperationalWindowResizeEdge = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
export type OperationalWindowGeometry = { x: number; y: number; width: number; height: number }
export type OperationalWindowViewport = { width: number; height: number }
export type RestorableOperationalWindowMode = Exclude<OperationalWindowMode, 'maximized'>

export type OperationalWindowOptions = {
  storageKey: string
  storageScope?: string
  defaultMode: RestorableOperationalWindowMode
  defaultWidth: number
  defaultHeight: number
  minWidth?: number
  minHeight?: number
  dockedWidth?: number
  align?: 'center' | 'right'
  mobileBreakpoint?: number
  /** Ephemeral mode used by focused child workflows such as CRM chat. Never persisted. */
  temporaryMode?: OperationalWindowMode
}

export interface OperationalWindowPreference {
  version: typeof OPERATIONAL_WINDOW_PREFERENCE_VERSION
  mode: OperationalWindowMode
  restoreMode: RestorableOperationalWindowMode
  preferredGeometry: OperationalWindowGeometry
}

export const OPERATIONAL_WINDOW_PREFERENCE_VERSION = 3
export const OPERATIONAL_WINDOW_MARGIN = 16
const DEFAULT_DESKTOP_VIEWPORT = { width: 1440, height: 900 }
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

function currentViewport(): OperationalWindowViewport {
  return {
    width: typeof window === 'undefined' ? DEFAULT_DESKTOP_VIEWPORT.width : window.innerWidth,
    height: typeof window === 'undefined' ? DEFAULT_DESKTOP_VIEWPORT.height : window.innerHeight,
  }
}

export function operationalWindowScopedStorageKey(storageKey: string, storageScope = 'shared') {
  const base = storageKey.replace(/:v\d+$/, '')
  return `${base}:v${OPERATIONAL_WINDOW_PREFERENCE_VERSION}:${encodeURIComponent(storageScope || 'shared')}`
}

export function defaultOperationalWindowGeometry({
  defaultWidth,
  defaultHeight,
  align,
  viewport,
}: {
  defaultWidth: number
  defaultHeight: number
  align: 'center' | 'right'
  viewport: OperationalWindowViewport
}): OperationalWindowGeometry {
  const referenceWidth = Math.max(DEFAULT_DESKTOP_VIEWPORT.width, viewport.width)
  const referenceHeight = Math.max(DEFAULT_DESKTOP_VIEWPORT.height, viewport.height)
  const x = align === 'center'
    ? Math.max(OPERATIONAL_WINDOW_MARGIN, (referenceWidth - defaultWidth) / 2)
    : Math.max(OPERATIONAL_WINDOW_MARGIN, referenceWidth - defaultWidth - 32)
  return {
    x,
    y: Math.max(OPERATIONAL_WINDOW_MARGIN, Math.min(48, referenceHeight - defaultHeight - OPERATIONAL_WINDOW_MARGIN)),
    width: defaultWidth,
    height: defaultHeight,
  }
}

export function clampOperationalWindowGeometry(
  geometry: OperationalWindowGeometry,
  viewport: OperationalWindowViewport,
  minWidth = 440,
  minHeight = 460,
): OperationalWindowGeometry {
  const maxWidth = Math.max(320, viewport.width - OPERATIONAL_WINDOW_MARGIN * 2)
  const maxHeight = Math.max(420, viewport.height - OPERATIONAL_WINDOW_MARGIN * 2)
  const width = clamp(geometry.width, Math.min(minWidth, maxWidth), maxWidth)
  const height = clamp(geometry.height, Math.min(minHeight, maxHeight), maxHeight)
  return {
    x: clamp(geometry.x, OPERATIONAL_WINDOW_MARGIN, viewport.width - width - OPERATIONAL_WINDOW_MARGIN),
    y: clamp(geometry.y, OPERATIONAL_WINDOW_MARGIN, viewport.height - height - OPERATIONAL_WINDOW_MARGIN),
    width,
    height,
  }
}

export function parseOperationalWindowPreference(raw: string | null): OperationalWindowPreference | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<OperationalWindowPreference>
    const geometry = value.preferredGeometry
    if (value.version !== OPERATIONAL_WINDOW_PREFERENCE_VERSION
      || !value.mode || !['docked', 'floating', 'maximized'].includes(value.mode)
      || !value.restoreMode || !['docked', 'floating'].includes(value.restoreMode)
      || !geometry || !Object.values(geometry).every(Number.isFinite)
      || geometry.width <= 0 || geometry.height <= 0) return null
    return value as OperationalWindowPreference
  } catch {
    return null
  }
}

export function parseLegacyOperationalWindowMode(raw: string | null): Pick<OperationalWindowPreference, 'mode' | 'restoreMode'> | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as { mode?: OperationalWindowMode; restoreMode?: RestorableOperationalWindowMode }
    if (!value.mode || !['docked', 'floating', 'maximized'].includes(value.mode)) return null
    const restoreMode = value.restoreMode && ['docked', 'floating'].includes(value.restoreMode)
      ? value.restoreMode
      : value.mode === 'maximized' ? 'floating' : value.mode
    return { mode: value.mode, restoreMode }
  } catch {
    return null
  }
}

export function resolveOperationalWindowMode(isMobile: boolean, mode: OperationalWindowMode, temporaryMode?: OperationalWindowMode): OperationalWindowMode {
  if (isMobile) return 'maximized'
  return temporaryMode || mode
}

export default function useOperationalWindow({
  storageKey,
  storageScope,
  defaultMode,
  defaultWidth,
  defaultHeight,
  minWidth = 440,
  minHeight = 460,
  dockedWidth = 672,
  align = 'right',
  mobileBreakpoint = 768,
  temporaryMode,
}: OperationalWindowOptions) {
  const scopedStorageKey = useMemo(() => operationalWindowScopedStorageKey(storageKey, storageScope), [storageKey, storageScope])
  const defaults = useCallback(() => defaultOperationalWindowGeometry({ defaultWidth, defaultHeight, align, viewport: currentViewport() }), [align, defaultHeight, defaultWidth])
  const [mode, setModeState] = useState<OperationalWindowMode>(defaultMode)
  const [preferredGeometry, setPreferredGeometry] = useState<OperationalWindowGeometry>(defaults)
  const [viewport, setViewport] = useState<OperationalWindowViewport>(currentViewport)
  const [hydratedStorageKey, setHydratedStorageKey] = useState('')
  const restoreModeRef = useRef<RestorableOperationalWindowMode>(defaultMode)
  const effectiveGeometry = useMemo(
    () => clampOperationalWindowGeometry(preferredGeometry, viewport, minWidth, minHeight),
    [minHeight, minWidth, preferredGeometry, viewport],
  )
  const effectiveGeometryRef = useRef(effectiveGeometry)
  effectiveGeometryRef.current = effectiveGeometry

  useEffect(() => {
    const preference = parseOperationalWindowPreference(localStorage.getItem(scopedStorageKey))
    if (preference) {
      restoreModeRef.current = preference.restoreMode
      setModeState(preference.mode)
      setPreferredGeometry(preference.preferredGeometry)
    } else {
      const legacyBase = storageKey.replace(/:v\d+$/, '')
      const legacyCandidates = Array.from(new Set([storageKey, legacyBase, `${legacyBase}:v2`, `${legacyBase}:v1`]))
      const legacy = legacyCandidates.map(key => parseLegacyOperationalWindowMode(localStorage.getItem(key))).find(Boolean)
      restoreModeRef.current = legacy?.restoreMode || defaultMode
      setModeState(legacy?.mode || defaultMode)
      setPreferredGeometry(defaults())
    }
    setHydratedStorageKey(scopedStorageKey)
  }, [defaultMode, defaults, scopedStorageKey, storageKey])

  useEffect(() => {
    if (hydratedStorageKey !== scopedStorageKey) return
    const preference: OperationalWindowPreference = {
      version: OPERATIONAL_WINDOW_PREFERENCE_VERSION,
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

  const isMobile = viewport.width < mobileBreakpoint
  const effectiveMode = resolveOperationalWindowMode(isMobile, mode, temporaryMode)
  const isModal = effectiveMode === 'maximized'
  const setMode = useCallback((next: OperationalWindowMode) => {
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
      clampOperationalWindowGeometry({ ...start, x: start.x + dx, y: start.y + dy }, currentViewport(), minWidth, minHeight),
    ))
  }, [effectiveMode, minHeight, minWidth, pointerSession])

  const beginResize = useCallback((edge: OperationalWindowResizeEdge, event: ReactPointerEvent) => {
    if (effectiveMode !== 'floating') return
    const start = effectiveGeometryRef.current
    const size = currentViewport()
    pointerSession(event, (dx, dy) => {
      let { x, y, width, height } = start
      if (edge.includes('e')) width = clamp(start.width + dx, Math.min(minWidth, size.width), size.width - start.x - OPERATIONAL_WINDOW_MARGIN)
      if (edge.includes('s')) height = clamp(start.height + dy, Math.min(minHeight, size.height), size.height - start.y - OPERATIONAL_WINDOW_MARGIN)
      if (edge.includes('w')) {
        width = clamp(start.width - dx, Math.min(minWidth, size.width), start.x + start.width - OPERATIONAL_WINDOW_MARGIN)
        x = start.x + start.width - width
      }
      if (edge.includes('n')) {
        height = clamp(start.height - dy, Math.min(minHeight, size.height), start.y + start.height - OPERATIONAL_WINDOW_MARGIN)
        y = start.y + start.height - height
      }
      setPreferredGeometry(clampOperationalWindowGeometry({ x, y, width, height }, size, minWidth, minHeight))
    })
  }, [effectiveMode, minHeight, minWidth, pointerSession])

  const panelStyle = useMemo<CSSProperties>(() => {
    if (effectiveMode === 'docked') return { top: 0, right: 0, width: `min(${dockedWidth}px, 100vw)`, height: '100dvh' }
    if (effectiveMode === 'maximized') return isMobile ? { inset: 0, width: '100vw', height: '100dvh' } : { inset: OPERATIONAL_WINDOW_MARGIN }
    return { left: effectiveGeometry.x, top: effectiveGeometry.y, width: effectiveGeometry.width, height: effectiveGeometry.height }
  }, [dockedWidth, effectiveGeometry, effectiveMode, isMobile])

  return { effectiveMode, isMobile, isModal, temporaryModeActive: Boolean(temporaryMode), panelStyle, viewport, effectiveGeometry, setMode, toggleMaximized, resetGeometry, beginDrag, beginResize }
}
