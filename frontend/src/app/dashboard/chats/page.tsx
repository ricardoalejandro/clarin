'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Search, Plus, X, Trash2, CheckSquare, MessageCircle, ShieldBan, Heart, ChevronDown, ChevronUp, MoreVertical, PanelRight, ListChecks, AlertTriangle, Loader2, RotateCcw, Sparkles, SlidersHorizontal } from 'lucide-react'
import { formatTime } from '@/utils/format'
import { subscribeWebSocket } from '@/lib/api'
import DeviceSelector from '@/components/chat/DeviceSelector'
import NewChatModal from '@/components/chat/NewChatModal'
import ChatPanel from '@/components/chat/ChatPanel'
import ContactPanel from '@/components/chat/ContactPanel'
import OwnStatusesCenter from '@/components/chat/OwnStatusesCenter'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import { Chat, Device, Message } from '@/types/chat'
import { getChatDisplayName, formatPhone } from '@/utils/chat'

const LEFT_PANEL_DEFAULT = 360
const LEFT_PANEL_MIN = 320
const LEFT_PANEL_MAX = 420
const RIGHT_PANEL_DEFAULT = 380
const RIGHT_PANEL_MIN = 340
const RIGHT_PANEL_MAX = 440
const CHAT_PANEL_MIN = 480
const PANEL_SEPARATOR_WIDTH = 8
const WIDE_PANEL_SEPARATORS_WIDTH = PANEL_SEPARATOR_WIDTH * 2
const COMPACT_WORKSPACE_MAX = LEFT_PANEL_MIN + CHAT_PANEL_MIN + PANEL_SEPARATOR_WIDTH
const ROW_MENU_WIDTH = 208
const ROW_MENU_HEIGHT = 208
const VIEWPORT_MARGIN = 8
const CHAT_LIST_RECONCILE_DELAY = 280
const CHAT_EVENT_DEDUPE_WINDOW = 30_000

type LayoutMode = 'compact' | 'medium' | 'wide'
type ResizePanel = 'left' | 'right'
type CompactSurface = 'list' | 'conversation' | 'details'
type CompactHistoryState = {
  clarinChatSurface?: 'conversation' | 'details'
  clarinChatId?: string
  clarinChatDepth?: number
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

const chatPreviewFromMessage = (message: Partial<Message>) => {
  const body = message.body?.trim()
  if (body) return body
  switch (message.message_type) {
    case 'image': return '📷 Imagen'
    case 'video': return '🎥 Video'
    case 'gif': return 'GIF'
    case 'audio': return '🎵 Audio'
    case 'document': return '📄 Documento'
    case 'sticker': return 'Sticker'
    case 'location': return '📍 Ubicación'
    case 'contact': return '👤 Contacto'
    case 'poll': return '📊 Encuesta'
    default: return 'Nuevo mensaje'
  }
}

const sameChatSnapshot = (current: Chat | undefined, next: Chat) => {
  if (!current) return false
  const keys = Array.from(new Set([...Object.keys(current), ...Object.keys(next)])) as Array<keyof Chat>
  for (const key of keys) {
    if (!Object.is(current[key], next[key])) return false
  }
  return true
}

const reconcileChatSnapshots = (current: Chat[], incoming: Chat[]) => {
  const currentById = new Map(current.map(chat => [chat.id, chat]))
  return incoming.map(chat => {
    const existing = currentById.get(chat.id)
    return sameChatSnapshot(existing, chat) ? existing as Chat : chat
  })
}

const messageTimestampValue = (value?: string) => {
  if (!value) return 0
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

export default function ChatsPage() {
  const pageRef = useRef<HTMLDivElement>(null)
  const [chats, setChats] = useState<Chat[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null)
  const [compactSurface, setCompactSurface] = useState<CompactSurface>('list')

  // Filters & UI State
  const [filterDevices, setFilterDevices] = useState<string[]>([])
  const [filterUnread, setFilterUnread] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showNewChatModal, setShowNewChatModal] = useState(false)
  const [showOwnStatuses, setShowOwnStatuses] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedChats, setSelectedChats] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [deleteRequest, setDeleteRequest] = useState<{ ids: string[]; label: string } | null>(null)
  const [listFeedback, setListFeedback] = useState('')
  const [chatListError, setChatListError] = useState('')
  const [openRowMenuId, setOpenRowMenuId] = useState<string | null>(null)
  const [rowMenuPosition, setRowMenuPosition] = useState<{ top: number; left: number } | null>(null)
  const [showToolbarMenu, setShowToolbarMenu] = useState(false)
  const [showMobileFilters, setShowMobileFilters] = useState(false)
  const [listSearchFocused, setListSearchFocused] = useState(false)
  const [listKeyboardOpen, setListKeyboardOpen] = useState(false)
  const rowMenuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const toolbarMenuRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const deleteDialogRef = useRef<HTMLDivElement>(null)
  const deleteCancelRef = useRef<HTMLButtonElement>(null)

  // Reaction filter
  const [filterHasReaction, setFilterHasReaction] = useState(false)
  const [reactionFromMe, setReactionFromMe] = useState<'any' | 'client' | 'me'>('client')
  const [reactionEmojis, setReactionEmojis] = useState<string[]>([])
  const [reactionRange, setReactionRange] = useState<'any' | '1d' | '7d' | '30d' | 'custom'>('30d')
  const [reactionCustomFrom, setReactionCustomFrom] = useState('')
  const [reactionCustomTo, setReactionCustomTo] = useState('')
  const [showReactionAdvanced, setShowReactionAdvanced] = useState(false)
  const chatQueryKey = JSON.stringify([filterDevices, filterUnread, debouncedSearch, filterHasReaction, reactionFromMe, reactionEmojis, reactionRange, reactionCustomFrom, reactionCustomTo])
  const activeChatQueryKeyRef = useRef(chatQueryKey)
  activeChatQueryKeyRef.current = chatQueryKey

  // Infinite scroll state
  const CHATS_PAGE_SIZE = 50
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [totalChats, setTotalChats] = useState(0)
  const offsetRef = useRef(0)
  const chatListRef = useRef<HTMLDivElement>(null)
  const chatsRequestSequenceRef = useRef(0)
  const chatsReconcileSequenceRef = useRef(0)
  const devicesRequestSequenceRef = useRef(0)
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const processedMessageEventsRef = useRef(new Map<string, number>())
  const selectedChatIdRef = useRef<string | null>(null)
  const compactHistoryDepthRef = useRef(0)

  // Responsive, resizable workspace
  const [containerWidth, setContainerWidth] = useState(1440)
  const [leftPanelWidth, setLeftPanelWidth] = useState(LEFT_PANEL_DEFAULT)
  const [rightPanelWidth, setRightPanelWidth] = useState(RIGHT_PANEL_DEFAULT)
  const resizingRef = useRef<{ panel: ResizePanel; startX: number; startWidth: number } | null>(null)

  // Contact info (3rd column)
  const [showContactInfo, setShowContactInfo] = useState(false)

  // Virtualizer for chat list
  const chatVirtualizer = useVirtualizer({
    count: chats.length,
    getScrollElement: () => chatListRef.current,
    getItemKey: index => chats[index]?.id ?? index,
    estimateSize: () => 80,
    overscan: 10,
  })

  const inlineDetailsWidth = leftPanelWidth + CHAT_PANEL_MIN + rightPanelWidth + WIDE_PANEL_SEPARATORS_WIDTH
  const layoutMode: LayoutMode = containerWidth < COMPACT_WORKSPACE_MAX ? 'compact' : containerWidth >= inlineDetailsWidth ? 'wide' : 'medium'
  const chatListWidth = layoutMode === 'compact' ? containerWidth : leftPanelWidth
  const showExpandedToolbar = chatListWidth >= 400
  const activeMobileFilterCount = Number(filterUnread) + Number(filterHasReaction)
  const collapseMobileListToolbar = layoutMode === 'compact' && compactSurface === 'list' && listKeyboardOpen

  useEffect(() => {
    if (layoutMode !== 'compact' || !listSearchFocused || typeof window === 'undefined') {
      setListKeyboardOpen(false)
      return
    }
    const viewport = window.visualViewport
    const updateKeyboardState = () => {
      const visibleHeight = viewport?.height ?? window.innerHeight
      const offsetTop = viewport?.offsetTop ?? 0
      setListKeyboardOpen(window.innerHeight - visibleHeight - offsetTop > 96)
    }
    updateKeyboardState()
    viewport?.addEventListener('resize', updateKeyboardState)
    viewport?.addEventListener('scroll', updateKeyboardState)
    return () => {
      viewport?.removeEventListener('resize', updateKeyboardState)
      viewport?.removeEventListener('scroll', updateKeyboardState)
    }
  }, [layoutMode, listSearchFocused])

  const closeRowMenu = useCallback((restoreFocus = false) => {
    setOpenRowMenuId(null)
    setRowMenuPosition(null)
    if (restoreFocus) requestAnimationFrame(() => rowMenuTriggerRef.current?.focus())
  }, [])

  useEffect(() => {
    selectedChatIdRef.current = layoutMode === 'compact' && compactSurface === 'list' ? null : selectedChat?.id || null
  }, [compactSurface, layoutMode, selectedChat])

  const pushCompactHistory = useCallback((surface: 'conversation' | 'details', chatId: string) => {
    if (layoutMode !== 'compact' || typeof window === 'undefined') return
    const current = (window.history.state || {}) as CompactHistoryState
    if (current.clarinChatSurface === surface && current.clarinChatId === chatId) return
    const nextDepth = compactHistoryDepthRef.current + 1
    window.history.pushState(
      { ...window.history.state, clarinChatSurface: surface, clarinChatId: chatId, clarinChatDepth: nextDepth },
      '',
      window.location.href,
    )
    compactHistoryDepthRef.current = nextDepth
  }, [layoutMode])

  const openChat = useCallback((chat: Chat, addHistory = true) => {
    setSelectedChat(chat)
    setShowContactInfo(false)
    setCompactSurface('conversation')
    closeRowMenu()
    if (addHistory) pushCompactHistory('conversation', chat.id)
  }, [closeRowMenu, pushCompactHistory])

  const openContactInfo = useCallback((addHistory = true) => {
    if (!selectedChat) return
    setShowContactInfo(true)
    setCompactSurface('details')
    if (addHistory) pushCompactHistory('details', selectedChat.id)
  }, [pushCompactHistory, selectedChat])

  const openChatDetails = useCallback((chat: Chat) => {
    setSelectedChat(chat)
    setShowContactInfo(true)
    setCompactSurface('details')
    closeRowMenu()
    if (layoutMode === 'compact') {
      pushCompactHistory('conversation', chat.id)
      pushCompactHistory('details', chat.id)
    }
  }, [closeRowMenu, layoutMode, pushCompactHistory])

  const returnFromCompactSurface = useCallback((surface: 'conversation' | 'details') => {
    if (layoutMode !== 'compact' || typeof window === 'undefined') {
      if (surface === 'details') {
        setShowContactInfo(false)
        setCompactSurface('conversation')
      }
      else {
        setSelectedChat(null)
        setShowContactInfo(false)
        setCompactSurface('list')
      }
      return
    }

    const current = (window.history.state || {}) as CompactHistoryState
    if (current.clarinChatSurface === surface) {
      window.history.back()
      return
    }
    if (surface === 'details') {
      setShowContactInfo(false)
      setCompactSurface('conversation')
    }
    else {
      setShowContactInfo(false)
      setCompactSurface('list')
    }
  }, [layoutMode])

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (layoutMode !== 'compact') return
      const state = (event.state || {}) as CompactHistoryState
      if (state.clarinChatSurface === 'details' && state.clarinChatId) {
        compactHistoryDepthRef.current = Math.max(1, Number(state.clarinChatDepth) || 1)
        const chat = chats.find(item => item.id === state.clarinChatId)
        if (chat) setSelectedChat(chat)
        setShowContactInfo(true)
        setCompactSurface('details')
        return
      }
      if (state.clarinChatSurface === 'conversation' && state.clarinChatId) {
        compactHistoryDepthRef.current = Math.max(1, Number(state.clarinChatDepth) || 1)
        const chat = chats.find(item => item.id === state.clarinChatId)
        if (chat) setSelectedChat(chat)
        setShowContactInfo(false)
        setCompactSurface('conversation')
        return
      }
      setShowContactInfo(false)
      setCompactSurface('list')
      compactHistoryDepthRef.current = 0
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [chats, layoutMode])

  useEffect(() => {
    if (layoutMode === 'compact' || compactHistoryDepthRef.current === 0) return
    const depth = compactHistoryDepthRef.current
    compactHistoryDepthRef.current = 0
    window.history.go(-depth)
  }, [layoutMode])

  // Observe the actual chat workspace, not the browser viewport (sidebar/Eros consume width).
  useEffect(() => {
    const element = pageRef.current
    if (!element) return
    const updateWidth = () => setContainerWidth(element.getBoundingClientRect().width)
    updateWidth()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth)
      return () => window.removeEventListener('resize', updateWidth)
    }
    const observer = new ResizeObserver(updateWidth)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    try {
      const savedLeft = Number(localStorage.getItem('clarin:chats:left-panel-width'))
      const savedRight = Number(localStorage.getItem('clarin:chats:right-panel-width'))
      if (Number.isFinite(savedLeft) && savedLeft > 0) setLeftPanelWidth(clamp(savedLeft, LEFT_PANEL_MIN, LEFT_PANEL_MAX))
      if (Number.isFinite(savedRight) && savedRight > 0) setRightPanelWidth(clamp(savedRight, RIGHT_PANEL_MIN, RIGHT_PANEL_MAX))
    } catch {
      // Storage can be unavailable in hardened browser contexts; defaults remain usable.
    }
  }, [])

  // Keep persisted widths valid after any container resize and preserve the chat
  // canvas minimum whenever three columns are visible.
  useEffect(() => {
    if (layoutMode === 'compact') return
    const reservedRight = layoutMode === 'wide' && showContactInfo
      ? rightPanelWidth + WIDE_PANEL_SEPARATORS_WIDTH
      : PANEL_SEPARATOR_WIDTH
    setLeftPanelWidth(current => clamp(current, LEFT_PANEL_MIN, Math.max(LEFT_PANEL_MIN, Math.min(LEFT_PANEL_MAX, containerWidth - reservedRight - CHAT_PANEL_MIN))))
    if (layoutMode === 'wide' && showContactInfo) {
      setRightPanelWidth(current => clamp(current, RIGHT_PANEL_MIN, Math.max(RIGHT_PANEL_MIN, Math.min(RIGHT_PANEL_MAX, containerWidth - leftPanelWidth - CHAT_PANEL_MIN - WIDE_PANEL_SEPARATORS_WIDTH))))
    }
  }, [containerWidth, layoutMode, showContactInfo, leftPanelWidth, rightPanelWidth])

  // Close panels on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (showMobileFilters) { setShowMobileFilters(false); return }
      if (deleteRequest || deleting || showNewChatModal || showOwnStatuses) return
      if (openRowMenuId) { closeRowMenu(true); return }
      // ContactPanel owns Escape so its nested dialogs can remain the top layer.
      if (showContactInfo) return
      if (selectedChat) { returnFromCompactSurface('conversation'); return }
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [closeRowMenu, deleteRequest, deleting, openRowMenuId, returnFromCompactSurface, selectedChat, showContactInfo, showMobileFilters, showNewChatModal, showOwnStatuses])

  useEffect(() => {
    if (layoutMode !== 'compact') setShowMobileFilters(false)
  }, [layoutMode])

  const closeDeleteDialog = useCallback(() => {
    if (!deleting) setDeleteRequest(null)
  }, [deleting])
  useAccessibleDialog(Boolean(deleteRequest), deleteDialogRef, closeDeleteDialog, deleteCancelRef)

  useEffect(() => {
    if (!openRowMenuId) return
    const closeMenu = () => closeRowMenu()
    document.addEventListener('pointerdown', closeMenu)
    window.addEventListener('resize', closeMenu)
    window.addEventListener('scroll', closeMenu, true)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
    }
  }, [closeRowMenu, openRowMenuId])

  useEffect(() => {
    if (!showToolbarMenu) return
    const closeMenu = (event: PointerEvent) => {
      if (!toolbarMenuRef.current?.contains(event.target as Node)) setShowToolbarMenu(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowToolbarMenu(false)
    }
    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [showToolbarMenu])

  useEffect(() => {
    if (showExpandedToolbar) setShowToolbarMenu(false)
  }, [showExpandedToolbar])

  // Auto-open logic
  const autoOpenProcessedRef = useRef(false)

  // Foreground requests may show loading UI. WebSocket reconciliation is silent
  // and uses its own sequence so it can never cancel a user-triggered query.
  const fetchChats = useCallback(async (reset: boolean = true, options: { silent?: boolean } = {}) => {
    const silent = Boolean(options.silent && reset)
    const sequenceRef = silent ? chatsReconcileSequenceRef : chatsRequestSequenceRef
    const requestSequence = ++sequenceRef.current
    const requestQueryKey = chatQueryKey
    const token = localStorage.getItem('token')
    const offset = reset ? 0 : offsetRef.current
    if (reset && !silent) {
      setLoading(true)
      setLoadingMore(false)
      setChatListError('')
    } else if (!reset) {
      setLoadingMore(true)
    }
    try {
      const params = new URLSearchParams()
      filterDevices.forEach(id => params.append('device_ids', id))
      if (filterUnread) params.append('unread_only', 'true')
      if (debouncedSearch) params.append('search', debouncedSearch)
      if (filterHasReaction) {
        params.append('has_reaction', 'true')
        if (reactionFromMe !== 'any') params.append('reaction_from_me', reactionFromMe === 'me' ? 'true' : 'false')
        reactionEmojis.forEach(e => params.append('reaction_emojis', e))
        const now = new Date()
        let since: Date | null = null
        let until: Date | null = null
        if (reactionRange === '1d') since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
        else if (reactionRange === '7d') since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        else if (reactionRange === '30d') since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        else if (reactionRange === 'custom') {
          if (reactionCustomFrom) since = new Date(reactionCustomFrom)
          if (reactionCustomTo) until = new Date(reactionCustomTo + 'T23:59:59')
        }
        if (since) params.append('reaction_since', since.toISOString())
        if (until) params.append('reaction_until', until.toISOString())
      }
      const requestLimit = silent ? Math.max(CHATS_PAGE_SIZE, offsetRef.current) : CHATS_PAGE_SIZE
      params.append('limit', String(requestLimit))
      params.append('offset', String(offset))

      const res = await fetch(`/api/chats?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.success) throw new Error(data?.error || 'No se pudieron cargar las conversaciones.')
      if (requestSequence !== sequenceRef.current || requestQueryKey !== activeChatQueryKeyRef.current) return
      if (data.success) {
        setChatListError('')
        const newChats: Chat[] = data.chats || []
        const total: number = data.total ?? 0
        setTotalChats(total)

        if (reset) {
          setChats(current => silent ? reconcileChatSnapshots(current, newChats) : newChats)
          const visibleIds = new Set(newChats.map(chat => chat.id))
          setSelectedChats(current => {
            const next = new Set(Array.from(current).filter(id => visibleIds.has(id)))
            return next.size === current.size ? current : next
          })
          offsetRef.current = newChats.length
        } else {
          // Append with deduplication
          setChats(prev => {
            const existingIds = new Set(prev.map(c => c.id))
            const unique = newChats.filter(c => !existingIds.has(c.id))
            return [...prev, ...unique]
          })
          offsetRef.current = offset + newChats.length
        }
        setHasMore((offset + newChats.length) < total)
      }
    } catch (err) {
      if (requestSequence === sequenceRef.current && requestQueryKey === activeChatQueryKeyRef.current) {
        if (silent) console.warn('Silent chat reconciliation failed', err)
        else {
          console.error('Failed to fetch chats', err)
          setChatListError(err instanceof Error ? err.message : 'No se pudieron cargar las conversaciones.')
        }
      }
    } finally {
      if (requestSequence === sequenceRef.current && requestQueryKey === activeChatQueryKeyRef.current) {
        if (!silent) setLoading(false)
        if (!reset) setLoadingMore(false)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterDevices, filterUnread, debouncedSearch, filterHasReaction, reactionFromMe, reactionEmojis, reactionRange, reactionCustomFrom, reactionCustomTo])

  const loadMoreChats = useCallback(() => {
    if (loadingMore || !hasMore) return
    fetchChats(false)
  }, [loadingMore, hasMore, fetchChats])

  const handleChatListScroll = useCallback(() => {
    const el = chatListRef.current
    if (!el || !hasMore || loadingMore) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
      loadMoreChats()
    }
  }, [hasMore, loadingMore, loadMoreChats])

  const fetchDevices = useCallback(async () => {
    const requestSequence = ++devicesRequestSequenceRef.current
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/devices', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (requestSequence === devicesRequestSequenceRef.current && data.success) setDevices(data.devices || [])
    } catch {}
  }, [])

  useEffect(() => {
    fetchChats()
    fetchDevices()
  }, [fetchChats, fetchDevices])

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), 500)
    return () => clearTimeout(timer)
  }, [searchTerm])

  // A selection always belongs to the currently visible result set.
  useEffect(() => {
    chatsReconcileSequenceRef.current++
    if (reconcileTimerRef.current) {
      clearTimeout(reconcileTimerRef.current)
      reconcileTimerRef.current = null
    }
    setSelectedChats(new Set())
    setSelectionMode(false)
    closeRowMenu()
  }, [closeRowMenu, searchTerm, filterDevices, filterUnread, filterHasReaction, reactionFromMe, reactionEmojis, reactionRange, reactionCustomFrom, reactionCustomTo])

  // Auto-open handling
  useEffect(() => {
    if (autoOpenProcessedRef.current) return
    const params = new URLSearchParams(window.location.search)
    const openChatId = params.get('open')
    const jid = params.get('jid')
    const deviceId = params.get('device')

    if (openChatId) {
      const chat = chats.find(c => c.id === openChatId)
      if (chat) {
        setSelectedChat(chat)
        setCompactSurface('conversation')
        autoOpenProcessedRef.current = true
        window.history.replaceState({}, '', '/dashboard/chats')
      } else if (chats.length > 0) {
        // Fetch specific chat if not in list
        const token = localStorage.getItem('token')
        fetch(`/api/chats/${openChatId}`, { headers: { Authorization: `Bearer ${token}` } })
          .then(r => r.json())
          .then(data => {
            if (data.success && data.chat) {
               setSelectedChat(data.chat)
               setCompactSurface('conversation')
               autoOpenProcessedRef.current = true
               window.history.replaceState({}, '', '/dashboard/chats')
            }
          })
      }
    } else if (jid && deviceId) {
       // Search by JID logic simplified for brevity, similar to original
       const chat = chats.find(c => c.jid === jid && c.device_id === deviceId)
       if (chat) {
          setSelectedChat(chat)
          setCompactSurface('conversation')
          autoOpenProcessedRef.current = true
          window.history.replaceState({}, '', '/dashboard/chats')
       }
    }
  }, [chats, fetchChats])

  const applyMessageToChatList = useCallback((rawPayload: unknown) => {
    const payload = (rawPayload || {}) as {
      chat_id?: string
      unread_count?: number
      message?: Partial<Message> & { chat_id?: string }
    }
    const message = (payload.message || payload) as Partial<Message> & { chat_id?: string }
    const chatId = payload.chat_id || message.chat_id
    if (!chatId) return

    const messageIdentity = message.message_id || message.id
    if (messageIdentity) {
      const eventKey = `${chatId}:${messageIdentity}`
      const now = Date.now()
      const previous = processedMessageEventsRef.current.get(eventKey)
      if (previous && now - previous < CHAT_EVENT_DEDUPE_WINDOW) return
      processedMessageEventsRef.current.set(eventKey, now)
      if (processedMessageEventsRef.current.size > 200) {
        for (const [key, seenAt] of Array.from(processedMessageEventsRef.current.entries())) {
          if (now - seenAt >= CHAT_EVENT_DEDUPE_WINDOW) processedMessageEventsRef.current.delete(key)
        }
      }
    }

    setChats(current => {
      const index = current.findIndex(chat => chat.id === chatId)
      if (index < 0) return current
      const existing = current[index]
      const timestamp = message.timestamp || existing.last_message_at
      const unreadCount = typeof payload.unread_count === 'number'
        ? payload.unread_count
        : message.is_from_me || selectedChatIdRef.current === chatId
          ? existing.unread_count
          : existing.unread_count + 1
      const updated: Chat = {
        ...existing,
        last_message: chatPreviewFromMessage(message),
        last_message_at: timestamp,
        unread_count: unreadCount,
      }
      const next = current.slice()
      next[index] = updated
      next.sort((a, b) => messageTimestampValue(b.last_message_at) - messageTimestampValue(a.last_message_at))
      return next
    })
  }, [])

  const scheduleChatReconciliation = useCallback(() => {
    if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current)
    reconcileTimerRef.current = setTimeout(() => {
      reconcileTimerRef.current = null
      void fetchChats(true, { silent: true })
    }, CHAT_LIST_RECONCILE_DELAY)
  }, [fetchChats])

  useEffect(() => () => {
    if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current)
  }, [])

  // WebSocket for List Updates
  useEffect(() => {
    const unsubscribe = subscribeWebSocket((data: unknown) => {
      const msg = data as { event?: string; type?: string; data?: unknown; message?: unknown }
      const eventType = msg.event || msg.type
      if (eventType === 'new_message' || eventType === 'message_sent') {
        applyMessageToChatList(msg.data || msg.message)
        scheduleChatReconciliation()
      } else if (eventType === 'chat_update' || eventType === 'contact_update') {
        scheduleChatReconciliation()
      } else if (eventType === 'device_status') {
        fetchDevices()
      }
    })
    return () => unsubscribe()
  }, [applyMessageToChatList, fetchDevices, scheduleChatReconciliation])

  const panelBounds = useCallback((panel: ResizePanel) => {
    const width = pageRef.current?.getBoundingClientRect().width || containerWidth
    if (panel === 'left') {
      const reserved = layoutMode === 'wide' && showContactInfo
        ? rightPanelWidth + CHAT_PANEL_MIN + WIDE_PANEL_SEPARATORS_WIDTH
        : CHAT_PANEL_MIN + PANEL_SEPARATOR_WIDTH
      return { min: LEFT_PANEL_MIN, max: Math.max(LEFT_PANEL_MIN, Math.min(LEFT_PANEL_MAX, width - reserved)) }
    }
    return { min: RIGHT_PANEL_MIN, max: Math.max(RIGHT_PANEL_MIN, Math.min(RIGHT_PANEL_MAX, width - leftPanelWidth - CHAT_PANEL_MIN - WIDE_PANEL_SEPARATORS_WIDTH)) }
  }, [containerWidth, layoutMode, leftPanelWidth, rightPanelWidth, showContactInfo])

  const updatePanelWidth = useCallback((panel: ResizePanel, value: number, persist = true) => {
    const bounds = panelBounds(panel)
    const next = clamp(value, bounds.min, bounds.max)
    if (panel === 'left') setLeftPanelWidth(next)
    else setRightPanelWidth(next)
    if (persist) {
      try {
        localStorage.setItem(`clarin:chats:${panel}-panel-width`, String(next))
      } catch {
        // Resizing remains functional without persistence.
      }
    }
  }, [panelBounds])

  const startResize = (panel: ResizePanel, e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    resizingRef.current = {
      panel,
      startX: e.clientX,
      startWidth: panel === 'left' ? leftPanelWidth : rightPanelWidth,
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const resize = resizingRef.current
      if (!resize) return
      const coordinateDelta = e.clientX - resize.startX
      const widthDelta = resize.panel === 'left' ? coordinateDelta : -coordinateDelta
      updatePanelWidth(resize.panel, resize.startWidth + widthDelta)
    }
    const handlePointerUp = () => {
      resizingRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [updatePanelWidth])

  const handleSeparatorKeyDown = (panel: ResizePanel, event: React.KeyboardEvent<HTMLDivElement>) => {
    const bounds = panelBounds(panel)
    const current = panel === 'left' ? leftPanelWidth : rightPanelWidth
    const step = event.shiftKey ? 16 : 4
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = current + (panel === 'left' ? -step : step)
    else if (event.key === 'ArrowRight') next = current + (panel === 'left' ? step : -step)
    else if (event.key === 'Home') next = panel === 'left' ? bounds.min : bounds.max
    else if (event.key === 'End') next = panel === 'left' ? bounds.max : bounds.min
    if (next === null) return
    event.preventDefault()
    updatePanelWidth(panel, next)
  }

  const resetPanelWidth = (panel: ResizePanel) => {
    updatePanelWidth(panel, panel === 'left' ? LEFT_PANEL_DEFAULT : RIGHT_PANEL_DEFAULT)
  }

  const toggleRowMenu = (chatId: string, trigger: HTMLButtonElement) => {
    rowMenuTriggerRef.current = trigger
    if (openRowMenuId === chatId) {
      closeRowMenu(true)
      return
    }

    const rect = trigger.getBoundingClientRect()
    const viewport = window.visualViewport
    const viewportTop = viewport?.offsetTop || 0
    const viewportLeft = viewport?.offsetLeft || 0
    const viewportHeight = viewport?.height || window.innerHeight
    const viewportWidth = viewport?.width || window.innerWidth
    const viewportBottom = viewportTop + viewportHeight
    const viewportRight = viewportLeft + viewportWidth
    const availableBelow = viewportBottom - rect.bottom - VIEWPORT_MARGIN
    const top = availableBelow >= ROW_MENU_HEIGHT
      ? rect.bottom + 6
      : rect.top - ROW_MENU_HEIGHT - 6
    setRowMenuPosition({
      top: clamp(top, viewportTop + VIEWPORT_MARGIN, viewportBottom - ROW_MENU_HEIGHT - VIEWPORT_MARGIN),
      left: clamp(rect.right - ROW_MENU_WIDTH, viewportLeft + VIEWPORT_MARGIN, viewportRight - ROW_MENU_WIDTH - VIEWPORT_MARGIN),
    })
    setOpenRowMenuId(chatId)
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-chat-row-menu-first="${chatId}"]`)?.focus()
    })
  }

  // Selection Logic (Simplified)
  const toggleChatSelection = (chatId: string) => {
    setSelectedChats(current => {
      const next = new Set(current)
      if (next.has(chatId)) next.delete(chatId)
      else next.add(chatId)
      return next
    })
  }

  const toggleSelectAll = () => {
     if (selectedChats.size === chats.length) setSelectedChats(new Set())
     else setSelectedChats(new Set(chats.map(c => c.id)))
  }

  const requestSelectedChatsDeletion = () => {
    const ids = Array.from(selectedChats)
    if (ids.length === 0) return
    setListFeedback('')
    setDeleteRequest({ ids, label: ids.length === 1 ? 'esta conversación' : `${ids.length} conversaciones` })
  }

  const requestSingleChatDeletion = (chat: Chat) => {
    closeRowMenu()
    setListFeedback('')
    setDeleteRequest({ ids: [chat.id], label: `la conversación con ${getChatDisplayName(chat)}` })
  }

  const confirmDeleteChats = async () => {
    if (!deleteRequest || deleting) return
    const ids = [...deleteRequest.ids]
    setDeleting(true)
    setListFeedback('')
    const token = localStorage.getItem('token')
    try {
      const response = ids.length === 1
        ? await fetch(`/api/chats/${ids[0]}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
        : await fetch('/api/chats/batch', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ ids }),
        })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.error || 'No se pudieron eliminar las conversaciones.')
      const deletedIds = new Set(ids)
      setDeleteRequest(null)
      setSelectedChats(new Set())
      setSelectionMode(false)
      setChats(current => current.filter(chat => !deletedIds.has(chat.id)))
      if (selectedChat && deletedIds.has(selectedChat.id)) {
        setSelectedChat(null)
        setShowContactInfo(false)
        setCompactSurface('list')
        if (layoutMode === 'compact' && compactHistoryDepthRef.current > 0) {
          const depth = compactHistoryDepthRef.current
          compactHistoryDepthRef.current = 0
          window.history.go(-depth)
        }
      }
      await fetchChats()
    } catch (error) {
      console.error(error)
      setListFeedback(error instanceof Error ? error.message : 'No se pudieron eliminar las conversaciones.')
    } finally {
      setDeleting(false)
    }
  }

  const handleChatCreated = (chatId: string) => {
    fetchChats()
    setTimeout(() => {
        // Optimistically select new chat
        const token = localStorage.getItem('token')
        fetch(`/api/chats/${chatId}`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(data => {
            if (data.success && data.chat) openChat(data.chat)
        })
    }, 500)
  }

  const selectedDevice = selectedChat?.device_id ? devices.find(device => device.id === selectedChat.device_id) : undefined
  const selectedDeviceName = selectedChat?.device_name || selectedDevice?.name
  const selectedDevicePhone = selectedChat?.device_phone || selectedDevice?.phone
  const selectedDeviceProvider = selectedDevice?.provider || 'whatsapp_web'
  const selectedChatReadOnly = !selectedChat?.device_id
    || !selectedDevice
    || selectedDevice.status !== 'connected'
    || selectedDeviceProvider !== 'whatsapp_web'

  return (
    <div
      ref={pageRef}
      data-layout={layoutMode}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden border-slate-200 bg-white md:rounded-xl md:border"
    >
      {/* Sidebar - Chat List */}
      <div
        className={`min-h-0 shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-white ${layoutMode === 'compact' && compactSurface !== 'list' ? 'hidden' : 'flex'}`}
        style={{ width: layoutMode === 'compact' ? '100%' : leftPanelWidth }}
      >
         <div className="p-3 border-b border-slate-200/70 bg-white/95 backdrop-blur space-y-3">
            {/* Header / Selection Mode. Search gets the full compact viewport while the software keyboard is open. */}
            {!collapseMobileListToolbar && (selectionMode ? (
                <div className="flex min-h-11 items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                <button type="button" onClick={() => { setSelectionMode(false); setSelectedChats(new Set()) }} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Salir de selección"><X className="w-4 h-4" /></button>
                        <div>
                          <p className="text-xs font-semibold text-slate-700">{selectedChats.size} seleccionados</p>
                          <p className="text-[10px] text-slate-400">Solo chats cargados ({chats.length})</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                <button type="button" onClick={toggleSelectAll} disabled={chats.length === 0} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40" aria-label={selectedChats.size === chats.length && chats.length > 0 ? 'Quitar selección de chats cargados' : 'Seleccionar todos los chats cargados'} title="Seleccionar todos los chats cargados"><CheckSquare className="w-4 h-4" /></button>
                <button type="button" onClick={requestSelectedChatsDeletion} disabled={deleting || selectedChats.size === 0} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-40" aria-label="Eliminar chats seleccionados"><Trash2 className="w-4 h-4" /></button>
                    </div>
                </div>
            ) : (
                <div className="flex min-h-11 min-w-0 items-center gap-1.5">
                    <DeviceSelector
                        devices={devices}
                        selectedDeviceIds={filterDevices}
                        onDeviceChange={setFilterDevices}
                        className="min-w-0 flex-1"
                    />
                    {showExpandedToolbar && (
                      <>
                        <button type="button" onClick={() => { setSelectionMode(true); setSelectedChats(new Set()) }} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Seleccionar chats" title="Seleccionar chats">
                            <ListChecks className="w-4 h-4" />
                        </button>
                        <button type="button" onClick={() => setShowOwnStatuses(true)} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Mis estados" title="Mis estados">
                            <Sparkles className="w-4 h-4" />
                        </button>
                      </>
                    )}
                    <button type="button" onClick={() => setShowNewChatModal(true)} className={`flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-emerald-600 text-xs font-semibold text-white shadow-sm shadow-emerald-600/20 transition hover:bg-emerald-700 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 active:scale-[0.98] ${showExpandedToolbar ? 'px-3' : 'w-11'}`} aria-label="Nuevo chat" title="Nuevo chat">
                        <Plus className="w-4 h-4" />
                        {showExpandedToolbar && <span>Nuevo chat</span>}
                    </button>
                    {!showExpandedToolbar && (
                      <div ref={toolbarMenuRef} className="relative shrink-0">
                        <button type="button" onClick={() => setShowToolbarMenu(value => !value)} className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Más acciones de chats" aria-haspopup="menu" aria-expanded={showToolbarMenu}>
                          <MoreVertical className="h-4 w-4" />
                        </button>
                        {showToolbarMenu && (
                          <div role="menu" className="fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-[70] max-h-[min(70dvh,24rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-900/15 sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-12 sm:w-52">
                            <button type="button" role="menuitem" onClick={() => { setShowOwnStatuses(true); setShowToolbarMenu(false) }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-700 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><Sparkles className="h-4 w-4 text-emerald-600" /> Mis estados</button>
                            <button type="button" role="menuitem" onClick={() => { setSelectionMode(true); setSelectedChats(new Set()); setShowToolbarMenu(false) }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><ListChecks className="h-4 w-4 text-slate-500" /> Seleccionar chats</button>
                          </div>
                        )}
                      </div>
                    )}
                </div>
            ))}

            {listFeedback && (
              <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs font-medium text-red-700" role="alert">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">{listFeedback}</span>
                <button type="button" onClick={() => setListFeedback('')} className="-m-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500" aria-label="Cerrar aviso"><X className="h-3.5 w-3.5" /></button>
              </div>
            )}

            {chatListError && chats.length > 0 && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800" role="status">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">{chatListError}</span>
                <button type="button" onClick={() => void fetchChats()} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500" aria-label="Reintentar"><RotateCcw className="h-3.5 w-3.5" /></button>
              </div>
            )}

            {/* Search */}
             <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                ref={searchInputRef}
                type="text"
                placeholder="Buscar chats..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onFocus={() => setListSearchFocused(true)}
                onBlur={() => setListSearchFocused(false)}
                className={`w-full pl-9 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 focus:bg-white focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 outline-none transition-all placeholder:text-slate-400 ${layoutMode === 'compact' ? 'pr-12' : 'pr-3'}`}
                />
                {layoutMode === 'compact' && (
                  <button
                    type="button"
                    onClick={() => { searchInputRef.current?.blur(); setShowMobileFilters(true) }}
                    className="absolute right-0 top-0 inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                    aria-label={`Abrir filtros de chats${activeMobileFilterCount ? `, ${activeMobileFilterCount} activos` : ''}`}
                  >
                    <SlidersHorizontal className="h-4.5 w-4.5" />
                    {activeMobileFilterCount > 0 && <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-600 px-1 text-[9px] font-bold text-white">{activeMobileFilterCount}</span>}
                  </button>
                )}
            </div>

              {/* Quick filters */}
              {layoutMode !== 'compact' && <div className="flex flex-wrap items-center gap-2">
                <button
                    onClick={() => setFilterUnread(!filterUnread)}
                  className={`flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-all duration-200 active:scale-[0.98] ${
                        filterUnread
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-300 shadow-sm'
                            : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-700'
                    }`}
                >
                    <MessageCircle className="w-3.5 h-3.5" />
                    No leídos
                </button>
                <button
                    data-testid="filter-reaction-toggle"
                    onClick={() => setFilterHasReaction(!filterHasReaction)}
                  className={`flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-all duration-200 active:scale-[0.98] ${
                        filterHasReaction
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-300 shadow-sm'
                            : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-700'
                    }`}
                    title="Filtrar chats con reacciones"
                >
                  <Heart className={`w-3.5 h-3.5 ${filterHasReaction ? 'fill-emerald-500 text-emerald-500' : ''}`} />
                    Con reacción
                </button>
            </div>}

            {/* Reaction advanced panel */}
            {layoutMode !== 'compact' && filterHasReaction && (
                <div data-testid="filter-reaction-advanced" className="max-h-[min(44dvh,22rem)] space-y-2 overflow-y-auto overscroll-contain rounded-xl border border-emerald-200 bg-emerald-50/40 p-2.5 shadow-sm shadow-emerald-600/5">
                    <button
                        onClick={() => setShowReactionAdvanced(!showReactionAdvanced)}
                    className="flex min-h-11 w-full items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-emerald-700 transition-colors hover:text-emerald-800"
                    >
                        <span className="flex items-center gap-1.5">
                      <Heart className="w-3 h-3 fill-emerald-500 text-emerald-500" />
                            Opciones de reacción
                        </span>
                        {showReactionAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                    {showReactionAdvanced && (
                        <div className="space-y-2.5 pt-1">
                            <div>
                                <label className="block text-[10px] font-medium text-slate-600 mb-1 uppercase tracking-wide">¿De quién?</label>
                                <div className="flex gap-1">
                                    {([
                                        { v: 'client' as const, label: 'Cliente' },
                                        { v: 'me' as const, label: 'Operador' },
                                        { v: 'any' as const, label: 'Cualquiera' },
                                    ]).map(opt => (
                                        <button
                                            key={opt.v}
                                            data-testid={`reaction-from-${opt.v}`}
                                            onClick={() => setReactionFromMe(opt.v)}
                                            className={`min-h-11 flex-1 rounded-md border px-2 text-[11px] font-medium transition-all ${
                                                reactionFromMe === opt.v
                                                ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                                                : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-300 hover:text-slate-800'
                                            }`}
                                        >{opt.label}</button>
                                    ))}
                                </div>
                            </div>
                            <div>
                                <label className="block text-[10px] font-medium text-slate-600 mb-1 uppercase tracking-wide">Emojis (opcional)</label>
                                <div className="flex flex-wrap gap-1">
                                    {['👍','❤️','😂','😮','😢','🙏','🔥'].map(e => {
                                        const active = reactionEmojis.includes(e)
                                        return (
                                            <button
                                                key={e}
                                                data-testid={`reaction-emoji-${e}`}
                                                onClick={() => setReactionEmojis(active ? reactionEmojis.filter(x => x !== e) : [...reactionEmojis, e])}
                                                className={`flex h-11 w-11 items-center justify-center rounded-md border text-sm transition-all ${
                                                  active ? 'bg-emerald-100 border-emerald-400 ring-2 ring-emerald-200' : 'bg-white border-slate-200 hover:border-emerald-300'
                                                }`}
                                            >{e}</button>
                                        )
                                    })}
                                    {reactionEmojis.length > 0 && (
                                        <button
                                            data-testid="reaction-emoji-clear"
                                            onClick={() => setReactionEmojis([])}
                                            className="h-11 px-2 text-[10px] text-slate-500 transition-colors hover:text-emerald-700"
                                        >limpiar</button>
                                    )}
                                </div>
                            </div>
                            <div>
                                <label className="block text-[10px] font-medium text-slate-600 mb-1 uppercase tracking-wide">Cuándo</label>
                                <div className="flex flex-wrap gap-1">
                                    {([
                                        { v: '1d' as const, label: 'Hoy' },
                                        { v: '7d' as const, label: '7 días' },
                                        { v: '30d' as const, label: '30 días' },
                                        { v: 'any' as const, label: 'Siempre' },
                                        { v: 'custom' as const, label: 'Rango' },
                                    ]).map(opt => (
                                        <button
                                            key={opt.v}
                                            data-testid={`reaction-range-${opt.v}`}
                                            onClick={() => setReactionRange(opt.v)}
                                            className={`min-h-11 rounded-md border px-3 text-[11px] font-medium transition-all ${
                                                reactionRange === opt.v
                                                ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                                                : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-300 hover:text-slate-800'
                                            }`}
                                        >{opt.label}</button>
                                    ))}
                                </div>
                                {reactionRange === 'custom' && (
                                    <div className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                                        <input
                                            type="date"
                                            value={reactionCustomFrom}
                                            onChange={e => setReactionCustomFrom(e.target.value)}
                                            className="h-11 min-w-0 rounded-md border border-slate-200 bg-white px-2 text-[11px] outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-300"
                                        />
                                        <input
                                            type="date"
                                            value={reactionCustomTo}
                                            onChange={e => setReactionCustomTo(e.target.value)}
                                            className="h-11 min-w-0 rounded-md border border-slate-200 bg-white px-2 text-[11px] outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-300"
                                        />
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}
         </div>

         {/* Chat List Items */}
         <div ref={chatListRef} onScroll={handleChatListScroll} className="flex-1 overflow-y-auto">
            {chatListError && chats.length === 0 && !loading ? (
            <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-700"><AlertTriangle className="h-6 w-6" /></div>
              <h3 className="mt-4 text-sm font-semibold text-slate-800">No pudimos cargar los chats</h3>
              <p className="mt-1 max-w-[240px] text-xs leading-5 text-slate-500">{chatListError}</p>
              <button type="button" onClick={() => void fetchChats()} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><RotateCcw className="h-4 w-4" /> Reintentar</button>
            </div>
            ) : loading ? (
            <div className="p-3 space-y-3">
              {[0, 1, 2, 3, 4, 5].map(i => (
                <div key={i} className="flex min-h-[78px] items-center gap-2.5 border-b border-slate-100 bg-white px-2.5 py-2 animate-pulse">
                  <div className="h-11 w-11 rounded-full bg-slate-100" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="h-3.5 w-2/3 rounded bg-slate-100" />
                    <div className="h-3 w-full rounded bg-slate-100" />
                    <div className="h-2.5 w-1/3 rounded bg-slate-100" />
                  </div>
                </div>
              ))}
            </div>
            ) : chats.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
              <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
                <MessageCircle className="w-7 h-7 text-slate-400" />
              </div>
              <h3 className="text-sm font-semibold text-slate-700 mb-1">No se encontraron chats</h3>
              <p className="text-xs leading-5 text-slate-500 max-w-[220px]">Prueba con otra búsqueda o desactiva algún filtro para ampliar los resultados.</p>
            </div>
            ) : (
                <div style={{ height: chatVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
                {chatVirtualizer.getVirtualItems().map(virtualRow => {
                    const chat = chats[virtualRow.index]
                    if (!chat) return null
                    return (
                    <div
                        key={chat.id}
                        ref={chatVirtualizer.measureElement}
                        data-index={virtualRow.index}
                        style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          setSelectionMode(true)
                          toggleChatSelection(chat.id)
                        }}
                        onClick={() => {
                            if (selectionMode) toggleChatSelection(chat.id)
                            else {
                              openChat(chat)
                            }
                        }}
                        onKeyDown={event => {
                          if (event.key !== 'Enter' && event.key !== ' ') return
                          if ((event.target as HTMLElement).closest('button, input, label')) return
                          event.preventDefault()
                          if (selectionMode) toggleChatSelection(chat.id)
                          else openChat(chat)
                        }}
                        role="button"
                        tabIndex={0}
                        aria-current={selectedChat?.id === chat.id ? 'true' : undefined}
                        aria-label={`Conversación con ${getChatDisplayName(chat)}`}
                        className={`group relative flex min-h-[78px] cursor-pointer items-start gap-2.5 border-b border-l-4 px-2.5 py-2 pr-9 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 ${selectedChat?.id === chat.id ? 'border-b-emerald-200 border-l-emerald-600 bg-emerald-100 shadow-[inset_0_0_0_1px_rgba(5,150,105,0.12)] hover:bg-emerald-100' : 'border-b-slate-100 border-l-transparent hover:bg-slate-50'}`}
                    >
                        {selectionMode && (
                          <label className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl hover:bg-slate-100 focus-within:ring-2 focus-within:ring-emerald-500" onClick={event => event.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selectedChats.has(chat.id)}
                              onChange={() => toggleChatSelection(chat.id)}
                              className="h-5 w-5 cursor-pointer rounded border-slate-300 accent-emerald-600 focus-visible:outline-none"
                              aria-label={`Seleccionar conversación con ${getChatDisplayName(chat)}`}
                            />
                          </label>
                        )}

                        <div className="relative shrink-0">
                             {chat.contact_avatar_url ? (
                              <img src={chat.contact_avatar_url} alt="" className="h-11 w-11 rounded-full object-cover ring-1 ring-slate-200 shadow-sm" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden') }} />
                             ) : null}
                            <div className={`flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 ring-1 ring-emerald-100 shadow-sm ${chat.contact_avatar_url ? 'hidden' : ''}`}>
                                <span className="text-base font-bold text-emerald-700">{getChatDisplayName(chat).charAt(0).toUpperCase()}</span>
                             </div>
                             {chat.unread_count > 0 && (
                              <div className="absolute -top-1 -right-1 bg-emerald-500 text-white text-[10px] font-bold h-5 min-w-5 px-1.5 rounded-full flex items-center justify-center shadow-sm ring-2 ring-white tabular-nums">
                                    {chat.unread_count}
                                </div>
                             )}
                        </div>

                        <div className="min-w-0 flex-1">
                            <div className="mb-0.5 flex items-start justify-between gap-1">
                                <h3 className={`truncate pr-2 text-sm font-semibold leading-5 ${chat.unread_count > 0 ? 'text-slate-950' : 'text-slate-800'}`}>
                                    {getChatDisplayName(chat)}
                                </h3>
                                <div className="flex shrink-0 items-center">
                                  <span className={`whitespace-nowrap pt-0.5 text-[10px] ${chat.unread_count > 0 ? 'font-bold text-emerald-700' : 'text-slate-400'}`}>
                                      {formatTime(chat.last_message_at)}
                                  </span>
                                </div>
                            </div>
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-xs text-slate-500 truncate block">
                                    {chat.last_message || 'Sin mensajes'}
                                </span>
                            </div>
                            {/* Device & Phone Labels */}
                            <div className="mt-1 flex min-w-0 items-center gap-1.5">
                                 {chat.device_name && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-slate-100/80 text-slate-500 border border-slate-200/80 max-w-[120px] truncate">
                                        {chat.device_name}
                                    </span>
                                 )}
                                 {formatPhone(chat.jid, chat.contact_phone) && formatPhone(chat.jid, chat.contact_phone) !== getChatDisplayName(chat) && (
                                    <span className="text-[10px] text-slate-400 truncate">
                                        {formatPhone(chat.jid, chat.contact_phone)}
                                    </span>
                                 )}
                                 {chat.lead_is_blocked && (
                                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-50 text-red-600 border border-red-200">
                                        <ShieldBan className="w-3 h-3" />
                                        Bloqueado
                                    </span>
                                 )}
                            </div>
                        </div>

                        {!selectionMode && (
                          <div className="absolute right-0.5 top-1/2 -translate-y-1/2">
                            <button
                              id={`chat-row-menu-trigger-${chat.id}`}
                              type="button"
                              onPointerDown={event => event.stopPropagation()}
                              onClick={event => {
                                event.stopPropagation()
                                toggleRowMenu(chat.id, event.currentTarget)
                              }}
                              className="touch-action-visible inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 opacity-100 transition hover:bg-white/90 hover:text-slate-700 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 sm:h-9 sm:w-9 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                              aria-label={`Acciones para ${getChatDisplayName(chat)}`}
                              aria-haspopup="menu"
                              aria-expanded={openRowMenuId === chat.id}
                            >
                              <MoreVertical className="h-4 w-4" />
                            </button>
                            {openRowMenuId === chat.id && rowMenuPosition && typeof document !== 'undefined' && createPortal(
                              <div
                                role="menu"
                                aria-labelledby={`chat-row-menu-trigger-${chat.id}`}
                                className="fixed z-[80] max-h-[calc(100dvh-1rem)] w-52 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-900/15"
                                style={{ top: rowMenuPosition.top, left: rowMenuPosition.left }}
                                onPointerDown={event => event.stopPropagation()}
                                onClick={event => event.stopPropagation()}
                              >
                                <button data-chat-row-menu-first={chat.id} type="button" role="menuitem" onClick={() => openChat(chat)} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><MessageCircle className="h-4 w-4 text-slate-400" /> Abrir conversación</button>
                                <button type="button" role="menuitem" onClick={() => openChatDetails(chat)} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><PanelRight className="h-4 w-4 text-slate-400" /> Ver detalles</button>
                                <button type="button" role="menuitem" onClick={() => { setSelectionMode(true); setSelectedChats(new Set([chat.id])); closeRowMenu() }} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><CheckSquare className="h-4 w-4 text-slate-400" /> Seleccionar</button>
                                <div className="my-1 border-t border-slate-100" />
                                <button type="button" role="menuitem" onClick={() => requestSingleChatDeletion(chat)} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs font-semibold text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"><Trash2 className="h-4 w-4" /> Eliminar del CRM</button>
                              </div>
                            , document.body)}
                          </div>
                        )}
                    </div>
                    )
                })}
                </div>
            )}
            {/* Loading more indicator */}
            {loadingMore && (
              <div className="flex justify-center py-3">
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-emerald-200 border-t-emerald-600" />
              </div>
            )}
            {!hasMore && chats.length > 0 && totalChats > CHATS_PAGE_SIZE && (
              <div className="text-center py-3 text-[11px] text-slate-400">
                {totalChats} chats cargados
              </div>
            )}
         </div>
      </div>

      {/* Resizer */}
      {layoutMode !== 'compact' && (
        <div
            role="separator"
            aria-label="Cambiar ancho de la lista de chats"
            aria-orientation="vertical"
            aria-valuemin={panelBounds('left').min}
            aria-valuemax={panelBounds('left').max}
            aria-valuenow={leftPanelWidth}
            tabIndex={0}
            onPointerDown={event => startResize('left', event)}
            onKeyDown={event => handleSeparatorKeyDown('left', event)}
            onDoubleClick={() => resetPanelWidth('left')}
            className="group relative z-10 shrink-0 cursor-col-resize touch-none bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
            style={{ width: PANEL_SEPARATOR_WIDTH }}
            title="Arrastra para ajustar. Doble clic para restablecer."
        >
          <span aria-hidden="true" className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-200 transition-all group-hover:w-1 group-hover:bg-emerald-300 group-active:bg-emerald-500" />
        </div>
      )}

      {/* Main Chat Panel */}
      <div className={`${layoutMode === 'compact' && compactSurface === 'list' ? 'hidden' : 'flex'} relative min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-slate-50/70`} style={layoutMode === 'compact' ? undefined : { minWidth: CHAT_PANEL_MIN }}>
        {selectedChat ? (
	            <ChatPanel
	                chatId={selectedChat.id}
	                deviceId={selectedChat.device_id || ''}
	                device={selectedDevice}
	                initialChat={selectedChat}
	                readOnly={selectedChatReadOnly}
	                onClose={() => returnFromCompactSurface('conversation')}
	                onContactInfoToggle={show => {
	                  if (show) openContactInfo()
	                  else returnFromCompactSurface('details')
	                }}
	                contactInfoOpen={showContactInfo}
	                onRequestDelete={() => requestSingleChatDeletion(selectedChat)}
	                isActive={layoutMode !== 'compact' || compactSurface === 'conversation'}
	            />
        ) : (
            <div className="flex flex-1 flex-col items-center justify-center bg-[radial-gradient(circle_at_center,rgba(16,185,129,0.08)_1px,transparent_1px)] bg-[length:22px_22px] p-8 text-center text-slate-400">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <MessageCircle className="h-7 w-7 text-emerald-500" />
                </div>
                <p className="text-sm font-semibold text-slate-700">Selecciona una conversación</p>
                <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-500">Consulta mensajes, datos del contacto y oportunidades sin perder el contexto del CRM.</p>
            </div>
        )}
      </div>

      {/* Right Resizer + Contact Panel (3rd column) */}
      {layoutMode === 'wide' && showContactInfo && selectedChat && (
        <>
          <div
            role="separator"
            aria-label="Cambiar ancho del panel de detalles"
            aria-orientation="vertical"
            aria-valuemin={panelBounds('right').min}
            aria-valuemax={panelBounds('right').max}
            aria-valuenow={rightPanelWidth}
            tabIndex={0}
            onPointerDown={event => startResize('right', event)}
            onKeyDown={event => handleSeparatorKeyDown('right', event)}
            onDoubleClick={() => resetPanelWidth('right')}
            className="group relative z-10 shrink-0 cursor-col-resize touch-none bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
            style={{ width: PANEL_SEPARATOR_WIDTH }}
            title="Arrastra para ajustar. Doble clic para restablecer."
          >
            <span aria-hidden="true" className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-200 transition-all group-hover:w-1 group-hover:bg-emerald-300 group-active:bg-emerald-500" />
          </div>
          <div className="shrink-0 overflow-hidden bg-white" style={{ width: rightPanelWidth }}>
            <ContactPanel
              chatId={selectedChat.id}
              isOpen={true}
              onClose={() => returnFromCompactSurface('details')}
              deviceName={selectedDeviceName}
              devicePhone={selectedDevicePhone}
              chatPhone={formatPhone(selectedChat.jid, selectedChat.contact_phone)}
            />
          </div>
        </>
      )}

      {/* Medium widths use a drawer; compact widths use a full workspace panel. */}
      {layoutMode !== 'wide' && showContactInfo && selectedChat && (
        <>
          {layoutMode === 'medium' && <button type="button" className="absolute inset-0 z-20 bg-slate-950/20" onClick={() => setShowContactInfo(false)} aria-label="Cerrar detalles" />}
          <div
            className={`absolute inset-y-0 right-0 z-30 overflow-hidden bg-white shadow-2xl ${layoutMode === 'compact' ? 'left-0' : 'border-l border-slate-200'}`}
            style={layoutMode === 'compact' ? undefined : { width: 'clamp(360px, 38vw, 440px)', maxWidth: '92%' }}
          >
            <ContactPanel
              chatId={selectedChat.id}
              isOpen={true}
              onClose={() => returnFromCompactSurface('details')}
              deviceName={selectedDeviceName}
              devicePhone={selectedDevicePhone}
              chatPhone={formatPhone(selectedChat.jid, selectedChat.contact_phone)}
            />
          </div>
        </>
      )}

      {showMobileFilters && layoutMode === 'compact' && typeof document !== 'undefined' && createPortal(
        <div className="app-viewport fixed inset-0 z-[90] flex flex-col bg-white" role="dialog" aria-modal="true" aria-labelledby="mobile-chat-filters-title">
          <div className="safe-area-top flex min-h-16 shrink-0 items-center justify-between border-b border-slate-200 px-4">
            <div className="min-w-0">
              <h2 id="mobile-chat-filters-title" className="font-bold text-slate-900">Filtros de chats</h2>
              <p className="text-xs text-slate-500">{activeMobileFilterCount ? `${activeMobileFilterCount} activo${activeMobileFilterCount === 1 ? '' : 's'}` : 'Sin filtros activos'}</p>
            </div>
            <button type="button" onClick={() => setShowMobileFilters(false)} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Cerrar filtros"><X className="h-5 w-5" /></button>
          </div>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
            <section aria-labelledby="mobile-basic-chat-filters" className="space-y-2">
              <h3 id="mobile-basic-chat-filters" className="text-xs font-bold uppercase tracking-wider text-slate-400">Mostrar</h3>
              <button type="button" onClick={() => setFilterUnread(value => !value)} className={`flex min-h-12 w-full items-center justify-between rounded-xl border px-4 text-sm font-semibold ${filterUnread ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-700'}`} aria-pressed={filterUnread}>
                <span className="flex items-center gap-3"><MessageCircle className="h-5 w-5" />Solo no leídos</span>
                <span className={`h-5 w-9 rounded-full p-0.5 transition ${filterUnread ? 'bg-emerald-600' : 'bg-slate-200'}`}><span className={`block h-4 w-4 rounded-full bg-white shadow transition ${filterUnread ? 'translate-x-4' : ''}`} /></span>
              </button>
              <button type="button" data-testid="mobile-filter-reaction-toggle" onClick={() => setFilterHasReaction(value => !value)} className={`flex min-h-12 w-full items-center justify-between rounded-xl border px-4 text-sm font-semibold ${filterHasReaction ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-700'}`} aria-pressed={filterHasReaction}>
                <span className="flex items-center gap-3"><Heart className={`h-5 w-5 ${filterHasReaction ? 'fill-emerald-500' : ''}`} />Con reacción</span>
                <span className={`h-5 w-9 rounded-full p-0.5 transition ${filterHasReaction ? 'bg-emerald-600' : 'bg-slate-200'}`}><span className={`block h-4 w-4 rounded-full bg-white shadow transition ${filterHasReaction ? 'translate-x-4' : ''}`} /></span>
              </button>
            </section>

            {filterHasReaction && (
              <section className="space-y-4 rounded-2xl border border-emerald-100 bg-emerald-50/40 p-4" aria-labelledby="mobile-reaction-options">
                <h3 id="mobile-reaction-options" className="text-xs font-bold uppercase tracking-wider text-emerald-700">Opciones de reacción</h3>
                <div>
                  <p className="mb-2 text-xs font-semibold text-slate-600">¿De quién?</p>
                  <div className="grid grid-cols-3 gap-2">
                    {([{ v: 'client' as const, label: 'Cliente' }, { v: 'me' as const, label: 'Operador' }, { v: 'any' as const, label: 'Cualquiera' }]).map(option => (
                      <button key={option.v} type="button" onClick={() => setReactionFromMe(option.v)} className={`min-h-11 rounded-xl border px-2 text-xs font-semibold ${reactionFromMe === option.v ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-200 bg-white text-slate-600'}`}>{option.label}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold text-slate-600">Emojis opcionales</p>
                  <div className="flex flex-wrap gap-2">
                    {['👍','❤️','😂','😮','😢','🙏','🔥'].map(emoji => {
                      const active = reactionEmojis.includes(emoji)
                      return <button key={emoji} type="button" onClick={() => setReactionEmojis(active ? reactionEmojis.filter(value => value !== emoji) : [...reactionEmojis, emoji])} className={`flex h-11 w-11 items-center justify-center rounded-xl border text-base ${active ? 'border-emerald-400 bg-emerald-100 ring-2 ring-emerald-200' : 'border-slate-200 bg-white'}`} aria-pressed={active}>{emoji}</button>
                    })}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold text-slate-600">Período</p>
                  <div className="flex flex-wrap gap-2">
                    {([{ v: '1d' as const, label: 'Hoy' }, { v: '7d' as const, label: '7 días' }, { v: '30d' as const, label: '30 días' }, { v: 'any' as const, label: 'Siempre' }, { v: 'custom' as const, label: 'Rango' }]).map(option => (
                      <button key={option.v} type="button" onClick={() => setReactionRange(option.v)} className={`min-h-11 rounded-xl border px-3 text-xs font-semibold ${reactionRange === option.v ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-200 bg-white text-slate-600'}`}>{option.label}</button>
                    ))}
                  </div>
                  {reactionRange === 'custom' && <div className="mt-3 grid grid-cols-1 gap-2 min-[380px]:grid-cols-2"><label className="text-xs text-slate-500">Desde<input type="date" value={reactionCustomFrom} onChange={event => setReactionCustomFrom(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-slate-700" /></label><label className="text-xs text-slate-500">Hasta<input type="date" value={reactionCustomTo} onChange={event => setReactionCustomTo(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-slate-700" /></label></div>}
                </div>
              </section>
            )}
          </div>
          <div className="safe-area-bottom flex shrink-0 gap-2 border-t border-slate-200 bg-white p-4">
            <button type="button" onClick={() => { setFilterUnread(false); setFilterHasReaction(false); setReactionEmojis([]); setReactionFromMe('client'); setReactionRange('30d'); setReactionCustomFrom(''); setReactionCustomTo('') }} disabled={activeMobileFilterCount === 0} className="min-h-12 flex-1 rounded-xl border border-slate-200 text-sm font-semibold text-slate-600 disabled:opacity-40">Limpiar</button>
            <button type="button" onClick={() => setShowMobileFilters(false)} className="min-h-12 flex-1 rounded-xl bg-emerald-600 text-sm font-bold text-white hover:bg-emerald-700">Ver resultados</button>
          </div>
        </div>,
        document.body,
      )}

       <NewChatModal
        isOpen={showNewChatModal}
        onClose={() => setShowNewChatModal(false)}
        onChatCreated={handleChatCreated}
        devices={devices}
      />

      <OwnStatusesCenter
        open={showOwnStatuses}
        devices={devices}
        filteredDeviceIds={filterDevices}
        onClose={() => setShowOwnStatuses(false)}
      />

      {deleteRequest && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget) closeDeleteDialog() }}>
          <div ref={deleteDialogRef} role="alertdialog" aria-modal="true" aria-labelledby="delete-chats-title" aria-describedby="delete-chats-description" tabIndex={-1} className="w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-2xl">
            <div className="flex items-start gap-3 border-b border-slate-200 px-5 py-5 sm:px-6">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-red-50 text-red-600"><Trash2 className="h-5 w-5" /></div>
              <div className="min-w-0 flex-1">
                <h2 id="delete-chats-title" className="text-lg font-bold text-slate-900">Eliminar del CRM</h2>
                <p id="delete-chats-description" className="mt-1 text-sm leading-relaxed text-slate-500">Vas a eliminar {deleteRequest.label} y su historial local.</p>
              </div>
              <button type="button" onClick={closeDeleteDialog} disabled={deleting} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50" aria-label="Cerrar"><X className="h-5 w-5" /></button>
            </div>
            <div className="space-y-3 px-5 py-5 text-sm leading-relaxed text-slate-600 sm:px-6">
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
                <p className="font-bold">Esta acción solo afecta a Clarin.</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                  <li>El contacto y sus oportunidades se conservan.</li>
                  <li>No se borra la conversación del dispositivo WhatsApp.</li>
                  <li>El chat puede reaparecer si llega un mensaje nuevo.</li>
                </ul>
              </div>
              <p>El historial local eliminado no se puede recuperar desde esta pantalla.</p>
            </div>
            <div className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
              <button ref={deleteCancelRef} type="button" onClick={closeDeleteDialog} disabled={deleting} className="min-h-11 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-50">Cancelar</button>
              <button type="button" onClick={() => void confirmDeleteChats()} disabled={deleting} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-red-600 px-5 text-sm font-bold text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
                {deleting ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Trash2 className="h-4 w-4" />}
                {deleting ? 'Eliminando…' : 'Eliminar del CRM'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
