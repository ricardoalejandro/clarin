'use client'

import { useState, useEffect, useRef } from 'react'
import { X, Search, Send, User, Image as ImageIcon, FileText, Video, Mic, Check } from 'lucide-react'
import { Chat, Message } from '@/types/chat'

interface Props {
  message: Message
  deviceId: string
  chatId: string
  onClose: () => void
  onSuccess: () => void
}

const MAX_FORWARD = 5

export default function ForwardMessageModal({ message, deviceId, chatId, onClose, onSuccess }: Props) {
  const [chats, setChats] = useState<Chat[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchChats()
    setTimeout(() => searchRef.current?.focus(), 100)
  }, [])

  const fetchChats = async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/chats?limit=200', {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      if (data.success && data.chats) {
        setChats(data.chats)
      }
    } catch (err) {
      console.error('Failed to fetch chats:', err)
    } finally {
      setLoading(false)
    }
  }

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id)
      if (prev.length >= MAX_FORWARD) return prev
      return [...prev, id]
    })
  }

  const handleForwardAll = async () => {
    if (selectedIds.length === 0 || sending) return
    setSending(true)

    const token = localStorage.getItem('token')
    const targets = chats.filter(c => selectedIds.includes(c.id))
    let successCount = 0

    for (const target of targets) {
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
        const data = await res.json()
        if (data.success) successCount++
      } catch (err) {
        console.error('Forward failed to', target.jid, err)
      }
    }

    if (successCount > 0) {
      onSuccess()
      onClose()
    } else {
      alert('No se pudo reenviar el mensaje')
    }
    setSending(false)
  }

  const filteredChats = chats.filter(c => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    const name = (c.contact_custom_name || c.contact_name || c.name || '').toLowerCase()
    const phone = (c.contact_phone || c.jid.split('@')[0] || '').toLowerCase()
    const deviceName = (c.device_name || '').toLowerCase()
    return name.includes(q) || phone.includes(q) || deviceName.includes(q)
  })

  const getMessagePreview = () => {
    const type = message.message_type || 'text'
    if (type === 'image') return { icon: <ImageIcon className="w-4 h-4" />, text: message.body || '📷 Imagen' }
    if (type === 'video') return { icon: <Video className="w-4 h-4" />, text: message.body || '🎥 Video' }
    if (type === 'audio') return { icon: <Mic className="w-4 h-4" />, text: '🎵 Audio' }
    if (type === 'document') return { icon: <FileText className="w-4 h-4" />, text: message.media_filename || '📄 Documento' }
    if (type === 'sticker') return { icon: <ImageIcon className="w-4 h-4" />, text: '🏷️ Sticker' }
    return { icon: null, text: message.body || '' }
  }

  const preview = getMessagePreview()
  const selectedChats = chats.filter(c => selectedIds.includes(c.id))

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col"
        style={{ maxHeight: '85vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
          <h3 className="text-lg font-bold text-slate-800">Reenviar mensaje</h3>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded-full transition">
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
                <button onClick={() => toggleSelect(c.id)} className="hover:text-emerald-950">
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
            <span className="text-xs text-slate-400 self-center ml-1">{selectedIds.length}/{MAX_FORWARD}</span>
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
          ) : filteredChats.length === 0 ? (
            <p className="text-center py-8 text-sm text-slate-400">No se encontraron chats</p>
          ) : (
            filteredChats.map(c => {
              const displayName = c.contact_custom_name || c.contact_name || c.name || c.jid.split('@')[0]
              const phone = c.contact_phone || c.jid.split('@')[0]
              const isSelected = selectedIds.includes(c.id)
              return (
                <button
                  key={c.id}
                  onClick={() => toggleSelect(c.id)}
                  disabled={!isSelected && selectedIds.length >= MAX_FORWARD}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition text-left ${
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
            })
          )}
        </div>

        {/* Send Button */}
        {selectedIds.length > 0 && (
          <div className="px-5 py-3 border-t border-slate-100 shrink-0">
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
                  Reenviar a {selectedIds.length} {selectedIds.length === 1 ? 'chat' : 'chats'}
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
