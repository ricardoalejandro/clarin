'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react'

interface ImageViewerProps {
  src: string
  alt?: string
  isOpen: boolean
  onClose: () => void
}

type ViewTransform = {
  scale: number
  rotation: number
  x: number
  y: number
}

type ActivePointer = {
  x: number
  y: number
  startX: number
  startY: number
  startedAt: number
  pointerType: string
  moved: boolean
}

type Gesture = {
  kind: 'pan' | 'pinch'
  startScale: number
  startX: number
  startY: number
  startDistance: number
  startMidpointX: number
  startMidpointY: number
}

const INITIAL_VIEW: ViewTransform = { scale: 1, rotation: 0, x: 0, y: 0 }

function distance(left: ActivePointer, right: ActivePointer) {
  return Math.hypot(right.x - left.x, right.y - left.y)
}

export default function ImageViewer({ src, alt, isOpen, onClose }: ImageViewerProps) {
  const [view, setView] = useState<ViewTransform>(INITIAL_VIEW)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const viewRef = useRef<ViewTransform>(INITIAL_VIEW)
  const pointersRef = useRef(new Map<number, ActivePointer>())
  const gestureRef = useRef<Gesture | null>(null)
  const frameRef = useRef(0)
  const lastTapRef = useRef({ at: 0, x: 0, y: 0 })

  const isCompactTouchViewer = useCallback(() => (
    typeof window !== 'undefined'
    && window.innerWidth < 768
    && window.matchMedia('(pointer: coarse)').matches
  ), [])

  const minimumScale = useCallback(() => isCompactTouchViewer() ? 1 : 0.25, [isCompactTouchViewer])

  const clampView = useCallback((candidate: ViewTransform): ViewTransform => {
    const surface = surfaceRef.current
    const image = imageRef.current
    const scale = Math.min(5, Math.max(minimumScale(), candidate.scale))
    if (!surface || !image) return { ...candidate, scale }

    const normalizedRotation = ((candidate.rotation % 360) + 360) % 360
    const swapsDimensions = normalizedRotation === 90 || normalizedRotation === 270
    const baseWidth = swapsDimensions ? image.offsetHeight : image.offsetWidth
    const baseHeight = swapsDimensions ? image.offsetWidth : image.offsetHeight
    const maximumX = Math.max(0, (baseWidth * scale - surface.clientWidth) / 2)
    const maximumY = Math.max(0, (baseHeight * scale - surface.clientHeight) / 2)

    return {
      scale,
      rotation: candidate.rotation,
      x: Math.max(-maximumX, Math.min(candidate.x, maximumX)),
      y: Math.max(-maximumY, Math.min(candidate.y, maximumY)),
    }
  }, [minimumScale])

  const renderView = useCallback((candidate: ViewTransform, commit = false) => {
    const next = clampView(candidate)
    viewRef.current = next
    if (frameRef.current) cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => {
      if (imageRef.current) {
        imageRef.current.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.scale}) rotate(${next.rotation}deg)`
      }
    })
    if (commit) setView(next)
    return next
  }, [clampView])

  const resetView = useCallback(() => {
    viewRef.current = INITIAL_VIEW
    setView(INITIAL_VIEW)
    renderView(INITIAL_VIEW)
  }, [renderView])

  const zoomAtPoint = useCallback((requestedScale: number, clientX?: number, clientY?: number, commit = true) => {
    const surface = surfaceRef.current
    const current = viewRef.current
    const nextScale = Math.min(5, Math.max(minimumScale(), requestedScale))
    if (!surface || clientX === undefined || clientY === undefined || current.scale === 0) {
      return renderView({ ...current, scale: nextScale, x: nextScale === 1 ? 0 : current.x, y: nextScale === 1 ? 0 : current.y }, commit)
    }

    const rect = surface.getBoundingClientRect()
    const pointX = clientX - (rect.left + rect.width / 2)
    const pointY = clientY - (rect.top + rect.height / 2)
    const ratio = nextScale / current.scale
    return renderView({
      ...current,
      scale: nextScale,
      x: nextScale === 1 ? 0 : pointX - (pointX - current.x) * ratio,
      y: nextScale === 1 ? 0 : pointY - (pointY - current.y) * ratio,
    }, commit)
  }, [minimumScale, renderView])

  useEffect(() => {
    if (!isOpen) return
    const previousOverflow = document.body.style.overflow
    resetView()
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      pointersRef.current.clear()
      gestureRef.current = null
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
    }
  }, [isOpen, resetView, src])

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'Escape':
          onClose()
          break
        case '+':
        case '=':
          zoomAtPoint(viewRef.current.scale + 0.25)
          break
        case '-':
          zoomAtPoint(viewRef.current.scale - 0.25)
          break
        case 'r':
          renderView({ ...viewRef.current, rotation: viewRef.current.rotation + 90 }, true)
          break
        case '0':
          resetView()
          break
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose, renderView, resetView, zoomAtPoint])

  useEffect(() => {
    if (!isOpen) return
    const surface = surfaceRef.current
    if (!surface) return
    const preventBrowserGesture = (event: Event) => event.preventDefault()
    surface.addEventListener('gesturestart', preventBrowserGesture, { passive: false })
    surface.addEventListener('gesturechange', preventBrowserGesture, { passive: false })
    return () => {
      surface.removeEventListener('gesturestart', preventBrowserGesture)
      surface.removeEventListener('gesturechange', preventBrowserGesture)
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const clampAfterResize = () => renderView(viewRef.current, true)
    window.addEventListener('resize', clampAfterResize, { passive: true })
    window.addEventListener('orientationchange', clampAfterResize, { passive: true })
    return () => {
      window.removeEventListener('resize', clampAfterResize)
      window.removeEventListener('orientationchange', clampAfterResize)
    }
  }, [isOpen, renderView])

  const beginGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic test events and a few older mobile engines do not expose an
      // active native pointer to capture. The gesture still remains scoped to
      // this fullscreen surface through touch-action and its event handlers.
    }
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: performance.now(),
      pointerType: event.pointerType,
      moved: false,
    })

    const pointers = Array.from(pointersRef.current.values())
    if (pointers.length >= 2) {
      const [left, right] = pointers
      gestureRef.current = {
        kind: 'pinch',
        startScale: viewRef.current.scale,
        startX: viewRef.current.x,
        startY: viewRef.current.y,
        startDistance: Math.max(1, distance(left, right)),
        startMidpointX: (left.x + right.x) / 2,
        startMidpointY: (left.y + right.y) / 2,
      }
    } else {
      gestureRef.current = {
        kind: 'pan',
        startScale: viewRef.current.scale,
        startX: viewRef.current.x,
        startY: viewRef.current.y,
        startDistance: 0,
        startMidpointX: event.clientX,
        startMidpointY: event.clientY,
      }
    }
  }

  const moveGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const pointer = pointersRef.current.get(event.pointerId)
    if (!pointer) return
    event.preventDefault()
    pointer.x = event.clientX
    pointer.y = event.clientY
    if (Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) > 8) pointer.moved = true

    const gesture = gestureRef.current
    const pointers = Array.from(pointersRef.current.values())
    if (!gesture) return

    if (pointers.length >= 2) {
      const [left, right] = pointers
      const surface = surfaceRef.current
      if (!surface) return
      const currentDistance = Math.max(1, distance(left, right))
      const scale = Math.min(5, Math.max(1, gesture.startScale * currentDistance / gesture.startDistance))
      const rect = surface.getBoundingClientRect()
      const startPointX = gesture.startMidpointX - (rect.left + rect.width / 2)
      const startPointY = gesture.startMidpointY - (rect.top + rect.height / 2)
      const currentPointX = (left.x + right.x) / 2 - (rect.left + rect.width / 2)
      const currentPointY = (left.y + right.y) / 2 - (rect.top + rect.height / 2)
      const ratio = scale / gesture.startScale
      renderView({
        ...viewRef.current,
        scale,
        x: currentPointX - (startPointX - gesture.startX) * ratio,
        y: currentPointY - (startPointY - gesture.startY) * ratio,
      })
      return
    }

    if (gesture.kind === 'pan' && pointers.length === 1 && viewRef.current.scale > 1) {
      renderView({
        ...viewRef.current,
        x: gesture.startX + pointers[0].x - gesture.startMidpointX,
        y: gesture.startY + pointers[0].y - gesture.startMidpointY,
      })
    }
  }

  const endGesture = (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const pointer = pointersRef.current.get(event.pointerId)
    if (!pointer) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    pointersRef.current.delete(event.pointerId)

    if (!cancelled && pointer.pointerType === 'touch' && !pointer.moved && performance.now() - pointer.startedAt < 320) {
      const lastTap = lastTapRef.current
      const closeInTime = performance.now() - lastTap.at < 320
      const closeInSpace = Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 28
      if (closeInTime && closeInSpace) {
        lastTapRef.current = { at: 0, x: 0, y: 0 }
        zoomAtPoint(viewRef.current.scale > 1 ? 1 : 2, event.clientX, event.clientY)
      } else {
        lastTapRef.current = { at: performance.now(), x: event.clientX, y: event.clientY }
      }
    }

    const remaining = Array.from(pointersRef.current.values())
    if (remaining.length === 1) {
      gestureRef.current = {
        kind: 'pan',
        startScale: viewRef.current.scale,
        startX: viewRef.current.x,
        startY: viewRef.current.y,
        startDistance: 0,
        startMidpointX: remaining[0].x,
        startMidpointY: remaining[0].y,
      }
    } else if (remaining.length === 0) {
      gestureRef.current = null
      setView(viewRef.current)
    }
  }

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    zoomAtPoint(viewRef.current.scale + (event.deltaY > 0 ? -0.15 : 0.15), event.clientX, event.clientY)
  }

  const rotate = () => renderView({ ...viewRef.current, rotation: viewRef.current.rotation + 90 }, true)

  const handleDownload = () => {
    const link = document.createElement('a')
    link.href = src
    link.download = alt || 'imagen'
    link.target = '_blank'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  if (!isOpen || typeof document === 'undefined') return null

  return createPortal(
    <div className="app-viewport fixed z-[110] flex flex-col overflow-hidden bg-black/90" role="dialog" aria-modal="true" aria-label={alt || 'Visor de imagen'}>
      <div className="safe-area-top safe-area-x flex min-h-14 shrink-0 items-center justify-between gap-2 bg-black/50 px-2 py-1 backdrop-blur-sm sm:px-4 sm:py-3">
        <div className="max-w-[45%] truncate text-sm font-medium text-white sm:max-w-[50%]">{alt || 'Imagen'}</div>
        <div className="flex items-center gap-0.5 sm:gap-1">
          <button type="button" onClick={() => zoomAtPoint(viewRef.current.scale + 0.25)} className="hidden h-11 w-11 items-center justify-center rounded-xl text-white/80 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:inline-flex sm:h-auto sm:w-auto sm:rounded-lg sm:p-2" title="Acercar (+)" aria-label="Acercar imagen"><ZoomIn className="h-5 w-5" /></button>
          <button type="button" onClick={() => zoomAtPoint(viewRef.current.scale - 0.25)} className="hidden h-11 w-11 items-center justify-center rounded-xl text-white/80 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:inline-flex sm:h-auto sm:w-auto sm:rounded-lg sm:p-2" title="Alejar (-)" aria-label="Alejar imagen"><ZoomOut className="h-5 w-5" /></button>
          <span data-testid="image-viewer-scale" className="min-w-[50px] px-1 text-center text-sm text-white/70">{Math.round(view.scale * 100)}%</span>
          <button type="button" onClick={rotate} className="flex h-11 w-11 items-center justify-center rounded-xl text-white/80 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:h-auto sm:w-auto sm:rounded-lg sm:p-2" title="Rotar (R)" aria-label="Rotar imagen"><RotateCw className="h-5 w-5" /></button>
          <button type="button" onClick={handleDownload} className="hidden h-11 w-11 items-center justify-center rounded-xl text-white/80 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:flex sm:h-auto sm:w-auto sm:rounded-lg sm:p-2" title="Descargar" aria-label="Descargar imagen"><Download className="h-5 w-5" /></button>
          <button type="button" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-xl text-white/80 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:h-auto sm:w-auto sm:rounded-lg sm:p-2" title="Cerrar (Esc)" aria-label="Cerrar visor"><X className="h-6 w-6" /></button>
        </div>
      </div>

      <div
        ref={surfaceRef}
        data-testid="image-viewer-surface"
        className="flex min-h-0 flex-1 cursor-grab items-center justify-center overflow-hidden overscroll-none active:cursor-grabbing"
        style={{ touchAction: 'none' }}
        onClick={event => { if (event.target === event.currentTarget && !isCompactTouchViewer()) onClose() }}
        onPointerDown={beginGesture}
        onPointerMove={moveGesture}
        onPointerUp={event => endGesture(event)}
        onPointerCancel={event => endGesture(event, true)}
        onWheel={handleWheel}
      >
        <img
          ref={imageRef}
          src={src}
          alt={alt || 'Imagen'}
          className="max-h-[90%] max-w-[90%] select-none object-contain will-change-transform"
          style={{ transform: 'translate3d(0, 0, 0) scale(1) rotate(0deg)' }}
          onLoad={() => renderView(viewRef.current, true)}
          draggable={false}
        />
      </div>

      <div className="safe-area-bottom shrink-0 py-2 text-center text-xs text-white/45">
        <span className="sm:hidden">Pellizca para ampliar · Arrastra para mover · Doble toque para acercar</span>
        <span className="hidden sm:inline">Scroll para zoom · Arrastra para mover · Esc para cerrar</span>
      </div>
    </div>,
    document.body,
  )
}
