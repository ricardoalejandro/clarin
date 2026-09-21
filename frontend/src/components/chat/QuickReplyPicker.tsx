'use client'

import { createPortal } from 'react-dom'
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react'
import { AlertCircle, File, Image, Loader2, Paperclip, RefreshCw, Video, X, Zap } from 'lucide-react'
import type { QuickReply } from '@/types/quick-reply'
import { getQuickReplyAttachments } from '@/utils/quickReplies'

interface QuickReplyPickerProps {
  replies: QuickReply[]
  isOpen: boolean
  filter: string
  loading: boolean
  error: string
  hasMore: boolean
  loadingMore: boolean
  anchorRef: RefObject<HTMLElement | null>
  portalTarget?: Element | null
  onSelect: (reply: QuickReply) => void
  onClose: () => void
  onLoadMore: () => void
  onRetry: () => void
}

type PickerGeometry = { left: number; top?: number; bottom?: number; width: number; maxHeight: number }

const PICKER_MARGIN = 8
const PICKER_GAP = 8
const PICKER_MIN_HEIGHT = 220
const PICKER_MAX_HEIGHT = 384

export default function QuickReplyPicker({
  replies,
  isOpen,
  filter,
  loading,
  error,
  hasMore,
  loadingMore,
  anchorRef,
  portalTarget,
  onSelect,
  onClose,
  onLoadMore,
  onRetry,
}: QuickReplyPickerProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [geometry, setGeometry] = useState<PickerGeometry | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const listboxID = useId()

  const positionPicker = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const viewport = window.visualViewport
    const viewportWidth = viewport?.width || window.innerWidth
    const viewportHeight = viewport?.height || window.innerHeight
    const offsetLeft = viewport?.offsetLeft || 0
    const offsetTop = viewport?.offsetTop || 0
    const width = Math.min(560, Math.max(300, Math.min(rect.width, viewportWidth - PICKER_MARGIN * 2)))
    const left = Math.min(offsetLeft + viewportWidth - width - PICKER_MARGIN, Math.max(offsetLeft + PICKER_MARGIN, rect.left))
    const spaceAbove = rect.top - offsetTop - PICKER_GAP - PICKER_MARGIN
    const spaceBelow = offsetTop + viewportHeight - rect.bottom - PICKER_GAP - PICKER_MARGIN
    const openAbove = spaceAbove >= PICKER_MIN_HEIGHT || spaceAbove >= spaceBelow
    const maxHeight = Math.max(160, Math.min(PICKER_MAX_HEIGHT, openAbove ? spaceAbove : spaceBelow))
    setGeometry(openAbove
      ? { left, bottom: Math.max(PICKER_MARGIN, window.innerHeight - rect.top + PICKER_GAP), width, maxHeight }
      : { left, top: Math.min(offsetTop + viewportHeight - maxHeight - PICKER_MARGIN, rect.bottom + PICKER_GAP), width, maxHeight })
  }, [anchorRef])

  useEffect(() => {
    if (!isOpen) return
    positionPicker()
    const viewport = window.visualViewport
    window.addEventListener('resize', positionPicker)
    window.addEventListener('scroll', positionPicker, true)
    viewport?.addEventListener('resize', positionPicker)
    viewport?.addEventListener('scroll', positionPicker)
    return () => {
      window.removeEventListener('resize', positionPicker)
      window.removeEventListener('scroll', positionPicker, true)
      viewport?.removeEventListener('resize', positionPicker)
      viewport?.removeEventListener('scroll', positionPicker)
    }
  }, [isOpen, positionPicker])

  useEffect(() => {
    if (!isOpen) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [anchorRef, isOpen, onClose])

  useEffect(() => { setSelectedIndex(0) }, [filter])
  useEffect(() => { setSelectedIndex(current => Math.min(current, Math.max(0, replies.length - 1))) }, [replies.length])
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(`[data-quick-reply-index="${selectedIndex}"]`)
    active?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  useEffect(() => {
    if (!isOpen) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedIndex(current => replies.length ? (current + 1) % replies.length : 0)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedIndex(current => replies.length ? (current - 1 + replies.length) % replies.length : 0)
      } else if (event.key === 'Home' && replies.length) {
        event.preventDefault()
        setSelectedIndex(0)
      } else if (event.key === 'End' && replies.length) {
        event.preventDefault()
        setSelectedIndex(replies.length - 1)
      } else if (event.key === 'Enter' && replies[selectedIndex]) {
        event.preventDefault()
        event.stopPropagation()
        onSelect(replies[selectedIndex])
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [isOpen, onClose, onSelect, replies, selectedIndex])

  if (!isOpen || !geometry || typeof document === 'undefined') return null
  const target = portalTarget || document.body

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Respuestas rápidas"
      style={{ left: geometry.left, top: geometry.top, bottom: geometry.bottom, width: geometry.width, maxHeight: geometry.maxHeight }}
      className="pointer-events-auto fixed z-[175] flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.24)] ring-1 ring-slate-900/5"
    >
      <div className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700"><Zap className="h-4 w-4" /></span>
          <div className="min-w-0">
            <p className="truncate text-sm font-black text-slate-800">Respuestas rápidas</p>
            <p className="truncate text-[10px] font-semibold text-slate-400">{filter ? `Buscando /${filter}` : 'Selecciona para preparar, no para enviar'}</p>
          </div>
          {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-emerald-600" aria-label="Buscando respuestas" />}
        </div>
        <button type="button" onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Cerrar respuestas rápidas"><X className="h-4 w-4" /></button>
      </div>

      <div
        ref={listRef}
        id={listboxID}
        role="listbox"
        aria-label="Resultados de respuestas rápidas"
        aria-activedescendant={replies[selectedIndex] ? `${listboxID}-${replies[selectedIndex].id}` : undefined}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {error && replies.length === 0 ? (
          <div className="flex min-h-36 flex-col items-center justify-center px-5 text-center" role="alert">
            <AlertCircle className="h-6 w-6 text-rose-500" />
            <p className="mt-2 text-xs font-bold text-slate-700">{error}</p>
            <button type="button" onClick={onRetry} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-xl border border-slate-200 px-3 text-xs font-black text-slate-700 hover:bg-slate-50"><RefreshCw className="h-3.5 w-3.5" />Reintentar</button>
          </div>
        ) : loading && replies.length === 0 ? (
          <div className="flex min-h-36 items-center justify-center gap-2 text-xs font-semibold text-slate-500" role="status"><Loader2 className="h-4 w-4 animate-spin text-emerald-600" />Buscando respuestas…</div>
        ) : replies.length === 0 ? (
          <div className="flex min-h-36 flex-col items-center justify-center px-5 text-center">
            <Zap className="h-6 w-6 text-slate-300" />
            <p className="mt-2 text-xs font-bold text-slate-600">No se encontraron respuestas rápidas</p>
            <p className="mt-1 text-[10px] leading-4 text-slate-400">Prueba otro atajo o continúa escribiendo tu mensaje.</p>
          </div>
        ) : replies.map((reply, index) => {
          const attachments = getQuickReplyAttachments(reply)
          return (
            <button
              id={`${listboxID}-${reply.id}`}
              data-quick-reply-index={index}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              key={reply.id}
              onClick={() => onSelect(reply)}
              onMouseEnter={() => setSelectedIndex(index)}
              className={`flex min-h-16 w-full items-start gap-3 border-b border-slate-100 px-3 py-2.5 text-left last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 ${index === selectedIndex ? 'bg-emerald-50/80' : 'hover:bg-slate-50'}`}
            >
              <span className="mt-0.5 inline-flex max-w-36 shrink-0 truncate rounded-lg bg-emerald-100 px-2 py-1 font-mono text-[11px] font-black text-emerald-700">/{reply.shortcut}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-black text-slate-800">{reply.title || 'Sin título'}</p>
                {attachments.length > 0 && <p className="mt-0.5 flex items-center gap-1 text-[10px] font-bold text-emerald-700"><Paperclip className="h-3 w-3" />{attachments.length} adjunto{attachments.length === 1 ? '' : 's'}{attachments[0]?.media_type === 'image' ? <Image className="h-3 w-3" /> : attachments[0]?.media_type === 'video' ? <Video className="h-3 w-3" /> : <File className="h-3 w-3" />}</p>}
                {reply.body && <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[11px] leading-4 text-slate-500">{reply.body}</p>}
              </div>
            </button>
          )
        })}
        {hasMore && replies.length > 0 && <div className="p-2"><button type="button" disabled={loadingMore} onClick={onLoadMore} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 text-xs font-black text-slate-600 hover:bg-slate-50 disabled:opacity-50">{loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Mostrar más</button></div>}
      </div>

      <div className="hidden shrink-0 border-t border-slate-100 bg-slate-50 px-3 py-2 text-[10px] font-semibold text-slate-400 sm:block">↑↓ navegar · Inicio/Fin · Enter preparar · Esc cerrar</div>
      <div className="sr-only" aria-live="polite">{loading ? 'Buscando respuestas rápidas' : `${replies.length} respuestas disponibles`}</div>
    </div>,
    target,
  )
}
