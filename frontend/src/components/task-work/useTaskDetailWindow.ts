'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

export type TaskDetailWindowMode = 'docked' | 'floating' | 'maximized'
export type TaskDetailResizeEdge = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
type Geometry = { x: number; y: number; width: number; height: number }

const STORAGE_KEY = 'clarin:tasks:detail-window:v2'
const MARGIN = 12
const MIN_WIDTH = 440
const MIN_HEIGHT = 460
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))
const viewport = () => ({ width: typeof window === 'undefined' ? 1440 : window.innerWidth, height: typeof window === 'undefined' ? 900 : window.innerHeight })
const defaults = (): Geometry => {
  const size = viewport()
  const width = Math.min(760, size.width - MARGIN * 2)
  const height = Math.min(760, size.height - MARGIN * 2)
  return { x: Math.max(MARGIN, size.width - width - 32), y: Math.max(MARGIN, Math.min(48, size.height - height - MARGIN)), width, height }
}
const clampGeometry = (geometry: Geometry): Geometry => {
  const size = viewport()
  const maxWidth = Math.max(320, size.width - MARGIN * 2)
  const maxHeight = Math.max(420, size.height - MARGIN * 2)
  const width = clamp(geometry.width, Math.min(MIN_WIDTH, maxWidth), maxWidth)
  const height = clamp(geometry.height, Math.min(MIN_HEIGHT, maxHeight), maxHeight)
  return { x: clamp(geometry.x, MARGIN, size.width - width - MARGIN), y: clamp(geometry.y, MARGIN, size.height - height - MARGIN), width, height }
}

export default function useTaskDetailWindow() {
  const [mode, setModeState] = useState<TaskDetailWindowMode>('docked')
  const [geometry, setGeometry] = useState<Geometry>(defaults)
  const [isMobile, setIsMobile] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const geometryRef = useRef(geometry)
  const restoreModeRef = useRef<Exclude<TaskDetailWindowMode, 'maximized'>>('docked')
  useEffect(() => { geometryRef.current = geometry }, [geometry])

  useEffect(() => {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as { mode?: TaskDetailWindowMode; restoreMode?: Exclude<TaskDetailWindowMode, 'maximized'>; geometry?: Geometry } | null
      if (value?.restoreMode && ['docked', 'floating'].includes(value.restoreMode)) restoreModeRef.current = value.restoreMode
      if (value?.mode && ['docked', 'floating', 'maximized'].includes(value.mode)) {
        setModeState(value.mode)
        if (value.mode !== 'maximized') restoreModeRef.current = value.mode
      }
      if (value?.geometry && Object.values(value.geometry).every(Number.isFinite)) setGeometry(clampGeometry(value.geometry))
    } catch {}
    setHydrated(true)
  }, [])
  useEffect(() => {
    if (!hydrated) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, restoreMode: restoreModeRef.current, geometry }))
  }, [geometry, hydrated, mode])
  useEffect(() => {
    const resize = () => { setIsMobile(window.innerWidth < 768); setGeometry(current => clampGeometry(current)) }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  const effectiveMode: TaskDetailWindowMode = isMobile ? 'maximized' : mode
  const isModal = effectiveMode === 'maximized'
  const setMode = useCallback((next: TaskDetailWindowMode) => {
    if (next !== 'maximized') restoreModeRef.current = next
    setModeState(next)
    if (next === 'floating') setGeometry(current => clampGeometry(current))
  }, [])
  const toggleMaximized = useCallback(() => setModeState(current => {
    if (current === 'maximized') return restoreModeRef.current
    restoreModeRef.current = current
    return 'maximized'
  }), [])

  const pointerSession = useCallback((event: ReactPointerEvent, moveValue: (dx: number, dy: number) => void) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startY = event.clientY
    const move = (pointer: PointerEvent) => { pointer.preventDefault(); moveValue(pointer.clientX - startX, pointer.clientY - startY) }
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
    const start = geometryRef.current
    pointerSession(event, (dx, dy) => {
      const next = clampGeometry({ ...start, x: start.x + dx, y: start.y + dy })
      geometryRef.current = next
      setGeometry(next)
    })
  }, [effectiveMode, pointerSession])

  const beginResize = useCallback((edge: TaskDetailResizeEdge, event: ReactPointerEvent) => {
    if (effectiveMode !== 'floating') return
    const start = geometryRef.current
    const size = viewport()
    pointerSession(event, (dx, dy) => {
      let { x, y, width, height } = start
      if (edge.includes('e')) width = clamp(start.width + dx, Math.min(MIN_WIDTH, size.width), size.width - start.x - MARGIN)
      if (edge.includes('s')) height = clamp(start.height + dy, Math.min(MIN_HEIGHT, size.height), size.height - start.y - MARGIN)
      if (edge.includes('w')) { width = clamp(start.width - dx, Math.min(MIN_WIDTH, size.width), start.x + start.width - MARGIN); x = start.x + start.width - width }
      if (edge.includes('n')) { height = clamp(start.height - dy, Math.min(MIN_HEIGHT, size.height), start.y + start.height - MARGIN); y = start.y + start.height - height }
      const next = clampGeometry({ x, y, width, height })
      geometryRef.current = next
      setGeometry(next)
    })
  }, [effectiveMode, pointerSession])

  const panelStyle = useMemo<CSSProperties>(() => {
    if (effectiveMode === 'docked') return { top: 0, right: 0, width: 'min(672px, 100vw)', height: '100dvh' }
    if (effectiveMode === 'maximized') return isMobile ? { inset: 0, width: '100vw', height: '100dvh' } : { inset: MARGIN }
    return { left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height }
  }, [effectiveMode, geometry, isMobile])

  return { effectiveMode, isMobile, isModal, panelStyle, setMode, toggleMaximized, beginDrag, beginResize }
}
