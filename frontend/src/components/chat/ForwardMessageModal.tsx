'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Search, Send, User, Image as ImageIcon, FileText, Video, Mic, Check, RefreshCw } from 'lucide-react'
import { Chat, Message } from '@/types/chat'

interface Props {
  message: Message
  deviceId: string
  chatId: string
  onClose: () => void
  onSuccess: () => void
}

const MAX_FORWARD = 5
const PAGE_SIZE = 50

export default function ForwardMessageModal({ message, deviceId, chatId, onClose, onSuccess }: Props) {
  const [chats, setChats] = useState<Chat[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [total, setTotal] = useState(0)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [selectedChats, setSelectedChats] = useState<Chat[]>([])
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const focusTimer = window.setTimeout(() => searchRef.current?.focus(), 100)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !sending) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose, sending])

  const fetchChats = useCallback(async (offset: number, append: boolean, signal?: AbortSignal) => {
    const token = localStorage.getItem('token')
    if (append) setLoadingMore(true)
    else setLoading(true)
    setLoadError('')
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
    if (search.trim()) params.set('search', search.trim())
    try {
      const res = await fetch(`/api/chats?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success || !Array.isArray(data.chats)) throw new Error(data.error || 'No se pudieron cargar los chats.')
      setChats(current => append ? [...current, ...data.chats.filter((chat: Chat) => !current.some(item => item.id === chat.id))] : data.chats)
      setTotal(Number(data.total) || data.chats.length)
    } catch (error) {
      if (signal?.aborted) return
      setLoadError(error instanceof Error ? error.message : 'No se pudieron cargar los chats.')
      if (!append) {
        setChats([])
        setTotal(0)
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [search])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void fetchChats(0, false, controller.signal)
    }, search.trim() ? 250 : 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [fetchChats, search])

  const toggleSelect = (chat: Chat) => {
    setSelectedChats(previous => {
      if (previous.some(item => item.id === chat.id)) return previous.filter(item => item.id !== chat.id)
      if (previous.length >= MAX_FORWARD) return previous
      return [...previous, chat]
    })
  }

  const handleForwardAll = async () => {
    if (selectedChats.length === 0 || sending) return
    setSending(true)
    setSendError('')

    const token = localStorage.getItem('token')
    let successCount = 0
    const failedTargets: Chat[] = []

    for (const target of selectedChats) {
      try {
        const res = await fetch('/api/messages/forward', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            device_id: deviceId,
            to: target.jid,
            chat_id: chatId,
            message_id: message.message_id
          })
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.success) successCount++
        else failedTargets.push(target)
      } catch (err) {
        console.error('Forward failed to', target.jid, err)
        failedTargets.push(target)
      }
    }

    if (successCount === selectedChats.length) {
      onSuccess()
      onClose()
    } else {
      setSelectedChats(failedTargets)
      setSendError(successCount > 0
        ? `Se reenvió a ${successCount}; quedan ${failedTargets.length} chat${failedTargets.length === 1 ? '' : 's'} por reintentar.`
        : 'No se pudo reenviar el mensaje. Revisa la conexión e inténtalo otra vez.')
    }
    setSending(false)
  }

  const getMessagePreview = () => {
    const type = message.message_type || 'text'
    if (type === 'image') return { icon: <ImageIcon className="w-4 h-4" />, text: message.body || '📷 Imagen' }
    if (type === 'video') return { icon: <Video className="w-4 h-4" />, text: message.body || '🎥 Video' }
    if (type === 'gif') return { icon: <Video className="w-4 h-4" />, text: message.body || 'GIF' }
    if (type === 'audio') return { icon: <Mic className="w-4 h-4" />, text: '🎵 Audio' }
    if (type === 'document') return { icon: <FileText className="w-4 h-4" />, text: message.media_filename || '📄 Documento' }
    if (type === 'sticker') return { icon: <ImageIcon className="w-4 h-4" />, text: '🏷️ Sticker' }
    return { icon: null, text: message.body || '' }
  }

  const preview = getMessagePreview()
  const selectedIds = new Set(selectedChats.map(chat => chat.id))
  const hasMore = chats.length < total

  return (
    <div className="app-viewport fixed inset-0 z-[105] flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget && !sending) onClose() }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="forward-message-title"
        className="flex h-[var(--app-height,100dvh)] w-full flex-col overflow-hidden bg-white shadow-2xl sm:h-auto sm:max-h-[85dvh] sm:max-w-md sm:rounded-2xl"
        onMouseDown={event => event.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
          <h3 id="forward-message-title" className="text-lg font-bold text-slate-800">Reenviar mensaje</h3>
          <button type="button" onClick={onClose} disabled={sending} className="flex h-11 w-11 items-center justify-center rounded-xl transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50" aria-label="Cerrar reenvío">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        {/* Message Preview */}
        <div className="mx-5 mt-3 p-3 bg-slate-50 rounded-xl border border-slate-200 shrink-0">
          <div className="flex items-center gap-2 text-sm text-slate-600">
            {preview.icon}
            <span className="line-clamp-2">{preview.text}</span>
          </div>
          {message.media_url && (message.message_type === 'image' || message.message_type === 'sticker') && (
            <img src={message.media_url} className="w-16 h-16 rounded-lg mt-2 object-cover" alt="" />
          )}
        </div>

        {/* Selected chips */}
        {selectedChats.length > 0 && (
          <div className="mx-5 mt-3 flex flex-wrap gap-1.5 shrink-0">
            {selectedChats.map(c => (
              <span
                key={c.id}
                className="inline-flex items-center gap-1 bg-emerald-100 text-emerald-800 text-xs font-medium px-2.5 py-1 rounded-full"
              >
                {c.contact_custom_name || c.contact_name || c.name || c.jid.split('@')[0]}
                <button type="button" onClick={() => toggleSelect(c)} className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-emerald-200 hover:text-emerald-950" aria-label={`Quitar ${c.contact_custom_name || c.contact_name || c.name || 'chat'}`}>
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
            <span className="text-xs text-slate-400 self-center ml-1">{selectedChats.length}/{MAX_FORWARD}</span>
          </div>
        )}

        {/* Search */}
        <div className="px-5 pt-3 pb-2 shrink-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Buscar por nombre, teléfono..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-slate-100 border-none rounded-xl text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            />
          </div>
        </div>

        {/* Chat List */}
        <div className="flex-1 overflow-y-auto px-2 pb-2 min-h-0">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-emerald-200 border-t-emerald-600" />
            </div>
          ) : loadError ? (
            <div className="px-4 py-8 text-center"><p className="text-sm text-red-600">{loadError}</p><button type="button" onClick={() => void fetchChats(0, false)} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-red-700 hover:bg-red-50"><RefreshCw className="h-4 w-4" /> Reintentar</button></div>
          ) : chats.length === 0 ? (
            <p className="text-center py-8 text-sm text-slate-400">No se encontraron chats</p>
          ) : (
            <>
            {chats.map(c => {
              const displayName = c.contact_custom_name || c.contact_name || c.name || c.jid.split('@')[0]
              const phone = c.contact_phone || c.jid.split('@')[0]
              const isSelected = selectedIds.has(c.id)
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleSelect(c)}
                  disabled={!isSelected && selectedChats.length >= MAX_FORWARD}
                  className={`flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                    isSelected ? 'bg-emerald-50' : 'hover:bg-slate-50'
                  } disabled:opacity-40`}
                >
                  {/* Checkbox */}
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition ${
                    isSelected ? 'bg-emerald-600 border-emerald-600' : 'border-slate-300'
                  }`}>
                    {isSelected && <Check className="w-3 h-3 text-white" />}
                  </div>
                  {c.contact_avatar_url ? (
                    <img src={c.contact_avatar_url} className="w-10 h-10 rounded-full object-cover shrink-0" alt="" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center shrink-0">
                      <User className="w-5 h-5 text-slate-500" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{displayName}</p>
                    <p className="text-xs text-slate-400 truncate">{phone}</p>
                  </div>
                </button>
              )
            })}
            {hasMore && <button type="button" onClick={() => void fetchChats(chats.length, true)} disabled={loadingMore} className="mx-auto my-2 flex min-h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 disabled:cursor-wait disabled:opacity-50">{loadingMore && <RefreshCw className="h-4 w-4 animate-spin" />} {loadingMore ? 'Cargando…' : 'Cargar más'}</button>}
            </>
          )}
        </div>

        {/* Send Button */}
        {selectedChats.length > 0 && (
          <div className="shrink-0 border-t border-slate-100 px-5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 sm:pb-3">
            {sendError && <p className="mb-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs font-medium text-red-700" role="alert">{sendError}</p>}
            <button
              onClick={handleForwardAll}
              disabled={sending}
              className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white py-3 rounded-xl font-semibold hover:bg-emerald-700 disabled:opacity-60 transition shadow-md"
            >
              {sending ? (
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-white/30 border-t-white" />
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  Reenviar a {selectedChats.length} {selectedChats.length === 1 ? 'chat' : 'chats'}
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
