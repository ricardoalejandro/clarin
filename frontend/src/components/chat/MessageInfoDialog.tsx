'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Check, CheckCheck, Clock3, Info, X } from 'lucide-react'
import type { Message } from '@/types/chat'

interface MessageInfoDialogProps {
  message: Message
  onClose: () => void
}

function formatReceiptTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('es-PE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function typeLabel(message: Message) {
  switch (message.message_type) {
    case 'image': return 'Imagen'
    case 'video': return 'Video'
    case 'gif': return 'GIF'
    case 'audio': return 'Audio'
    case 'document': return 'Documento'
    case 'sticker': return 'Sticker'
    case 'location': return 'Ubicación'
    case 'contact': return 'Contacto'
    case 'poll': return 'Encuesta'
    default: return 'Texto'
  }
}

export default function MessageInfoDialog({ message, onClose }: MessageInfoDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current?.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      returnFocus?.focus()
    }
  }, [onClose])

  const statusLevel = message.status === 'read' ? 3 : message.status === 'delivered' ? 2 : message.status === 'sent' ? 1 : 0
  const sentAt = formatReceiptTime(message.timestamp)
  const deliveredAt = formatReceiptTime(message.delivered_at)
  const readAt = formatReceiptTime(message.read_at)
  const preview = message.body?.trim() || message.media_filename || typeLabel(message)

  return createPortal(
    <div className="app-viewport fixed inset-0 z-[110] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="message-info-title" tabIndex={-1} className="flex max-h-[min(82dvh,var(--app-height,100dvh))] w-full flex-col overflow-hidden rounded-t-3xl border border-slate-200 bg-white shadow-2xl sm:max-w-md sm:rounded-2xl">
        <div className="flex min-h-16 shrink-0 items-center gap-3 border-b border-slate-100 px-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700"><Info className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <h2 id="message-info-title" className="font-bold text-slate-900">Información del mensaje</h2>
            <p className="text-xs text-slate-500">{typeLabel(message)}{message.is_edited ? ' · editado' : ''}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Cerrar información del mensaje"><X className="h-5 w-5" /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-4">
          <div className="rounded-2xl bg-[#d9fdd3] px-3 py-2.5 text-sm text-slate-800 shadow-sm">
            <p className="line-clamp-4 whitespace-pre-wrap break-words">{preview}</p>
          </div>

          <div className="mt-4 divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
            <div className="flex gap-3 px-4 py-3.5">
              <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" />
              <div><p className="text-sm font-semibold text-slate-800">Enviado</p><p className="mt-0.5 text-xs text-slate-500">{sentAt || 'Hora no disponible'}</p></div>
            </div>
            <div className="flex gap-3 px-4 py-3.5">
              <CheckCheck className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" />
              <div><p className="text-sm font-semibold text-slate-800">Entregado</p><p className="mt-0.5 text-xs text-slate-500">{deliveredAt || (statusLevel >= 2 ? 'Confirmado · hora no disponible' : 'Sin confirmación de entrega')}</p></div>
            </div>
            <div className="flex gap-3 px-4 py-3.5">
              {statusLevel >= 3 ? <CheckCheck className="mt-0.5 h-5 w-5 shrink-0 text-blue-500" /> : <Check className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />}
              <div><p className="text-sm font-semibold text-slate-800">Leído</p><p className="mt-0.5 text-xs text-slate-500">{readAt || (statusLevel >= 3 ? 'Confirmado · hora no disponible' : 'Sin confirmación de lectura')}</p></div>
            </div>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-400">Si la otra persona desactivó las confirmaciones de lectura, Clarin no puede afirmar cuándo abrió el mensaje.</p>
        </div>
      </div>
    </div>,
    document.body,
  )
}
