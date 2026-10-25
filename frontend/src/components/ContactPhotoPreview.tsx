'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import ZoomableImageSurface from '@/components/image-viewer/ZoomableImageSurface'

interface ContactPhotoPreviewProps {
  url?: string | null
  name: string
  ownerKey?: string
  sizeClassName?: string
  fallbackClassName?: string
  suspended?: boolean
}

export default function ContactPhotoPreview({
  url,
  name,
  ownerKey,
  sizeClassName = 'h-11 w-11',
  fallbackClassName = 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100',
  suspended = false,
}: ContactPhotoPreviewProps) {
  const authScope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  const identityKey = `${authScope}:${ownerKey || name}:${url || ''}`
  const identityRef = useRef(identityKey)
  identityRef.current = identityKey
  const [openIdentity, setOpenIdentity] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const visible = openIdentity === identityKey && !suspended && !isAuthIdentityChanging(authScope)

  useEffect(() => setFailed(false), [identityKey])
  useEffect(() => { if (suspended) setOpenIdentity(null) }, [suspended])

  useEffect(() => {
    if (!visible) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const controls = Array.from(previewRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]') || [])
        const first = controls[0], last = controls[controls.length - 1]
        if (!first) { event.preventDefault(); closeButtonRef.current?.focus() }
        else if (!previewRef.current?.contains(document.activeElement)) { event.preventDefault(); first.focus() }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        return
      }
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpenIdentity(null)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previousOverflow
      window.setTimeout(() => {
        const trigger = triggerRef.current
        if (identityRef.current === identityKey && !suspendedRef.current && trigger?.isConnected && !trigger.closest('[hidden], [inert]')) trigger.focus()
      }, 0)
    }
  }, [visible, identityKey])

  const initials = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?'
  const hasPhoto = Boolean(url) && !failed && !isAuthIdentityChanging(authScope)

  return (
    <>
      {hasPhoto ? (
        <button
          key={identityKey}
          ref={triggerRef}
          type="button"
          disabled={suspended}
          onClick={event => { event.stopPropagation(); setOpenIdentity(identityKey) }}
          className={`${sizeClassName} shrink-0 overflow-hidden rounded-full bg-slate-100 shadow-sm ring-1 ring-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2`}
          aria-label={`Ampliar foto de ${name}`}
          title="Ampliar foto"
        >
          <img src={url || ''} alt={`Foto de ${name}`} loading="lazy" onError={() => { if (identityRef.current === identityKey) setFailed(true) }} className="h-full w-full object-cover" />
        </button>
      ) : (
        <span className={`${sizeClassName} ${fallbackClassName} flex shrink-0 items-center justify-center rounded-full text-xs font-bold`} aria-hidden="true">{initials}</span>
      )}

      {visible && url && typeof document !== 'undefined' && createPortal(
        <div role="dialog" aria-modal="true" aria-label={`Foto de ${name}`} className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm" onMouseDown={() => setOpenIdentity(null)}>
          <div ref={previewRef} className="relative flex max-h-[92vh] max-w-[92vw] flex-col items-center" onMouseDown={event => event.stopPropagation()}>
            <button ref={closeButtonRef} type="button" onClick={() => setOpenIdentity(null)} className="absolute right-2 top-2 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white shadow-lg hover:bg-black/75 focus:outline-none focus-visible:ring-2 focus-visible:ring-white" aria-label="Cerrar foto">
              <X className="h-5 w-5" />
            </button>
            <ZoomableImageSurface src={url} alt={`Foto ampliada de ${name}`} sourceKey={identityKey} active={visible} className="h-[min(75vh,40rem)] w-[min(90vw,40rem)] rounded-2xl bg-slate-950 shadow-2xl" imageClassName="rounded-2xl" />
            <p className="mt-3 max-w-[90vw] truncate rounded-full bg-black/45 px-4 py-1.5 text-sm font-medium text-white">{name}</p>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
