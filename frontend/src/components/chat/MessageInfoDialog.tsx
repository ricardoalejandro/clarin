'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Check, CheckCheck, Clock3, Info, User, X } from 'lucide-react'
import { messageAuthor } from '@/utils/chatInbox'
import { renderFormattedText } from '@/lib/whatsappFormat'
import type { Message } from '@/types/chat'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import { participantName } from '@/utils/chatGroups'
import { OPERATIONAL_OVERLAY_LAYERS, useOperationalOverlayPortal, useOperationalOverlayRegistration } from '@/components/operational-window/OperationalOverlayContext'

interface MessageInfoDialogProps {
  chatId?: string
  isGroup?: boolean
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

export default function MessageInfoDialog(props: MessageInfoDialogProps) {
  const scope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  return isAuthIdentityChanging(scope) ? null : <MessageInfoSession key={scope + ':' + props.chatId + ':' + props.message.id} {...props} scope={scope} />
}
function MessageInfoSession({ message, onClose, chatId, isGroup = false, scope }: MessageInfoDialogProps & { scope: string }) {
  const [receipts, setReceipts] = useState<Array<{ jid: string; name?: string; delivered_at?: string; read_at?: string }>>([])
  const [receiptsLoading, setReceiptsLoading] = useState(false)
  const [receiptsError, setReceiptsError] = useState('')
  const [receiptCursor, setReceiptCursor] = useState('')
  const [receiptNextCursor, setReceiptNextCursor] = useState('')
  useEffect(() => { setReceiptCursor(''); setReceipts([]); setReceiptNextCursor('') }, [chatId, message.id])
  const [receiptRetry, setReceiptRetry] = useState(0)
  useEffect(() => {
    if (!isGroup || !chatId) return
    const controller = new AbortController()
    if (!receiptCursor) setReceipts([]); setReceiptsLoading(true); setReceiptsError('')
    void fetch(`/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(message.id)}/receipts?limit=50&cursor=${encodeURIComponent(receiptCursor)}`, { signal: controller.signal, credentials: 'include' }).then(async response => {
      const data = await response.json()
      if (!response.ok || !data.success || !Array.isArray(data.receipts)) throw new Error(data.error || 'No se pudieron cargar los recibos.')
      if (!controller.signal.aborted && getAuthScope() === scope) { setReceipts(current => receiptCursor ? [...current, ...data.receipts.filter((row: { jid: string }) => !current.some(item => item.jid === row.jid))] : data.receipts); setReceiptNextCursor(data.next_cursor || '') }
    }).catch(cause => { if (!controller.signal.aborted && getAuthScope() === scope) setReceiptsError(cause instanceof Error ? cause.message : 'No se pudieron cargar los recibos.') }).finally(() => { if (!controller.signal.aborted && getAuthScope() === scope) setReceiptsLoading(false) })
    return () => controller.abort()
  }, [chatId, isGroup, message.id, receiptRetry, receiptCursor])
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const operationalPortal = useOperationalOverlayPortal()
  useOperationalOverlayRegistration(true, `message-info:${message.id}`)

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
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
  const author = messageAuthor(message)
  const preview = message.body?.trim() || message.media_filename || typeLabel(message)

  return createPortal(
    <div data-chat-overlay="message-info" className="app-viewport pointer-events-auto fixed inset-0 flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4" style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.dialog }} onMouseDown={event => {
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
            <div className="line-clamp-4 whitespace-pre-wrap break-words">{renderFormattedText(preview)}</div>
          </div>

          {message.is_from_me && <div className="mt-4 flex gap-3 rounded-2xl border border-slate-200 px-4 py-3.5"><User className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" /><div className="min-w-0"><p className="text-xs text-slate-500">Enviado por</p><p className="mt-1 break-words text-sm font-semibold text-slate-800">{author.name}</p><p className="mt-1 text-xs text-slate-500">{author.origin}</p></div></div>}
          {!isGroup && <div className="mt-4 divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
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
          }
          {isGroup && <section className="mt-4" aria-label="Recibos confirmados"><h3 className="text-sm font-semibold text-slate-800">Recibos confirmados</h3><p className="mt-1 text-xs leading-5 text-slate-500">Solo se muestran las confirmaciones recibidas de WhatsApp. Estos datos no prueban que todo el grupo haya leído el mensaje.</p>{receiptsLoading && <p role="status" className="py-4 text-xs text-slate-500">Cargando recibos…</p>}{receiptsError && <div role="alert" className="mt-3 rounded-xl bg-rose-50 p-3 text-xs text-rose-700">{receiptsError}<button type="button" onClick={() => setReceiptRetry(value => value + 1)} className="block min-h-11 font-semibold underline">Reintentar</button></div>}<ul className="mt-3 divide-y divide-slate-100">{receipts.map(receipt => <li key={receipt.jid} className="py-3"><p className="text-sm font-medium text-slate-800">{participantName(receipt.jid, receipt.name)}</p><p className="mt-1 text-xs text-slate-500">{receipt.read_at ? 'Leído: ' + formatReceiptTime(receipt.read_at) : receipt.delivered_at ? 'Entregado: ' + formatReceiptTime(receipt.delivered_at) : 'Sin hora confirmada'}</p></li>)}</ul>{receiptNextCursor && <button type="button" disabled={receiptsLoading} onClick={() => setReceiptCursor(receiptNextCursor)} className="min-h-11 w-full rounded-xl border border-slate-200 text-sm font-semibold text-emerald-700 disabled:opacity-40">Mostrar más recibos</button>}{!receiptsLoading && !receiptsError && !receipts.length && <p className="py-5 text-xs text-slate-500">Todavía no hay recibos confirmados.</p>}</section>}
          {!isGroup && <p className="mt-3 text-xs leading-relaxed text-slate-400">Si la otra persona desactivó las confirmaciones de lectura, Clarin no puede afirmar cuándo abrió el mensaje.</p>}
        </div>
      </div>
    </div>,
    operationalPortal || document.body,
  )
}
