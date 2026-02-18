'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Send, Paperclip, MoreVertical, Search, Phone, Video,
  ArrowLeft, Smile, Image as ImageIcon, FileText, X,
  Mic, Trash2, Reply, Check, CheckCheck, Download,
  CornerUpRight, Play, Pause, AlertCircle, BarChart3, User
} from 'lucide-react'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { Chat, Message } from '@/types/chat'
import { createWebSocket } from '@/lib/api'
import { getChatDisplayName } from '@/utils/chat'
import WhatsAppTextInput, { WhatsAppTextInputHandle } from '../WhatsAppTextInput'
import ImageViewer from './ImageViewer'
import MessageBubble from './MessageBubble'
import StickerPicker from './StickerPicker'
import PollModal from './PollModal'
import ContactPanel from './ContactPanel'
import QuickReplyPicker from './QuickReplyPicker'

interface ChatPanelProps {
  chatId: string | null
  deviceId?: string
  initialChat?: Chat
  onClose?: () => void
  className?: string
}

export default function ChatPanel({ chatId, deviceId, initialChat, onClose, className = '' }: ChatPanelProps) {
  const [chat, setChat] = useState<Chat | null>(initialChat || null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [messageText, setMessageText] = useState('')
  const [sendingMessage, setSendingMessage] = useState(false)
  const [replyingTo, setReplyingTo] = useState<Message | null>(null)

  // Attachments
  const [showAttachments, setShowAttachments] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Audio recording
  const [isRecording, setIsRecording] = useState(false)
  const [recordingDuration, setRecordingDuration] = useState(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Modals & Viewers
  const [viewImage, setViewImage] = useState<string | null>(null)
  const [activePopup, setActivePopup] = useState<'emoji' | 'sticker' | null>(null)
  const [showPollModal, setShowPollModal] = useState(false)

  // Panels
  const [showContactInfo, setShowContactInfo] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Forwarding
  const [forwardingMsg, setForwardingMsg] = useState<Message | null>(null)
  const [forwardSearch, setForwardSearch] = useState('')

  // Quick Reply
  const [showQuickReply, setShowQuickReply] = useState(false)
  const [quickReplyFilter, setQuickReplyFilter] = useState('')
  const [quickRepliesData, setQuickRepliesData] = useState<any[]>([])

  // Resize
  const [rightPanelWidth, setRightPanelWidth] = useState(320)

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<WhatsAppTextInputHandle>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const optimisticIdRef = useRef(0)

  // Fetch quick replies
  useEffect(() => {
    const token = localStorage.getItem('token')
    fetch('/api/quick-replies', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          setQuickRepliesData(data.quick_replies || [])
        }
      })
      .catch(console.error)
  }, [])

  // Media query for responsive layout
  const [isMdScreen, setIsMdScreen] = useState(true)
  useEffect(() => {
    const handler = (e: MediaQueryListEvent) => setIsMdScreen(e.matches)
    const mql = window.matchMedia('(min-width: 768px)')
    setIsMdScreen(mql.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  // Resize handler
  const startResizing = useCallback((mouseDownEvent: React.MouseEvent) => {
    mouseDownEvent.preventDefault();
    const startX = mouseDownEvent.clientX;
    const startWidth = rightPanelWidth;

    const doDrag = (mouseMoveEvent: MouseEvent) => {
      const newWidth = startWidth + (startX - mouseMoveEvent.clientX);
      if (newWidth > 200 && newWidth < 600) {
        setRightPanelWidth(newWidth);
      }
    };

    const stopDrag = () => {
      document.removeEventListener('mousemove', doDrag);
      document.removeEventListener('mouseup', stopDrag);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', doDrag);
    document.addEventListener('mouseup', stopDrag);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [rightPanelWidth]);


  useEffect(() => {
    if (initialChat) {
        setChat(initialChat)
        setMessages([]) // Clear previous messages to avoid flash
    }
  }, [initialChat])

  useEffect(() => {
    if (chatId) {
      fetchChatDetails()
    } else {
        setChat(null)
        setMessages([])
    }
  }, [chatId])

  useEffect(() => {
    if (!chatId || !deviceId) return

    // Close previous WS if any
    if (wsRef.current) {
      wsRef.current.close()
    }

    // Connect new WS with dummy handler (we overwrite onmessage below to handle raw events if needed)
    const ws = createWebSocket(() => {})
    if (!ws) return

    wsRef.current = ws

    ws.onopen = () => {
        // Subscribe to chat events
        ws.send(JSON.stringify({
            type: 'subscribe_chat',
            chat_id: chatId,
            device_id: deviceId
        }))
    }

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data)
            if (data.type === 'new_message' && data.message) {
                // Ensure message belongs to this chat
                if (data.message.chat_id === chatId ||
                    (chat && data.message.from_jid === chat?.jid) ||
                    (chat && data.message.to === chat?.jid)) {

                    setMessages(prev => {
                        // Avoid duplicates
                        if (prev.some(m => m.id === data.message.id)) return prev
                        return [...prev, data.message]
                    })
                    scrollToBottom()
                }
            } else if (data.type === 'message_update' && data.message) {
                 setMessages(prev => prev.map(m => m.id === data.message.id ? data.message : m))
            }
        } catch (e) {
            console.error('WS parse error', e)
        }
    }

    return () => {
        ws.close()
    }
  }, [chatId, deviceId, chat])

  const fetchChatDetails = async () => {
    if (!chatId) return
    setLoading(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/chats/${chatId}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      if (data.success) {
        setChat(data.chat)
      }

      // Fetch messages from dedicated endpoint
      const msgRes = await fetch(`/api/chats/${chatId}/messages?limit=50`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const msgData = await msgRes.json()
      if (msgData.success && msgData.messages) {
        setMessages(msgData.messages)
        scrollToBottom()
      }
    } catch (error) {
      console.error('Failed to fetch chat', error)
    } finally {
      setLoading(false)
    }
  }

  const scrollToBottom = () => {
    setTimeout(() => {
      if (messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight
      }
    }, 100)
  }

  const handleSendMessage = async () => {
    if ((!messageText.trim() && !forwardingMsg) || !chat || !deviceId) return

    setSendingMessage(true)
    const text = messageText.trim()
    setMessageText('')
    setReplyingTo(null)
    setQuickReplyFilter('')

    if (inputRef.current) {
        inputRef.current.clear()
        inputRef.current.focus()
    }

    // Optimistic UI
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
      quoted_message_id: replyingTo?.id,
      quoted_body: replyingTo?.body,
      quoted_sender: replyingTo?.from_jid
    }

    setMessages(prev => [...prev, optimisticMsg])
    scrollToBottom()

    const token = localStorage.getItem('token')
    try {
        const res = await fetch('/api/messages/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
                device_id: deviceId,
                to: chat.jid,
                body: text,
                quoted_message_id: replyingTo?.message_id
            })
        })
        const data = await res.json()

        if (data.success) {
            if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
                 const realMsg = data.message
                 if (realMsg) {
                     setMessages(prev => prev.map(m => m.id === tempId ? { ...realMsg, is_from_me: true } : m))
                 } else {
                     setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'sent' } : m))
                 }
            }
        } else {
            setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
            // alert('Error al enviar mensaje: ' + (data.error || 'Desconocido'))
        }
    } catch (err) {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
        console.error(err)
    } finally {
        setSendingMessage(false)
    }
  }

  const handleRetrySend = async (failedMsg: Message) => {
    if (!chat || !deviceId) return

    setMessages(prev => prev.map(m => m.id === failedMsg.id ? { ...m, status: 'sending' } : m))

    const token = localStorage.getItem('token')
    try {
        const res = await fetch('/api/messages/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
                device_id: deviceId,
                to: chat.jid,
                body: failedMsg.body
            })
        })
        const data = await res.json()
        if (data.success && data.message) {
            setMessages(prev => prev.map(m => m.id === failedMsg.id ? data.message : m))
        } else {
            setMessages(prev => prev.map(m => m.id === failedMsg.id ? { ...m, status: 'failed' } : m))
        }
    } catch (e) {
        setMessages(prev => prev.map(m => m.id === failedMsg.id ? { ...m, status: 'failed' } : m))
    }
  }

  const handleSendMedia = async (file: File, mediaType: string) => {
      if (!chat || !deviceId) return

      const tempId = `optimistic-${++optimisticIdRef.current}`
      const previewUrl = URL.createObjectURL(file)
      const caption = mediaType === 'document' ? file.name : ''

      const optimisticMsg: Message = {
        id: tempId,
        message_id: tempId,
        from_jid: '',
        from_name: 'Me',
        body: caption,
        message_type: mediaType,
        media_url: previewUrl,
        is_from_me: true,
        is_read: false,
        status: 'sending',
        timestamp: new Date().toISOString()
      }

      setMessages(prev => [...prev, optimisticMsg])
      setActivePopup(null)
      scrollToBottom()

      const token = localStorage.getItem('token')
      try {
           const formData = new FormData()
           formData.append('file', file)
           formData.append('folder', 'uploads')

           const uploadRes = await fetch('/api/media/upload', {
               method: 'POST',
               headers: { Authorization: `Bearer ${token}` },
               body: formData
           })
           const uploadData = await uploadRes.json()

           if (!uploadData.success) throw new Error(uploadData.error || 'Error al subir archivo')

           const res = await fetch('/api/messages/send', {
             method: 'POST',
             headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
             body: JSON.stringify({
               device_id: deviceId,
               to: chat.jid,
               body: caption,
               media_url: uploadData.proxy_url || uploadData.public_url,
               media_type: mediaType
             })
           })

           const data = await res.json()
           if (!data.success) {
               setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
           }
      } catch (err) {
           console.error(err)
           setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
      }
  }

  const handleSendMediaUrl = async (url: string, mediaType: string, caption: string) => {
    if (!chat || !deviceId) return

    const tempId = `optimistic-${++optimisticIdRef.current}`

    const optimisticMsg: Message = {
      id: tempId,
      message_id: tempId,
      from_jid: '',
      from_name: 'Me',
      body: caption,
      message_type: mediaType,
      media_url: url,
      is_from_me: true,
      is_read: false,
      status: 'sending',
      timestamp: new Date().toISOString()
    }

    setMessages(prev => [...prev, optimisticMsg])
    scrollToBottom()

    const token = localStorage.getItem('token')
    try {
        const res = await fetch('/api/messages/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
                device_id: deviceId,
                to: chat.jid,
                body: caption,
                media_url: url,
                media_type: mediaType
            })
        })

        const data = await res.json()
        if (!data.success) {
            setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
        }
    } catch (err) {
        console.error(err)
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
    }
  }

  const handleSendSticker = async (stickerUrl: string, file?: File) => {
      if (!chat || !deviceId) return

      if (file) {
          await handleSendMedia(file, 'sticker')
          return
      }

      const tempId = `optimistic-${++optimisticIdRef.current}`
      const optimisticMsg: Message = {
          id: tempId,
          message_id: tempId,
          from_jid: '',
          from_name: 'Me',
          body: '',
          message_type: 'sticker',
          media_url: stickerUrl,
          is_from_me: true,
          is_read: false,
          status: 'sending',
          timestamp: new Date().toISOString()
      }
      setMessages(prev => [...prev, optimisticMsg])
      scrollToBottom()

      const token = localStorage.getItem('token')
      fetch('/api/messages/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
              device_id: deviceId,
              to: chat.jid,
              media_url: stickerUrl,
              media_type: 'sticker'
          })
      }).then(res => res.json()).then(data => {
          if (!data.success) {
              setMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
          }
      })
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
     if (e.target.files && e.target.files.length > 0) {
         const file = e.target.files[0]
         const type = file.type.startsWith('image/') ? 'image' :
                      file.type.startsWith('video/') ? 'video' :
                      file.type.startsWith('audio/') ? 'audio' : 'document'
         handleSendMedia(file, type)
     }
  }

  const startRecording = async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const recorder = new MediaRecorder(stream)
        mediaRecorderRef.current = recorder
        audioChunksRef.current = []

        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunksRef.current.push(e.data)
        }

        recorder.start()
        setIsRecording(true)
        setRecordingDuration(0)

        recordingTimerRef.current = setInterval(() => {
            setRecordingDuration(prev => prev + 1)
        }, 1000)

    } catch (e) {
        console.error('Mic error', e)
        alert('No se pudo acceder al micrófono')
    }
  }

  const stopRecording = () => {
     if (mediaRecorderRef.current && isRecording) {
         mediaRecorderRef.current.onstop = () => {
             const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
             const file = new File([blob], 'voice_note.webm', { type: 'audio/webm' })
             handleSendMedia(file, 'audio')
         }
         mediaRecorderRef.current.stop()
         mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop())
     }
     setIsRecording(false)
     if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
  }

  const cancelRecording = () => {
      if (mediaRecorderRef.current && isRecording) {
          mediaRecorderRef.current.stop()
          mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop())
      }
      setIsRecording(false)
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
  }

  const formatTime = (seconds: number) => {
      const mins = Math.floor(seconds / 60)
      const secs = seconds % 60
      return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
       e.preventDefault()
       handleSendMessage()
    }
  }

  const handleMessageChange = (text: string) => {
     setMessageText(text)
     if (text.endsWith('/')) {
         setQuickReplyFilter('')
         setShowQuickReply(true)
     } else if (showQuickReply) {
         const match = text.match(/\/(\w*)$/)
         if (match) {
             setQuickReplyFilter(match[1])
         } else {
             setShowQuickReply(false)
         }
     }
  }

  const handleQuickReplySelect = (reply: any) => {
     const textBeforeCommand = messageText.replace(/\/[\w-]*$/, '')

     if (reply.media_url) {
         handleSendMediaUrl(reply.media_url, reply.media_type || 'image', reply.body || '')
         setMessageText(textBeforeCommand.trim())
     } else {
         setMessageText((textBeforeCommand + reply.body).trim())
     }

     setShowQuickReply(false)
     if (inputRef.current) inputRef.current.focus()
  }

  const handleSaveSticker = (url: string) => {
      const saved = JSON.parse(localStorage.getItem('saved_stickers') || '[]')
      if (!saved.includes(url)) {
          saved.push(url)
          localStorage.setItem('saved_stickers', JSON.stringify(saved))
          alert('Sticker guardado')
      }
  }

  const savedStickerUrls = typeof window !== 'undefined' ? JSON.parse(localStorage.getItem('saved_stickers') || '[]') : []

  if (!chat && loading) {
       return (
        <div className={`flex items-center justify-center bg-slate-50 h-full ${className}`}>
           <div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-200 border-t-emerald-600" />
        </div>
       )
  }

  if (!chat) {
      return (
          <div className={`flex items-center justify-center bg-slate-50 h-full ${className}`}>
             <p className="text-slate-500">Chat no encontrado</p>
          </div>
      )
  }

  return (
    <div className={`flex-1 flex flex-col min-h-0 overflow-hidden h-full ${className}`}>
         {/* Chat header */}
         <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200 bg-white shrink-0">
              <div className="flex items-center gap-3">
                {onClose && (
                  <button
                    onClick={onClose}
                    className="p-1.5 hover:bg-slate-200 rounded-lg"
                  >
                    <ArrowLeft className="w-5 h-5" />
                  </button>
                )}
                <div
                  className="flex items-center gap-3 cursor-pointer"
                  onClick={() => setShowContactInfo(!showContactInfo)}
                >
                    {chat.contact_avatar_url ? (
                        <img src={chat.contact_avatar_url} className="w-9 h-9 rounded-full object-cover" alt="" />
                    ) : (
                        <div className="w-9 h-9 rounded-full bg-slate-200 flex items-center justify-center">
                            <User className="w-5 h-5 text-slate-500" />
                        </div>
                    )}
                    <div>
                        <h3 className="font-semibold text-sm text-slate-900 leading-tight">
                            {chat.contact_name || chat.name || chat.jid.split('@')[0]}
                        </h3>
                        <p className="text-xs text-slate-500">
                             Click para info
                        </p>
                    </div>
                </div>
              </div>

              <div className="flex items-center gap-1">
                   <button onClick={() => setShowSearch(!showSearch)} className="p-2 text-slate-500 hover:bg-slate-100 rounded-full transition">
                       <Search className="w-5 h-5" />
                   </button>
                   <button className="p-2 text-slate-500 hover:bg-slate-100 rounded-full transition">
                       <MoreVertical className="w-5 h-5" />
                   </button>
              </div>
         </div>

         {/* Content Area */}
         <div className="flex-1 flex min-h-0 relative">
             {/* Messages */}
             <div
                ref={messagesContainerRef}
                className="flex-1 overflow-y-auto bg-[#efeae2] p-4 space-y-2 relative"
                style={{ backgroundImage: 'url("https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png")', backgroundRepeat: 'repeat' }}
             >
                  {messages.map((msg, idx) => {
                      // Date separator between different days
                      let showDateSep = false
                      const msgDate = new Date(msg.timestamp)
                      if (idx === 0) {
                        showDateSep = true
                      } else {
                        const prevDate = new Date(messages[idx - 1].timestamp)
                        if (msgDate.toDateString() !== prevDate.toDateString()) {
                          showDateSep = true
                        }
                      }

                      const contactName = chat ? getChatDisplayName(chat) : undefined

                      return (
                          <div key={msg.id}>
                              {showDateSep && (
                                <div className="flex justify-center my-3">
                                  <span className="bg-white/90 text-slate-600 text-xs px-3 py-1 rounded-lg shadow-sm font-medium">
                                    {format(msgDate, "d 'de' MMMM, yyyy", { locale: es })}
                                  </span>
                                </div>
                              )}
                              <MessageBubble
                                message={msg}
                                contactName={contactName}
                                onMediaClick={(url) => setViewImage(url)}
                                onRetry={() => handleRetrySend(msg)}
                                onReply={(m) => setReplyingTo(m)}
                                onForward={(m) => setForwardingMsg(m)}
                              />
                          </div>
                      )
                  })}
             </div>

             {/* Right Panel (Contact/Search) - Overlay/Sidebar */}
             {showContactInfo && (
                <div
                   className="absolute top-0 right-0 h-full border-l border-slate-200 bg-white z-20 shadow-xl"
                   style={{ width: isMdScreen ? rightPanelWidth : '100%' }}
                >
                     {/* Drag handle for resizing */}
                     {isMdScreen && (
                        <div
                          className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-emerald-400 transition z-30"
                          onMouseDown={startResizing}
                        />
                     )}

                     <ContactPanel
                        chatId={chat.id}
                        isOpen={true}
                        onClose={() => setShowContactInfo(false)}
                        deviceName={deviceId ? 'Dispositivo actual' : undefined}
                     />
                </div>
             )}
         </div>

         {/* Footer / Input */}
         <div className="px-3 py-2 bg-slate-50 border-t border-slate-200 flex items-end gap-2 relative z-30 shrink-0">
              {replyingTo && (
                  <div className="absolute bottom-full left-0 right-0 bg-slate-100 p-2 border-t border-emerald-500 flex justify-between items-center shadow-sm">
                      <div className="text-xs border-l-4 border-emerald-500 pl-2">
                          <p className="font-bold text-emerald-700">Respondiendo a {replyingTo.is_from_me ? 'ti mismo' : 'contacto'}</p>
                          <p className="line-clamp-1 text-slate-600">{replyingTo.body || 'Media'}</p>
                      </div>
                      <button onClick={() => setReplyingTo(null)}><X className="w-4 h-4 text-slate-500" /></button>
                  </div>
              )}

              {/* Attachments Menu */}
              {showAttachments && (
                  <div className="absolute bottom-16 left-4 bg-white rounded-xl shadow-xl border border-slate-100 p-2 flex flex-col gap-2 animate-in slide-in-from-bottom-2 duration-200">
                      <button className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded-lg transition text-sm text-slate-700" onClick={() => fileInputRef.current?.click()}>
                          <ImageIcon className="w-5 h-5 text-purple-500" /> Foto/Video
                      </button>
                      <button className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded-lg transition text-sm text-slate-700">
                          <FileText className="w-5 h-5 text-blue-500" /> Documento
                      </button>
                      <button className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded-lg transition text-sm text-slate-700">
                          <User className="w-5 h-5 text-emerald-500" /> Contacto
                      </button>
                  </div>
              )}
              <input type="file" ref={fileInputRef} className="hidden" multiple onChange={handleFileSelect} />

              <div className="flex gap-1 pb-1">
                  <button onClick={() => setShowAttachments(!showAttachments)} className="p-2 text-slate-500 hover:text-emerald-600 transition">
                      <Paperclip className="w-6 h-6" />
                  </button>
                  <button
                     onClick={() => setActivePopup(activePopup === 'emoji' ? null : 'emoji')}
                     className={`p-2 transition ${activePopup === 'emoji' ? 'text-emerald-600' : 'text-slate-500 hover:text-emerald-600'}`}
                  >
                      <Smile className="w-6 h-6" />
                  </button>
              </div>

              <div className="flex-1 relative">
                    <QuickReplyPicker
                      replies={quickRepliesData}
                      isOpen={showQuickReply}
                      filter={quickReplyFilter}
                      onSelect={handleQuickReplySelect}
                      onClose={() => { setShowQuickReply(false); setQuickReplyFilter('') }}
                    />
                    <WhatsAppTextInput
                      ref={inputRef}
                      value={messageText}
                      onChange={handleMessageChange}
                      placeholder="Escribe un mensaje... ( / para respuestas rápidas)"
                      onKeyDown={handleKeyDown}
                      disabled={sendingMessage}
                      singleLine
                    />
              </div>

              <div className="flex gap-1 pb-1">
                    <StickerPicker
                      onStickerSelect={handleSendSticker}
                      isOpen={activePopup === 'sticker'}
                      onToggle={() => setActivePopup(activePopup === 'sticker' ? null : 'sticker')}
                    />
                    <button
                      onClick={() => setShowPollModal(true)}
                      className="p-2 text-slate-500 hover:text-emerald-600 hover:bg-slate-100 rounded-lg transition-colors"
                      title="Crear encuesta"
                    >
                      <BarChart3 className="w-5 h-5" />
                    </button>
              </div>

              {messageText || forwardingMsg ? (
                  <button
                    onClick={handleSendMessage}
                    disabled={sendingMessage}
                    className="p-3 bg-emerald-600 text-white rounded-full hover:bg-emerald-700 disabled:opacity-50 transition shadow-md"
                  >
                      <Send className="w-5 h-5" />
                  </button>
              ) : (
                  <button
                    onMouseDown={startRecording}
                    onMouseUp={stopRecording}
                    onMouseLeave={cancelRecording}
                    className={`p-3 rounded-full transition shadow-md ${isRecording ? 'bg-red-500 text-white animate-pulse' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}
                  >
                      {isRecording ? <div className="w-5 h-5 flex items-center justify-center font-mono text-xs">{formatTime(recordingDuration)}</div> : <Mic className="w-5 h-5" />}
                  </button>
              )}
         </div>

         {/* Poll Modal */}
         {showPollModal && (
             <PollModal
               onClose={() => setShowPollModal(false)}
               onSend={(question, options, maxSelections) => {
                  console.log('Poll:', question, options, maxSelections)
                  // Implement poll sending logic here via API if available
                  setShowPollModal(false)
               }}
             />
         )}

         {/* Image Viewer */}
         {viewImage && (
             <ImageViewer src={viewImage} isOpen={!!viewImage} onClose={() => setViewImage(null)} />
         )}
    </div>
  )
}
