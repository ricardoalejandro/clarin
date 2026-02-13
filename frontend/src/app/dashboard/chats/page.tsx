'use client'

import { useEffect, useState, useRef, useCallback, Fragment } from 'react'
import { Search, Send, MoreVertical, ArrowLeft, Plus, User, X, Trash2, CheckSquare, Square, RefreshCw, Reply, Forward, BarChart3 } from 'lucide-react'
import { formatDistanceToNow, format, isToday, isYesterday, differenceInCalendarDays } from 'date-fns'
import { es } from 'date-fns/locale'
import DeviceSelector from '@/components/chat/DeviceSelector'
import MessageBubble from '@/components/chat/MessageBubble'
import { formatToHtmlPreview, getCaretOffset, setCaretOffset } from '@/lib/whatsappFormat'
import ContactPanel from '@/components/chat/ContactPanel'
import EmojiPicker from '@/components/chat/EmojiPicker'
import FileUploader from '@/components/chat/FileUploader'
import StickerPicker from '@/components/chat/StickerPicker'
import NewChatModal from '@/components/chat/NewChatModal'
import ImageViewer from '@/components/chat/ImageViewer'

interface Chat {
  id: string
  jid: string
  name: string
  device_id?: string
  last_message: string
  last_message_at: string
  unread_count: number
  device_name?: string
  device_phone?: string
  contact_phone?: string
  contact_avatar_url?: string
  contact_custom_name?: string
  contact_name?: string
}

// Clean synced names that start with dots/punctuation
const cleanName = (name?: string | null) => name?.replace(/^[\s.\u00b7\u2022\-]+/, '').trim() || ''

// Get the best display name for a chat
// Priority: custom_name (CRM) → contact_name (WhatsApp address book) → chat.name (push_name) → phone
const getChatDisplayName = (chat: Chat): string => {
  const cn = cleanName(chat.contact_custom_name)
  if (cn) return cn
  const nm = cleanName(chat.contact_name)
  if (nm) return nm
  const pn = cleanName(chat.name)
  if (pn) return pn
  return formatPhone(chat.jid, chat.contact_phone) || chat.jid
}

// Format JID or contact phone for human-readable display
const formatPhone = (jid: string, contactPhone?: string): string => {
  // For @lid JIDs, check if contactPhone is the real resolved phone or the meaningless lid number
  if (jid.endsWith('@lid')) {
    const lidUser = jid.replace('@lid', '')
    // If contact phone is same as lid user, it's meaningless
    if (!contactPhone || contactPhone === lidUser) {
      return ''
    }
    // Contact has a real resolved phone, show it
    return contactPhone.startsWith('+') ? contactPhone : '+' + contactPhone
  }
  // Prefer the real phone from contacts table
  if (contactPhone) {
    return contactPhone.startsWith('+') ? contactPhone : '+' + contactPhone
  }
  // Strip WhatsApp suffixes
  const num = jid.replace(/@(s\.whatsapp\.net|g\.us)$/, '')
  // Only format if it looks like a phone number (all digits)
  if (/^\d+$/.test(num)) {
    return '+' + num
  }
  return num
}

interface Message {
  id: string
  message_id: string
  from_jid?: string
  from_name?: string
  body?: string
  message_type?: string
  media_url?: string
  media_type?: string
  is_from_me: boolean
  is_read: boolean
  status: string
  timestamp: string
  quoted_message_id?: string
  quoted_body?: string
  quoted_sender?: string
  reactions?: Array<{
    id: string
    target_message_id: string
    sender_jid: string
    sender_name?: string
    emoji: string
    is_from_me: boolean
  }>
  poll_question?: string
  poll_options?: Array<{ id: string; name: string; vote_count: number }>
  poll_votes?: Array<{ id: string; voter_jid: string; selected_names: string[] }>
  poll_max_selections?: number
}

// WhatsApp-style date label for message separators
const getDateLabel = (timestamp: string): string => {
  try {
    const date = new Date(timestamp)
    if (isToday(date)) return 'hoy'
    if (isYesterday(date)) return 'ayer'
    const diffDays = differenceInCalendarDays(new Date(), date)
    if (diffDays < 7) {
      return format(date, 'EEEE', { locale: es })
    }
    return format(date, 'd/M/yyyy')
  } catch {
    return ''
  }
}

interface Device {
  id: string
  name: string
  phone?: string
  status: string
}

function PollModal({ onClose, onSend }: { onClose: () => void; onSend: (q: string, opts: string[], max: number) => void }) {
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [maxSelections, setMaxSelections] = useState(1)

  const addOption = () => {
    if (options.length < 12) setOptions([...options, ''])
  }

  const removeOption = (idx: number) => {
    if (options.length > 2) setOptions(options.filter((_, i) => i !== idx))
  }

  const valid = question.trim() && options.filter(o => o.trim()).length >= 2

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-md shadow-2xl">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-green-600" />
            <h3 className="font-semibold text-gray-900">Crear encuesta</h3>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Pregunta</label>
            <input
              type="text"
              value={question}
              onChange={e => setQuestion(e.target.value)}
              placeholder="Escribe tu pregunta..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder:text-gray-400 focus:ring-2 focus:ring-green-500 focus:border-transparent"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Opciones</label>
            <div className="space-y-2">
              {options.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={opt}
                    onChange={e => {
                      const newOpts = [...options]
                      newOpts[i] = e.target.value
                      setOptions(newOpts)
                    }}
                    placeholder={`Opción ${i + 1}`}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder:text-gray-400 focus:ring-2 focus:ring-green-500 focus:border-transparent text-sm"
                  />
                  {options.length > 2 && (
                    <button onClick={() => removeOption(i)} className="p-1 text-gray-400 hover:text-red-500">
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {options.length < 12 && (
              <button
                onClick={addOption}
                className="mt-2 text-sm text-green-600 hover:text-green-700 font-medium"
              >
                + Agregar opción
              </button>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Máx. selecciones permitidas
            </label>
            <select
              value={maxSelections}
              onChange={e => setMaxSelections(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 focus:ring-2 focus:ring-green-500 focus:border-transparent"
            >
              {Array.from({ length: options.filter(o => o.trim()).length || 1 }, (_, i) => i + 1).map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="p-4 border-t border-gray-200 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg text-sm"
          >
            Cancelar
          </button>
          <button
            onClick={() => {
              const validOpts = options.filter(o => o.trim()).map(o => o.trim())
              if (question.trim() && validOpts.length >= 2) {
                onSend(question.trim(), validOpts, Math.min(maxSelections, validOpts.length))
              }
            }}
            disabled={!valid}
            className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50"
          >
            Enviar encuesta
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ChatsPage() {
  const [chats, setChats] = useState<Chat[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null)
  const [filterDevices, setFilterDevices] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [sendingMessage, setSendingMessage] = useState(false)
  const [messageText, setMessageText] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [showContactPanel, setShowContactPanel] = useState(false)
  const [showNewChatModal, setShowNewChatModal] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedChats, setSelectedChats] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [activePopup, setActivePopup] = useState<'emoji' | 'file' | 'sticker' | null>(null)
  const [viewerImage, setViewerImage] = useState<{ src: string; alt?: string } | null>(null)
  const [replyingTo, setReplyingTo] = useState<Message | null>(null)
  const [forwardingMsg, setForwardingMsg] = useState<Message | null>(null)
  const [forwardSearch, setForwardSearch] = useState('')
  const [savedStickerUrls, setSavedStickerUrls] = useState<Set<string>>(new Set())
  const [showPollModal, setShowPollModal] = useState(false)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLDivElement>(null)
  const optimisticIdRef = useRef(0)

  // Resizable panels
  const [leftPanelWidth, setLeftPanelWidth] = useState(384) // default lg:w-96 = 384px
  const [rightPanelWidth, setRightPanelWidth] = useState(320) // default w-80 = 320px
  const resizingRef = useRef<'left' | 'right' | null>(null)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  // Responsive: detect md+ screen for conditional inline styles
  const [isMdScreen, setIsMdScreen] = useState(true)
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)')
    setIsMdScreen(mql.matches)
    const handler = (e: MediaQueryListEvent) => setIsMdScreen(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizingRef.current) return
      e.preventDefault()
      const delta = e.clientX - startXRef.current
      if (resizingRef.current === 'left') {
        const newWidth = Math.min(600, Math.max(260, startWidthRef.current + delta))
        setLeftPanelWidth(newWidth)
      } else {
        // Right panel: dragging left increases width
        const newWidth = Math.min(500, Math.max(260, startWidthRef.current - delta))
        setRightPanelWidth(newWidth)
      }
    }
    const handleMouseUp = () => {
      if (resizingRef.current) {
        resizingRef.current = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const startResize = (panel: 'left' | 'right', e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = panel
    startXRef.current = e.clientX
    startWidthRef.current = panel === 'left' ? leftPanelWidth : rightPanelWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  // Auto-detect device from selected chat
  const selectedDevice = selectedChat?.device_id || ''
  const chatDevice = devices.find(d => d.id === selectedDevice)
  const isChatDeviceConnected = chatDevice?.status === 'connected'

  const scrollToBottom = () => {
    const container = messagesContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }

  const fetchChats = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const params = new URLSearchParams()
      if (filterDevices.length > 0) {
        filterDevices.forEach(id => params.append('device_ids', id))
      }
      if (debouncedSearch) {
        params.append('search', debouncedSearch)
      }
      const url = `/api/chats${params.toString() ? '?' + params.toString() : ''}`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setChats(data.chats || [])
      }
    } catch (err) {
      console.error('Failed to fetch chats:', err)
    } finally {
      setLoading(false)
    }
  }, [filterDevices, debouncedSearch])

  const fetchDevices = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/devices', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        setDevices(data.devices || [])
      }
    } catch (err) {
      console.error('Failed to fetch devices:', err)
    }
  }, [])

  const fetchSavedStickerUrls = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/stickers/saved', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) setSavedStickerUrls(new Set(data.stickers || []))
    } catch {}
  }, [])

  const handleSaveSticker = async (mediaUrl: string) => {
    const token = localStorage.getItem('token')
    const isSaved = savedStickerUrls.has(mediaUrl)
    try {
      if (isSaved) {
        await fetch('/api/stickers/saved', {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ media_url: mediaUrl }),
        })
        setSavedStickerUrls(prev => { const n = new Set(prev); n.delete(mediaUrl); return n })
      } else {
        await fetch('/api/stickers/saved', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ media_url: mediaUrl }),
        })
        setSavedStickerUrls(prev => new Set(prev).add(mediaUrl))
      }
    } catch (err) {
      console.error('Error toggling saved sticker:', err)
    }
  }

  const fetchMessages = useCallback(async (chatId: string) => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/chats/${chatId}/messages?limit=100`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) {
        // Messages come sorted DESC, reverse for display
        setMessages((data.messages || []).reverse())
        // Mark as read
        await fetch(`/api/chats/${chatId}/read`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
        fetchChats() // Refresh unread count
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err)
    }
  }, [fetchChats])

  // Debounce search: wait 500ms after user stops typing
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), 500)
    return () => clearTimeout(timer)
  }, [searchTerm])

  useEffect(() => {
    fetchChats()
    fetchDevices()
    fetchSavedStickerUrls()
  }, [fetchChats, fetchDevices, fetchSavedStickerUrls])

  // Auto-open chat from URL param (e.g., from contacts page "Enviar Mensaje")
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const openChatId = params.get('open')
    if (openChatId && chats.length > 0) {
      const chat = chats.find(c => c.id === openChatId)
      if (chat) {
        setSelectedChat(chat)
      }
      window.history.replaceState({}, '', '/dashboard/chats')
    }
  }, [chats])

  useEffect(() => {
    if (selectedChat) {
      fetchMessages(selectedChat.id)
    }
  }, [selectedChat, fetchMessages])

  useEffect(() => {
    // Use requestAnimationFrame to ensure DOM has rendered before scrolling
    requestAnimationFrame(() => {
      scrollToBottom()
    })
  }, [messages])

  // WebSocket for real-time messages
  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) return

    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws?token=${token}`
    const ws = new WebSocket(wsUrl)

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)
      if (data.event === 'new_message') {
        fetchChats()
        if (selectedChat && data.data.chat_id === selectedChat.id) {
          fetchMessages(selectedChat.id)
        }
      } else if (data.event === 'message_sent') {
        // Update optimistic message with real data from server
        const sentMsg = data.data?.message
        if (sentMsg && selectedChat && data.data.chat_id === selectedChat.id) {
          setMessages(prev => {
            // Check if we have an optimistic message to replace
            const hasOptimistic = prev.some(m => m.id.startsWith('optimistic-'))
            if (hasOptimistic) {
              // Replace the first optimistic message with matching body
              let replaced = false
              return prev.map(m => {
                if (!replaced && m.id.startsWith('optimistic-') && m.status === 'sending') {
                  replaced = true
                  return { ...sentMsg, is_from_me: true }
                }
                return m
              })
            }
            return prev
          })
        }
        fetchChats() // Update chat list with latest message
      } else if (data.event === 'message_reaction') {
        // Update reactions on the target message in real time
        const rd = data.data
        if (selectedChat && rd?.chat_id === selectedChat.id) {
          fetchMessages(selectedChat.id)
        }
      } else if (data.event === 'poll_update') {
        // Refresh messages to get updated poll vote counts
        const pd = data.data
        if (selectedChat && pd?.chat_id === selectedChat.id) {
          fetchMessages(selectedChat.id)
        }
      }
    }

    return () => ws.close()
  }, [selectedChat, fetchChats, fetchMessages])

  const handleSendMessage = async () => {
    if (!messageText.trim() || !selectedChat || !selectedDevice || !isChatDeviceConnected) return

    const text = messageText.trim()
    const currentReply = replyingTo
    setMessageText('')
    setReplyingTo(null)
    if (inputRef.current) {
      inputRef.current.innerHTML = ''
      inputRef.current.focus()
    }

    // Create optimistic message — appears instantly
    const tempId = `optimistic-${++optimisticIdRef.current}`
    const optimisticMsg: Message = {
      id: tempId,
      message_id: tempId,
      from_jid: '',
      from_name: 'Me',
      body: text,
      message_type: 'text',
      is_from_me: true,
      is_read: false,
      status: 'sending',
      timestamp: new Date().toISOString(),
      ...(currentReply ? {
        quoted_message_id: currentReply.message_id,
        quoted_body: currentReply.body || '[media]',
        quoted_sender: currentReply.is_from_me ? 'Me' : (currentReply.from_name || currentReply.from_jid),
      } : {}),
    }
    setMessages(prev => [...prev, optimisticMsg])

    const token = localStorage.getItem('token')
    try {
      const sendPayload: Record<string, unknown> = {
        device_id: selectedDevice,
        to: selectedChat.jid,
        body: text,
      }
      if (currentReply) {
        sendPayload.quoted_message_id = currentReply.message_id
        sendPayload.quoted_body = currentReply.body || '[media]'
        sendPayload.quoted_sender = currentReply.is_from_me ? 'Me' : (currentReply.from_jid || '')
        sendPayload.quoted_is_from_me = currentReply.is_from_me
      }
      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(sendPayload),
      })
      const data = await res.json()
      if (data.success) {
        // Replace optimistic message with real one
        const realMsg = data.message
        if (realMsg) {
          setMessages(prev => prev.map(m => m.id === tempId ? { ...realMsg, is_from_me: true } : m))
        } else {
          // If no message returned, mark as sent
          setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'sent' } : m))
        }
        fetchChats()
      } else {
        // Mark as failed
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
      }
    } catch (err) {
      console.error('Failed to send message:', err)
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
    }
  }

  const handleRetrySend = async (failedMsg: Message) => {
    if (!selectedChat || !selectedDevice || !isChatDeviceConnected) return

    // Mark as sending again
    setMessages(prev => prev.map(m => m.id === failedMsg.id ? { ...m, status: 'sending' } : m))

    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          device_id: selectedDevice,
          to: selectedChat.jid,
          body: failedMsg.body,
        }),
      })
      const data = await res.json()
      if (data.success) {
        const realMsg = data.message
        if (realMsg) {
          setMessages(prev => prev.map(m => m.id === failedMsg.id ? { ...realMsg, is_from_me: true } : m))
        } else {
          setMessages(prev => prev.map(m => m.id === failedMsg.id ? { ...m, status: 'sent' } : m))
        }
        fetchChats()
      } else {
        setMessages(prev => prev.map(m => m.id === failedMsg.id ? { ...m, status: 'failed' } : m))
      }
    } catch (err) {
      setMessages(prev => prev.map(m => m.id === failedMsg.id ? { ...m, status: 'failed' } : m))
    }
  }

  const handleSendMedia = async (file: File, mediaType: string) => {
    if (!selectedChat || !selectedDevice || !isChatDeviceConnected) return

    // Create optimistic message — appears instantly
    const tempId = `optimistic-${++optimisticIdRef.current}`
    const previewUrl = URL.createObjectURL(file)
    const optimisticMsg: Message = {
      id: tempId,
      message_id: tempId,
      from_jid: '',
      from_name: 'Me',
      body: file.name,
      message_type: mediaType,
      media_url: previewUrl,
      is_from_me: true,
      is_read: false,
      status: 'sending',
      timestamp: new Date().toISOString(),
    }
    setMessages(prev => [...prev, optimisticMsg])

    const token = localStorage.getItem('token')

    try {
      // Upload file
      const formData = new FormData()
      formData.append('file', file)
      formData.append('folder', 'uploads')

      const uploadRes = await fetch('/api/media/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      const uploadData = await uploadRes.json()
      
      if (!uploadData.success) {
        throw new Error(uploadData.error || 'Error al subir archivo')
      }

      // Send message with uploaded URL
      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          device_id: selectedDevice,
          to: selectedChat.jid,
          body: file.name,
          media_url: uploadData.proxy_url || uploadData.public_url,
          media_type: mediaType,
        }),
      })
      const data = await res.json()
      
      if (data.success) {
        const realMsg = data.message
        if (realMsg) {
          // Keep blob preview URL to avoid image reload flash
          setMessages(prev => prev.map(m => {
            if (m.id !== tempId) return m
            return { ...realMsg, is_from_me: true, media_url: m.media_url?.startsWith('blob:') ? m.media_url : realMsg.media_url }
          }))
        } else {
          setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'sent' } : m))
        }
        fetchChats()
      } else {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
      }
    } catch (err) {
      console.error('Failed to send media:', err)
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
    }

    // Close file popup
    setActivePopup(null)
  }

  const handleSendSticker = async (stickerUrl: string, file?: File) => {
    if (!selectedChat || !selectedDevice || !isChatDeviceConnected) return

    const token = localStorage.getItem('token')
    const tempId = `optimistic-${++optimisticIdRef.current}`

    try {
      let mediaUrl = stickerUrl

      // If a file is provided (custom upload), upload it first
      if (file) {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('folder', 'uploads')

        const uploadRes = await fetch('/api/media/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        })
        const uploadData = await uploadRes.json()
        if (!uploadData.success) throw new Error(uploadData.error || 'Upload failed')
        mediaUrl = uploadData.proxy_url || uploadData.public_url
      }

      // Optimistic message
      const optimisticMsg: Message = {
        id: tempId,
        message_id: tempId,
        from_jid: '',
        from_name: 'Me',
        body: '',
        message_type: 'sticker',
        media_url: mediaUrl,
        is_from_me: true,
        is_read: false,
        status: 'sending',
        timestamp: new Date().toISOString(),
      }
      setMessages(prev => [...prev, optimisticMsg])

      // Send sticker message
      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          device_id: selectedDevice,
          to: selectedChat.jid,
          body: '',
          media_url: mediaUrl,
          media_type: 'sticker',
        }),
      })
      const data = await res.json()

      if (data.success && data.message) {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...data.message, is_from_me: true } : m))
        fetchChats()
      } else {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
      }
    } catch (err) {
      console.error('Failed to send sticker:', err)
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
    }

    setActivePopup(null)
  }

  const handleReact = async (msg: Message, emoji: string) => {
    if (!selectedChat || !selectedDevice) return
    const token = localStorage.getItem('token')
    try {
      await fetch('/api/messages/react', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          device_id: selectedDevice,
          to: selectedChat.jid,
          target_message_id: msg.message_id,
          emoji,
        }),
      })
    } catch (err) {
      console.error('Failed to react:', err)
    }
  }

  const handleSendPoll = async (question: string, options: string[], maxSelections: number) => {
    if (!selectedChat || !selectedDevice || !isChatDeviceConnected) return
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/messages/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          device_id: selectedDevice,
          to: selectedChat.jid,
          question,
          options,
          max_selections: maxSelections,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setShowPollModal(false)
        fetchChats()
      } else {
        alert(data.error || 'Error al crear encuesta')
      }
    } catch (err) {
      console.error('Failed to send poll:', err)
      alert('Error al crear encuesta')
    }
  }

  const handleEmojiSelect = (emoji: string) => {
    if (inputRef.current) {
      inputRef.current.focus()
      const caretPos = getCaretOffset(inputRef.current)
      const text = messageText
      const newText = text.slice(0, caretPos) + emoji + text.slice(caretPos)
      setMessageText(newText)
      const html = formatToHtmlPreview(newText)
      inputRef.current.innerHTML = html || ''
      setCaretOffset(inputRef.current, caretPos + emoji.length)
    } else {
      setMessageText(prev => prev + emoji)
    }
  }

  const handleForwardToChat = async (targetChat: Chat) => {
    if (!forwardingMsg || !selectedDevice) return
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/messages/forward', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          device_id: selectedDevice,
          to: targetChat.jid,
          chat_id: selectedChat?.id,
          message_id: forwardingMsg.message_id,
        }),
      })
      const data = await res.json()
      if (data.success) {
        setForwardingMsg(null)
        setForwardSearch('')
        fetchChats()
      } else {
        alert(data.error || 'Error al reenviar')
      }
    } catch (err) {
      console.error('Failed to forward:', err)
      alert('Error al reenviar mensaje')
    }
  }

  const handleChatCreated = (chatId: string) => {
    fetchChats()
    // Find and select the new chat
    setTimeout(() => {
      const newChat = chats.find(c => c.id === chatId)
      if (newChat) setSelectedChat(newChat)
    }, 500)
  }

  const toggleChatSelection = (chatId: string) => {
    const newSelected = new Set(selectedChats)
    if (newSelected.has(chatId)) {
      newSelected.delete(chatId)
    } else {
      newSelected.add(chatId)
    }
    setSelectedChats(newSelected)
  }

  const toggleSelectAll = () => {
    if (selectedChats.size === chats.length) {
      setSelectedChats(new Set())
    } else {
      setSelectedChats(new Set(chats.map(c => c.id)))
    }
  }

  const exitSelectionMode = () => {
    setSelectionMode(false)
    setSelectedChats(new Set())
  }

  const deleteSelectedChats = async () => {
    if (selectedChats.size === 0) return
    
    const confirmMsg = selectedChats.size === 1 
      ? '¿Eliminar este chat y todos sus mensajes?' 
      : `¿Eliminar ${selectedChats.size} chats y todos sus mensajes?`
    
    if (!confirm(confirmMsg)) return

    setDeleting(true)
    const token = localStorage.getItem('token')

    try {
      const res = await fetch('/api/chats/batch', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ids: Array.from(selectedChats) }),
      })
      const data = await res.json()
      if (data.success) {
        // If selected chat was deleted, clear it
        if (selectedChat && selectedChats.has(selectedChat.id)) {
          setSelectedChat(null)
          setMessages([])
        }
        exitSelectionMode()
        fetchChats()
      } else {
        alert(data.error || 'Error al eliminar chats')
      }
    } catch (err) {
      console.error('Failed to delete chats:', err)
      alert('Error al eliminar chats')
    } finally {
      setDeleting(false)
    }
  }

  const deleteAllChats = async () => {
    if (!confirm('¿Eliminar TODOS los chats y mensajes? Esta acción no se puede deshacer.')) return

    setDeleting(true)
    const token = localStorage.getItem('token')

    try {
      const res = await fetch('/api/chats/batch', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ delete_all: true }),
      })
      const data = await res.json()
      if (data.success) {
        setSelectedChat(null)
        setMessages([])
        exitSelectionMode()
        fetchChats()
      } else {
        alert(data.error || 'Error al eliminar chats')
      }
    } catch (err) {
      console.error('Failed to delete all chats:', err)
      alert('Error al eliminar chats')
    } finally {
      setDeleting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  // Search is now done server-side via fetchChats
  const filteredChats = chats

  const formatTime = (timestamp: string) => {
    if (!timestamp) return ''
    try {
      return formatDistanceToNow(new Date(timestamp), { addSuffix: true, locale: es })
    } catch {
      return ''
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600" />
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex bg-white md:rounded-xl md:border border-gray-200 overflow-hidden">
      {/* Chat list */}
      <div
        className={`border-r border-gray-200 flex flex-col min-h-0 overflow-hidden shrink-0 ${selectedChat ? 'hidden md:flex' : 'flex w-full md:w-auto'}`}
        style={isMdScreen ? { width: selectedChat ? leftPanelWidth : undefined, minWidth: selectedChat ? undefined : leftPanelWidth } : undefined}
      >
        {/* Header with device filter and new chat */}
        <div className="p-3 border-b border-gray-200 space-y-3">
          {selectionMode ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  onClick={exitSelectionMode}
                  className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg"
                  title="Cancelar"
                >
                  <X className="w-5 h-5" />
                </button>
                <span className="text-sm font-medium text-gray-700">
                  {selectedChats.size} seleccionado{selectedChats.size !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleSelectAll}
                  className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg"
                  title={selectedChats.size === chats.length ? 'Deseleccionar todos' : 'Seleccionar todos'}
                >
                  {selectedChats.size === chats.length ? (
                    <CheckSquare className="w-5 h-5 text-green-600" />
                  ) : (
                    <Square className="w-5 h-5" />
                  )}
                </button>
                <button
                  onClick={deleteSelectedChats}
                  disabled={selectedChats.size === 0 || deleting}
                  className="p-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
                  title="Eliminar seleccionados"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
                <button
                  onClick={deleteAllChats}
                  disabled={chats.length === 0 || deleting}
                  className="px-3 py-2 bg-red-800 text-white text-sm rounded-lg hover:bg-red-900 disabled:opacity-50"
                  title="Eliminar todos"
                >
                  Borrar todos
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <DeviceSelector
                devices={devices}
                selectedDeviceIds={filterDevices}
                onDeviceChange={setFilterDevices}
                mode="multi"
                placeholder="Todos los dispositivos"
              />
              <div className="flex items-center gap-1">
                {chats.length > 0 && (
                  <button
                    onClick={() => setSelectionMode(true)}
                    className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg"
                    title="Seleccionar chats"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                )}
                <button
                  onClick={() => setShowNewChatModal(true)}
                  className="p-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
                  title="Nueva conversación"
                >
                  <Plus className="w-5 h-5" />
                </button>
              </div>
            </div>
          )}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Buscar chat..."
              className="w-full pl-10 pr-4 py-2.5 bg-gray-100 rounded-lg focus:bg-white focus:ring-2 focus:ring-green-500 border-transparent text-gray-900 placeholder:text-gray-400"
            />
          </div>
        </div>

        {/* Chat list */}
        <div className="flex-1 overflow-y-auto">
          {filteredChats.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              {searchTerm ? 'No se encontraron chats' : 'No hay chats aún'}
            </div>
          ) : (
            filteredChats.map((chat) => (
              <div
                key={chat.id}
                onClick={() => selectionMode ? toggleChatSelection(chat.id) : setSelectedChat(chat)}
                className={`p-3 flex items-center gap-3 cursor-pointer hover:bg-gray-50 border-b border-gray-100 ${
                  selectedChat?.id === chat.id && !selectionMode ? 'bg-green-50' : ''
                } ${selectionMode && selectedChats.has(chat.id) ? 'bg-red-50' : ''}`}
              >
                {selectionMode && (
                  <div className="flex-shrink-0">
                    {selectedChats.has(chat.id) ? (
                      <CheckSquare className="w-6 h-6 text-red-600" />
                    ) : (
                      <Square className="w-6 h-6 text-gray-400" />
                    )}
                  </div>
                )}
                {chat.contact_avatar_url ? (
                  <img
                    src={chat.contact_avatar_url}
                    alt={getChatDisplayName(chat)}
                    className="w-12 h-12 rounded-full object-cover flex-shrink-0"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden') }}
                  />
                ) : null}
                <div className={`w-12 h-12 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0 ${chat.contact_avatar_url ? 'hidden' : ''}`}>
                  <span className="text-green-700 font-medium text-lg">
                    {getChatDisplayName(chat).charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-gray-900 truncate">{getChatDisplayName(chat)}</p>
                    <span className="text-xs text-gray-500">
                      {formatTime(chat.last_message_at)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    <p className="text-sm text-gray-500 truncate">{chat.last_message || 'Sin mensajes'}</p>
                    {(chat.unread_count || 0) > 0 && (
                      <span className="bg-green-600 text-white text-xs font-medium px-2 py-0.5 rounded-full ml-2">
                        {chat.unread_count}
                      </span>
                    )}
                  </div>
                  {chat.device_name && (
                    <p className="text-xs font-semibold text-green-700 mt-0.5 truncate bg-green-50 px-1.5 py-0.5 rounded inline-block">
                      📱 {chat.device_name}
                    </p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Left panel resize handle */}
      {selectedChat && (
        <div
          onMouseDown={(e) => startResize('left', e)}
          className="hidden md:flex w-1 hover:w-1.5 bg-transparent hover:bg-green-400/50 cursor-col-resize shrink-0 transition-all active:bg-green-500/50"
        />
      )}

      {/* Chat window */}
      <div className={`flex-1 flex flex-col min-h-0 overflow-hidden ${selectedChat ? 'flex' : 'hidden md:flex'}`}>
        {selectedChat ? (
          <>
            {/* Chat header */}
            <div className="h-16 px-4 flex items-center justify-between border-b border-gray-200 bg-gray-50 shrink-0">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setSelectedChat(null)}
                  className="md:hidden p-2 hover:bg-gray-200 rounded-lg"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <div 
                  className="flex items-center gap-3 cursor-pointer"
                  onClick={() => setShowContactPanel(true)}
                >
                  {selectedChat.contact_avatar_url ? (
                    <img
                      src={selectedChat.contact_avatar_url}
                      alt={getChatDisplayName(selectedChat)}
                      className="w-10 h-10 rounded-full object-cover cursor-pointer hover:opacity-80 transition"
                      onClick={(e) => {
                        e.stopPropagation()
                        setViewerImage({ src: selectedChat.contact_avatar_url!, alt: getChatDisplayName(selectedChat) })
                      }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden') }}
                    />
                  ) : null}
                  <div className={`w-10 h-10 bg-green-100 rounded-full flex items-center justify-center ${selectedChat.contact_avatar_url ? 'hidden' : ''}`}>
                    <span className="text-green-700 font-medium">
                      {getChatDisplayName(selectedChat).charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">{getChatDisplayName(selectedChat)}</p>
                    {(() => {
                      const phone = formatPhone(selectedChat.jid, selectedChat.contact_phone)
                      const name = getChatDisplayName(selectedChat)
                      // Only show phone as subtitle if the name isn't already the phone
                      return phone && phone !== name ? (
                        <p className="text-sm text-gray-500">{phone}</p>
                      ) : null
                    })()}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => setShowContactPanel(!showContactPanel)}
                  className={`p-2 rounded-lg ${showContactPanel ? 'bg-green-100 text-green-600' : 'text-gray-500 hover:bg-gray-200'}`}
                >
                  <User className="w-5 h-5" />
                </button>
                <button className="p-2 text-gray-500 hover:bg-gray-200 rounded-lg">
                  <MoreVertical className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Messages and contact panel container */}
            <div className="flex-1 flex overflow-hidden min-h-0">
              {/* Messages */}
              <div 
                ref={messagesContainerRef}
                className="flex-1 overflow-y-auto p-4 space-y-2 min-h-0 wa-chat-bg" 
              >
                {messages.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-gray-500">
                    No hay mensajes aún
                  </div>
                ) : (
                  messages.map((msg, idx) => {
                    const msgDateStr = new Date(msg.timestamp).toDateString()
                    const prevDateStr = idx > 0 ? new Date(messages[idx - 1].timestamp).toDateString() : null
                    const showDateSeparator = msgDateStr !== prevDateStr

                    return (
                      <Fragment key={msg.id}>
                        {showDateSeparator && (
                          <div className="flex justify-center my-2">
                            <span className="bg-white px-3 py-1 rounded-lg text-xs text-gray-600 shadow-sm uppercase">
                              {getDateLabel(msg.timestamp)}
                            </span>
                          </div>
                        )}
                        <MessageBubble
                          message={msg}
                          contactName={getChatDisplayName(selectedChat!)}
                          onRetry={() => handleRetrySend(msg)}
                          onReply={(m) => { setReplyingTo(m as Message); inputRef.current?.focus() }}
                          onForward={(m) => { setForwardingMsg(m as Message); setForwardSearch('') }}
                          onSaveSticker={handleSaveSticker}
                          onReact={(m, emoji) => handleReact(m as Message, emoji)}
                          savedStickerUrls={savedStickerUrls}
                          onMediaClick={(url, type) => {
                            if (type === 'image') {
                              setViewerImage({ src: url, alt: 'Imagen' })
                            }
                          }}
                        />
                      </Fragment>
                    )
                  })
                )}

              </div>

              {/* Contact panel with resize handle */}
              {showContactPanel && selectedChat && (
                <>
                  {/* Resize handle - desktop only */}
                  <div
                    onMouseDown={(e) => startResize('right', e)}
                    className="hidden md:flex w-1 hover:w-1.5 bg-transparent hover:bg-green-400/50 cursor-col-resize shrink-0 transition-all active:bg-green-500/50"
                  />
                  {/* Mobile backdrop */}
                  <div
                    className="fixed inset-0 bg-black/50 z-40 md:hidden"
                    onClick={() => setShowContactPanel(false)}
                  />
                  <div
                    className="fixed inset-y-0 right-0 z-50 w-[85vw] max-w-[380px] md:relative md:inset-auto md:z-auto md:w-auto md:max-w-none shrink-0 overflow-hidden shadow-xl md:shadow-none"
                    style={isMdScreen ? { width: rightPanelWidth } : undefined}
                  >
                    <ContactPanel
                      chatId={selectedChat.id}
                      isOpen={showContactPanel}
                      onClose={() => setShowContactPanel(false)}
                      deviceName={selectedChat.device_name}
                      devicePhone={selectedChat.device_phone}
                    />
                  </div>
                </>
              )}
            </div>

            {/* Message input */}
            <div className="bg-gray-50 border-t border-gray-200 shrink-0 pb-[env(safe-area-inset-bottom)]">
              {/* Reply preview bar */}
              {replyingTo && (
                <div className="px-3 pt-2">
                  <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2">
                    <Reply className="w-4 h-4 text-green-600 flex-shrink-0" />
                    <div className="flex-1 min-w-0 border-l-2 border-green-500 pl-2">
                      <p className="text-xs font-semibold text-green-700 truncate">
                        {replyingTo.is_from_me ? 'Tú' : (replyingTo.from_name || 'Contacto')}
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {replyingTo.body || (replyingTo.media_url ? `[${replyingTo.message_type || 'media'}]` : '')}
                      </p>
                    </div>
                    <button
                      onClick={() => setReplyingTo(null)}
                      className="p-1 text-gray-400 hover:text-gray-600 flex-shrink-0"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              <div className="p-3">
              {!selectedDevice ? (
                <div className="text-center text-gray-500 py-2">
                  Este chat no tiene un dispositivo asociado
                </div>
              ) : !isChatDeviceConnected ? (
                <div className="text-center py-2 space-y-1">
                  <p className="text-red-500 font-medium text-sm">
                    📱 Dispositivo &quot;{chatDevice?.name || 'Desconocido'}&quot; desconectado
                  </p>
                  <p className="text-gray-400 text-xs">
                    Conecta el dispositivo para poder enviar mensajes en este chat
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-end gap-2">
                    <EmojiPicker
                      onEmojiSelect={handleEmojiSelect}
                      isOpen={activePopup === 'emoji'}
                      onToggle={() => setActivePopup(activePopup === 'emoji' ? null : 'emoji')}
                    />
                    <FileUploader
                      onFileSelect={handleSendMedia}
                      disabled={sendingMessage}
                      isOpen={activePopup === 'file'}
                      onToggle={() => setActivePopup(activePopup === 'file' ? null : 'file')}
                    />
                    <StickerPicker
                      onStickerSelect={handleSendSticker}
                      isOpen={activePopup === 'sticker'}
                      onToggle={() => setActivePopup(activePopup === 'sticker' ? null : 'sticker')}
                    />
                    <button
                      onClick={() => setShowPollModal(true)}
                      className="p-2.5 text-gray-500 hover:text-green-600 hover:bg-gray-100 rounded-lg transition-colors"
                      title="Crear encuesta"
                    >
                      <BarChart3 className="w-5 h-5" />
                    </button>
                    <div className="flex-1 relative">
                      {!messageText && (
                        <div className="absolute left-4 top-2.5 text-gray-400 pointer-events-none select-none">
                          Escribe un mensaje...
                        </div>
                      )}
                      <div
                        ref={inputRef}
                        contentEditable={!sendingMessage}
                        onInput={() => {
                          if (!inputRef.current) return
                          const text = (inputRef.current.innerText || '').replace(/\u00a0/g, ' ')
                          const caretPos = getCaretOffset(inputRef.current)
                          setMessageText(text)
                          const html = formatToHtmlPreview(text)
                          inputRef.current.innerHTML = html || ''
                          setCaretOffset(inputRef.current, caretPos)
                        }}
                        onKeyDown={handleKeyDown}
                        onPaste={(e) => {
                          e.preventDefault()
                          const text = e.clipboardData.getData('text/plain')
                          document.execCommand('insertText', false, text)
                        }}
                        className="w-full px-4 py-2.5 bg-white border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent message-input text-gray-900 min-h-[42px] max-h-32 overflow-y-auto whitespace-pre-wrap break-words outline-none"
                      />
                    </div>
                    <button
                      onClick={handleSendMessage}
                      disabled={sendingMessage || !messageText.trim()}
                      className="p-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Send className="w-6 h-6" />
                    </button>
                  </div>
                </div>
              )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-gray-50">
            <div className="text-center">
              <div className="w-24 h-24 bg-gray-200 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-12 h-12 text-gray-400" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
              </div>
              <h3 className="text-xl font-medium text-gray-700 mb-2">Clarin WhatsApp</h3>
              <p className="text-gray-500">Selecciona un chat para comenzar</p>
              <button
                onClick={() => setShowNewChatModal(true)}
                className="mt-4 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 inline-flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                Nueva conversación
              </button>
            </div>
          </div>
        )}
      </div>

      {/* New chat modal */}
      <NewChatModal
        isOpen={showNewChatModal}
        onClose={() => setShowNewChatModal(false)}
        devices={devices}
        onChatCreated={handleChatCreated}
      />

      {/* Image viewer lightbox */}
      <ImageViewer
        src={viewerImage?.src || ''}
        alt={viewerImage?.alt}
        isOpen={!!viewerImage}
        onClose={() => setViewerImage(null)}
      />

      {/* Poll creation modal */}
      {showPollModal && (
        <PollModal
          onClose={() => setShowPollModal(false)}
          onSend={handleSendPoll}
        />
      )}

      {/* Forward message modal */}
      {forwardingMsg && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md max-h-[70vh] flex flex-col shadow-2xl">
            <div className="p-4 border-b border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Forward className="w-5 h-5 text-green-600" />
                <h3 className="font-semibold text-gray-900">Reenviar mensaje</h3>
              </div>
              <button
                onClick={() => { setForwardingMsg(null); setForwardSearch('') }}
                className="p-1 text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Forwarded message preview */}
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-200">
              <div className="border-l-2 border-green-500 pl-2">
                <p className="text-xs text-gray-500 truncate">
                  {forwardingMsg.body || `[${forwardingMsg.message_type || 'media'}]`}
                </p>
              </div>
            </div>

            {/* Search */}
            <div className="p-3 border-b border-gray-200">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  value={forwardSearch}
                  onChange={(e) => setForwardSearch(e.target.value)}
                  placeholder="Buscar chat..."
                  autoFocus
                  className="w-full pl-9 pr-3 py-2 bg-gray-100 rounded-lg text-sm focus:bg-white focus:ring-2 focus:ring-green-500 border-transparent text-gray-900 placeholder:text-gray-400"
                />
              </div>
            </div>

            {/* Chat list to forward to */}
            <div className="flex-1 overflow-y-auto">
              {chats
                .filter(c => {
                  if (!forwardSearch) return true
                  const name = getChatDisplayName(c).toLowerCase()
                  return name.includes(forwardSearch.toLowerCase())
                })
                .map(c => (
                  <div
                    key={c.id}
                    onClick={() => handleForwardToChat(c)}
                    className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-gray-50 border-b border-gray-100"
                  >
                    {c.contact_avatar_url ? (
                      <img
                        src={c.contact_avatar_url}
                        alt=""
                        className="w-10 h-10 rounded-full object-cover flex-shrink-0"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden') }}
                      />
                    ) : null}
                    <div className={`w-10 h-10 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0 ${c.contact_avatar_url ? 'hidden' : ''}`}>
                      <span className="text-green-700 font-medium">
                        {getChatDisplayName(c).charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 truncate">{getChatDisplayName(c)}</p>
                      {c.device_name && (
                        <p className="text-xs text-green-600">{c.device_name}</p>
                      )}
                    </div>
                    <Forward className="w-4 h-4 text-gray-400" />
                  </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
