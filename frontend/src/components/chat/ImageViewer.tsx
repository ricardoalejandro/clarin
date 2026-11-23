'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Download, Loader2, RefreshCw, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useImageViewportGestures } from '@/hooks/useImageViewportGestures'
import { OPERATIONAL_OVERLAY_LAYERS, useOperationalOverlayPortal, useOperationalOverlayRegistration } from '@/components/operational-window/OperationalOverlayContext'

interface ImageViewerProps {
  src: string
  alt?: string
  isOpen: boolean
  onClose: () => void
}

export default function ImageViewer({ src, alt, isOpen, onClose }: ImageViewerProps) {
  const [rotation, setRotation] = useState(0)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const imageSessionKey = `${isOpen}:${src}:${attempt}`
  const imageSessionRef = useRef(imageSessionKey)
  imageSessionRef.current = imageSessionKey
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const historyMarkerRef = useRef(`image-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const historyActiveRef = useRef(false)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const operationalPortal = useOperationalOverlayPortal()
  useOperationalOverlayRegistration(isOpen, 'chat-image-viewer')

  const closeViewer = useCallback(() => {
    if (historyActiveRef.current && window.history.state?.__clarinImageViewer === historyMarkerRef.current) {
      historyActiveRef.current = false
      window.history.back()
    }
    onCloseRef.current()
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const openedURL = window.location.href
    let disposed = false
    // Wait for the effect to survive React's mount/cleanup replay. The microtask
    // runs before the next user input, without creating duplicate Back entries.
    queueMicrotask(() => {
      if (disposed) return
      const currentState = window.history.state && typeof window.history.state === 'object' ? window.history.state : {}
      window.history.pushState({ ...currentState, __clarinImageViewer: historyMarkerRef.current }, '')
      historyActiveRef.current = true
    })
    const focusFrame = requestAnimationFrame(() => dialogRef.current?.focus())
    const handleBack = (event: PopStateEvent) => {
      if (!historyActiveRef.current || event.state?.__clarinImageViewer === historyMarkerRef.current) return
      historyActiveRef.current = false
      onCloseRef.current()
    }
    window.addEventListener('popstate', handleBack)
    return () => {
      disposed = true
      cancelAnimationFrame(focusFrame)
      window.removeEventListener('popstate', handleBack)
      if (historyActiveRef.current && window.history.state?.__clarinImageViewer === historyMarkerRef.current) {
        historyActiveRef.current = false
        // A source/owner disappearing must not leave a marker on a new route.
        if (window.location.href === openedURL) window.history.back()
        else {
          const { __clarinImageViewer: _marker, ...rest } = window.history.state
          window.history.replaceState(rest, '')
        }
      }
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [isOpen])

  useEffect(() => {
    setPhase('loading')
    setAttempt(0)
    setRotation(0)
  }, [src, isOpen])

  useEffect(() => {
    if (!isOpen || phase !== 'loading') return
    const timeout = window.setTimeout(() => setPhase('error'), 30_000)
    return () => window.clearTimeout(timeout)
  }, [attempt, isOpen, phase, src])

  const isCompactTouchViewer = useCallback(() => (
    typeof window !== 'undefined'
    && window.innerWidth < 768
    && window.matchMedia('(pointer: coarse)').matches
  ), [])

  const minimumScale = useCallback(() => isCompactTouchViewer() ? 1 : 0.25, [isCompactTouchViewer])

  const gestures = useImageViewportGestures({ sourceKey: `${src}:${attempt}`, active: isOpen, viewportRef: surfaceRef, contentRef: imageRef, minScale: minimumScale, maxScale: 5, rotation, wheelMode: 'always', doubleTapZoom: true })
  const view = gestures.transform
  const viewRef = useRef(view)
  viewRef.current = view
  const zoomAtPoint = gestures.zoomTo
  const resetView = useCallback(() => { setRotation(0); gestures.reset() }, [gestures.reset])
  useEffect(() => {
    if (!isOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]') || [])
          .filter(element => !element.hidden && getComputedStyle(element).display !== 'none')
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {
          event.preventDefault()
          first?.focus()
        }
        return
      }
      switch (event.key) {
        case 'Escape':
          event.preventDefault()
          event.stopPropagation()
          event.stopImmediatePropagation()
          closeViewer()
          break
        case '+':
        case '=':
          zoomAtPoint(viewRef.current.scale + 0.25)
          break
        case '-':
          zoomAtPoint(viewRef.current.scale - 0.25)
          break
        case 'r':
          setRotation(value => value + 90)
          break
        case '0':
          resetView()
          break
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isOpen, closeViewer, resetView, zoomAtPoint])

  const rotate = () => setRotation(value => value + 90)

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
    <div ref={dialogRef} tabIndex={-1} data-chat-overlay="image-viewer" className="app-viewport pointer-events-auto fixed flex flex-col overflow-hidden bg-black/90 outline-none" style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.dialog }} role="dialog" aria-modal="true" aria-label={alt || 'Visor de imagen'}>
      <div className="safe-area-top safe-area-x flex min-h-14 shrink-0 items-center justify-between gap-2 bg-black/50 px-2 py-1 backdrop-blur-sm sm:px-4 sm:py-3">
        <div className="max-w-[45%] truncate text-sm font-medium text-white sm:max-w-[50%]">{alt || 'Imagen'}</div>
        <div className="flex items-center gap-0.5 sm:gap-1">
          <button type="button" onClick={() => zoomAtPoint(viewRef.current.scale + 0.25)} className="hidden h-11 w-11 items-center justify-center rounded-xl text-white/80 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:inline-flex sm:h-auto sm:w-auto sm:rounded-lg sm:p-2" title="Acercar (+)" aria-label="Acercar imagen"><ZoomIn className="h-5 w-5" /></button>
          <button type="button" onClick={() => zoomAtPoint(viewRef.current.scale - 0.25)} className="hidden h-11 w-11 items-center justify-center rounded-xl text-white/80 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:inline-flex sm:h-auto sm:w-auto sm:rounded-lg sm:p-2" title="Alejar (-)" aria-label="Alejar imagen"><ZoomOut className="h-5 w-5" /></button>
          <span data-testid="image-viewer-scale" className="hidden min-w-[50px] px-1 text-center text-sm text-white/70 min-[375px]:inline">{Math.round(view.scale * 100)}%</span>
          <button type="button" onClick={rotate} className="flex h-11 w-11 items-center justify-center rounded-xl text-white/80 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:h-auto sm:w-auto sm:rounded-lg sm:p-2" title="Rotar (R)" aria-label="Rotar imagen"><RotateCw className="h-5 w-5" /></button>
          <button type="button" onClick={handleDownload} disabled={phase !== 'ready'} className="flex h-11 w-11 items-center justify-center rounded-xl text-white/80 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40 sm:h-auto sm:w-auto sm:rounded-lg sm:p-2" title="Descargar" aria-label="Descargar imagen"><Download className="h-5 w-5" /></button>
          <button type="button" onClick={closeViewer} className="flex h-11 w-11 items-center justify-center rounded-xl text-white/80 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:h-auto sm:w-auto sm:rounded-lg sm:p-2" title="Cerrar (Esc)" aria-label="Cerrar visor"><X className="h-6 w-6" /></button>
        </div>
      </div>

      <div
        ref={surfaceRef}
        data-testid="image-viewer-surface"
        className="flex min-h-0 flex-1 cursor-grab items-center justify-center overflow-hidden overscroll-none active:cursor-grabbing"
        {...gestures.viewportProps}
        data-image-viewport
        data-image-scale={view.scale}
        data-image-x={view.x}
        data-image-y={view.y}
        onClick={event => { if (event.target === event.currentTarget && !isCompactTouchViewer()) closeViewer() }}
      >
        {phase === 'loading' && <div className="pointer-events-none absolute flex items-center gap-2 text-sm text-white/80" role="status"><Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden />Cargando imagen…</div>}
        {phase === 'error' ? <div className="flex flex-col items-center gap-3 px-6 text-center text-white" role="alert" onPointerDown={event => event.stopPropagation()}><AlertCircle className="h-7 w-7 text-white/70" aria-hidden /><p className="text-sm">No se pudo cargar la imagen.</p><button type="button" onClick={() => { setAttempt(value => value + 1); setPhase('loading') }} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white/10 px-4 text-sm font-semibold hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"><RefreshCw className="h-4 w-4" aria-hidden />Reintentar imagen</button></div> : <img
          key={`${src}:${attempt}`}
          ref={imageRef}
          src={src}
          alt={alt || 'Imagen'}
          className={`max-h-[90%] max-w-[90%] select-none object-contain will-change-transform transition-opacity duration-150 motion-reduce:transition-none ${phase === 'ready' ? 'opacity-100' : 'opacity-0'}`}
          style={gestures.transformStyle}
          onLoad={() => { if (imageSessionRef.current === imageSessionKey) { setPhase('ready'); gestures.reclamp() } }}
          onError={() => { if (imageSessionRef.current === imageSessionKey) setPhase('error') }}
          draggable={false}
        />}
      </div>

      <div className="safe-area-bottom shrink-0 py-2 text-center text-xs text-white/45">
        <span className="sm:hidden">Pellizca para ampliar · Arrastra para mover · Doble toque para acercar</span>
        <span className="hidden sm:inline">Scroll para zoom · Arrastra para mover · Esc para cerrar</span>
      </div>
    </div>,
    operationalPortal || document.body,
  )
}
