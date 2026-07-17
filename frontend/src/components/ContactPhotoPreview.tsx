'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

interface ContactPhotoPreviewProps {
  url?: string | null
  name: string
  sizeClassName?: string
  fallbackClassName?: string
}

export default function ContactPhotoPreview({
  url,
  name,
  sizeClassName = 'h-11 w-11',
  fallbackClassName = 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100',
}: ContactPhotoPreviewProps) {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => setFailed(false), [url])

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        event.preventDefault()
        closeButtonRef.current?.focus()
        return
      }
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previousOverflow
      window.setTimeout(() => triggerRef.current?.focus(), 0)
    }
  }, [open])

  const initials = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?'
  const hasPhoto = Boolean(url) && !failed

  return (
    <>
      {hasPhoto ? (
        <button
          ref={triggerRef}
          type="button"
          onClick={event => { event.stopPropagation(); setOpen(true) }}
          className={`${sizeClassName} shrink-0 overflow-hidden rounded-full bg-slate-100 shadow-sm ring-1 ring-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2`}
          aria-label={`Ampliar foto de ${name}`}
          title="Ampliar foto"
        >
          <img src={url || ''} alt={`Foto de ${name}`} loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover" />
        </button>
      ) : (
        <span className={`${sizeClassName} ${fallbackClassName} flex shrink-0 items-center justify-center rounded-full text-xs font-bold`} aria-hidden="true">{initials}</span>
      )}

      {open && url && typeof document !== 'undefined' && createPortal(
        <div role="dialog" aria-modal="true" aria-label={`Foto de ${name}`} className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm" onMouseDown={() => setOpen(false)}>
          <div className="relative flex max-h-[92vh] max-w-[92vw] flex-col items-center" onMouseDown={event => event.stopPropagation()}>
            <button ref={closeButtonRef} type="button" onClick={() => setOpen(false)} className="absolute right-2 top-2 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white shadow-lg hover:bg-black/75 focus:outline-none focus-visible:ring-2 focus-visible:ring-white" aria-label="Cerrar foto">
              <X className="h-5 w-5" />
            </button>
            <img src={url} alt={`Foto ampliada de ${name}`} className="max-h-[85vh] max-w-[90vw] rounded-2xl object-contain shadow-2xl" />
            <p className="mt-3 max-w-[90vw] truncate rounded-full bg-black/45 px-4 py-1.5 text-sm font-medium text-white">{name}</p>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
