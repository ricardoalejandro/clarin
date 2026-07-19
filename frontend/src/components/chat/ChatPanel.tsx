'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  Send, Paperclip, MoreVertical, Search, Phone, Video,
  ArrowLeft, Smile, Image as ImageIcon, FileText, X,
  Mic, Trash2, Reply, Check, CheckCheck, Download,
  CornerUpRight, Play, Pause, AlertCircle, User, EyeOff, RefreshCw,
  ChevronUp, ChevronDown, PanelRight, Camera, Copy, Info, Keyboard,
} from 'lucide-react'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { Chat, Device, Message } from '@/types/chat'
import { subscribeWebSocket } from '@/lib/api'
import { getChatDisplayName } from '@/utils/chat'
import WhatsAppTextInput, { WhatsAppTextInputHandle } from '../WhatsAppTextInput'
import ImageViewer from './ImageViewer'
import MessageBubble from './MessageBubble'
import StickerPicker from './StickerPicker'
import EmojiPicker from './EmojiPicker'
import ContactPanel from './ContactPanel'
import ForwardMessageModal from './ForwardMessageModal'
import MessageInfoDialog from './MessageInfoDialog'
import QuickReplyPicker from './QuickReplyPicker'
import MobileComposerAccessory, { MobileComposerAccessoryTab } from './MobileComposerAccessory'
import { useChatMobileChrome } from './ChatMobileChromeContext'
import ContactSelector, { SelectedPerson } from '../ContactSelector'
import { compressImageStandard } from '@/utils/imageCompression'
import { applyReactionMutation, dedupeReactions, hasOwnReaction, SELF_REACTION_ACTOR } from '@/utils/chatReactions'
import { ChatMediaType, validateChatAttachment } from '@/utils/chatAttachments'
import { chatMediaIdentity } from '@/utils/chatMediaUrl'
import { useContainerWidth } from '../responsive/useContainerWidth'

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
  quotedMessageId?: string
  quotedBody?: string
  quotedSender?: string
  quotedIsFromMe?: boolean
}

type ComposerFeedback = {
  kind: 'error' | 'info'
  message: string
}

type StickerListResponse = {
  success?: boolean
  stickers?: unknown
  error?: string
}

function normalizeStickerUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(
    value
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map(chatMediaIdentity),
  ))
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
  const optimisticMessage = messages.find(message => message.id === tempId)
  const normalizedMessage: Message = {
    ...realMessage,
    is_from_me: true,
    quoted_message_id: realMessage.quoted_message_id || optimisticMessage?.quoted_message_id,
    quoted_body: realMessage.quoted_body || optimisticMessage?.quoted_body,
    quoted_sender: realMessage.quoted_sender || optimisticMessage?.quoted_sender,
    quoted_is_from_me: realMessage.quoted_is_from_me ?? optimisticMessage?.quoted_is_from_me,
  }
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

function mergeFetchedMessages(current: Message[], fetched: Message[]): Message[] {
  const merged = [...fetched]
  for (const message of current) {
    const index = merged.findIndex(candidate => hasSameMessageIdentity(candidate, message))
    if (index >= 0) {
      // Preserve live-only state (optimistic status, reactions, local media
      // preview) while accepting any fields newly returned by the server.
      merged[index] = { ...merged[index], ...message }
    } else {
      merged.push(message)
    }
  }
  return merged.sort((left, right) => {
    const timestampDelta = new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
    return timestampDelta || left.id.localeCompare(right.id)
  })
}

function useStableCallback<T extends (...args: any[]) => any>(callback: T): T {
  const callbackRef = useRef(callback)
  callbackRef.current = callback
  return useCallback(((...args: Parameters<T>) => callbackRef.current(...args)) as T, [])
}

interface ChatPanelProps {
  chatId: string | null
  deviceId?: string
  device?: Device
  initialChat?: Chat
  onClose?: () => void
  className?: string
  readOnly?: boolean
  onContactInfoToggle?: (show: boolean) => void
  contactInfoOpen?: boolean
  onRequestDelete?: () => void
  isActive?: boolean
}

export default function ChatPanel({ chatId, deviceId, device, initialChat, onClose, className = '', readOnly = false, onContactInfoToggle, contactInfoOpen, onRequestDelete, isActive = true }: ChatPanelProps) {
  const { ref: panelRef, width: panelWidth } = useContainerWidth<HTMLDivElement>()
  const { setComposerAccessoryOpen } = useChatMobileChrome()
  const compactActions = panelWidth > 0 && panelWidth < 640
  const deviceProvider = device?.provider || 'whatsapp_web'
  const deviceUnavailable = Boolean(device && (device.status !== 'connected' || deviceProvider !== 'whatsapp_web'))
  const effectiveReadOnly = readOnly || !deviceId || deviceUnavailable
  const canSendStickers = !effectiveReadOnly && (
    device ? device.runtime_capabilities?.can_send_sticker === true : true
  )
  const readOnlyReason = !deviceId
    ? 'Esta conversación no tiene un dispositivo asociado.'
    : deviceProvider === 'whatsapp_cloud_api'
      ? 'Este chat usa Cloud API y no admite acciones manuales desde esta vista.'
      : device && device.status !== 'connected'
        ? 'El dispositivo de WhatsApp no está conectado.'
        : 'El dispositivo no está disponible para enviar mensajes.'
  const [chat, setChat] = useState<Chat | null>(initialChat || null)
  const [messages, setMessages] = useState<Message[]>([])
  const messagesCacheRef = useRef<Map<string, CachedChatMessages>>(new Map())
  const isNearBottomRef = useRef(true)
  const [isFollowingLatest, setIsFollowingLatest] = useState(true)
  const [pendingLatestMessages, setPendingLatestMessages] = useState(0)
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
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const [showContactPicker, setShowContactPicker] = useState(false)

  // Media preview with caption
  const [attachmentDraft, setAttachmentDraft] = useState<AttachmentDraft | null>(null)
  const [sendingAttachment, setSendingAttachment] = useState(false)
  const [composerFeedback, setComposerFeedback] = useState<ComposerFeedback | null>(null)

  // Sticker favorites are account-scoped and come exclusively from the API.
  const [savedStickers, setSavedStickers] = useState<string[]>([])
  const [savedStickersLoading, setSavedStickersLoading] = useState(false)
  const [savedStickersError, setSavedStickersError] = useState<string | null>(null)
  const [savingStickerUrls, setSavingStickerUrls] = useState<Set<string>>(() => new Set())

  // Modals & Viewers
  const [viewImage, setViewImage] = useState<string | null>(null)
  const [activePopup, setActivePopup] = useState<'emoji' | 'sticker' | null>(null)
  const [mobileAccessoryReady, setMobileAccessoryReady] = useState(false)
  const [mobileAccessoryHeight, setMobileAccessoryHeight] = useState(280)
  const accessoryHistoryActiveRef = useRef(false)
  const closedAccessoryHistoryActiveRef = useRef(false)
  const restoreKeyboardAfterCloseRef = useRef(false)

  // Panels
  const [showContactInfoLocal, setShowContactInfoLocal] = useState(false)
  const showContactInfo = contactInfoOpen !== undefined ? contactInfoOpen : showContactInfoLocal
  const setShowContactInfo = (show: boolean) => {
    if (onContactInfoToggle) onContactInfoToggle(show)
    else setShowContactInfoLocal(show)
  }
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResult, setSearchResult] = useState<Message | null>(null)
  const [searchResultIndex, setSearchResultIndex] = useState(0)
  const [searchTotal, setSearchTotal] = useState(0)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [activeSearchMessageId, setActiveSearchMessageId] = useState('')
  const [searchWindowMessages, setSearchWindowMessages] = useState<Message[] | null>(null)
  const [quotedContextActive, setQuotedContextActive] = useState(false)
  const [quoteNavigationLoading, setQuoteNavigationLoading] = useState(false)
  const [showHeaderMenu, setShowHeaderMenu] = useState(false)
  const headerMenuTriggerRef = useRef<HTMLButtonElement>(null)

  // Compact message selection
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null)
  const selectedMessageRef = useRef<Message | null>(null)
  const selectionHistoryActiveRef = useRef(false)
  const [showSelectionMenu, setShowSelectionMenu] = useState(false)
  const [messageActionPending, setMessageActionPending] = useState<'delete' | null>(null)
  const [infoMessage, setInfoMessage] = useState<Message | null>(null)

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
  const [historySyncFeedback, setHistorySyncFeedback] = useState<ComposerFeedback | null>(null)

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
  const searchRequestRef = useRef<AbortController | null>(null)
  const quoteContextRequestRef = useRef<AbortController | null>(null)
  const chatDetailsRequestRef = useRef<AbortController | null>(null)
  const chatDetailsRequestSequenceRef = useRef(0)
  const searchSessionRef = useRef(0)
  const searchRequestSequenceRef = useRef(0)
  const searchOpenRef = useRef(false)
  const inputRef = useRef<WhatsAppTextInputHandle>(null)
  const captionInputRef = useRef<WhatsAppTextInputHandle>(null)
  const optimisticIdRef = useRef(0)
  const previousChatIdRef = useRef<string | null>(chatId)
  const activeChatIdRef = useRef<string | null>(chatId)
  const attachmentDraftRef = useRef<AttachmentDraft | null>(attachmentDraft)
  const attachmentSendingRef = useRef(false)
  const mediaRetryRef = useRef<Map<string, RetryableMedia>>(new Map())
  const reactionRequestSeqRef = useRef<Map<string, number>>(new Map())
  const savedStickersRef = useRef<string[]>([])
  const savedStickersRequestRef = useRef<AbortController | null>(null)
  const savingStickerUrlsRef = useRef<Set<string>>(new Set())
  const historySyncTimeoutRef = useRef<number | null>(null)

  const removeAccessoryHistoryMarker = useCallback((consumeHistory: boolean) => {
    if (typeof window === 'undefined' || !accessoryHistoryActiveRef.current) return
    accessoryHistoryActiveRef.current = false
    const state = window.history.state
    if (!state?.__clarinComposerAccessory) return
    if (consumeHistory) {
      window.history.back()
      return
    }
    const { __clarinComposerAccessory: _accessoryMarker, ...rest } = state
    window.history.replaceState({ ...rest, __clarinComposerAccessoryClosed: true }, '')
    closedAccessoryHistoryActiveRef.current = true
  }, [])

  const focusMessageComposer = useCallback(() => {
    const editor = panelRef.current?.querySelector<HTMLElement>('[data-chat-keyboard-target="true"]')
    editor?.focus({ preventScroll: true })
    inputRef.current?.focus()
  }, [panelRef])

  const closeMobileAccessory = useCallback((options?: { restoreKeyboard?: boolean; consumeHistory?: boolean }) => {
    const restoreKeyboard = options?.restoreKeyboard === true
    restoreKeyboardAfterCloseRef.current = restoreKeyboard
    setActivePopup(null)
    setMobileAccessoryReady(false)
    removeAccessoryHistoryMarker(options?.consumeHistory !== false)
    if (restoreKeyboard) {
      focusMessageComposer()
      requestAnimationFrame(focusMessageComposer)
    }
  }, [focusMessageComposer, removeAccessoryHistoryMarker])

  const openMobileAccessory = useCallback((tab: MobileComposerAccessoryTab) => {
    if (!compactActions) {
      setActivePopup(tab)
      return
    }

    const viewport = window.visualViewport
    const fullHeight = window.innerHeight
    const keyboardInset = Math.max(0, fullHeight - (viewport?.height || fullHeight) - (viewport?.offsetTop || 0))
    const minimum = Math.min(260, fullHeight * 0.42)
    const maximum = Math.min(360, fullHeight * 0.56)
    const preferred = keyboardInset > 120 ? keyboardInset : fullHeight * 0.38
    setMobileAccessoryHeight(Math.round(Math.max(minimum, Math.min(preferred, maximum))))
    if (activePopup === null) setMobileAccessoryReady(false)

    inputRef.current?.blur()
    setShowAttachments(false)
    setShowQuickReply(false)
    setQuickReplyFilter('')

    const currentState = typeof window.history.state === 'object' && window.history.state ? window.history.state : {}
    if (closedAccessoryHistoryActiveRef.current || currentState.__clarinComposerAccessoryClosed) {
      const { __clarinComposerAccessoryClosed: _closedAccessoryMarker, ...rest } = currentState
      window.history.replaceState({ ...rest, __clarinComposerAccessory: true }, '')
      closedAccessoryHistoryActiveRef.current = false
      accessoryHistoryActiveRef.current = true
    } else if (!accessoryHistoryActiveRef.current) {
      window.history.pushState({ ...currentState, __clarinComposerAccessory: true }, '')
      accessoryHistoryActiveRef.current = true
    }
    setActivePopup(tab)
  }, [activePopup, compactActions])

  useEffect(() => {
    const accessoryOpen = compactActions && activePopup !== null
    setComposerAccessoryOpen(accessoryOpen)
    if (!accessoryOpen && accessoryHistoryActiveRef.current) {
      if (!compactActions) {
        setActivePopup(null)
        setMobileAccessoryReady(false)
      }
      removeAccessoryHistoryMarker(false)
    }
  }, [activePopup, compactActions, removeAccessoryHistoryMarker, setComposerAccessoryOpen])

  useEffect(() => {
    if (activePopup !== null || !restoreKeyboardAfterCloseRef.current) return
    restoreKeyboardAfterCloseRef.current = false
    focusMessageComposer()
    requestAnimationFrame(focusMessageComposer)
    const shortTimer = window.setTimeout(focusMessageComposer, 80)
    const settledTimer = window.setTimeout(focusMessageComposer, 240)
    return () => {
      window.clearTimeout(shortTimer)
      window.clearTimeout(settledTimer)
    }
  }, [activePopup, focusMessageComposer])

  useEffect(() => () => {
    setComposerAccessoryOpen(false)
    removeAccessoryHistoryMarker(false)
  }, [removeAccessoryHistoryMarker, setComposerAccessoryOpen])

  useEffect(() => {
    closedAccessoryHistoryActiveRef.current = Boolean(window.history.state?.__clarinComposerAccessoryClosed)
  }, [])

  useEffect(() => {
    if (!compactActions || activePopup === null) {
      setMobileAccessoryReady(false)
      return
    }

    const viewport = window.visualViewport
    let frame = 0
    const markReadyWhenKeyboardCloses = () => {
      if (frame) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const visibleHeight = viewport?.height || window.innerHeight
        const keyboardInset = Math.max(0, window.innerHeight - visibleHeight - (viewport?.offsetTop || 0))
        if (keyboardInset < 96) setMobileAccessoryReady(true)
      })
    }
    const fallback = window.setTimeout(() => setMobileAccessoryReady(true), 350)
    viewport?.addEventListener('resize', markReadyWhenKeyboardCloses, { passive: true })
    viewport?.addEventListener('scroll', markReadyWhenKeyboardCloses, { passive: true })
    markReadyWhenKeyboardCloses()
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.clearTimeout(fallback)
      viewport?.removeEventListener('resize', markReadyWhenKeyboardCloses)
      viewport?.removeEventListener('scroll', markReadyWhenKeyboardCloses)
    }
  }, [activePopup, compactActions])

  const closeSearch = useCallback(() => {
    searchSessionRef.current += 1
    searchOpenRef.current = false
    searchRequestRef.current?.abort()
    searchRequestRef.current = null
    setShowSearch(false)
    setSearchQuery('')
    setSearchResult(null)
    setSearchResultIndex(0)
    setSearchTotal(0)
    setSearchLoading(false)
    setSearchError('')
    setActiveSearchMessageId('')
    setSearchWindowMessages(null)
    setQuotedContextActive(false)
  }, [])

  const openSearch = useCallback(() => {
    if (searchOpenRef.current) {
      setShowSearch(true)
      return
    }
    searchSessionRef.current += 1
    searchOpenRef.current = true
    setShowSearch(true)
  }, [])

  const toggleSearch = useCallback(() => {
    if (searchOpenRef.current) closeSearch()
    else openSearch()
  }, [closeSearch, openSearch])

  const clearMessageSelection = useCallback((consumeHistory = true) => {
    selectedMessageRef.current = null
    setSelectedMessage(null)
    setShowSelectionMenu(false)
    if (typeof window === 'undefined' || !selectionHistoryActiveRef.current) return
    selectionHistoryActiveRef.current = false
    const state = window.history.state
    if (!state?.__clarinMessageSelection) return
    if (consumeHistory) {
      window.history.back()
      return
    }
    const { __clarinMessageSelection: _selectionMarker, ...rest } = state
    window.history.replaceState(rest, '')
  }, [])

  const selectMessage = useCallback((message: Message) => {
    if (!compactActions || message.is_revoked || message.id.startsWith('optimistic-')) return
    if (!selectionHistoryActiveRef.current && typeof window !== 'undefined') {
      const currentState = typeof window.history.state === 'object' && window.history.state ? window.history.state : {}
      window.history.pushState({ ...currentState, __clarinMessageSelection: true }, '')
      selectionHistoryActiveRef.current = true
    }
    selectedMessageRef.current = message
    setSelectedMessage(message)
    setShowSelectionMenu(false)
    setShowHeaderMenu(false)
    setShowAttachments(false)
    setActivePopup(null)
  }, [compactActions])

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (accessoryHistoryActiveRef.current) {
        accessoryHistoryActiveRef.current = false
        closedAccessoryHistoryActiveRef.current = false
        setActivePopup(null)
        setMobileAccessoryReady(false)
        return
      }
      if (closedAccessoryHistoryActiveRef.current) {
        closedAccessoryHistoryActiveRef.current = false
        window.setTimeout(() => window.history.back(), 0)
        return
      }
      if (!selectionHistoryActiveRef.current || event.state?.__clarinMessageSelection) return
      selectionHistoryActiveRef.current = false
      selectedMessageRef.current = null
      setSelectedMessage(null)
      setShowSelectionMenu(false)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    if (compactActions) return
    clearMessageSelection(false)
  }, [clearMessageSelection, compactActions])

  useEffect(() => {
    const current = selectedMessageRef.current
    if (!current) return
    const latest = (searchWindowMessages || messages).find(message => hasSameMessageIdentity(message, current))
    if (!latest) return
    if (latest.is_revoked) {
      clearMessageSelection()
      return
    }
    if (latest !== current) {
      selectedMessageRef.current = latest
      setSelectedMessage(latest)
    }
  }, [clearMessageSelection, messages, searchWindowMessages])

  useEffect(() => {
    clearMessageSelection(false)
    setInfoMessage(null)
  }, [chatId, clearMessageSelection])

  useEffect(() => {
    if (isActive) return
    closeSearch()
    setShowHeaderMenu(false)
    setShowAttachments(false)
    setActivePopup(null)
    setShowQuickReply(false)
    setQuickReplyFilter('')
    setShowContactPicker(false)
    setViewImage(null)
    setForwardingMsg(null)
    clearMessageSelection(false)
    setInfoMessage(null)
  }, [clearMessageSelection, closeSearch, isActive])

  const scrollMessageIntoView = useCallback((messageIdentity: string) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const container = messagesContainerRef.current
      const element = container
        ? Array.from(container.querySelectorAll<HTMLElement>('[data-chat-message-id]')).find(item => (
            item.dataset.chatMessageId === messageIdentity || item.dataset.whatsappMessageId === messageIdentity
          ))
        : undefined
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }))
  }, [])

  const revealSearchMessage = useCallback(async (message: Message, historyOffset: number, controller: AbortController, session: number, requestSequence: number) => {
    const isCurrentSearch = () => (
      searchOpenRef.current
      && searchSessionRef.current === session
      && searchRequestSequenceRef.current === requestSequence
      && searchRequestRef.current === controller
      && !controller.signal.aborted
    )
    const canScrollToResult = () => (
      searchOpenRef.current
      && searchSessionRef.current === session
      && searchRequestSequenceRef.current === requestSequence
      && !controller.signal.aborted
    )
    if (!isCurrentSearch()) return
    setActiveSearchMessageId(message.id)
    const canonicalMessages = chatId ? messagesCacheRef.current.get(chatId)?.messages || [] : []
    if (canonicalMessages.some(item => item.id === message.id)) {
      setSearchWindowMessages(null)
    } else if (chatId && historyOffset >= 0) {
      const token = localStorage.getItem('token')
      const windowOffset = Math.max(0, historyOffset - 25)
      const response = await fetch(`/api/chats/${chatId}/messages?limit=50&offset=${windowOffset}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      const data = await response.json().catch(() => ({}))
      if (!isCurrentSearch()) return
      if (!response.ok || !data.success || !Array.isArray(data.messages)) throw new Error(data.error || 'No se pudo abrir el mensaje encontrado')
      setSearchWindowMessages(data.messages)
    } else {
      // A safe fallback still exposes the matching message without contaminating
      // the paginated conversation cache or its next offset.
      setSearchWindowMessages([message])
    }
    requestAnimationFrame(() => {
      if (canScrollToResult()) scrollMessageIntoView(message.id)
    })
  }, [chatId, scrollMessageIntoView])

  const revealQuotedMessage = useCallback(async (quotedMessageId: string) => {
    if (!chatId || !quotedMessageId) return
    quoteContextRequestRef.current?.abort()
    const controller = new AbortController()
    quoteContextRequestRef.current = controller
    const targetChatId = chatId
    setQuoteNavigationLoading(true)
    setComposerFeedback(null)

    const canonicalMessages = messagesCacheRef.current.get(targetChatId)?.messages || []
    const loadedMessage = canonicalMessages.find(item => item.id === quotedMessageId || item.message_id === quotedMessageId)
    if (loadedMessage) {
      quoteContextRequestRef.current = null
      setSearchWindowMessages(null)
      setQuotedContextActive(false)
      setActiveSearchMessageId(loadedMessage.id)
      setQuoteNavigationLoading(false)
      scrollMessageIntoView(loadedMessage.id)
      window.setTimeout(() => setActiveSearchMessageId(current => current === loadedMessage.id ? '' : current), 2200)
      return
    }

    try {
      const token = localStorage.getItem('token')
      const response = await fetch(`/api/chats/${targetChatId}/messages/${encodeURIComponent(quotedMessageId)}/context?limit=50`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      const data = await response.json().catch(() => ({}))
      if (controller.signal.aborted || activeChatIdRef.current !== targetChatId) return
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo abrir el mensaje respondido.')
      const contextMessages = Array.isArray(data.messages)
        ? data.messages as Message[]
        : Array.isArray(data.context?.messages)
          ? data.context.messages as Message[]
          : data.message
            ? [data.message as Message]
            : []
      const targetMessage = contextMessages.find(item => item.id === quotedMessageId || item.message_id === quotedMessageId)
        || (data.message as Message | undefined)
      if (contextMessages.length === 0 || !targetMessage) throw new Error('WhatsApp no devolvió el mensaje original.')
      setSearchWindowMessages(contextMessages)
      setQuotedContextActive(true)
      setActiveSearchMessageId(targetMessage.id)
      scrollMessageIntoView(targetMessage.id)
    } catch (error) {
      if ((error as Error).name !== 'AbortError' && activeChatIdRef.current === targetChatId) {
        setComposerFeedback({ kind: 'error', message: error instanceof Error ? error.message : 'No se pudo abrir el mensaje respondido.' })
      }
    } finally {
      if (quoteContextRequestRef.current === controller) quoteContextRequestRef.current = null
      if (!controller.signal.aborted && activeChatIdRef.current === targetChatId) setQuoteNavigationLoading(false)
    }
  }, [chatId, scrollMessageIntoView])

  const fetchSearchResult = useCallback(async (query: string, index: number) => {
    if (!chatId || query.length < 2 || !searchOpenRef.current) return
    searchRequestRef.current?.abort()
    const controller = new AbortController()
    const session = searchSessionRef.current
    const requestSequence = ++searchRequestSequenceRef.current
    searchRequestRef.current = controller
    const isCurrentSearch = () => (
      searchOpenRef.current
      && searchSessionRef.current === session
      && searchRequestSequenceRef.current === requestSequence
      && searchRequestRef.current === controller
      && !controller.signal.aborted
    )
    setSearchLoading(true)
    setSearchError('')
    try {
      const token = localStorage.getItem('token')
      const params = new URLSearchParams({ q: query, limit: '1', offset: String(index) })
      const response = await fetch(`/api/chats/${chatId}/messages/search?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      const data = await response.json().catch(() => ({}))
      if (!isCurrentSearch()) return
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo buscar en la conversación')
      const total = Number(data.total) || 0
      const result = Array.isArray(data.messages) ? data.messages[0] as Message | undefined : undefined
      setSearchTotal(total)
      setSearchResultIndex(total > 0 ? Math.min(index, total - 1) : 0)
      setSearchResult(result || null)
      if (result) await revealSearchMessage(result, Number(data.history_offset), controller, session, requestSequence)
      else setActiveSearchMessageId('')
    } catch (error) {
      if ((error as Error).name !== 'AbortError' && isCurrentSearch()) {
        setSearchError((error as Error).message)
        setSearchResult(null)
        setSearchTotal(0)
        setActiveSearchMessageId('')
      }
    } finally {
      if (searchRequestRef.current === controller) {
        searchRequestRef.current = null
        if (searchOpenRef.current && searchSessionRef.current === session) setSearchLoading(false)
      }
    }
  }, [chatId, revealSearchMessage])

  useEffect(() => {
    if (!showSearch) return
    searchRequestSequenceRef.current += 1
    searchRequestRef.current?.abort()
    searchRequestRef.current = null
    setSearchLoading(false)
    const query = searchQuery.trim()
    if (query.length < 2) {
      setSearchResult(null)
      setSearchTotal(0)
      setSearchError('')
      setActiveSearchMessageId('')
      setSearchWindowMessages(null)
      return
    }
    setSearchLoading(true)
    const timer = window.setTimeout(() => void fetchSearchResult(query, 0), 300)
    return () => window.clearTimeout(timer)
  }, [fetchSearchResult, searchQuery, showSearch])

  useEffect(() => {
    quoteContextRequestRef.current?.abort()
    quoteContextRequestRef.current = null
    setQuoteNavigationLoading(false)
    closeSearch()
    setShowHeaderMenu(false)
  }, [chatId, closeSearch])

  useEffect(() => {
    if (!showSearch) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeSearch()
    }
    window.addEventListener('keydown', handleEscape, true)
    return () => window.removeEventListener('keydown', handleEscape, true)
  }, [closeSearch, showSearch])

  useEffect(() => () => {
    searchRequestRef.current?.abort()
    quoteContextRequestRef.current?.abort()
    if (historySyncTimeoutRef.current) window.clearTimeout(historySyncTimeoutRef.current)
  }, [])

  useEffect(() => {
    if (!showHeaderMenu) return
    const close = () => setShowHeaderMenu(false)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
        requestAnimationFrame(() => headerMenuTriggerRef.current?.focus())
      }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [showHeaderMenu])

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

  const loadSavedStickers = useCallback(async () => {
    if (savingStickerUrlsRef.current.size > 0) return

    savedStickersRequestRef.current?.abort()
    const controller = new AbortController()
    savedStickersRequestRef.current = controller
    setSavedStickersLoading(true)
    setSavedStickersError(null)

    try {
      const token = localStorage.getItem('token')
      const response = await fetch('/api/stickers/saved', {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      const data = await response.json().catch(() => ({})) as StickerListResponse
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'No se pudieron cargar los stickers favoritos.')
      }
      const nextStickers = normalizeStickerUrls(data.stickers)
      savedStickersRef.current = nextStickers
      setSavedStickers(nextStickers)
    } catch (error) {
      if (controller.signal.aborted) return
      setSavedStickersError(error instanceof Error ? error.message : 'No se pudieron cargar los stickers favoritos.')
    } finally {
      if (savedStickersRequestRef.current === controller) {
        savedStickersRequestRef.current = null
        setSavedStickersLoading(false)
      }
    }
  }, [])

  const handleToggleSavedSticker = useCallback(async (url: string) => {
    if (!url) return
    const identity = chatMediaIdentity(url)
    if (savingStickerUrlsRef.current.has(identity)) return

    const wasSaved = savedStickersRef.current.includes(identity)
    const nextStickers = wasSaved
      ? savedStickersRef.current.filter(item => item !== identity)
      : [identity, ...savedStickersRef.current]

    savedStickersRef.current = nextStickers
    setSavedStickers(nextStickers)
    savingStickerUrlsRef.current = new Set(savingStickerUrlsRef.current).add(identity)
    setSavingStickerUrls(new Set(savingStickerUrlsRef.current))
    setSavedStickersError(null)

    try {
      const token = localStorage.getItem('token')
      const response = await fetch('/api/stickers/saved', {
        method: wasSaved ? 'DELETE' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_url: url }),
      })
      const data = await response.json().catch(() => ({})) as { success?: boolean; error?: string; media_url?: string }
      if (!response.ok || !data.success) {
        throw new Error(data.error || (wasSaved ? 'No se pudo quitar el sticker.' : 'No se pudo guardar el sticker.'))
      }
      setComposerFeedback({
        kind: 'info',
        message: wasSaved ? 'Sticker quitado de favoritos.' : 'Sticker guardado en favoritos.',
      })
    } catch (error) {
      const rolledBack = wasSaved
        ? [identity, ...savedStickersRef.current.filter(item => item !== identity)]
        : savedStickersRef.current.filter(item => item !== identity)
      savedStickersRef.current = rolledBack
      setSavedStickers(rolledBack)
      setComposerFeedback({
        kind: 'error',
        message: error instanceof Error ? error.message : 'No se pudo actualizar el sticker favorito.',
      })
    } finally {
      const nextPending = new Set(savingStickerUrlsRef.current)
      nextPending.delete(identity)
      savingStickerUrlsRef.current = nextPending
      setSavingStickerUrls(new Set(nextPending))
    }
  }, [])

  useEffect(() => {
    attachmentDraftRef.current = attachmentDraft
  }, [attachmentDraft])

  useEffect(() => {
    if (!effectiveReadOnly) return
    setActivePopup(null)
    setShowAttachments(false)
    setShowContactPicker(false)
    setReplyingTo(null)
    setEditingMsg(null)
    if (!attachmentSendingRef.current && attachmentDraftRef.current) {
      if (attachmentDraftRef.current.previewUrl) URL.revokeObjectURL(attachmentDraftRef.current.previewUrl)
      attachmentDraftRef.current = null
      setAttachmentDraft(null)
    }
  }, [effectiveReadOnly])

  useEffect(() => {
    void loadSavedStickers()
  }, [loadSavedStickers])

  useEffect(() => {
    if (!composerFeedback) return
    const timer = window.setTimeout(() => setComposerFeedback(null), 6000)
    return () => window.clearTimeout(timer)
  }, [composerFeedback])

  useEffect(() => () => {
    savedStickersRequestRef.current?.abort()
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
    if (!chatId || syncingHistory || effectiveReadOnly) return
    setSyncingHistory(true)
    setHistorySyncFeedback({ kind: 'info', message: 'Solicitando a WhatsApp los mensajes anteriores…' })
    if (historySyncTimeoutRef.current) window.clearTimeout(historySyncTimeoutRef.current)
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(`/api/chats/${chatId}/sync-history`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'No se pudo solicitar el historial.')
      }
      setHistorySyncFeedback({ kind: 'info', message: data.message || 'Solicitud enviada. WhatsApp avisará cuando termine.' })
      historySyncTimeoutRef.current = window.setTimeout(() => {
        setSyncingHistory(false)
        setHistorySyncFeedback({ kind: 'info', message: 'La recuperación continúa en WhatsApp. Puedes seguir usando el chat.' })
        historySyncTimeoutRef.current = null
      }, 20000)
    } catch (err) {
      console.error('[HistorySync]', err)
      setSyncingHistory(false)
      setHistorySyncFeedback({ kind: 'error', message: err instanceof Error ? err.message : 'No se pudo solicitar el historial.' })
    }
  }, [chatId, effectiveReadOnly, syncingHistory])

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
    chatDetailsRequestRef.current?.abort()
    chatDetailsRequestSequenceRef.current += 1
    if (historySyncTimeoutRef.current) {
      window.clearTimeout(historySyncTimeoutRef.current)
      historySyncTimeoutRef.current = null
    }
    setSyncingHistory(false)
    setHistorySyncFeedback(null)
    isNearBottomRef.current = true
    setIsFollowingLatest(true)
    setPendingLatestMessages(0)
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
	return () => chatDetailsRequestRef.current?.abort()
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
            const actualMessage = actualMsg as Message
            const shouldFollowMessage = isNearBottomRef.current
            const alreadyKnown = (messagesCacheRef.current.get(chatId)?.messages || []).some(message => hasSameMessageIdentity(message, actualMessage))
            updateMessages(prev => {
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
            if (shouldFollowMessage) scrollToBottom()
            else if (!alreadyKnown) setPendingLatestMessages(current => current + 1)
          }
        } else if ((eventType === 'message_update') && payload) {
          const actualMsg = payload.message || payload
          updateMessages(prev => prev.map(m => m.id === actualMsg.id ? (actualMsg as Message) : m))
        } else if (eventType === 'message_status' && payload) {
          // Update message delivery/read status (only upgrade, never downgrade)
          const msgIds: string[] = payload.message_ids || []
          const newStatus: string = payload.status
          const receiptTimestamp = typeof payload.timestamp === 'string' ? payload.timestamp : undefined
          const statusOrder: Record<string, number> = { sending: 0, sent: 1, delivered: 2, read: 3 }
          const newLevel = statusOrder[newStatus] ?? -1
          if (chat && payload.chat_jid === chat.jid && msgIds.length > 0 && newLevel >= 0) {
            updateMessages(prev => prev.map(m => {
              if (!msgIds.includes(m.message_id)) return m
              const currentLevel = statusOrder[m.status] ?? -1
              const next: Message = newLevel > currentLevel ? { ...m, status: newStatus } : { ...m }
              if (newStatus === 'delivered' && receiptTimestamp && !next.delivered_at) next.delivered_at = receiptTimestamp
              if (newStatus === 'read' && receiptTimestamp && !next.read_at) next.read_at = receiptTimestamp
              return next
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
          const belongsToChat = payload.chat_id ? payload.chat_id === chatId : payload.device_id === deviceId
          if (!belongsToChat) return
          const finished = payload.finished !== false
          if (historySyncTimeoutRef.current) {
            window.clearTimeout(historySyncTimeoutRef.current)
            historySyncTimeoutRef.current = null
          }
          if (!finished) {
            historySyncTimeoutRef.current = window.setTimeout(() => {
              setSyncingHistory(false)
              setHistorySyncFeedback({ kind: 'info', message: 'WhatsApp continúa procesando la recuperación. Puedes seguir usando el chat.' })
              historySyncTimeoutRef.current = null
            }, 30000)
          }
          setSyncingHistory(!finished)
          const saved = Number(payload.messages_saved ?? payload.saved ?? 0)
          if (payload.error) {
            setHistorySyncFeedback({ kind: 'error', message: String(payload.error) })
          } else if (!finished) {
            setHistorySyncFeedback({ kind: 'info', message: `Se recuperaron ${saved} mensaje${saved === 1 ? '' : 's'}; WhatsApp continúa buscando mensajes anteriores…` })
            fetchChatDetails()
          } else if (saved > 0) {
            setHistorySyncFeedback({ kind: 'info', message: `Se recuperaron ${saved} mensaje${saved === 1 ? '' : 's'} anterior${saved === 1 ? '' : 'es'}.` })
            fetchChatDetails()
          } else {
            setHistorySyncFeedback({ kind: 'info', message: 'No se encontraron mensajes anteriores nuevos.' })
          }
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
	chatDetailsRequestRef.current?.abort()
	const controller = new AbortController()
	chatDetailsRequestRef.current = controller
	const requestSequence = ++chatDetailsRequestSequenceRef.current
    const hasCachedMessages = messagesCacheRef.current.has(targetChatId)
    setLoading(!hasCachedMessages)
    const token = localStorage.getItem('token')
    try {
      const res = await fetch(`/api/chats/${targetChatId}`, {
        headers: { Authorization: `Bearer ${token}` },
		signal: controller.signal,
      })
      const data = await res.json()
	  if (controller.signal.aborted || requestSequence !== chatDetailsRequestSequenceRef.current || activeChatIdRef.current !== targetChatId) return
      if (data.success) {
        setChat(data.chat)
      }

      // Fetch messages from dedicated endpoint
      const msgRes = await fetch(`/api/chats/${targetChatId}/messages?limit=50`, {
		headers: { Authorization: `Bearer ${token}` },
		signal: controller.signal,
      })
      const msgData = await msgRes.json()
	  if (controller.signal.aborted || requestSequence !== chatDetailsRequestSequenceRef.current || activeChatIdRef.current !== targetChatId) return
      if (msgData.success && msgData.messages) {
        const nextHasMore = msgData.messages.length >= 50
		setMessages(previous => {
		  const merged = mergeFetchedMessages(previous, msgData.messages as Message[])
		  cacheMessages(targetChatId, merged, nextHasMore)
		  return merged
		})
        setHasMoreMessages(nextHasMore)
        if (isNearBottomRef.current) scrollToBottom()

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
	  if (!controller.signal.aborted) console.error('Failed to fetch chat', error)
    } finally {
	  if (chatDetailsRequestRef.current === controller) chatDetailsRequestRef.current = null
	  if (!controller.signal.aborted && requestSequence === chatDetailsRequestSequenceRef.current && activeChatIdRef.current === targetChatId) {
        setLoading(false)
      }
    }
  }

  const scrollToBottom = () => {
    const targetChatId = activeChatIdRef.current
    isNearBottomRef.current = true
    setIsFollowingLatest(true)
    setPendingLatestMessages(0)
    setTimeout(() => {
      if (activeChatIdRef.current === targetChatId && messagesContainerRef.current) {
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
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    const nearBottom = distanceFromBottom <= 120
    isNearBottomRef.current = nearBottom
    setIsFollowingLatest(current => current === nearBottom ? current : nearBottom)
    if (nearBottom) setPendingLatestMessages(0)
    if (container.scrollTop < 80 && hasMoreMessages && !loadingMore && !loadingMoreRef.current) {
      loadOlderMessages()
    }
  }

  const handleSendMessage = async () => {
    if (effectiveReadOnly || (!messageText.trim() && !forwardingMsg) || !chat || !deviceId) return

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
      let editSucceeded = false
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
        if (res.ok && data.success) {
          updateTargetMessages(prev => prev.map(m =>
            m.message_id === editingMsg.message_id ? { ...m, body: text, is_edited: true } : m
          ))
          editSucceeded = true
          if (data.warning) setComposerFeedback({ kind: 'info', message: data.warning })
        } else {
          setComposerFeedback({ kind: 'error', message: data.error || 'No se pudo editar el mensaje.' })
        }
      } catch (err) {
        console.error('Failed to edit message', err)
        setComposerFeedback({ kind: 'error', message: 'No se pudo conectar con WhatsApp para editar el mensaje.' })
      } finally {
        finishMessageSend()
      }
      if (!editSucceeded) return
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
      quoted_message_id: replyingTo?.message_id || replyingTo?.id,
      quoted_body: replyingTo?.body || replyingTo?.media_filename || (replyingTo ? 'Mensaje citado' : undefined),
      quoted_sender: replyingTo?.is_from_me ? 'Me' : (replyingTo?.from_name || replyingTo?.from_jid),
      quoted_is_from_me: replyingTo?.is_from_me,
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
                chat_id: targetChatId,
                to: chat.jid,
                body: text,
                quoted_message_id: replyingTo?.message_id || replyingTo?.id,
                quoted_body: replyingTo?.body || replyingTo?.media_filename || '',
                quoted_sender: replyingTo?.is_from_me ? 'Me' : (replyingTo?.from_name || replyingTo?.from_jid || ''),
                quoted_is_from_me: Boolean(replyingTo?.is_from_me),
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
          chat_id: targetChatId,
          to: targetChatJid,
          body: media.caption,
          media_url: uploadedMediaUrl,
          media_type: media.type,
          media_filename: media.file.name,
          quoted_message_id: media.quotedMessageId,
          quoted_body: media.quotedBody,
          quoted_sender: media.quotedSender,
          quoted_is_from_me: media.quotedIsFromMe,
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
        const detail = err instanceof Error && err.message.trim()
          ? err.message.trim()
          : 'No se pudo enviar el archivo'
        setComposerFeedback({ kind: 'error', message: `${detail}. Puedes reintentarlo desde el mensaje.` })
      }
      return false
    }
  }

  const handleRetrySend = async (failedMsg: Message) => {
    if (effectiveReadOnly || !chat || !deviceId || !chatId) return
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
          chat_id: targetChatId,
          to: targetChatJid,
          body: failedMsg.body,
          quoted_message_id: failedMsg.quoted_message_id,
          quoted_body: failedMsg.quoted_body,
          quoted_sender: failedMsg.quoted_sender,
          quoted_is_from_me: failedMsg.quoted_is_from_me,
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
    if (effectiveReadOnly || (mediaType === 'sticker' && !canSendStickers) || !chat || !deviceId || !chatId) return false
    const targetChatId = chatId
    const targetChatJid = chat.jid
    const targetDeviceId = deviceId
    const quote = replyingTo

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
    const retryableMedia: RetryableMedia = {
      file: fileToSend,
      type: mediaType,
      caption: finalCaption,
      previewUrl,
      quotedMessageId: quote?.message_id || quote?.id,
      quotedBody: quote?.body || quote?.media_filename || (quote ? 'Mensaje citado' : undefined),
      quotedSender: quote?.is_from_me ? 'Me' : (quote?.from_name || quote?.from_jid),
      quotedIsFromMe: quote?.is_from_me,
    }

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
      quoted_message_id: retryableMedia.quotedMessageId,
      quoted_body: retryableMedia.quotedBody,
      quoted_sender: retryableMedia.quotedSender,
      quoted_is_from_me: retryableMedia.quotedIsFromMe,
    }

    mediaRetryRef.current.set(tempId, retryableMedia)
    updateMessages(prev => [...prev, optimisticMsg])
    if (quote) setReplyingTo(null)
    setActivePopup(null)
    scrollToBottom()
    void transmitRetryableMedia(tempId, retryableMedia, targetChatId, targetChatJid, targetDeviceId)
    return true
  }

  const handleSendMediaUrl = async (url: string, mediaType: string, caption: string) => {
    if (effectiveReadOnly || !chat || !deviceId || !chatId) return
    const targetChatId = chatId
    const targetChatJid = chat.jid
    const targetDeviceId = deviceId
    const quote = replyingTo

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
      timestamp: new Date().toISOString(),
      quoted_message_id: quote?.message_id || quote?.id,
      quoted_body: quote?.body || quote?.media_filename || (quote ? 'Mensaje citado' : undefined),
      quoted_sender: quote?.is_from_me ? 'Me' : (quote?.from_name || quote?.from_jid),
      quoted_is_from_me: quote?.is_from_me,
    }

    updateMessagesForChat(targetChatId, prev => [...prev, optimisticMsg])
    if (quote) setReplyingTo(null)
    if (activeChatIdRef.current === targetChatId) scrollToBottom()

    const token = localStorage.getItem('token')
    try {
        const res = await fetch('/api/messages/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({
                device_id: targetDeviceId,
                chat_id: targetChatId,
                to: targetChatJid,
                body: caption,
                media_url: url,
                media_type: mediaType,
                quoted_message_id: quote?.message_id || quote?.id,
                quoted_body: quote?.body || quote?.media_filename,
                quoted_sender: quote?.is_from_me ? 'Me' : (quote?.from_name || quote?.from_jid),
                quoted_is_from_me: quote?.is_from_me,
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
      if (!canSendStickers || !chat || !deviceId || !chatId) return

      if (file) {
          await handleSendMedia(file, 'sticker')
          return
      }

      const targetChatId = chatId
      const targetChatJid = chat.jid
      const targetDeviceId = deviceId
      const quote = replyingTo

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
          timestamp: new Date().toISOString(),
          quoted_message_id: quote?.message_id || quote?.id,
          quoted_body: quote?.body || quote?.media_filename || (quote ? 'Mensaje citado' : undefined),
          quoted_sender: quote?.is_from_me ? 'Me' : (quote?.from_name || quote?.from_jid),
          quoted_is_from_me: quote?.is_from_me,
      }
      updateMessagesForChat(targetChatId, prev => [...prev, optimisticMsg])
      if (quote) setReplyingTo(null)
      if (activeChatIdRef.current === targetChatId) scrollToBottom()

      const token = localStorage.getItem('token')
      try {
        const res = await fetch('/api/messages/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
              device_id: targetDeviceId,
              chat_id: targetChatId,
              to: targetChatJid,
              media_url: stickerUrl,
              media_type: 'sticker',
              quoted_message_id: quote?.message_id || quote?.id,
              quoted_body: quote?.body || quote?.media_filename,
              quoted_sender: quote?.is_from_me ? 'Me' : (quote?.from_name || quote?.from_jid),
              quoted_is_from_me: quote?.is_from_me,
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
        if (activeChatIdRef.current === targetChatId) {
          setComposerFeedback({
            kind: 'error',
            message: err instanceof Error ? err.message : 'No se pudo enviar el sticker.',
          })
          void loadSavedStickers()
        }
      }
  }

  const beginAttachmentDraft = (files: File[], forceDocument = false) => {
    if (effectiveReadOnly || files.length === 0) return
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

    const previewUrl = validation.mediaType === 'image' || validation.mediaType === 'video' || validation.mediaType === 'gif'
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
    if (effectiveReadOnly || !chat || !deviceId || !chatId) return
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
    if (effectiveReadOnly || !draft || attachmentSendingRef.current) return

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

  const isCanonicalMessage = (message: Message) => Boolean(message.message_id) && !message.id.startsWith('optimistic-') && !message.is_revoked

  const canEditMessage = (message: Message) => {
    if (effectiveReadOnly || !deviceId || !isCanonicalMessage(message) || !message.is_from_me) return false
    if ((message.message_type || 'text') !== 'text' || message.device_id !== deviceId) return false
    const sentAt = new Date(message.timestamp).getTime()
    return Number.isFinite(sentAt) && Date.now() - sentAt <= 15 * 60 * 1000
  }

  const canDeleteMessage = (message: Message) => (
    !effectiveReadOnly
    && Boolean(deviceId)
    && isCanonicalMessage(message)
    && message.is_from_me
    && message.device_id === deviceId
  )

  const handleCopyMessage = async (message: Message) => {
    const text = message.body?.trim() || message.media_filename || ''
    if (!text) {
      setComposerFeedback({ kind: 'info', message: 'Este mensaje no contiene texto para copiar.' })
      return
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        textarea.remove()
      }
      setComposerFeedback({ kind: 'info', message: 'Mensaje copiado.' })
      clearMessageSelection()
    } catch {
      setComposerFeedback({ kind: 'error', message: 'No se pudo copiar el mensaje.' })
    }
  }

  const handleOpenMessageInfo = (message: Message) => {
    if (!message.is_from_me || !isCanonicalMessage(message)) return
    clearMessageSelection()
    setInfoMessage(message)
  }

  const handleBeginReply = (message: Message) => {
    clearMessageSelection()
    setReplyingTo(message)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const handleBeginForward = (message: Message) => {
    clearMessageSelection()
    setForwardingMsg(message)
  }

  const handleBeginEdit = (message: Message) => {
    if (!canEditMessage(message)) return
    clearMessageSelection()
    setEditingMsg(message)
    setMessageText(message.body || '')
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const handleDeleteChatMessage = async (message: Message) => {
    if (!deviceId || !chat || !canDeleteMessage(message) || messageActionPending) return
    if (!window.confirm('¿Eliminar este mensaje para todos? WhatsApp puede rechazar la solicitud si el plazo ya venció.')) return
    const targetChatId = chat.id
    setMessageActionPending('delete')
    setShowSelectionMenu(false)
    try {
      const token = localStorage.getItem('token')
      const response = await fetch('/api/messages/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          device_id: deviceId,
          chat_jid: chat.jid,
          sender_jid: message.from_jid || '',
          message_id: message.message_id,
          is_from_me: true,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo eliminar el mensaje para todos.')
      updateMessagesForChat(targetChatId, previous => previous.map(item => (
        item.message_id === message.message_id ? { ...item, is_revoked: true, body: undefined } : item
      )))
      clearMessageSelection()
      setComposerFeedback({ kind: data.warning ? 'info' : 'info', message: data.warning || 'Mensaje eliminado para todos.' })
    } catch (error) {
      setComposerFeedback({ kind: 'error', message: error instanceof Error ? error.message : 'No se pudo eliminar el mensaje para todos.' })
    } finally {
      setMessageActionPending(null)
    }
  }

  const handleReactMessage = async (message: Message, emoji: string) => {
    if (!deviceId || !chat || effectiveReadOnly || !isCanonicalMessage(message)) return
    const token = localStorage.getItem('token')
    const targetChatId = chat.id
    const requestedEmoji = hasOwnReaction(message.reactions, emoji) ? '' : emoji
    const previousReactions = dedupeReactions(message.reactions)
    const requestSeq = (reactionRequestSeqRef.current.get(message.message_id) || 0) + 1
    reactionRequestSeqRef.current.set(message.message_id, requestSeq)

    const rollback = () => {
      if (reactionRequestSeqRef.current.get(message.message_id) !== requestSeq) return
      updateMessagesForChat(targetChatId, previous => previous.map(item => (
        item.message_id === message.message_id ? { ...item, reactions: previousReactions } : item
      )))
      if (activeChatIdRef.current === targetChatId) setComposerFeedback({ kind: 'error', message: 'No se pudo actualizar la reacción.' })
    }

    updateMessagesForChat(targetChatId, previous => previous.map(item => {
      if (item.message_id !== message.message_id) return item
      return {
        ...item,
        reactions: applyReactionMutation(item.reactions, {
          targetMessageId: message.message_id,
          senderJid: SELF_REACTION_ACTOR,
          senderName: 'Tú',
          emoji: requestedEmoji,
          isFromMe: true,
          removed: requestedEmoji === '',
        }),
      }
    }))
    try {
      const response = await fetch('/api/messages/react', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          device_id: deviceId,
          to: chat.jid,
          target_message_id: message.message_id,
          target_from_me: Boolean(message.is_from_me),
          target_sender_jid: message.from_jid || '',
          emoji: requestedEmoji,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) rollback()
      else clearMessageSelection()
    } catch {
      rollback()
    }
  }

  const savedStickerUrls = useMemo(() => new Set(savedStickers), [savedStickers])
  const openMessageMedia = useCallback((url: string) => setViewImage(url), [])
  const retryMessage = useStableCallback(handleRetrySend)
  const revealQuotedMessageStable = useStableCallback(revealQuotedMessage)
  const beginReplyStable = useStableCallback(handleBeginReply)
  const beginForwardStable = useStableCallback(handleBeginForward)
  const deleteMessageStable = useStableCallback(handleDeleteChatMessage)
  const editMessageStable = useStableCallback(handleBeginEdit)
  const openMessageInfoStable = useStableCallback(handleOpenMessageInfo)
  const copyMessageStable = useStableCallback(handleCopyMessage)
  const toggleSavedStickerStable = useStableCallback(handleToggleSavedSticker)
  const reactToMessageStable = useStableCallback(handleReactMessage)
  const sendStickerStable = useStableCallback(handleSendSticker)
  const insertMobileEmoji = useCallback((emoji: string) => {
    inputRef.current?.insertAtCaret(emoji, { restoreFocus: false })
  }, [])
  const closeMobileAccessoryWithoutHistory = useCallback(() => {
    closeMobileAccessory({ consumeHistory: false })
  }, [closeMobileAccessory])

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

  const visibleMessages = searchWindowMessages || messages

  return (
    <div ref={panelRef} className={`relative flex-1 flex flex-col min-h-0 overflow-hidden h-full ${className}`}>
         {/* Chat header */}
         {selectedMessage && compactActions ? (
           <div data-testid="message-selection-header" className="flex min-h-14 shrink-0 items-center justify-between gap-1 border-b border-emerald-200 bg-emerald-50 px-2">
             <div className="flex min-w-0 items-center gap-1">
               <button type="button" onClick={() => clearMessageSelection()} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-600 hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Cerrar selección del mensaje"><X className="h-5 w-5" /></button>
               <span className="min-w-6 text-center text-sm font-bold text-slate-800" aria-label="1 mensaje seleccionado">1</span>
             </div>
             <div className="flex shrink-0 items-center gap-0.5">
               {!effectiveReadOnly && <button type="button" onClick={() => handleBeginReply(selectedMessage)} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-600 hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Responder mensaje"><Reply className="h-5 w-5" /></button>}
               {!effectiveReadOnly && <button type="button" onClick={() => handleBeginForward(selectedMessage)} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-600 hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Reenviar mensaje"><CornerUpRight className="h-5 w-5" /></button>}
               {canDeleteMessage(selectedMessage) && (
                 <button type="button" onClick={() => void handleDeleteChatMessage(selectedMessage)} disabled={messageActionPending === 'delete'} className="flex h-11 w-11 items-center justify-center rounded-xl text-red-600 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-wait disabled:opacity-50" aria-label="Eliminar mensaje para todos">{messageActionPending === 'delete' ? <RefreshCw className="h-5 w-5 animate-spin" /> : <Trash2 className="h-5 w-5" />}</button>
               )}
               <button type="button" onClick={() => setShowSelectionMenu(value => !value)} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-600 hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Más acciones del mensaje" aria-haspopup="menu" aria-expanded={showSelectionMenu}><MoreVertical className="h-5 w-5" /></button>
             </div>
           </div>
         ) : (
         <div className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-white px-2 sm:px-4">
              <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                {onClose && (
                  <button
                    type="button"
                    onClick={onClose}
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                    aria-label="Volver a la lista de chats"
                  >
                    <ArrowLeft className="w-5 h-5" />
                  </button>
                )}
                <button
                  type="button"
                  className="flex min-h-11 min-w-0 items-center gap-3 rounded-xl px-1 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                  onClick={() => setShowContactInfo(!showContactInfo)}
                  aria-label="Ver detalles de la conversación"
                  aria-expanded={showContactInfo}
                >
                    {chat.contact_avatar_url ? (
                        <img src={chat.contact_avatar_url} className="w-9 h-9 rounded-full object-cover" alt="" />
                    ) : (
                        <div className="w-9 h-9 rounded-full bg-slate-200 flex items-center justify-center">
                            <User className="w-5 h-5 text-slate-500" />
                        </div>
                    )}
                    <div className="min-w-0">
                        <h3 className="truncate font-semibold text-sm text-slate-900 leading-tight">
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
                          <p className="text-xs text-slate-500">Ver detalles</p>
                        )}
                    </div>
                </button>
              </div>

	              <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
	                   <button type="button" onClick={() => { toggleSearch(); setShowHeaderMenu(false) }} className={`inline-flex h-11 w-11 items-center justify-center rounded-xl transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${showSearch ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-100'}`} aria-label="Buscar en la conversación" aria-pressed={showSearch} title="Buscar mensajes">
	                       <Search className="w-5 h-5" />
	                   </button>
                   <div className="relative">
                     <button ref={headerMenuTriggerRef} type="button" onPointerDown={event => event.stopPropagation()} onClick={() => setShowHeaderMenu(value => !value)} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Acciones de la conversación" aria-haspopup="menu" aria-expanded={showHeaderMenu}>
                         <MoreVertical className="w-5 h-5" />
                     </button>
	                     {showHeaderMenu && (
	                       <div role="menu" onPointerDown={event => event.stopPropagation()} className="fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-[90] max-h-[min(70dvh,24rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-900/15 sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-12 sm:z-50 sm:w-56">
	                         <button type="button" role="menuitem" onClick={() => { setShowContactInfo(true); setShowHeaderMenu(false) }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><PanelRight className="h-4 w-4 text-slate-400" /> Ver detalles</button>
	                         <button type="button" role="menuitem" onClick={() => { void handleRequestHistorySync(); setShowHeaderMenu(false) }} disabled={syncingHistory || effectiveReadOnly} title={effectiveReadOnly ? readOnlyReason : undefined} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-45"><RefreshCw className={`h-4 w-4 text-slate-400 ${syncingHistory ? 'animate-spin' : ''}`} /> {syncingHistory ? 'Recuperando historial…' : 'Recuperar mensajes anteriores'}</button>
	                         {onRequestDelete && <><div className="my-1 border-t border-slate-100" /><button type="button" role="menuitem" onClick={() => { setShowHeaderMenu(false); onRequestDelete() }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"><Trash2 className="h-4 w-4" /> Eliminar del CRM</button></>}
                       </div>
                     )}
                   </div>
              </div>
         </div>
         )}

         {showSelectionMenu && selectedMessage && compactActions && typeof document !== 'undefined' && createPortal(
           <>
             <button type="button" className="app-viewport fixed inset-0 z-[99] bg-slate-950/20" onClick={() => setShowSelectionMenu(false)} aria-label="Cerrar acciones del mensaje" />
             <div role="menu" aria-label="Acciones del mensaje seleccionado" className="fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-[100] max-h-[min(72dvh,28rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-2xl">
               {!effectiveReadOnly && <><p className="px-3 pb-2 pt-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">Reaccionar</p>
               <div className="grid grid-cols-6 gap-1 px-1 pb-2" role="group" aria-label="Reacciones rápidas">
                 {['👍', '❤️', '😂', '😮', '😢', '🙏'].map(emoji => <button key={emoji} type="button" onClick={() => { setShowSelectionMenu(false); void handleReactMessage(selectedMessage, emoji) }} className="flex h-11 items-center justify-center rounded-xl text-2xl hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label={`Reaccionar con ${emoji}`}>{emoji}</button>)}
               </div></>}
               <div className="border-t border-slate-100 pt-1">
                 {(selectedMessage.body || selectedMessage.media_filename) && <button type="button" role="menuitem" onClick={() => { setShowSelectionMenu(false); void handleCopyMessage(selectedMessage) }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><Copy className="h-4 w-4 text-slate-400" /> Copiar</button>}
                 {selectedMessage.is_from_me && isCanonicalMessage(selectedMessage) && <button type="button" role="menuitem" onClick={() => { setShowSelectionMenu(false); handleOpenMessageInfo(selectedMessage) }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><Info className="h-4 w-4 text-slate-400" /> Información del mensaje</button>}
                 {canEditMessage(selectedMessage) && <button type="button" role="menuitem" onClick={() => { setShowSelectionMenu(false); handleBeginEdit(selectedMessage) }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><FileText className="h-4 w-4 text-slate-400" /> Editar mensaje</button>}
               </div>
             </div>
           </>,
           document.body,
         )}

         {showSearch && (
           <div className="shrink-0 border-b border-slate-200 bg-white px-3 py-2 shadow-sm" role="search">
             <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1 focus-within:border-emerald-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-emerald-100 md:flex-nowrap">
               <div className="flex min-h-11 min-w-0 flex-1 basis-[calc(100%-3rem)] items-center gap-2 px-2 md:basis-auto">
                 <Search className="h-4 w-4 shrink-0 text-slate-400" />
                 <input autoFocus type="search" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Buscar mensajes…" className="min-w-0 flex-1 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400" aria-label="Texto a buscar" />
               </div>
               <div className="order-last flex min-h-11 w-full items-center justify-between border-t border-slate-200 px-1 pt-1 md:order-none md:w-auto md:gap-1 md:border-0 md:p-0">
                 {searchLoading ? <span className="ml-2 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-emerald-200 border-t-emerald-600" aria-label="Buscando" /> : (
                   <span className="shrink-0 px-2 text-xs font-semibold tabular-nums text-slate-500" title={searchResult?.body || searchResult?.media_filename || undefined}>
                     {searchQuery.trim().length < 2 ? '2+ caracteres' : searchTotal > 0 ? `${searchResultIndex + 1} de ${searchTotal}` : 'Sin resultados'}
                   </span>
                 )}
                 <div className="flex items-center gap-1">
                   <button type="button" onClick={() => void fetchSearchResult(searchQuery.trim(), searchResultIndex - 1)} disabled={searchLoading || searchResultIndex <= 0 || searchTotal === 0} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-30" aria-label="Resultado más reciente"><ChevronUp className="h-4 w-4" /></button>
                   <button type="button" onClick={() => void fetchSearchResult(searchQuery.trim(), searchResultIndex + 1)} disabled={searchLoading || searchResultIndex + 1 >= searchTotal} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-30" aria-label="Resultado anterior"><ChevronDown className="h-4 w-4" /></button>
                 </div>
               </div>
               <button type="button" onClick={closeSearch} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Cerrar búsqueda"><X className="h-4 w-4" /></button>
	             </div>
	             {searchError ? (
	               <p className="mt-1.5 px-1 text-xs font-medium text-red-600" role="alert">{searchError}</p>
	             ) : searchResult && !searchLoading ? (
	               <p className="mt-1.5 truncate px-1 text-xs text-slate-500" title={searchResult.body || searchResult.media_filename || 'Mensaje multimedia'}>Coincidencia: {searchResult.body || searchResult.media_filename || 'Mensaje multimedia'}</p>
	             ) : searchQuery.trim().length < 2 ? (
	               <p className="mt-1.5 px-1 text-xs text-slate-400">Escribe al menos dos caracteres para buscar en todo el historial.</p>
	             ) : null}
	           </div>
	         )}

	         {historySyncFeedback && (
	           <div role={historySyncFeedback.kind === 'error' ? 'alert' : 'status'} className={`flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs ${historySyncFeedback.kind === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-blue-200 bg-blue-50 text-blue-700'}`}>
	             {syncingHistory ? <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" /> : historySyncFeedback.kind === 'error' ? <AlertCircle className="h-3.5 w-3.5 shrink-0" /> : <Check className="h-3.5 w-3.5 shrink-0" />}
	             <span className="min-w-0 flex-1">{historySyncFeedback.message}</span>
	             <button type="button" onClick={() => setHistorySyncFeedback(null)} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current" aria-label="Cerrar aviso"><X className="h-3.5 w-3.5" /></button>
	           </div>
	         )}

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
                onScroll={searchWindowMessages ? undefined : handleMessagesScroll}
                className="relative flex-1 space-y-2 overflow-y-auto px-2 py-3 overscroll-contain sm:p-4"
                style={{
                  backgroundColor: '#efeae2',
                  backgroundImage: "url('/whatsapp-chat-background.png')",
                  backgroundRepeat: 'repeat',
                }}
	             >
	                  {quoteNavigationLoading && (
	                    <div className="sticky top-0 z-20 mx-auto flex w-fit items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-xs font-semibold text-slate-600 shadow-sm backdrop-blur" role="status">
	                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-emerald-200 border-t-emerald-600" /> Buscando mensaje original…
	                    </div>
	                  )}
	                  {quotedContextActive && !quoteNavigationLoading && (
	                    <div className="sticky top-0 z-20 mx-auto flex w-fit max-w-full items-center gap-2 rounded-full border border-emerald-200 bg-white/95 px-3 py-1.5 text-xs text-slate-600 shadow-sm backdrop-blur" role="status">
	                      <Reply className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
	                      <span className="truncate">Mostrando el mensaje respondido</span>
	                      <button type="button" onClick={() => { setSearchWindowMessages(null); setQuotedContextActive(false); setActiveSearchMessageId(''); requestAnimationFrame(scrollToBottom) }} className="shrink-0 rounded-lg px-2 py-1 font-bold text-emerald-700 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">Volver al final</button>
	                    </div>
	                  )}
	                  {!searchWindowMessages && loadingMore && (
                    <div className="flex justify-center py-3">
                      <div className="animate-spin rounded-full h-5 w-5 border-2 border-emerald-200 border-t-emerald-600" />
                    </div>
                  )}
                  {!searchWindowMessages && !hasMoreMessages && messages.length > 0 && (
                    <div className="flex justify-center py-2">
                      <span className="text-xs text-slate-400 bg-white/80 px-3 py-1 rounded-full">Inicio de la conversación</span>
                    </div>
                  )}
                  {visibleMessages.map((msg, idx) => {
                      // Date separator between different days
                      let showDateSep = false
                      const msgDate = new Date(msg.timestamp)
                      const isValidDate = msg.timestamp && !isNaN(msgDate.getTime())
                      if (isValidDate) {
                        if (idx === 0) {
                          showDateSep = true
                        } else {
                          const prevDate = new Date(visibleMessages[idx - 1].timestamp)
                          if (!isNaN(prevDate.getTime()) && msgDate.toDateString() !== prevDate.toDateString()) {
                            showDateSep = true
                          }
                        }
                      }

                      const contactName = chat ? getChatDisplayName(chat) : undefined

                      return (
	                          <div key={msg.id} data-chat-message-id={msg.id} data-whatsapp-message-id={msg.message_id} className={`rounded-xl transition-[background-color,box-shadow] duration-500 ${activeSearchMessageId === msg.id || activeSearchMessageId === msg.message_id ? 'bg-amber-100/80 shadow-[0_0_0_4px_rgba(251,191,36,0.18)]' : ''}`}>
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
	                                onMediaClick={openMessageMedia}
	                                onRetry={effectiveReadOnly ? undefined : retryMessage}
	                                onReply={effectiveReadOnly ? undefined : beginReplyStable}
	                                onQuotedMessageClick={revealQuotedMessageStable}
	                                onForward={effectiveReadOnly ? undefined : beginForwardStable}
	                                onDelete={canDeleteMessage(msg) ? deleteMessageStable : undefined}
	                                onEdit={canEditMessage(msg) ? editMessageStable : undefined}
	                                onInfo={msg.is_from_me && isCanonicalMessage(msg) ? openMessageInfoStable : undefined}
	                                onCopy={(msg.body || msg.media_filename) ? copyMessageStable : undefined}
                                compactSelection={compactActions}
                                selected={Boolean(selectedMessage && hasSameMessageIdentity(msg, selectedMessage))}
                                onSelect={selectMessage}
	                                onToggleStickerFavorite={toggleSavedStickerStable}
                                savedStickerUrls={savedStickerUrls}
                                savingStickerUrls={savingStickerUrls}
	                                onReact={effectiveReadOnly ? undefined : reactToMessageStable}
                              />
                          </div>
                      )
                  })}
             </div>

             {!searchWindowMessages && !isFollowingLatest && (
               <button
                 type="button"
                 onClick={scrollToBottom}
                 className="absolute bottom-3 right-3 z-20 inline-flex min-h-11 items-center gap-2 rounded-full border border-emerald-200 bg-white px-3 text-xs font-bold text-emerald-700 shadow-lg shadow-slate-900/10 transition hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                 aria-label={pendingLatestMessages > 0 ? `Ir al final, ${pendingLatestMessages} mensaje${pendingLatestMessages === 1 ? '' : 's'} nuevo${pendingLatestMessages === 1 ? '' : 's'}` : 'Ir al final de la conversación'}
               >
                 <ChevronDown className="h-4 w-4" />
                 {pendingLatestMessages > 0 ? `${pendingLatestMessages} nuevo${pendingLatestMessages === 1 ? '' : 's'}` : 'Ir al final'}
               </button>
             )}

             {/* Right Panel (Contact/Search) - Overlay/Sidebar — only when NOT parent-controlled */}
             {showContactInfo && !onContactInfoToggle && (
                <div
                   className="absolute inset-y-0 right-0 z-20 w-full border-l border-slate-200 bg-white shadow-xl md:w-[380px] md:max-w-[45%]"
                >
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
         {attachmentDraft && !effectiveReadOnly && (
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
                 {attachmentDraft.type === 'image' ? 'Imagen' : attachmentDraft.type === 'video' ? 'Video' : attachmentDraft.type === 'gif' ? 'GIF' : attachmentDraft.type === 'audio' ? 'Audio' : 'Documento'}
               </span>
               <div className="w-10" />
             </div>
             {/* Preview */}
             <div className="flex-1 flex items-center justify-center p-4 min-h-0 bg-slate-50">
               {attachmentDraft.type === 'image' || attachmentDraft.type === 'gif' ? (
                 <img src={attachmentDraft.previewUrl} className="max-h-full max-w-full object-contain rounded-lg shadow-md" alt={attachmentDraft.type === 'gif' ? 'Vista previa del GIF' : 'Vista previa del adjunto'} />
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
                   formatToolbarPlacement="outside"
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
         {effectiveReadOnly ? (
           <div className="flex shrink-0 items-center justify-center gap-2 border-t border-amber-200 bg-amber-50 px-4 py-3 text-center" role="status">
             <EyeOff className="w-4 h-4 text-amber-600" />
             <span className="text-sm font-medium text-amber-700">Solo lectura — {readOnlyReason}</span>
           </div>
         ) : (
         <div className="relative z-30 flex shrink-0 items-end gap-1 border-t border-slate-200 bg-slate-50 px-2 pt-2 sm:gap-2 sm:px-3" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
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
                  <div className="absolute bottom-full left-0 right-0 flex items-center justify-between gap-3 border-t border-emerald-300 bg-white/95 px-3 py-2 shadow-sm backdrop-blur">
                      <div className="min-w-0 flex-1 border-l-4 border-emerald-500 pl-2.5 text-xs">
                          <p className="truncate font-bold text-emerald-700">Respondiendo a {replyingTo.is_from_me ? 'ti' : (replyingTo.from_name || getChatDisplayName(chat))}</p>
                          <p className="line-clamp-1 text-slate-600">{replyingTo.body || replyingTo.media_filename || (replyingTo.message_type === 'image' ? 'Foto' : replyingTo.message_type === 'video' ? 'Video' : replyingTo.message_type === 'gif' ? 'GIF' : replyingTo.message_type === 'audio' ? 'Audio' : 'Mensaje multimedia')}</p>
                      </div>
                      <button type="button" onClick={() => setReplyingTo(null)} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Cancelar respuesta"><X className="h-4 w-4" /></button>
                  </div>
              )}

              {/* Attachments Menu */}
              {showAttachments && (
                <>
                  <button type="button" className="app-viewport fixed inset-0 z-[80] bg-slate-950/25 sm:hidden" onClick={() => setShowAttachments(false)} aria-label="Cerrar opciones de adjuntos" />
                  <div role="menu" className="absolute inset-x-2 bottom-full z-[90] mb-2 flex max-h-[min(calc(var(--app-height,100dvh)-8rem),28rem)] flex-col gap-1 overflow-y-auto rounded-2xl border border-slate-100 bg-white p-2 shadow-2xl animate-in slide-in-from-bottom-2 duration-200 sm:inset-x-auto sm:bottom-16 sm:left-4 sm:z-50 sm:mb-0 sm:w-56 sm:rounded-xl sm:shadow-xl">
                      <button type="button" role="menuitem" className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" onClick={() => { fileInputRef.current?.click(); setShowAttachments(false) }}>
                          <ImageIcon className="w-5 h-5 text-purple-500" /> Foto/Video
                      </button>
                      <button type="button" role="menuitem" className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" onClick={() => { docFileInputRef.current?.click(); setShowAttachments(false) }}>
                          <FileText className="w-5 h-5 text-blue-500" /> Documento
                      </button>
                      <button type="button" role="menuitem" className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" onClick={() => { setShowContactPicker(true); setShowAttachments(false) }}>
                          <User className="w-5 h-5 text-emerald-500" /> Contacto
                      </button>
                      <div className="my-1 border-t border-slate-100 sm:hidden" />
                      <button type="button" role="menuitem" className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 sm:hidden" onClick={() => openMobileAccessory('emoji')}>
                        <Smile className="h-5 w-5 text-amber-500" /> Emoji
                      </button>
                      {canSendStickers && (
                        <button type="button" role="menuitem" className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 sm:hidden" onClick={() => openMobileAccessory('sticker')}>
                          <Smile className="h-5 w-5 text-emerald-500" /> Sticker
                        </button>
                      )}
                  </div>
                </>
              )}
              <input type="file" ref={fileInputRef} className="hidden" accept="image/*,video/*" onChange={e => handleFileSelect(e, 'media')} />
              <input type="file" ref={docFileInputRef} className="hidden" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.rar" onChange={e => handleFileSelect(e, 'document')} />
              <input type="file" ref={cameraInputRef} className="hidden" accept="image/*" capture="environment" onChange={e => handleFileSelect(e, 'media')} />

              {!compactActions && <div className="flex shrink-0 gap-1 pb-0.5">
                  <button type="button" onClick={() => { setActivePopup(null); setShowAttachments(value => !value) }} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-emerald-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Adjuntar archivo" aria-expanded={showAttachments}>
                      <Paperclip className="w-6 h-6" />
                  </button>
                  <EmojiPicker
                    onEmojiSelect={(emoji) => inputRef.current?.insertAtCaret(emoji)}
                    isOpen={activePopup === 'emoji'}
                    onToggle={() => setActivePopup(activePopup === 'emoji' ? null : 'emoji')}
                    buttonClassName={`hidden h-11 w-11 items-center justify-center rounded-xl transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 sm:inline-flex ${activePopup === 'emoji' ? 'bg-emerald-50 text-emerald-600' : 'text-slate-500 hover:bg-slate-100 hover:text-emerald-600'}`}
                  />
                  {canSendStickers ? <StickerPicker
                      onStickerSelect={handleSendSticker}
                      isOpen={activePopup === 'sticker'}
                      onToggle={() => setActivePopup(activePopup === 'sticker' ? null : 'sticker')}
                      savedStickers={savedStickers}
                      savedStickerUrls={savedStickerUrls}
                      savingStickerUrls={savingStickerUrls}
                      savedLoading={savedStickersLoading}
                      savedError={savedStickersError}
                      onToggleSavedSticker={handleToggleSavedSticker}
                      onRefreshSavedStickers={loadSavedStickers}
                      triggerClassName="hidden sm:flex"
                  /> : (
                    <button type="button" disabled className="hidden h-11 w-11 cursor-not-allowed items-center justify-center rounded-xl text-slate-300 sm:inline-flex" aria-label="Stickers no disponibles para este dispositivo" title="Stickers no disponibles para este dispositivo">
                      <Smile className="h-5 w-5" />
                    </button>
                  )}
              </div>}

              {compactActions && (
                <div className="shrink-0 pb-0.5">
                  <button
                    type="button"
                    onClick={() => activePopup
                      ? closeMobileAccessory({ restoreKeyboard: true, consumeHistory: false })
                      : openMobileAccessory('emoji')}
                    className={`inline-flex h-11 w-11 items-center justify-center rounded-xl transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${activePopup ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-100 hover:text-emerald-600'}`}
                    aria-label={activePopup ? 'Mostrar teclado' : 'Abrir selector de emojis'}
                    aria-expanded={activePopup !== null}
                    aria-controls={activePopup ? 'mobile-composer-accessory' : undefined}
                  >
                    {activePopup ? <Keyboard className="h-5 w-5" /> : <Smile className="h-5 w-5" />}
                  </button>
                </div>
              )}

              <div className="relative min-w-0 flex-1">
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
                      placeholder="Escribe un mensaje…"
                      onKeyDown={handleKeyDown}
                      onPasteFiles={files => beginAttachmentDraft(files)}
                      keyboardChromeTarget
                      formatToolbarPlacement="outside"
                      singleLine
                    />
              </div>

              {compactActions && (
                <button
                  type="button"
                  onClick={() => {
                    if (activePopup) closeMobileAccessory({ consumeHistory: false })
                    inputRef.current?.blur()
                    setShowAttachments(value => !value)
                  }}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-emerald-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                  aria-label="Adjuntar archivo"
                  aria-expanded={showAttachments}
                >
                  <Paperclip className="h-5 w-5" />
                </button>
              )}

              {compactActions && !messageText.trim() && !forwardingMsg && !editingMsg && (
                <button
                  type="button"
                  onClick={() => {
                    if (activePopup) closeMobileAccessory({ consumeHistory: false })
                    inputRef.current?.blur()
                    setShowAttachments(false)
                    cameraInputRef.current?.click()
                  }}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-emerald-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                  aria-label="Tomar una foto"
                >
                  <Camera className="h-5 w-5" />
                </button>
              )}

              {(messageText.trim() || forwardingMsg) && (
                  <button
                    type="button"
                    onClick={handleSendMessage}
                    disabled={sendingMessage}
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white shadow-md transition hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:opacity-50"
                    aria-label={sendingMessage ? 'Enviando mensaje' : 'Enviar mensaje'}
                  >
                      <Send className="w-5 h-5" />
                  </button>
              )}
         </div>
         )}

         {!effectiveReadOnly && compactActions && activePopup && (
           <MobileComposerAccessory
             activeTab={activePopup}
             ready={mobileAccessoryReady}
             height={mobileAccessoryHeight}
             canSendStickers={canSendStickers}
             onTabChange={openMobileAccessory}
             onClose={closeMobileAccessoryWithoutHistory}
             onEmojiSelect={insertMobileEmoji}
             onStickerSelect={sendStickerStable}
             savedStickers={savedStickers}
             savedStickerUrls={savedStickerUrls}
             savingStickerUrls={savingStickerUrls}
             savedLoading={savedStickersLoading}
             savedError={savedStickersError}
             onToggleSavedSticker={toggleSavedStickerStable}
             onRefreshSavedStickers={loadSavedStickers}
           />
         )}

         {/* Image Viewer */}
         {viewImage && (
             <ImageViewer src={viewImage} isOpen={!!viewImage} onClose={() => setViewImage(null)} />
         )}

         {infoMessage && (
           <MessageInfoDialog message={infoMessage} onClose={() => setInfoMessage(null)} />
         )}

         {/* Forward Modal */}
         {!effectiveReadOnly && forwardingMsg && chat && deviceId && (
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
           open={!effectiveReadOnly && showContactPicker}
           onClose={() => setShowContactPicker(false)}
           onConfirm={handleSendContact}
           title="Enviar Contacto"
           subtitle="Selecciona los contactos que deseas enviar"
           confirmLabel="Enviar"
         />
    </div>
  )
}
