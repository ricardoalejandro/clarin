'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

export type ErosWindowMode = 'floating' | 'maximized' | 'docked'
export type ErosResizeEdge = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

interface ErosGeometry {
  x: number
  y: number
  width: number
  height: number
}

interface StoredErosWindow {
  version: 2
  mode: ErosWindowMode
  geometry: ErosGeometry
  dockWidth: number
}

const STORAGE_KEY = 'clarin:eros:window:v2'
const VIEWPORT_MARGIN = 12
const MIN_WIDTH = 380
const MIN_HEIGHT = 480
const DEFAULT_WIDTH = 480
const DEFAULT_HEIGHT = 640
export const DEFAULT_DOCK_WIDTH = 440

const viewportSize = () => ({
  width: typeof window === 'undefined' ? 1440 : window.innerWidth,
  height: typeof window === 'undefined' ? 900 : window.innerHeight,
})

const defaultGeometry = (): ErosGeometry => {
  const viewport = viewportSize()
  const width = Math.min(DEFAULT_WIDTH, viewport.width - VIEWPORT_MARGIN * 2)
  const height = Math.min(DEFAULT_HEIGHT, viewport.height - VIEWPORT_MARGIN * 2)
  return {
    x: Math.max(VIEWPORT_MARGIN, viewport.width - width - 24),
    y: Math.max(VIEWPORT_MARGIN, Math.min(56, viewport.height - height - VIEWPORT_MARGIN)),
    width,
    height,
  }
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

const clampGeometry = (geometry: ErosGeometry): ErosGeometry => {
  const viewport = viewportSize()
  const maxWidth = Math.max(280, viewport.width - VIEWPORT_MARGIN * 2)
  const maxHeight = Math.max(360, viewport.height - VIEWPORT_MARGIN * 2)
  const width = clamp(geometry.width, Math.min(MIN_WIDTH, maxWidth), maxWidth)
  const height = clamp(geometry.height, Math.min(MIN_HEIGHT, maxHeight), maxHeight)
  return {
    x: clamp(geometry.x, VIEWPORT_MARGIN, viewport.width - width - VIEWPORT_MARGIN),
    y: clamp(geometry.y, VIEWPORT_MARGIN, viewport.height - height - VIEWPORT_MARGIN),
    width,
    height,
  }
}

const maxDockWidth = (workspaceWidth = viewportSize().width) => Math.min(640, workspaceWidth - 640)

const clampDockWidth = (width: number, workspaceWidth?: number) => clamp(width, MIN_WIDTH, maxDockWidth(workspaceWidth))

const isStoredWindow = (value: unknown): value is StoredErosWindow => {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<StoredErosWindow>
  const geometry = row.geometry as Partial<ErosGeometry> | undefined
  return row.version === 2
    && (row.mode === 'floating' || row.mode === 'maximized' || row.mode === 'docked')
    && Boolean(geometry)
    && [geometry?.x, geometry?.y, geometry?.width, geometry?.height, row.dockWidth].every(Number.isFinite)
}

export function useErosWindow() {
  const [mode, setModeState] = useState<ErosWindowMode>('floating')
  const [geometry, setGeometry] = useState<ErosGeometry>(defaultGeometry)
  const [dockWidth, setDockWidth] = useState(DEFAULT_DOCK_WIDTH)
  const [isMobile, setIsMobile] = useState(false)
  const [workspaceWidth, setWorkspaceWidth] = useState(() => viewportSize().width)
  const [isInteracting, setIsInteracting] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const geometryRef = useRef(geometry)
  const dockWidthRef = useRef(dockWidth)

  useEffect(() => { geometryRef.current = geometry }, [geometry])
  useEffect(() => { dockWidthRef.current = dockWidth }, [dockWidth])

  useEffect(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null')
      if (isStoredWindow(parsed)) {
        setModeState(parsed.mode)
        setGeometry(clampGeometry(parsed.geometry))
        // Preserve the user's preferred width even when the current viewport is
        // temporarily too narrow to dock. The rendered width is clamped below.
        setDockWidth(clamp(parsed.dockWidth, MIN_WIDTH, 640))
      } else {
        setGeometry(defaultGeometry())
      }
    } catch {
      setGeometry(defaultGeometry())
    } finally {
      setHydrated(true)
    }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    const value: StoredErosWindow = { version: 2, mode, geometry, dockWidth }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  }, [dockWidth, geometry, hydrated, mode])

  useEffect(() => {
    const updateViewport = () => {
      setIsMobile(window.innerWidth <= 1024)
      const sidebar = document.querySelector<HTMLElement>('[data-dashboard-sidebar]')
      const sidebarWidth = window.innerWidth >= 1024 ? (sidebar?.getBoundingClientRect().width || 0) : 0
      const nextWorkspaceWidth = Math.max(0, window.innerWidth - sidebarWidth)
      setWorkspaceWidth(nextWorkspaceWidth)
      setGeometry(current => clampGeometry(current))
    }
    updateViewport()
    const sidebar = document.querySelector<HTMLElement>('[data-dashboard-sidebar]')
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateViewport) : null
    if (sidebar) observer?.observe(sidebar)
    window.addEventListener('resize', updateViewport)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateViewport)
    }
  }, [])

  const canDock = !isMobile && maxDockWidth(workspaceWidth) >= MIN_WIDTH
  const effectiveMode: ErosWindowMode = isMobile
    ? 'maximized'
    : mode === 'docked' && !canDock
      ? 'maximized'
      : mode
  const dockMax = Math.max(MIN_WIDTH, maxDockWidth(workspaceWidth))
  const effectiveDockWidth = clampDockWidth(dockWidth, workspaceWidth)

  const setMode = useCallback((next: ErosWindowMode) => {
    setModeState(next)
    if (next === 'floating') setGeometry(current => clampGeometry(current))
  }, [])

  const toggleMaximized = useCallback(() => {
    setModeState(current => current === 'maximized' ? 'floating' : 'maximized')
  }, [])

  const beginPointerSession = useCallback((
    event: ReactPointerEvent,
    onMove: (dx: number, dy: number) => void,
    onEnd?: () => void,
  ) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    setIsInteracting(true)
    document.documentElement.classList.add('eros-window-interacting')

    const move = (pointer: PointerEvent) => {
      pointer.preventDefault()
      onMove(pointer.clientX - startX, pointer.clientY - startY)
    }
    const end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      document.documentElement.classList.remove('eros-window-interacting')
      setIsInteracting(false)
      onEnd?.()
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', end, { once: true })
    window.addEventListener('pointercancel', end, { once: true })
  }, [])

  const beginDrag = useCallback((event: ReactPointerEvent) => {
    if (effectiveMode !== 'floating') return
    const target = event.target as HTMLElement
    if (target.closest('button, a, input, textarea, select, [data-no-window-drag]')) return
    const start = geometryRef.current
    beginPointerSession(event, (dx, dy) => {
      const next = clampGeometry({ ...start, x: start.x + dx, y: start.y + dy })
      geometryRef.current = next
      setGeometry(next)
    }, () => {
      const current = geometryRef.current
      const viewport = viewportSize()
      if (current.y <= VIEWPORT_MARGIN + 4) {
        setModeState('maximized')
      } else if (canDock && viewport.width - current.x - current.width <= VIEWPORT_MARGIN + 4) {
        setModeState('docked')
      }
    })
  }, [beginPointerSession, canDock, effectiveMode])

  const beginResize = useCallback((edge: ErosResizeEdge, event: ReactPointerEvent) => {
    if (effectiveMode !== 'floating') return
    const start = geometryRef.current
    const viewport = viewportSize()
    beginPointerSession(event, (dx, dy) => {
      let { x, y, width, height } = start
      if (edge.includes('e')) width = clamp(start.width + dx, Math.min(MIN_WIDTH, viewport.width), viewport.width - start.x - VIEWPORT_MARGIN)
      if (edge.includes('s')) height = clamp(start.height + dy, Math.min(MIN_HEIGHT, viewport.height), viewport.height - start.y - VIEWPORT_MARGIN)
      if (edge.includes('w')) {
        const nextWidth = clamp(start.width - dx, Math.min(MIN_WIDTH, viewport.width), start.x + start.width - VIEWPORT_MARGIN)
        x = start.x + start.width - nextWidth
        width = nextWidth
      }
      if (edge.includes('n')) {
        const nextHeight = clamp(start.height - dy, Math.min(MIN_HEIGHT, viewport.height), start.y + start.height - VIEWPORT_MARGIN)
        y = start.y + start.height - nextHeight
        height = nextHeight
      }
      const next = { x, y, width, height }
      geometryRef.current = next
      setGeometry(next)
    })
  }, [beginPointerSession, effectiveMode])

  const beginDockResize = useCallback((event: ReactPointerEvent) => {
    if (effectiveMode !== 'docked') return
    const start = clampDockWidth(dockWidthRef.current, workspaceWidth)
    beginPointerSession(event, dx => {
      const next = clampDockWidth(start - dx, workspaceWidth)
      dockWidthRef.current = next
      setDockWidth(next)
    })
  }, [beginPointerSession, effectiveMode, workspaceWidth])

  const handleDockSeparatorKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (effectiveMode !== 'docked') return
    const step = event.shiftKey ? 48 : 16
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = dockWidthRef.current + step
    if (event.key === 'ArrowRight') next = dockWidthRef.current - step
    if (event.key === 'Home') next = MIN_WIDTH
    if (event.key === 'End') next = maxDockWidth(workspaceWidth)
    if (next === null) return
    event.preventDefault()
    const clamped = clampDockWidth(next, workspaceWidth)
    dockWidthRef.current = clamped
    setDockWidth(clamped)
  }, [effectiveMode, workspaceWidth])

  const panelStyle = useMemo<CSSProperties>(() => {
    if (effectiveMode === 'docked') return { width: effectiveDockWidth, height: '100%' }
    if (effectiveMode === 'maximized') {
      return isMobile
        ? { inset: 0, width: '100vw', height: '100dvh' }
        : { inset: VIEWPORT_MARGIN }
    }
    return {
      left: geometry.x,
      top: geometry.y,
      width: geometry.width,
      height: geometry.height,
    }
  }, [effectiveDockWidth, effectiveMode, geometry, isMobile])

  return {
    mode,
    effectiveMode,
    isMobile,
    isInteracting,
    canDock,
    dockWidth: effectiveDockWidth,
    dockMin: MIN_WIDTH,
    dockMax,
    panelStyle,
    setMode,
    toggleMaximized,
    beginDrag,
    beginResize,
    beginDockResize,
    handleDockSeparatorKeyDown,
    resetDockWidth: () => setDockWidth(clampDockWidth(DEFAULT_DOCK_WIDTH, workspaceWidth)),
  }
}
