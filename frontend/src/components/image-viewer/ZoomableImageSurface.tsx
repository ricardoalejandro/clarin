"use client"

import { useEffect, useRef, useState, type ReactEventHandler } from 'react'
import { AlertCircle, Loader2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import { useImageViewportGestures } from '@/hooks/useImageViewportGestures'

type Props = {
  src: string
  alt: string
  sourceKey?: string
  active?: boolean
  className?: string
  imageClassName?: string
  minScale?: number
  maxScale?: number
  onLoad?: ReactEventHandler<HTMLImageElement>
  onError?: ReactEventHandler<HTMLImageElement>
  showControls?: boolean
  onScaleChange?: (scale: number) => void
}

/** Inline image viewport: the owning window keeps its size, focus and lifecycle. */
export default function ZoomableImageSurface({ src, alt, sourceKey = src, active = true, className = '', imageClassName = '', minScale = 1, maxScale = 5, onLoad, onError, showControls = true, onScaleChange }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLImageElement>(null)
  const key = `${sourceKey}:${src}`
  const session = useRef(key); session.current = key
  const [load, setLoad] = useState({ key, phase: 'loading' as 'loading' | 'ready' | 'error', attempt: 0 })
  const phase = load.key === key ? load.phase : 'loading'
  const gestures = useImageViewportGestures({ sourceKey: `${key}:${load.attempt}`, active, viewportRef, contentRef, minScale, maxScale, onScaleChange, wheelMode: 'modifier', doubleTapZoom: true })
  useEffect(() => {
    if (!active || phase !== 'loading') return
    const timeout = window.setTimeout(() => { if (session.current === key) setLoad(current => ({ key, phase: 'error', attempt: current.attempt })) }, 30_000)
    return () => window.clearTimeout(timeout)
  }, [active, key, phase, load.attempt])
  const retry = () => { gestures.reset(); setLoad(current => ({ key, phase: 'loading', attempt: current.attempt + 1 })) }
  return <div className={`flex min-h-0 flex-col ${className}`} data-zoomable-image-surface>
    <div ref={viewportRef} {...gestures.viewportProps} data-image-viewport data-image-scale={gestures.transform.scale} data-image-x={gestures.transform.x} data-image-y={gestures.transform.y} role="region" aria-label={`Imagen ampliable: ${alt}`} tabIndex={active ? 0 : -1}
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
      onKeyDown={event => { if (!active || event.ctrlKey || event.metaKey || event.altKey) return; if (['+', '=', '-', '0'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); if (event.key === '0') gestures.reset(); else gestures.zoomTo(gestures.transform.scale + (event.key === '-' ? -.25 : .25)) } }}>
      {phase === 'loading' && <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-slate-400"><Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />Cargando imagen…</div>}
      {phase === 'error' && <div role="alert" className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-4 text-center text-sm text-slate-400"><AlertCircle className="h-6 w-6" />No se pudo cargar la imagen.<button type="button" onClick={retry} className="min-h-11 rounded-xl border border-current/30 px-4 font-medium">Reintentar</button></div>}
      <img key={`${key}:${load.attempt}`} ref={contentRef} data-zoomable-image src={src} alt={alt} draggable={false} style={{ ...gestures.transformStyle, visibility: phase === 'ready' ? 'visible' : 'hidden' }} className={`max-h-full max-w-full select-none object-contain ${imageClassName}`}
        onLoad={event => { if (session.current !== key) return; setLoad(current => ({ key, phase: 'ready', attempt: current.attempt })); gestures.reclamp(); onLoad?.(event) }}
        onError={event => { if (session.current !== key) return; setLoad(current => ({ key, phase: 'error', attempt: current.attempt })); onError?.(event) }} />
    </div>
    {showControls && <div className="flex shrink-0 items-center justify-center gap-1 pt-2 text-slate-500" aria-label="Zoom de la imagen">
      <button type="button" disabled={!active || phase !== 'ready' || gestures.transform.scale <= minScale} onClick={() => gestures.zoomTo(gestures.transform.scale - .25)} aria-label="Alejar imagen" className="flex h-11 w-11 items-center justify-center rounded-xl hover:bg-slate-500/10 disabled:opacity-30"><ZoomOut className="h-4 w-4" /></button>
      <output className="min-w-14 text-center text-xs tabular-nums" aria-label="Escala de imagen">{Math.round(gestures.transform.scale * 100)}%</output>
      <button type="button" disabled={!active || phase !== 'ready' || gestures.transform.scale >= maxScale} onClick={() => gestures.zoomTo(gestures.transform.scale + .25)} aria-label="Acercar imagen" className="flex h-11 w-11 items-center justify-center rounded-xl hover:bg-slate-500/10 disabled:opacity-30"><ZoomIn className="h-4 w-4" /></button>
      <button type="button" disabled={!active || phase !== 'ready'} onClick={() => gestures.reset()} aria-label="Ajustar imagen" className="flex h-11 w-11 items-center justify-center rounded-xl hover:bg-slate-500/10 disabled:opacity-30"><RotateCcw className="h-4 w-4" /></button>
    </div>}
  </div>
}
