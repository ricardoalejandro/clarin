"use client"
import { useLayoutEffect, useRef, useState } from 'react'
import { useImageViewportGestures } from '@/hooks/useImageViewportGestures'
import type { TaskAttachmentAnchor } from '@/types/task'
import { normalizedAttachmentPoint } from './taskAttachmentAnchors'

type Props = { src: string; alt: string; sourceKey: string; active: boolean; scale: number; onScaleChange: (scale: number) => void; anchor: TaskAttachmentAnchor; onAnchor: (anchor: TaskAttachmentAnchor) => void; onError: () => void }

/** The image and its normalized comment marker share one transform and click owner. */
export default function TaskImageViewport({ src, alt, sourceKey, active, scale, onScaleChange, anchor, onAnchor, onError }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [natural, setNatural] = useState({ width: 0, height: 0 })
  const gestures = useImageViewportGestures({ sourceKey, active, viewportRef, contentRef, scale, onScaleChange, minScale: .5, maxScale: 4, wheelMode: 'modifier' })
  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element || !active) return
    const measure = () => setSize(previous => {
      const width = element.clientWidth, height = element.clientHeight
      return previous.width === width && previous.height === height ? previous : { width, height }
    })
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [active, sourceKey])
  const ratio = natural.width && natural.height && size.width && size.height ? Math.min(1, size.width / natural.width, size.height / natural.height) : 0
  return <div ref={viewportRef} {...gestures.viewportProps} data-task-image-viewport data-image-scale={gestures.transform.scale} role="region" aria-label={`Imagen ampliable: ${alt}`} tabIndex={active ? 0 : -1}
    className="absolute inset-5 flex items-center justify-center overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
    onClick={event => {
      const rect = contentRef.current?.getBoundingClientRect()
      if (!active || !ratio || !rect || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return
      onAnchor(normalizedAttachmentPoint('image', rect, event.clientX, event.clientY))
    }}>
    <div ref={contentRef} data-task-image-content className="relative shrink-0" style={{ ...gestures.transformStyle, width: ratio ? natural.width * ratio : '100%', height: ratio ? natural.height * ratio : '100%' }}>
      <img src={src} alt={alt} draggable={false} className="h-full w-full select-none rounded-lg object-contain shadow-2xl" style={{ visibility: ratio ? 'visible' : 'hidden' }}
        onLoad={event => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); gestures.reclamp() }} onError={onError} />
      {anchor.kind === 'image' && anchor.x !== undefined && <span data-task-image-anchor className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-white bg-emerald-500 shadow-lg" style={{ left: `${anchor.x * 100}%`, top: `${(anchor.y || 0) * 100}%` }} />}
    </div>
  </div>
}
