'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

export type TaskWindowMode = 'docked' | 'floating' | 'maximized'
export type TaskWindowResizeEdge = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
type Geometry = { x: number; y: number; width: number; height: number }
type Options = { storageKey: string; defaultMode: Exclude<TaskWindowMode, 'maximized'>; defaultWidth: number; defaultHeight: number; minWidth?: number; minHeight?: number; align?: 'center' | 'right' }

const MARGIN = 12
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))
const viewport = () => ({ width: typeof window === 'undefined' ? 1440 : window.innerWidth, height: typeof window === 'undefined' ? 900 : window.innerHeight })

export default function useTaskWindow({ storageKey, defaultMode, defaultWidth, defaultHeight, minWidth = 440, minHeight = 460, align = 'right' }: Options) {
  const defaults = useCallback((): Geometry => {
    const size = viewport()
    const width = Math.min(defaultWidth, size.width - MARGIN * 2)
    const height = Math.min(defaultHeight, size.height - MARGIN * 2)
    const x = align === 'center' ? Math.max(MARGIN, (size.width - width) / 2) : Math.max(MARGIN, size.width - width - 32)
    return { x, y: Math.max(MARGIN, Math.min(48, size.height - height - MARGIN)), width, height }
  }, [align, defaultHeight, defaultWidth])
  const clampGeometry = useCallback((geometry: Geometry): Geometry => {
    const size = viewport()
    const maxWidth = Math.max(320, size.width - MARGIN * 2)
    const maxHeight = Math.max(420, size.height - MARGIN * 2)
    const width = clamp(geometry.width, Math.min(minWidth, maxWidth), maxWidth)
    const height = clamp(geometry.height, Math.min(minHeight, maxHeight), maxHeight)
    return { x: clamp(geometry.x, MARGIN, size.width - width - MARGIN), y: clamp(geometry.y, MARGIN, size.height - height - MARGIN), width, height }
  }, [minHeight, minWidth])
  const [mode, setModeState] = useState<TaskWindowMode>(defaultMode)
  const [geometry, setGeometry] = useState<Geometry>(defaults)
  const [isMobile, setIsMobile] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const geometryRef = useRef(geometry)
  const restoreModeRef = useRef<Exclude<TaskWindowMode, 'maximized'>>(defaultMode)
  useEffect(() => { geometryRef.current = geometry }, [geometry])
  useEffect(() => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || 'null') as { mode?: TaskWindowMode; restoreMode?: Exclude<TaskWindowMode, 'maximized'>; geometry?: Geometry } | null
      if (value?.restoreMode && ['docked', 'floating'].includes(value.restoreMode)) restoreModeRef.current = value.restoreMode
      if (value?.mode && ['docked', 'floating', 'maximized'].includes(value.mode)) { setModeState(value.mode); if (value.mode !== 'maximized') restoreModeRef.current = value.mode }
      if (value?.geometry && Object.values(value.geometry).every(Number.isFinite)) setGeometry(clampGeometry(value.geometry))
    } catch {}
    setHydrated(true)
  }, [clampGeometry, storageKey])
  useEffect(() => { if (hydrated) localStorage.setItem(storageKey, JSON.stringify({ mode, restoreMode: restoreModeRef.current, geometry })) }, [geometry, hydrated, mode, storageKey])
  useEffect(() => {
    const resize = () => { setIsMobile(window.innerWidth < 768); setGeometry(current => clampGeometry(current)) }
    resize(); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize)
  }, [clampGeometry])
  const effectiveMode: TaskWindowMode = isMobile ? 'maximized' : mode
  const isModal = effectiveMode === 'maximized'
  const setMode = useCallback((next: TaskWindowMode) => { if (next !== 'maximized') restoreModeRef.current = next; setModeState(next); if (next === 'floating') setGeometry(current => clampGeometry(current)) }, [clampGeometry])
  const toggleMaximized = useCallback(() => setModeState(current => { if (current === 'maximized') return restoreModeRef.current; restoreModeRef.current = current; return 'maximized' }), [])
  const pointerSession = useCallback((event: ReactPointerEvent, moveValue: (dx: number, dy: number) => void) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX; const startY = event.clientY
    const move = (pointer: PointerEvent) => { pointer.preventDefault(); moveValue(pointer.clientX - startX, pointer.clientY - startY) }
    const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end) }
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', end, { once: true }); window.addEventListener('pointercancel', end, { once: true })
  }, [])
  const beginDrag = useCallback((event: ReactPointerEvent) => {
    if (effectiveMode !== 'floating' || (event.target as HTMLElement).closest('button,a,input,textarea,select,[data-no-window-drag]')) return
    const start = geometryRef.current
    pointerSession(event, (dx, dy) => { const next = clampGeometry({ ...start, x: start.x + dx, y: start.y + dy }); geometryRef.current = next; setGeometry(next) })
  }, [clampGeometry, effectiveMode, pointerSession])
  const beginResize = useCallback((edge: TaskWindowResizeEdge, event: ReactPointerEvent) => {
    if (effectiveMode !== 'floating') return
    const start = geometryRef.current; const size = viewport()
    pointerSession(event, (dx, dy) => {
      let { x, y, width, height } = start
      if (edge.includes('e')) width = clamp(start.width + dx, Math.min(minWidth, size.width), size.width - start.x - MARGIN)
      if (edge.includes('s')) height = clamp(start.height + dy, Math.min(minHeight, size.height), size.height - start.y - MARGIN)
      if (edge.includes('w')) { width = clamp(start.width - dx, Math.min(minWidth, size.width), start.x + start.width - MARGIN); x = start.x + start.width - width }
      if (edge.includes('n')) { height = clamp(start.height - dy, Math.min(minHeight, size.height), start.y + start.height - MARGIN); y = start.y + start.height - height }
      const next = clampGeometry({ x, y, width, height }); geometryRef.current = next; setGeometry(next)
    })
  }, [clampGeometry, effectiveMode, minHeight, minWidth, pointerSession])
  const panelStyle = useMemo<CSSProperties>(() => {
    if (effectiveMode === 'docked') return { top: 0, right: 0, width: 'min(672px, 100vw)', height: '100dvh' }
    if (effectiveMode === 'maximized') return isMobile ? { inset: 0, width: '100vw', height: '100dvh' } : { inset: MARGIN }
    return { left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height }
  }, [effectiveMode, geometry, isMobile])
  return { effectiveMode, isMobile, isModal, panelStyle, setMode, toggleMaximized, beginDrag, beginResize }
}
