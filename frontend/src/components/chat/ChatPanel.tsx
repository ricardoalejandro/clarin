'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Send, Paperclip, MoreVertical, Search, Phone, Video,
  ArrowLeft, Smile, Image as ImageIcon, FileText, X,
  Mic, Trash2, Reply, Check, CheckCheck, Download,
  CornerUpRight, Play, Pause, AlertCircle, User, EyeOff, RefreshCw
} from 'lucide-react'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { Chat, Message } from '@/types/chat'
import { subscribeWebSocket } from '@/lib/api'
import { getChatDisplayName } from '@/utils/chat'
import WhatsAppTextInput, { WhatsAppTextInputHandle } from '../WhatsAppTextInput'
import ImageViewer from './ImageViewer'
import MessageBubble from './MessageBubble'
import StickerPicker from './StickerPicker'
import EmojiPicker from './EmojiPicker'
import ContactPanel from './ContactPanel'
import ForwardMessageModal from './ForwardMessageModal'
import QuickReplyPicker from './QuickReplyPicker'
import ContactSelector, { SelectedPerson } from '../ContactSelector'
import { compressImageStandard } from '@/utils/imageCompression'
import { applyReactionMutation, dedupeReactions, hasOwnReaction, SELF_REACTION_ACTOR } from '@/utils/chatReactions'
import { ChatMediaType, validateChatAttachment } from '@/utils/chatAttachments'

type CachedChatMessages = {
  messages: Message[]
  hasMore: boolean
}

type AttachmentDraft = {
  file: File
  type: ChatMediaType
  previewUrl: string
  caption: string
}

type OutgoingMediaType = ChatMediaType | 'sticker'

type RetryableMedia = {
  file: File
  type: OutgoingMediaType
  caption: string
  previewUrl: string
  uploadedMediaUrl?: string
}

type ComposerFeedback = {
  kind: 'error' | 'info'
  message: string
}

function hasSameMessageIdentity(message: Message, candidate: Message): boolean {
  return message.id === candidate.id || (!!candidate.message_id && message.message_id === candidate.message_id)
}

function isCompatibleOptimisticMessage(message: Message, actualMessage: Message): boolean {
  if (!message.is_from_me || !message.id.startsWith('optimistic-')) return false
  if (message.status !== 'sending' && message.status !== 'sent') return false
  if ((message.message_type || 'text') !== (actualMessage.message_type || 'text')) return false
  if ((message.body || '') !== (actualMessage.body || '')) return false
  if (message.media_filename && actualMessage.media_filename && message.media_filename !== actualMessage.media_filename) return false
  return true
}

function findCompatibleOptimisticIndex(messages: Message[], actualMessage: Message): number {
  const candidates = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => isCompatibleOptimisticMessage(message, actualMessage))
  if (candidates.length === 0) return -1

  const actualTimestamp = new Date(actualMessage.timestamp).getTime()
  if (!Number.isFinite(actualTimestamp)) return candidates[candidates.length - 1].index

  return candidates.reduce((closest, candidate) => {
    const closestDistance = Math.abs(new Date(closest.message.timestamp).getTime() - actualTimestamp)
    const candidateDistance = Math.abs(new Date(candidate.message.timestamp).getTime() - actualTimestamp)
    return candidateDistance < closestDistance ? candidate : closest
  }).index
}

function reconcileOptimisticMessage(messages: Message[], tempId: string, realMessage: Message): Message[] {
  const normalizedMessage = { ...realMessage, is_from_me: true }
  const realAlreadyExists = messages.some(message => hasSameMessageIdentity(message, normalizedMessage))

  if (realAlreadyExists) {
    return messages
      .filter(message => message.id !== tempId)
      .map(message => hasSameMessageIdentity(message, normalizedMessage) ? normalizedMessage : message)
  }

  const tempExists = messages.some(message => message.id === tempId)
  if (tempExists) {
    return messages.map(message => message.id === tempId ? normalizedMessage : message)
  }

  return [...messages, normalizedMessage]
}

interface ChatPanelProps {
  chatId: string | null
  deviceId?: string
  initialChat?: Chat
  onClose?: () => void
  className?: string
  readOnly?: boolean
  onContactInfoToggle?: (show: boolean) => void
  contactInfoOpen?: boolean
}

export default function ChatPanel({ chatId, deviceId, initialChat, onClose, className = '', readOnly = false, onContactInfoToggle, contactInfoOpen }: ChatPanelProps) {
  const [chat, setChat] = useState<Chat | null>(initialChat || null)
  const [messages, setMessages] = useState<Message[]>([])
  const messagesCacheRef = useRef<Map<string, CachedChatMessages>>(new Map())
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)
  const [hasMoreMessages, setHasMoreMessages] = useState(true)
  const [messageText, setMessageText] = useState('')
  const [sendingMessage, setSendingMessage] = useState(false)
  const messageSendSequenceRef = useRef(0)
  const activeMessageSendRef = useRef<number | null>(null)
  const [replyingTo, setReplyingTo] = useState<Message | null>(null)

  // Attachments
  const [showAttachments, setShowAttachments] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const docFileInputRef = useRef<HTMLInputElement>(null)
  const [showContactPicker, setShowContactPicker] = useState(false)

  // Media preview with caption
  const [attachmentDraft, setAttachmentDraft] = useState<AttachmentDraft | null>(null)
  const [sendingAttachment, setSendingAttachment] = useState(false)
  const [composerFeedback, setComposerFeedback] = useState<ComposerFeedback | null>(null)

  // Modals & Viewers
  const [viewImage, setViewImage] = useState<string | null>(null)
  const [activePopup, setActivePopup] = useState<'emoji' | 'sticker' | null>(null)

  // Panels
  const [showContactInfoLocal, setShowContactInfoLocal] = useState(false)
  const showContactInfo = contactInfoOpen !== undefined ? contactInfoOpen : showContactInfoLocal
  const setShowContactInfo = (show: boolean) => {
    if (onContactInfoToggle) onContactInfoToggle(show)
    else setShowContactInfoLocal(show)
  }
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Forwarding
  const [forwardingMsg, setForwardingMsg] = useState<Message | null>(null)
  const [forwardSearch, setForwardSearch] = useState('')

  // Editing
  const [editingMsg, setEditingMsg] = useState<Message | null>(null)

  // Quick Reply
  const [showQuickReply, setShowQuickReply] = useState(false)
  const [quickReplyFilter, setQuickReplyFilter] = useState('')
  const [quickRepliesData, setQuickRepliesData] = useState<any[]>([])

  // Typing indicator
  const [contactTyping, setContactTyping] = useState<string | null>(null) // null | 'composing' | 'recording'
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const lastTypingSentRef = useRef<number>(0)
  const typingPauseTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // History sync
  const [syncingHistory, setSyncingHistory] = useState(false)

  const cacheMessages = useCallback((targetChatId: string | null | undefined, nextMessages: Message[], nextHasMore = hasMoreMessages) => {
    if (!targetChatId) return
    messagesCacheRef.current.set(targetChatId, {
      messages: nextMessages,
      hasMore: nextHasMore
    })
  }, [hasMoreMessages])

  const updateMessages = useCallback((updater: Message[] | ((prev: Message[]) => Message[]), targetChatId = chatId) => {
    setMessages(prev => {
      const nextMessages = typeof updater === 'function' ? updater(prev) : updater
      cacheMessages(targetChatId, nextMessages)
      return nextMessages
    })
  }, [cacheMessages, chatId])

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<WhatsAppTextInputHandle>(null)
  const captionInputRef = useRef<WhatsAppTextInputHandle>(null)
  const optimisticIdRef = useRef(0)
  const previousChatIdRef = useRef<string | null>(chatId)
  const activeChatIdRef = useRef<string | null>(chatId)
  const attachmentDraftRef = useRef<AttachmentDraft | null>(attachmentDraft)
  const attachmentSendingRef = useRef(false)
  const mediaRetryRef = useRef<Map<string, RetryableMedia>>(new Map())
  const reactionRequestSeqRef = useRef<Map<string, number>>(new Map())

  const releaseRetryableMedia = useCallback((tempId: string) => {
    const media = mediaRetryRef.current.get(tempId)
    if (media?.previewUrl) URL.revokeObjectURL(media.previewUrl)
    mediaRetryRef.current.delete(tempId)
  }, [])

  const updateMessagesForChat = useCallback((targetChatId: string, updater: (prev: Message[]) => Message[]) => {
    if (activeChatIdRef.current === targetChatId) {
      updateMessages(updater, targetChatId)
      return
    }

    const cached = messagesCacheRef.current.get(targetChatId)
    if (!cached) return
    messagesCacheRef.current.set(targetChatId, {
      ...cached,
      messages: updater(cached.messages),
    })
  }, [updateMessages])

  useEffect(() => {
    attachmentDraftRef.current = attachmentDraft
  }, [attachmentDraft])

  useEffect(() => {
    if (!composerFeedback) return
    const timer = window.setTimeout(() => setComposerFeedback(null), 6000)
    return () => window.clearTimeout(timer)
  }, [composerFeedback])

  useEffect(() => () => {
    if (attachmentDraftRef.current?.previewUrl) {
      URL.revokeObjectURL(attachmentDraftRef.current.previewUrl)
    }
    mediaRetryRef.current.forEach(media => {
      if (media.previewUrl) URL.revokeObjectURL(media.previewUrl)
    })
    mediaRetryRef.current.clear()
  }, [])

  // Helper: send typing/composing presence to recipient
  const sendPresence = useCallback((composing: boolean, media: string = '') => {
    if (!chat || !deviceId) return
    const token = localStorage.getItem('token')
    fetch('/api/messages/typing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ device_id: deviceId, to: chat.jid, composing, media })
    }).catch(() => {})
  }, [chat, deviceId])

  useEffect(() => {
    if (previousChatIdRef.current === chatId) return
    previousChatIdRef.current = chatId

    if (typingPauseTimeoutRef.current) clearTimeout(typingPauseTimeoutRef.current)
    if (attachmentDraftRef.current?.previewUrl) {
      URL.revokeObjectURL(attachmentDraftRef.current.previewUrl)
    }

    sendPresence(false)
    lastTypingSentRef.current = 0
    setMessageText('')
    setReplyingTo(null)
    setEditingMsg(null)
    setShowQuickReply(false)
    setQuickReplyFilter('')
    setActivePopup(null)
    setShowAttachments(false)
    setAttachmentDraft(null)
    setSendingAttachment(false)
    setSendingMessage(false)
    setComposerFeedback(null)
    attachmentSendingRef.current = false
    messageSendSequenceRef.current += 1
    activeMessageSendRef.current = null
    inputRef.current?.clear()
    captionInputRef.current?.clear()
  }, [chatId, sendPresence])

  // Request history sync for current chat
  const handleRequestHistorySync = useCallback(async () => {
    if (!chatId || syncingHistory) return
    setSyncingHistory(true)
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(`/api/chats/${chatId}/sync-history`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Error solicitando historial')
      }
    } catch (err: any) {
      console.error('[HistorySync]', err)
    } finally {
      // Keep spinning for a bit — response comes async via WebSocket
      setTimeout(() => setSyncingHistory(false), 15000)
    }
  }, [chatId, syncingHistory])

  // Resize
  const [rightPanelWidth, setRightPanelWidth] = useState(320)

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
    if (initialChat && (!chatId || initialChat.id === chatId)) {
        setChat(initialChat)
        const cached = messagesCacheRef.current.get(initialChat.id)
        if (cached) {
          setMessages(cached.messages)
          setHasMoreMessages(cached.hasMore)
        } else {
          setMessages([])
          setHasMoreMessages(true)
        }
    }
  }, [initialChat, chatId])

  useEffect(() => {
    activeChatIdRef.current = chatId
    loadingMoreRef.current = false
    setLoadingMore(false)
    if (chatId) {
      const cached = messagesCacheRef.current.get(chatId)
      if (cached) {
        setMessages(cached.messages)
        setHasMoreMessages(cached.hasMore)
        requestAnimationFrame(scrollToBottom)
      } else {
        setChat(initialChat && initialChat.id === chatId ? initialChat : null)
        setMessages([])
        setHasMoreMessages(true)
      }
      fetchChatDetails(chatId, deviceId)
    } else {
        setChat(null)
        setMessages([])
        setHasMoreMessages(true)
    }
  }, [chatId, deviceId, initialChat])

  useEffect(() => {
    if (!chatId || !deviceId) return

    const unsubscribe = subscribeWebSocket(
      (data: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = data as any
        const eventType = msg.type || msg.event
        const payload = msg.data || msg.message

        if ((eventType === 'new_message' || eventType === 'message_sent') && payload) {
          // The actual message object is nested inside payload.message
          const actualMsg = payload.message || payload
          const matchChatId = payload.chat_id || actualMsg.chat_id
          if (matchChatId === chatId ||
              (chat && actualMsg.from_jid === chat?.jid) ||
              (chat && actualMsg.to === chat?.jid)) {
            updateMessages(prev => {
              const actualMessage = actualMsg as Message
              const realAlreadyExists = prev.some(message => hasSameMessageIdentity(message, actualMessage))

              if (actualMessage.is_from_me) {
                const optimisticIndex = findCompatibleOptimisticIndex(prev, actualMessage)
                if (optimisticIndex >= 0) {
                  const tempId = prev[optimisticIndex].id
                  releaseRetryableMedia(tempId)
                  return reconcileOptimisticMessage(prev, tempId, actualMessage)
                }
                if (realAlreadyExists) {
                  return prev.map(message => hasSameMessageIdentity(message, actualMessage) ? actualMessage : message)
                }
                // No optimistic message pending → safe to add (e.g. sent from another device)
                return [...prev, actualMessage]
              }

              if (realAlreadyExists) {
                return prev.map(message => hasSameMessageIdentity(message, actualMessage) ? actualMessage : message)
              }
              // Incoming message → always add
              return [...prev, actualMessage]
            })
            scrollToBottom()
          }
        } else if ((eventType === 'message_update') && payload) {
          const actualMsg = payload.message || payload
          updateMessages(prev => prev.map(m => m.id === actualMsg.id ? (actualMsg as Message) : m))
        } else if (eventType === 'message_status' && payload) {
          // Update message delivery/read status (only upgrade, never downgrade)
          const msgIds: string[] = payload.message_ids || []
          const newStatus: string = payload.status
          const statusOrder: Record<string, number> = { sending: 0, sent: 1, delivered: 2, read: 3 }
          const newLevel = statusOrder[newStatus] ?? -1
          if (chat && payload.chat_jid === chat.jid && msgIds.length > 0 && newLevel >= 0) {
            updateMessages(prev => prev.map(m => {
              if (!msgIds.includes(m.message_id)) return m
              const currentLevel = statusOrder[m.status] ?? -1
              if (newLevel > currentLevel) return { ...m, status: newStatus }
              return m
            }))
          }
        } else if (eventType === 'message_revoked' && payload) {
          // Mark message as revoked
          const revokedMsgId: string = payload.message_id
          if (chat && payload.chat_jid === chat.jid) {
            updateMessages(prev => prev.map(m =>
              m.message_id === revokedMsgId ? { ...m, is_revoked: true, body: undefined } : m
            ))
          }
        } else if (eventType === 'message_edited' && payload) {
          // Update edited message body
          const editedMsgId: string = payload.message_id
          const newBody: string = payload.new_body
          if (chat && payload.chat_jid === chat.jid) {
            updateMessages(prev => prev.map(m =>
              m.message_id === editedMsgId ? { ...m, body: newBody, is_edited: true } : m
            ))
          }
        } else if ((eventType === 'typing' || eventType === 'presence') && payload) {
          // Typing/presence indicator from contact
          if (chat && payload.jid === chat.jid) {
            if (payload.composing || payload.available) {
              const media = payload.media === 'audio' ? 'recording' : 'composing'
              setContactTyping(media)
              // Auto-clear typing after 15s (in case stop event is missed)
              if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
              typingTimeoutRef.current = setTimeout(() => setContactTyping(null), 15000)
            } else {
              setContactTyping(null)
              if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
            }
          }
        } else if (eventType === 'history_sync_complete' && payload) {
          // History sync completed — reload messages to include historical ones
          setSyncingHistory(false)
          fetchChatDetails()
        } else if (eventType === 'message_reaction' && payload) {
          // Incoming reaction from contact or self echo
          if (chat && payload.chat_id === chat.id) {
            const targetMsgId: string = payload.target_message_id
            const emoji: string = payload.emoji
            const senderJid: string = payload.sender_jid || ''
            const senderName: string = payload.sender_name || ''
            const isFromMe: boolean = !!payload.is_from_me
            const removed: boolean = !!payload.removed

            updateMessages(prev => prev.map(m => {
              if (m.message_id !== targetMsgId) return m
              const reactions = applyReactionMutation(m.reactions, {
                targetMessageId: targetMsgId,
                senderJid,
                senderName,
                emoji,
                isFromMe,
                removed,
              })
              return { ...m, reactions }
            }))
          }
        }
      },
      (send) => {
        send(JSON.stringify({
          event: 'subscribe_chat',
          data: { chat_id: chatId, device_id: deviceId }
        }))
      }
    )

    return () => {
      unsubscribe()
    }
  }, [chatId, deviceId, chat])

  const fetchChatDetails = async (targetChatId: string | null = chatId, targetDeviceId: string | undefined = deviceId) => {
    if (!targetChatId) return
    const hasCachedMessages = messagesCacheRef.current.has(targetChatId)
    setLoading(!hasCachedMessages)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/chats/${targetChatId}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      if (activeChatIdRef.current !== targetChatId) return
      if (data.success) {
        setChat(data.chat)
      }

      // Fetch messages from dedicated endpoint
      const msgRes = await fetch(`/api/chats/${targetChatId}/messages?limit=50`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const msgData = await msgRes.json()
      if (activeChatIdRef.current !== targetChatId) return
      if (msgData.success && msgData.messages) {
        const nextHasMore = msgData.messages.length >= 50
        setMessages(msgData.messages)
        setHasMoreMessages(nextHasMore)
        cacheMessages(targetChatId, msgData.messages, nextHasMore)
        scrollToBottom()

        // Send read receipts for unread incoming messages
        if (targetDeviceId && data.chat?.jid) {
          const unreadIncoming = (msgData.messages as Message[]).filter(
            (m: Message) => !m.is_from_me && !m.is_read
          )
          if (unreadIncoming.length > 0) {
            const lastMsg = unreadIncoming[unreadIncoming.length - 1]
            fetch('/api/messages/read-receipt', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({
                device_id: targetDeviceId,
                chat_jid: data.chat.jid,
                sender_jid: lastMsg.from_jid || '',
                message_ids: unreadIncoming.map((m: Message) => m.message_id)
              })
            }).catch(() => {})
          }
        }
      }
    } catch (error) {
      console.error('Failed to fetch chat', error)
    } finally {
      if (activeChatIdRef.current === targetChatId) {
        setLoading(false)
      }
    }
  }

  const scrollToBottom = () => {
    setTimeout(() => {
      if (messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight
      }
    }, 100)
  }

  const loadOlderMessages = async () => {
    if (loadingMoreRef.current || loadingMore || !hasMoreMessages || !chatId) return
    const targetChatId = chatId
    const targetMessages = messagesCacheRef.current.get(targetChatId)?.messages || messages
    const offset = targetMessages.filter(message => !message.id.startsWith('optimistic-')).length
    loadingMoreRef.current = true
    setLoadingMore(true)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/chats/${targetChatId}/messages?limit=50&offset=${offset}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      if (activeChatIdRef.current !== targetChatId) return
      if (data.success && data.messages) {
        if (data.messages.length === 0) {
          setHasMoreMessages(false)
        } else {
          // Preserve scroll position
          const container = messagesContainerRef.current
          const prevHeight = container?.scrollHeight || 0
          const nextHasMore = data.messages.length >= 50
          updateMessages(prev => {
            const existingKeys = new Set(prev.flatMap(message => [message.id, message.message_id].filter(Boolean)))
            const olderMessages = (data.messages as Message[]).filter(message =>
              !existingKeys.has(message.id) && !existingKeys.has(message.message_id)
            )
            const nextMessages = [...olderMessages, ...prev]
            cacheMessages(targetChatId, nextMessages, nextHasMore)
            return nextMessages
          }, targetChatId)
          setHasMoreMessages(nextHasMore)
          // Restore scroll position after prepending
          requestAnimationFrame(() => {
            if (container) {
              container.scrollTop = container.scrollHeight - prevHeight
            }
          })
        }
      }
    } catch (err) {
      console.error('Failed to load older messages', err)
    } finally {
      if (activeChatIdRef.current === targetChatId) {
        loadingMoreRef.current = false
        setLoadingMore(false)
      }
    }
  }

  const handleMessagesScroll = () => {
    const container = messagesContainerRef.current
    if (!container) return
    if (container.scrollTop < 80 && hasMoreMessages && !loadingMore && !loadingMoreRef.current) {
      loadOlderMessages()
    }
  }

  const handleSendMessage = async () => {
    if ((!messageText.trim() && !forwardingMsg) || !chat || !deviceId) return

    const text = messageText.trim()
    if (editingMsg && !text) return
    if (activeMessageSendRef.current !== null) return

    const targetChatId = chatId
    const requestSequence = ++messageSendSequenceRef.current
    activeMessageSendRef.current = requestSequence
    setSendingMessage(true)

    const updateTargetMessages = (updater: (prev: Message[]) => Message[]) => {
      if (targetChatId) updateMessagesForChat(targetChatId, updater)
      else updateMessages(updater)
    }

    const finishMessageSend = () => {
      if (
        activeChatIdRef.current !== targetChatId ||
        activeMessageSendRef.current !== requestSequence
      ) return
      activeMessageSendRef.current = null
      setSendingMessage(false)
    }

    // Handle edit mode
    if (editingMsg) {
      const token = localStorage.getItem('token')
      try {
        const res = await fetch('/api/messages/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            device_id: deviceId,
            chat_jid: chat.jid,
            message_id: editingMsg.message_id,
            new_body: text
          })
        })
        const data = await res.json()
        if (data.success) {
          updateTargetMessages(prev => prev.map(m =>
            m.message_id === editingMsg.message_id ? { ...m, body: text, is_edited: true } : m
          ))
        } else {
          alert(data.error || 'Error al editar mensaje')
        }
      } catch (err) {
        console.error('Failed to edit message', err)
      } finally {
        finishMessageSend()
      }
      if (activeChatIdRef.current !== targetChatId) return
      setEditingMsg(null)
      setMessageText('')
      inputRef.current?.clear()
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }

    // Stop typing indicator on send
    if (typingPauseTimeoutRef.current) clearTimeout(typingPauseTimeoutRef.current)
    sendPresence(false)
    lastTypingSentRef.current = 0

    setMessageText('')
    setReplyingTo(null)
    setQuickReplyFilter('')

    if (inputRef.current) {
        inputRef.current.clear()
        // Use rAF to ensure focus happens after React re-render
        requestAnimationFrame(() => inputRef.current?.focus())
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

    updateMessages(prev => [...prev, optimisticMsg])
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
            // Always update the optimistic message from the API response
            const realMsg = data.message
            if (realMsg) {
                updateTargetMessages(prev => reconcileOptimisticMessage(prev, tempId, realMsg as Message))
            } else {
                updateTargetMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'sent' } : m))
            }
        } else {
            updateTargetMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
            // alert('Error al enviar mensaje: ' + (data.error || 'Desconocido'))
        }
    } catch (err) {
        updateTargetMessages(prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
        console.error(err)
    } finally {
        finishMessageSend()
    }
  }

  const transmitRetryableMedia = async (
    tempId: string,
    media: RetryableMedia,
    targetChatId: string,
    targetChatJid: string,
    targetDeviceId: string,
  ): Promise<boolean> => {
    const token = localStorage.getItem('token')
    try {
      let uploadedMediaUrl = media.uploadedMediaUrl
      if (!uploadedMediaUrl) {
        const formData = new FormData()
        formData.append('file', media.file)
        formData.append('folder', 'uploads')

        const uploadRes = await fetch('/api/media/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        })
        const uploadData = await uploadRes.json().catch(() => ({}))
        if (!uploadRes.ok || !uploadData.success) {
          throw new Error(uploadData.error || 'Error al subir archivo')
        }
        uploadedMediaUrl = uploadData.proxy_url || uploadData.public_url
        if (!uploadedMediaUrl) throw new Error('La subida no devolvió una URL válida')
        media.uploadedMediaUrl = uploadedMediaUrl
      }

      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          device_id: targetDeviceId,
          to: targetChatJid,
          body: media.caption,
          media_url: uploadedMediaUrl,
          media_type: media.type,
          media_filename: media.file.name,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || 'Error al enviar archivo')

      if (data.message) {
        updateMessagesForChat(targetChatId, prev => reconcileOptimisticMessage(prev, tempId, data.message as Message))
        releaseRetryableMedia(tempId)
      } else {
        updateMessagesForChat(targetChatId, prev => prev.map(message =>
          message.id === tempId ? { ...message, status: 'sent', media_url: uploadedMediaUrl } : message
        ))
        releaseRetryableMedia(tempId)
      }
      return true
    } catch (err) {
      console.error('[ChatMedia]', err)
      updateMessagesForChat(targetChatId, prev => prev.map(message =>
        message.id === tempId ? { ...message, status: 'failed' } : message
      ))
      if (activeChatIdRef.current === targetChatId) {
        setComposerFeedback({ kind: 'error', message: 'No se pudo enviar el archivo. Puedes reintentarlo desde el mensaje.' })
      }
      return false
    }
  }

  const handleRetrySend = async (failedMsg: Message) => {
    if (!chat || !deviceId || !chatId) return
    const targetChatId = chatId
    const targetChatJid = chat.jid
    const targetDeviceId = deviceId

    const retryableMedia = mediaRetryRef.current.get(failedMsg.id)
    if (retryableMedia) {
      updateMessagesForChat(targetChatId, prev => prev.map(message => message.id === failedMsg.id ? { ...message, status: 'sending' } : message))
      await transmitRetryableMedia(failedMsg.id, retryableMedia, targetChatId, targetChatJid, targetDeviceId)
      return
    }

    if (failedMsg.message_type && failedMsg.message_type !== 'text') {
      setComposerFeedback({ kind: 'error', message: 'El archivo original ya no está disponible. Vuelve a adjuntarlo.' })
      return
    }

    updateMessagesForChat(targetChatId, prev => prev.map(m => m.id === failedMsg.id ? { ...m, status: 'sending' } : m))

    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          device_id: targetDeviceId,
          to: targetChatJid,
          body: failedMsg.body,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.success && data.message) {
        updateMessagesForChat(targetChatId, prev => reconcileOptimisticMessage(prev, failedMsg.id, data.message as Message))
      } else {
        throw new Error(data.error || 'Error al reenviar mensaje')
      }
    } catch (err) {
      console.error('[ChatRetry]', err)
      updateMessagesForChat(targetChatId, prev => prev.map(m => m.id === failedMsg.id ? { ...m, status: 'failed' } : m))
      if (activeChatIdRef.current === targetChatId) {
        setComposerFeedback({ kind: 'error', message: 'No se pudo reenviar el mensaje.' })
      }
    }
  }

  const handleSendMedia = async (file: File, mediaType: OutgoingMediaType, caption?: string): Promise<boolean> => {
    if (!chat || !deviceId || !chatId) return false
    const targetChatId = chatId
    const targetChatJid = chat.jid
    const targetDeviceId = deviceId

    // Compress images client-side (like WhatsApp: max 1600px, JPEG 70%)
    let fileToSend = file
    if (mediaType === 'image') {
      try {
        fileToSend = await compressImageStandard(file)
      } catch (err) {
        console.warn('[ImageCompress] Compression failed, using original:', err)
      }
    }

    if (activeChatIdRef.current !== targetChatId) return false

    const tempId = `optimistic-${++optimisticIdRef.current}`
    const previewUrl = URL.createObjectURL(fileToSend)
    const finalCaption = caption ?? (mediaType === 'document' ? fileToSend.name : '')
    const retryableMedia: RetryableMedia = { file: fileToSend, type: mediaType, caption: finalCaption, previewUrl }

    const optimisticMsg: Message = {
      id: tempId,
      message_id: tempId,
      from_jid: '',
      from_name: 'Me',
      body: finalCaption,
      message_type: mediaType,
      media_url: previewUrl,
      media_filename: fileToSend.name,
      media_mimetype: fileToSend.type,
      media_size: fileToSend.size,
      is_from_me: true,
      is_read: false,
      status: 'sending',
      timestamp: new Date().toISOString(),
    }

    mediaRetryRef.current.set(tempId, retryableMedia)
    updateMessages(prev => [...prev, optimisticMsg])
    setActivePopup(null)
    scrollToBottom()
    void transmitRetryableMedia(tempId, retryableMedia, targetChatId, targetChatJid, targetDeviceId)
    return true
  }

  const handleSendMediaUrl = async (url: string, mediaType: string, caption: string) => {
    if (!chat || !deviceId || !chatId) return
    const targetChatId = chatId
    const targetChatJid = chat.jid
    const targetDeviceId = deviceId

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

    updateMessagesForChat(targetChatId, prev => [...prev, optimisticMsg])
    if (activeChatIdRef.current === targetChatId) scrollToBottom()

    const token = localStorage.getItem('token')
    try {
        const res = await fetch('/api/messages/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
                device_id: targetDeviceId,
                to: targetChatJid,
                body: caption,
                media_url: url,
                media_type: mediaType
            })
        })

        const data = await res.json()
        if (data.success) {
            const realMsg = data.message
            if (realMsg) {
                updateMessagesForChat(targetChatId, prev => reconcileOptimisticMessage(prev, tempId, realMsg as Message))
            } else {
                updateMessagesForChat(targetChatId, prev => prev.map(m => m.id === tempId ? { ...m, status: 'sent' } : m))
            }
        } else {
            updateMessagesForChat(targetChatId, prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
        }
    } catch (err) {
        console.error(err)
        updateMessagesForChat(targetChatId, prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
    }
  }

  const handleSendSticker = async (stickerUrl: string, file?: File) => {
      if (!chat || !deviceId || !chatId) return

      if (file) {
          await handleSendMedia(file, 'sticker')
          return
      }

      const targetChatId = chatId
      const targetChatJid = chat.jid
      const targetDeviceId = deviceId

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
      updateMessagesForChat(targetChatId, prev => [...prev, optimisticMsg])
      if (activeChatIdRef.current === targetChatId) scrollToBottom()

      const token = localStorage.getItem('token')
      try {
        const res = await fetch('/api/messages/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
              device_id: targetDeviceId,
              to: targetChatJid,
              media_url: stickerUrl,
              media_type: 'sticker'
          })
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Error al enviar sticker')
        if (data.success) {
          const realMsg = data.message
          if (realMsg) {
            updateMessagesForChat(targetChatId, prev => reconcileOptimisticMessage(prev, tempId, realMsg as Message))
          } else {
            updateMessagesForChat(targetChatId, prev => prev.map(m => m.id === tempId ? { ...m, status: 'sent' } : m))
          }
        } else {
          throw new Error(data.error || 'Error al enviar sticker')
        }
      } catch (err) {
        console.error('[ChatSticker]', err)
        updateMessagesForChat(targetChatId, prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
      }
  }

  const beginAttachmentDraft = (files: File[], forceDocument = false) => {
    if (files.length === 0) return
    if (editingMsg) {
      setComposerFeedback({ kind: 'info', message: 'Termina o cancela la edición antes de adjuntar un archivo.' })
      return
    }

    const file = files[0]
    const validation = validateChatAttachment(file, forceDocument)
    if (!validation.ok) {
      setComposerFeedback({ kind: 'error', message: validation.error })
      return
    }

    const previousDraft = attachmentDraftRef.current
    const caption = previousDraft?.caption ?? messageText
    if (previousDraft?.previewUrl) URL.revokeObjectURL(previousDraft.previewUrl)

    const previewUrl = validation.mediaType === 'image' || validation.mediaType === 'video'
      ? URL.createObjectURL(file)
      : ''
    const nextDraft: AttachmentDraft = {
      file,
      type: validation.mediaType,
      previewUrl,
      caption,
    }

    attachmentDraftRef.current = nextDraft
    setAttachmentDraft(nextDraft)
    setMessageText('')
    inputRef.current?.clear()
    captionInputRef.current?.clear()
    setShowAttachments(false)
    setActivePopup(null)
    if (typingPauseTimeoutRef.current) clearTimeout(typingPauseTimeoutRef.current)
    sendPresence(false)
    lastTypingSentRef.current = 0

    if (files.length > 1) {
      setComposerFeedback({ kind: 'info', message: 'Se adjuntó el primer archivo. Los demás deben enviarse por separado.' })
    }
    window.setTimeout(() => captionInputRef.current?.focus(), 100)
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, pickerType: 'media' | 'document') => {
    beginAttachmentDraft(Array.from(e.target.files || []), pickerType === 'document')
    // Reset input so same file can be selected again
    e.target.value = ''
  }

  const handleSendContact = async (contacts: SelectedPerson[]) => {
    if (!chat || !deviceId || !chatId) return
    const targetChatId = chatId
    const targetChatJid = chat.jid
    const targetDeviceId = deviceId
    setShowContactPicker(false)
    setShowAttachments(false)
    const token = localStorage.getItem('token')
    for (const contact of contacts) {
      const tempId = `optimistic-${++optimisticIdRef.current}`
      const displayName = contact.name || contact.phone || 'Contacto'
      const optimisticMsg: Message = {
        id: tempId,
        message_id: tempId,
        from_jid: '',
        from_name: 'Me',
        body: displayName,
        message_type: 'contact',
        is_from_me: true,
        is_read: false,
        status: 'sending',
        timestamp: new Date().toISOString(),
        contact_name: displayName,
        contact_phone: contact.phone,
      }
      updateMessagesForChat(targetChatId, prev => [...prev, optimisticMsg])
      if (activeChatIdRef.current === targetChatId) scrollToBottom()
      try {
        const res = await fetch('/api/messages/send-contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            device_id: targetDeviceId,
            to: targetChatJid,
            contact_name: displayName,
            contact_phone: contact.phone,
          })
        })
        const data = await res.json()
        if (data.success && data.message) {
          updateMessagesForChat(targetChatId, prev => reconcileOptimisticMessage(prev, tempId, data.message as Message))
        } else {
          updateMessagesForChat(targetChatId, prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
        }
      } catch {
        updateMessagesForChat(targetChatId, prev => prev.map(m => m.id === tempId ? { ...m, status: 'failed' } : m))
      }
    }
  }

  const handleSendPendingMedia = async () => {
    const draft = attachmentDraftRef.current
    if (!draft || attachmentSendingRef.current) return

    attachmentSendingRef.current = true
    setSendingAttachment(true)
    try {
      const queued = await handleSendMedia(draft.file, draft.type, draft.caption.trim())
      if (!queued) return

      if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl)
      attachmentDraftRef.current = null
      setAttachmentDraft(null)
      captionInputRef.current?.clear()
    } finally {
      attachmentSendingRef.current = false
      setSendingAttachment(false)
    }
  }

  const handleCancelPendingMedia = () => {
    const draft = attachmentDraftRef.current
    if (!draft || attachmentSendingRef.current) return

    if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl)
    attachmentDraftRef.current = null
    setAttachmentDraft(null)
    setMessageText(draft.caption)
    captionInputRef.current?.clear()
    requestAnimationFrame(() => inputRef.current?.focus())
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

     // Send typing indicator (debounced - max once every 3 seconds)
     if (chat && deviceId && text.length > 0) {
       const now = Date.now()
       if (now - lastTypingSentRef.current > 3000) {
         lastTypingSentRef.current = now
         sendPresence(true)
       }
       // Auto-send paused after 5s of no typing
       if (typingPauseTimeoutRef.current) clearTimeout(typingPauseTimeoutRef.current)
       typingPauseTimeoutRef.current = setTimeout(() => {
         sendPresence(false)
         lastTypingSentRef.current = 0
       }, 5000)
     } else if (text.length === 0) {
       // Cleared input — stop composing immediately
       if (typingPauseTimeoutRef.current) clearTimeout(typingPauseTimeoutRef.current)
       sendPresence(false)
       lastTypingSentRef.current = 0
     }
  }

  const handleQuickReplySelect = (reply: any) => {
     const textBeforeCommand = messageText.replace(/\/[\w-]*$/, '')

     // Multi-attachment support
     if (reply.attachments && reply.attachments.length > 0) {
         for (const att of reply.attachments) {
             handleSendMediaUrl(att.media_url, att.media_type || 'image', att.caption || '')
         }
         if (reply.body) {
             // Send body as separate text message
             const sendText = async () => {
                 const token = localStorage.getItem('token')
                 if (!chat || !deviceId) return
                 try {
                     await fetch('/api/messages/send', {
                         method: 'POST',
                         headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                         body: JSON.stringify({ device_id: deviceId, to: chat.jid, body: reply.body })
                     })
                 } catch {}
             }
             sendText()
         }
         setMessageText(textBeforeCommand.trim())
     } else if (reply.media_url) {
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
    <div className={`relative flex-1 flex flex-col min-h-0 overflow-hidden h-full ${className}`}>
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
                            {getChatDisplayName(chat)}
                        </h3>
                        {contactTyping ? (
                          <p className="text-xs text-emerald-600 font-medium">
                            {contactTyping === 'recording' ? (
                              <span className="flex items-center gap-1">
                                <Mic className="w-3 h-3" />
                                grabando audio...
                              </span>
                            ) : (
                              <span className="flex items-center gap-1">
                                escribiendo
                                <span className="inline-flex">
                                  <span className="animate-bounce" style={{ animationDelay: '0ms' }}>.</span>
                                  <span className="animate-bounce" style={{ animationDelay: '150ms' }}>.</span>
                                  <span className="animate-bounce" style={{ animationDelay: '300ms' }}>.</span>
                                </span>
                              </span>
                            )}
                          </p>
                        ) : (
                          <p className="text-xs text-slate-500">
                               Click para info
                          </p>
                        )}
                    </div>
                </div>
              </div>

              <div className="flex items-center gap-1">
                   <button
                     onClick={handleRequestHistorySync}
                     disabled={syncingHistory}
                     className="p-2 text-slate-500 hover:bg-slate-100 rounded-full transition disabled:opacity-50"
                     title="Sincronizar historial de mensajes"
                   >
                       <RefreshCw className={`w-5 h-5 ${syncingHistory ? 'animate-spin' : ''}`} />
                   </button>
                   <button onClick={() => setShowSearch(!showSearch)} className="p-2 text-slate-500 hover:bg-slate-100 rounded-full transition">
                       <Search className="w-5 h-5" />
                   </button>
                   <button className="p-2 text-slate-500 hover:bg-slate-100 rounded-full transition">
                       <MoreVertical className="w-5 h-5" />
                   </button>
              </div>
         </div>

         {composerFeedback && (
           <div
             role={composerFeedback.kind === 'error' ? 'alert' : 'status'}
             className={`absolute left-1/2 top-16 z-[70] flex w-[calc(100%_-_1.5rem)] max-w-lg -translate-x-1/2 items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs shadow-lg ${
               composerFeedback.kind === 'error'
                 ? 'border-red-200 bg-red-50 text-red-700'
                 : 'border-blue-200 bg-blue-50 text-blue-700'
             }`}
           >
             <span>{composerFeedback.message}</span>
             <button type="button" onClick={() => setComposerFeedback(null)} className="shrink-0 rounded p-0.5 hover:bg-black/5" aria-label="Cerrar aviso">
               <X className="h-3.5 w-3.5" />
             </button>
           </div>
         )}

         {/* Content Area */}
         <div className="flex-1 flex min-h-0 relative">
             {/* Messages */}
             <div
                ref={messagesContainerRef}
                onScroll={handleMessagesScroll}
                className="flex-1 overflow-y-auto bg-[#efeae2] p-4 space-y-2 relative"
                style={{ backgroundImage: 'url("https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png")', backgroundRepeat: 'repeat' }}
             >
                  {loadingMore && (
                    <div className="flex justify-center py-3">
                      <div className="animate-spin rounded-full h-5 w-5 border-2 border-emerald-200 border-t-emerald-600" />
                    </div>
                  )}
                  {!hasMoreMessages && messages.length > 0 && (
                    <div className="flex justify-center py-2">
                      <span className="text-xs text-slate-400 bg-white/80 px-3 py-1 rounded-full">Inicio de la conversación</span>
                    </div>
                  )}
                  {messages.map((msg, idx) => {
                      // Date separator between different days
                      let showDateSep = false
                      const msgDate = new Date(msg.timestamp)
                      const isValidDate = msg.timestamp && !isNaN(msgDate.getTime())
                      if (isValidDate) {
                        if (idx === 0) {
                          showDateSep = true
                        } else {
                          const prevDate = new Date(messages[idx - 1].timestamp)
                          if (!isNaN(prevDate.getTime()) && msgDate.toDateString() !== prevDate.toDateString()) {
                            showDateSep = true
                          }
                        }
                      }

                      const contactName = chat ? getChatDisplayName(chat) : undefined

                      return (
                          <div key={msg.id}>
                              {showDateSep && isValidDate && (
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
                                onDelete={async (m) => {
                                  if (!deviceId || !chat) return
                                  const token = localStorage.getItem('token')
                                  try {
                                    const res = await fetch('/api/messages/delete', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                                      body: JSON.stringify({
                                        device_id: deviceId,
                                        chat_jid: chat.jid,
                                        sender_jid: m.from_jid || '',
                                        message_id: m.message_id,
                                        is_from_me: m.is_from_me
                                      })
                                    })
                                    const data = await res.json()
                                    if (data.success) {
                                      updateMessages(prev => prev.map(msg =>
                                        msg.message_id === m.message_id ? { ...msg, is_revoked: true, body: undefined } : msg
                                      ))
                                    }
                                  } catch (err) {
                                    console.error('Failed to delete message', err)
                                  }
                                }}
                                onEdit={(m) => {
                                  setEditingMsg(m)
                                  setMessageText(m.body || '')
                                  requestAnimationFrame(() => {
                                    inputRef.current?.focus()
                                  })
                                }}
                                onReact={async (m, emoji) => {
                                  if (!deviceId || !chat) return
                                  const token = localStorage.getItem('token')
                                  const targetChatId = chat.id
                                  const requestedEmoji = hasOwnReaction(m.reactions, emoji) ? '' : emoji
                                  const previousReactions = dedupeReactions(m.reactions)
                                  const requestSeq = (reactionRequestSeqRef.current.get(m.message_id) || 0) + 1
                                  reactionRequestSeqRef.current.set(m.message_id, requestSeq)

                                  const rollback = () => {
                                    if (reactionRequestSeqRef.current.get(m.message_id) !== requestSeq) return
                                    updateMessagesForChat(targetChatId, prev => prev.map(message =>
                                      message.message_id === m.message_id
                                        ? { ...message, reactions: previousReactions }
                                        : message
                                    ))
                                    if (activeChatIdRef.current === targetChatId) {
                                      setComposerFeedback({ kind: 'error', message: 'No se pudo actualizar la reacción.' })
                                    }
                                  }

                                  try {
                                    // Optimistically update UI
                                    updateMessagesForChat(targetChatId, prev => prev.map(message => {
                                      if (message.message_id !== m.message_id) return message
                                      const reactions = applyReactionMutation(message.reactions, {
                                        targetMessageId: m.message_id,
                                        senderJid: SELF_REACTION_ACTOR,
                                        senderName: 'Tú',
                                        emoji: requestedEmoji,
                                        isFromMe: true,
                                        removed: requestedEmoji === '',
                                      })
                                      return { ...message, reactions }
                                    }))
                                    const res = await fetch('/api/messages/react', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                                      body: JSON.stringify({
                                        device_id: deviceId,
                                        to: chat.jid,
                                        target_message_id: m.message_id,
                                        target_from_me: !!m.is_from_me,
                                        target_sender_jid: m.from_jid || '',
                                        emoji: requestedEmoji
                                      })
                                    })
                                    const data = await res.json().catch(() => ({}))
                                    if (!res.ok || !data.success) {
                                      console.error('Failed to send reaction:', data.error)
                                      rollback()
                                    }
                                  } catch (err) {
                                    console.error('Failed to send reaction', err)
                                    rollback()
                                  }
                                }}
                              />
                          </div>
                      )
                  })}
             </div>

             {/* Right Panel (Contact/Search) - Overlay/Sidebar — only when NOT parent-controlled */}
             {showContactInfo && !onContactInfoToggle && (
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

         {/* Media Preview Overlay */}
         {attachmentDraft && (
           <div className="absolute inset-0 z-40 bg-white flex flex-col">
             {/* Close */}
             <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
               <button
                 onClick={handleCancelPendingMedia}
                 disabled={sendingAttachment}
                 className="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-full transition disabled:opacity-50"
                 aria-label="Cancelar adjunto"
               >
                 <X className="w-6 h-6" />
               </button>
               <span className="text-slate-600 text-sm font-medium">
                 {attachmentDraft.type === 'image' ? 'Imagen' : attachmentDraft.type === 'video' ? 'Video' : attachmentDraft.type === 'audio' ? 'Audio' : 'Documento'}
               </span>
               <div className="w-10" />
             </div>
             {/* Preview */}
             <div className="flex-1 flex items-center justify-center p-4 min-h-0 bg-slate-50">
               {attachmentDraft.type === 'image' ? (
                 <img src={attachmentDraft.previewUrl} className="max-h-full max-w-full object-contain rounded-lg shadow-md" alt="Vista previa del adjunto" />
               ) : attachmentDraft.type === 'video' ? (
                 <video src={attachmentDraft.previewUrl} className="max-h-full max-w-full rounded-lg shadow-md" controls />
               ) : (
                 <div className="flex flex-col items-center gap-4 p-8 bg-white rounded-2xl shadow-lg border border-slate-200 max-w-sm">
                   <div className="w-20 h-20 bg-blue-100 rounded-2xl flex items-center justify-center">
                     <FileText className="w-10 h-10 text-blue-500" />
                   </div>
                   <div className="text-center">
                     <p className="text-sm font-semibold text-slate-800 break-all">{attachmentDraft.file.name}</p>
                     <p className="text-xs text-slate-400 mt-1">{(attachmentDraft.file.size / 1024 / 1024).toFixed(2)} MB</p>
                   </div>
                 </div>
               )}
             </div>
             {/* Caption + Send */}
             <div className="px-4 py-3 flex items-center gap-3 border-t border-slate-200 bg-white">
               <EmojiPicker
                 onEmojiSelect={(emoji) => {
                   if (captionInputRef.current) {
                     captionInputRef.current.insertAtCaret(emoji)
                   } else {
                     setAttachmentDraft(prev => prev ? { ...prev, caption: prev.caption + emoji } : prev)
                   }
                 }}
                 buttonClassName="p-2 text-slate-500 hover:text-emerald-600 transition"
               />
               <div className="flex-1">
                 <WhatsAppTextInput
                   ref={captionInputRef}
                   value={attachmentDraft.caption}
                   onChange={caption => setAttachmentDraft(prev => {
                     if (!prev) return prev
                     const next = { ...prev, caption }
                     attachmentDraftRef.current = next
                     return next
                   })}
                   placeholder={attachmentDraft.type === 'document' ? 'Agregar descripción...' : 'Agregar pie de foto...'}
                   onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !sendingAttachment) { e.preventDefault(); void handleSendPendingMedia() } }}
                   singleLine
                   disabled={sendingAttachment}
                 />
               </div>
               <button
                 onClick={() => void handleSendPendingMedia()}
                 disabled={sendingAttachment}
                 className="p-3 bg-emerald-600 text-white rounded-full hover:bg-emerald-700 transition shadow-md disabled:opacity-50"
                 aria-label={sendingAttachment ? 'Preparando adjunto' : 'Enviar adjunto'}
               >
                 {sendingAttachment ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
               </button>
             </div>
           </div>
         )}

         {/* Footer / Input */}
         {readOnly ? (
           <div className="px-4 py-3 bg-amber-50 border-t border-amber-200 flex items-center justify-center gap-2 shrink-0">
             <EyeOff className="w-4 h-4 text-amber-600" />
             <span className="text-sm text-amber-700 font-medium">Solo lectura — dispositivo no conectado</span>
           </div>
         ) : (
         <div className="px-3 py-2 bg-slate-50 border-t border-slate-200 flex items-end gap-2 relative z-30 shrink-0">
              {editingMsg && (
                  <div className="absolute bottom-full left-0 right-0 bg-blue-50 p-2 border-t border-blue-400 flex justify-between items-center shadow-sm">
                      <div className="text-xs border-l-4 border-blue-500 pl-2">
                          <p className="font-bold text-blue-700">Editando mensaje</p>
                          <p className="line-clamp-1 text-slate-600">{editingMsg.body}</p>
                      </div>
                      <button onClick={() => { setEditingMsg(null); setMessageText(''); inputRef.current?.clear() }}><X className="w-4 h-4 text-slate-500" /></button>
                  </div>
              )}
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
                      <button className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded-lg transition text-sm text-slate-700" onClick={() => { fileInputRef.current?.click(); setShowAttachments(false) }}>
                          <ImageIcon className="w-5 h-5 text-purple-500" /> Foto/Video
                      </button>
                      <button className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded-lg transition text-sm text-slate-700" onClick={() => { docFileInputRef.current?.click(); setShowAttachments(false) }}>
                          <FileText className="w-5 h-5 text-blue-500" /> Documento
                      </button>
                      <button className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded-lg transition text-sm text-slate-700" onClick={() => { setShowContactPicker(true); setShowAttachments(false) }}>
                          <User className="w-5 h-5 text-emerald-500" /> Contacto
                      </button>
                  </div>
              )}
              <input type="file" ref={fileInputRef} className="hidden" accept="image/*,video/*" onChange={e => handleFileSelect(e, 'media')} />
              <input type="file" ref={docFileInputRef} className="hidden" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.rar" onChange={e => handleFileSelect(e, 'document')} />

              <div className="flex gap-1 pb-1">
                  <button onClick={() => setShowAttachments(!showAttachments)} className="p-2 text-slate-500 hover:text-emerald-600 transition">
                      <Paperclip className="w-6 h-6" />
                  </button>
                  <EmojiPicker
                    onEmojiSelect={(emoji) => inputRef.current?.insertAtCaret(emoji)}
                    isOpen={activePopup === 'emoji'}
                    onToggle={() => setActivePopup(activePopup === 'emoji' ? null : 'emoji')}
                    buttonClassName={`p-2 transition ${activePopup === 'emoji' ? 'text-emerald-600' : 'text-slate-500 hover:text-emerald-600'}`}
                  />
                  <StickerPicker
                      onStickerSelect={handleSendSticker}
                      isOpen={activePopup === 'sticker'}
                      onToggle={() => setActivePopup(activePopup === 'sticker' ? null : 'sticker')}
                  />
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
                      onPasteFiles={files => beginAttachmentDraft(files)}
                      singleLine
                    />
              </div>

              {(messageText || forwardingMsg) && (
                  <button
                    onClick={handleSendMessage}
                    disabled={sendingMessage}
                    className="p-3 bg-emerald-600 text-white rounded-full hover:bg-emerald-700 disabled:opacity-50 transition shadow-md"
                  >
                      <Send className="w-5 h-5" />
                  </button>
              )}
         </div>
         )}

         {/* Image Viewer */}
         {viewImage && (
             <ImageViewer src={viewImage} isOpen={!!viewImage} onClose={() => setViewImage(null)} />
         )}

         {/* Forward Modal */}
         {forwardingMsg && chat && deviceId && (
             <ForwardMessageModal
               message={forwardingMsg}
               deviceId={deviceId}
               chatId={chat.id}
               onClose={() => setForwardingMsg(null)}
               onSuccess={() => setForwardingMsg(null)}
             />
         )}

         {/* Contact Picker for sending contact vCard */}
         <ContactSelector
           open={showContactPicker}
           onClose={() => setShowContactPicker(false)}
           onConfirm={handleSendContact}
           title="Enviar Contacto"
           subtitle="Selecciona los contactos que deseas enviar"
           confirmLabel="Enviar"
         />
    </div>
  )
}
