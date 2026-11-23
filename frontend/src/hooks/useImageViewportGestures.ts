"use client"

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type RefObject } from 'react'
import { clampImageViewport, imagePanBounds, pinchImageViewport, zoomImageViewportAt, type ImageViewportGeometry, type ImageViewportTransform } from '@/lib/imageViewportGeometry'

export type ImageViewportGestureOptions = {
  sourceKey: string
  active: boolean
  viewportRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
  minScale?: number | (() => number)
  maxScale?: number
  scale?: number
  onScaleChange?: (scale: number) => void
  rotation?: number
  wheelMode?: 'modifier' | 'always'
  panEnabled?: boolean
  doubleTapZoom?: boolean
}
type Pointer = { x: number; y: number; startX: number; startY: number; startedAt: number; touch: boolean; moved: boolean; multiple: boolean }
type Gesture = { start: ImageViewportTransform; distance: number; midpoint: { x: number; y: number }; pinch: boolean }
const INITIAL = { scale: 1, x: 0, y: 0 }
const distance = (a: Pointer, b: Pointer) => Math.hypot(a.x - b.x, a.y - b.y)

/** Content must be centered in its viewport; transform its image and markers together. */
export function useImageViewportGestures(options: ImageViewportGestureOptions) {
  const config = useRef(options); config.current = options
  const [transform, setTransform] = useState<ImageViewportTransform>(INITIAL)
  const current = useRef<ImageViewportTransform>(INITIAL)
  const pointers = useRef(new Map<number, Pointer>())
  const gesture = useRef<Gesture | null>(null)
  const suppressNextClick = useRef(false)
  const lastTap = useRef({ at: 0, x: 0, y: 0 })
  const session = useRef({ key: options.sourceKey, active: options.active })
  const skipControlledSync = useRef(false)
  const safariGesture = useRef<{ start: ImageViewportTransform; x: number; y: number } | null>(null)
  const minimum = useCallback(() => typeof config.current.minScale === 'function' ? config.current.minScale() : config.current.minScale ?? 1, [])
  const geometry = useCallback((): ImageViewportGeometry => {
    const { viewportRef, contentRef, rotation } = config.current
    const viewport = viewportRef.current
    const content = contentRef.current
    const rect = viewport?.getBoundingClientRect()
    return { viewportWidth: viewport?.clientWidth || rect?.width || 0, viewportHeight: viewport?.clientHeight || rect?.height || 0, contentWidth: content?.offsetWidth || 0, contentHeight: content?.offsetHeight || 0, rotation }
  }, [])
  const publish = useCallback((value: ImageViewportTransform, notify = true) => {
    const next = clampImageViewport(value, geometry(), minimum(), config.current.maxScale ?? 5)
    const previous = current.current
    current.current = next
    if (next.scale !== previous.scale || next.x !== previous.x || next.y !== previous.y) setTransform(next)
    if (notify && next.scale !== previous.scale) config.current.onScaleChange?.(next.scale)
    return next
  }, [geometry, minimum])
  const point = useCallback((clientX?: number, clientY?: number) => {
    const rect = config.current.viewportRef.current?.getBoundingClientRect()
    return { x: rect && clientX !== undefined ? clientX - rect.left - rect.width / 2 : 0, y: rect && clientY !== undefined ? clientY - rect.top - rect.height / 2 : 0 }
  }, [])
  const zoomTo = useCallback((scale: number, clientX?: number, clientY?: number) => publish(zoomImageViewportAt(current.current, scale, point(clientX, clientY), geometry(), minimum(), config.current.maxScale ?? 5)), [geometry, minimum, point, publish])
  const clearPointers = useCallback(() => {
    const viewport = config.current.viewportRef.current
    const ids = [...pointers.current.keys()]
    pointers.current.clear(); gesture.current = null; safariGesture.current = null
    for (const id of ids) {
      try { if (viewport?.hasPointerCapture?.(id)) viewport.releasePointerCapture(id) } catch { /* Pointer may already have ended. */ }
    }
  }, [])
  const reset = useCallback(() => { clearPointers(); lastTap.current = { at: 0, x: 0, y: 0 }; suppressNextClick.current = false; return publish(INITIAL) }, [clearPointers, publish])
  const reclamp = useCallback(() => publish(current.current), [publish])

  useLayoutEffect(() => {
    const changed = session.current.key !== options.sourceKey || session.current.active !== options.active
    session.current = { key: options.sourceKey, active: options.active }
    skipControlledSync.current = changed
    clearPointers(); lastTap.current = { at: 0, x: 0, y: 0 }; suppressNextClick.current = false
    const previousScale = current.current.scale
    publish(INITIAL, options.active)
    if (changed && options.active && previousScale === 1 && options.scale !== undefined && options.scale !== 1) options.onScaleChange?.(1)
    return clearPointers
  }, [options.sourceKey, options.active, clearPointers, publish])
  useLayoutEffect(() => {
    if (!options.active) return
    if (skipControlledSync.current) { skipControlledSync.current = false; return }
    if (options.scale !== undefined && Number.isFinite(options.scale) && options.scale !== current.current.scale) zoomTo(options.scale)
    else reclamp()
  }, [options.active, options.scale, options.rotation, options.minScale, options.maxScale, reclamp, zoomTo])

  useLayoutEffect(() => {
    if (!options.active) return
    const viewport = options.viewportRef.current
    if (!viewport) return
    const wheel = (event: WheelEvent) => {
      if (!config.current.active || (config.current.wheelMode !== 'always' && !event.ctrlKey && !event.metaKey)) return
      if (event.cancelable) event.preventDefault()
      event.stopPropagation()
      if (!event.deltaY) return
      const normalized = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(1, viewport.clientHeight) : 1)
      const requested = event.ctrlKey || event.metaKey ? current.current.scale * Math.exp(-Math.max(-250, Math.min(250, normalized)) * .002) : current.current.scale + (normalized > 0 ? -.15 : .15)
      zoomTo(requested, event.clientX, event.clientY)
    }
    const gestureStart = (event: Event) => {
      if (event.cancelable) event.preventDefault()
      const input = event as Event & { clientX?: number; clientY?: number }
      safariGesture.current = { start: { ...current.current }, x: input.clientX ?? viewport.getBoundingClientRect().left + viewport.clientWidth / 2, y: input.clientY ?? viewport.getBoundingClientRect().top + viewport.clientHeight / 2 }
    }
    const gestureChange = (event: Event) => {
      if (event.cancelable) event.preventDefault()
      const input = event as Event & { scale?: number }
      if (pointers.current.size >= 2 || !safariGesture.current || !Number.isFinite(input.scale)) return
      suppressNextClick.current = true
      zoomTo(safariGesture.current.start.scale * (input.scale ?? 1), safariGesture.current.x, safariGesture.current.y)
    }
    const gestureEnd = (event: Event) => { if (event.cancelable) event.preventDefault(); safariGesture.current = null }
    const touchMove = (event: TouchEvent) => { if (event.touches.length >= 2 && event.cancelable) event.preventDefault() }
    const resize = () => { clearPointers(); reclamp() }
    viewport.addEventListener('wheel', wheel, { passive: false })
    viewport.addEventListener('gesturestart', gestureStart, { passive: false })
    viewport.addEventListener('gesturechange', gestureChange, { passive: false })
    viewport.addEventListener('gestureend', gestureEnd, { passive: false })
    viewport.addEventListener('touchmove', touchMove, { passive: false })
    window.addEventListener('resize', resize)
    window.addEventListener('orientationchange', resize)
    window.visualViewport?.addEventListener('resize', resize)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    observer?.observe(viewport)
    if (options.contentRef.current) observer?.observe(options.contentRef.current)
    return () => {
      clearPointers(); observer?.disconnect()
      viewport.removeEventListener('wheel', wheel)
      viewport.removeEventListener('gesturestart', gestureStart)
      viewport.removeEventListener('gesturechange', gestureChange)
      viewport.removeEventListener('gestureend', gestureEnd)
      viewport.removeEventListener('touchmove', touchMove)
      window.removeEventListener('resize', resize)
      window.removeEventListener('orientationchange', resize)
      window.visualViewport?.removeEventListener('resize', resize)
    }
  }, [options.active, options.sourceKey, options.viewportRef, options.contentRef, clearPointers, reclamp, zoomTo])

  const capture = useCallback((id: number) => { try { config.current.viewportRef.current?.setPointerCapture(id) } catch { /* Synthetic or ended pointer. */ } }, [])
  const startGesture = useCallback(() => {
    const rows = [...pointers.current.values()]
    if (!rows.length) { gesture.current = null; return }
    const left = rows[0], right = rows[1]
    const mid = right ? { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 } : left
    gesture.current = { start: { ...current.current }, distance: right ? Math.max(1, distance(left, right)) : 0, midpoint: point(mid.x, mid.y), pinch: Boolean(right) }
  }, [point])
  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    if (!config.current.active || (event.pointerType === 'mouse' && event.button !== 0)) return
    if ((event.target as Element).closest?.('button,a,input,textarea,select,[data-image-gesture-ignore]')) return
    if (!pointers.current.size) suppressNextClick.current = false
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, startedAt: performance.now(), touch: event.pointerType === 'touch', moved: false, multiple: false })
    const bounds = imagePanBounds(geometry(), current.current.scale)
    if (pointers.current.size >= 2) {
      for (const [id, row] of pointers.current) { row.multiple = true; capture(id) }
      if (event.cancelable) event.preventDefault()
    } else if (config.current.panEnabled !== false && (bounds.x > 0 || bounds.y > 0)) { capture(event.pointerId); event.preventDefault() }
    startGesture()
  }, [capture, geometry, startGesture])
  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const row = pointers.current.get(event.pointerId)
    if (!row || !config.current.active || !gesture.current) return
    row.x = event.clientX; row.y = event.clientY
    if (Math.hypot(row.x - row.startX, row.y - row.startY) > 6) {
      row.moved = true
      // A drag at a clamped edge is still a drag, never an annotation click.
      suppressNextClick.current = true
    }
    const rows = [...pointers.current.values()]
    const start = gesture.current
    if (rows.length >= 2 && start.pinch) {
      event.preventDefault(); suppressNextClick.current = true
      publish(pinchImageViewport(start.start, start.distance, distance(rows[0], rows[1]), start.midpoint, point((rows[0].x + rows[1].x) / 2, (rows[0].y + rows[1].y) / 2), geometry(), minimum(), config.current.maxScale ?? 5))
    } else if (config.current.panEnabled !== false && !start.pinch) {
      const delta = point(row.x, row.y)
      const next = publish({ ...current.current, x: start.start.x + delta.x - start.midpoint.x, y: start.start.y + delta.y - start.midpoint.y })
      if (row.moved && (next.x !== start.start.x || next.y !== start.start.y)) { event.preventDefault(); suppressNextClick.current = true }
    }
  }, [geometry, minimum, point, publish])
  const endPointer = useCallback((event: PointerEvent<HTMLElement>, cancelled = false) => {
    const row = pointers.current.get(event.pointerId)
    if (!row) return
    pointers.current.delete(event.pointerId)
    try { if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* Already released. */ }
    if (row.multiple) suppressNextClick.current = true
    if (!cancelled && config.current.doubleTapZoom && row.touch && !row.multiple && !row.moved && performance.now() - row.startedAt < 320) {
      const last = lastTap.current
      if (last.at > 0 && performance.now() - last.at < 320 && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 28) {
        lastTap.current = { at: 0, x: 0, y: 0 }; suppressNextClick.current = true
        zoomTo(current.current.scale > 1 ? 1 : 2, event.clientX, event.clientY)
      } else lastTap.current = { at: performance.now(), x: event.clientX, y: event.clientY }
    }
    startGesture()
  }, [startGesture, zoomTo])
  const suppressClick = useCallback((event: MouseEvent<HTMLElement>) => {
    if (suppressNextClick.current) { suppressNextClick.current = false; event.preventDefault(); event.stopPropagation() }
  }, [])
  const viewportProps = useMemo(() => ({ onPointerDown, onPointerMove, onPointerUp: (event: PointerEvent<HTMLElement>) => endPointer(event), onPointerCancel: (event: PointerEvent<HTMLElement>) => endPointer(event, true), onLostPointerCapture: (event: PointerEvent<HTMLElement>) => endPointer(event, true), onClickCapture: suppressClick, style: { touchAction: options.active ? 'none' : undefined, overscrollBehavior: 'contain' } as CSSProperties }), [onPointerDown, onPointerMove, endPointer, suppressClick, options.active])
  const transformStyle: CSSProperties = { transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale}) rotate(${options.rotation ?? 0}deg)`, transformOrigin: 'center center' }
  return { transform, transformStyle, viewportProps, zoomTo, reset, reclamp, suppressClick }
}
