'use client'

import { useEffect, useLayoutEffect, useState, useRef, useCallback, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Search, Plus, Pin, PinOff, Users, RefreshCw, X, Trash2, CheckSquare, MessageCircle, ShieldBan, Heart, ChevronDown, ChevronUp, MoreVertical, PanelRight, ListChecks, AlertTriangle, Loader2, RotateCcw, Sparkles, SlidersHorizontal } from 'lucide-react'
import { formatTime } from '@/utils/format'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import { subscribeWebSocket } from '@/lib/api'
import { SEARCH_DEBOUNCE_MS } from '@/lib/useDebouncedValue'
import DeviceSelector from '@/components/chat/DeviceSelector'
import ChatKindSelector from '@/components/chat/ChatKindSelector'
import ConversationMenu from '@/components/chat/ConversationMenu'
import NewChatModal from '@/components/chat/NewChatModal'
import { bindingRevision, chatDeletionIssue, continuityChatIds, continuityDeviceMatches, parseChatContinuityEvent, reconcileContinuityRows, remapContinuityIds, remapContinuityDeviceFilter, restrictedChatContinuity, verifiedChatContinuity, type ChatContinuityEvent } from '@/components/chat/chatContinuity'
import { mergeChatSnapshot } from '@/components/chat/chatExperience'
import ChatPanel from '@/components/chat/ChatPanel'
import GroupDetailsPanel, { type GroupDetailsPanelHandle } from '@/components/chat/GroupDetailsPanel'
import ChatDetailsSurface from '@/components/chat/ChatDetailsSurface'
import GroupIdentityRecoveryNotice from '@/components/chat/GroupIdentityRecoveryNotice'
import { useGroupIdentityRecovery } from '@/components/chat/useGroupIdentityRecovery'
import { hasGroupMemberHistoryLayer } from '@/components/chat/groupParticipantIdentity'
import { usePersonalChatPins } from '@/components/chat/usePersonalChatPins'
import { applyChatPin } from '@/utils/chatPins'
import { chatAvatar, chatPreview, isGroupChat } from '@/utils/chatGroups'
import ContactPanel, { type ContactPanelHandle } from '@/components/chat/ContactPanel'
import OwnStatusesCenter from '@/components/chat/OwnStatusesCenter'
import { useChatHistoryLayer } from '@/components/chat/useChatHistoryLayer'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import { Chat, ChatState, Device, Message } from '@/types/chat'
import { applyChatState, matchesInbox, nextPendingChat, orderInbox, reconcileInboxPage, type InboxView } from '@/utils/chatInbox'
import { getChatDisplayName, formatPhone, isPendingChatIdentity, mergeReconciledChatIdentity, reconcileChatIdentity, type ChatIdentityReconciliation } from '@/utils/chat'
import { announceChatConversationActive, useChatMobileChrome } from '@/components/chat/ChatMobileChromeContext'
import { reconcileChatDeviceFilters } from '@/components/chat/deviceFilters'
import { chatReadError } from '@/components/chat/chatReadError'

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
const ROW_MENU_HEIGHT = 260
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
  const { setConversationActive } = useChatMobileChrome()
  const pageRef = useRef<HTMLDivElement>(null)
  const chatListRef = useRef<HTMLDivElement>(null)
  const listAnchorRef = useRef<{ id: string; offset: number; query: string } | null>(null)
  const [chats, setChatRows] = useState<Chat[]>([])
  const setChats = useCallback((next: Chat[] | ((rows: Chat[]) => Chat[])) => {
    const container = chatListRef.current
    if (container && container.scrollTop > 24 && !listAnchorRef.current) {
      const top = container.getBoundingClientRect().top
      const row = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-id]')).find(element => element.getBoundingClientRect().bottom > top)
      if (row?.dataset.chatRowId) listAnchorRef.current = { id: row.dataset.chatRowId, offset: row.getBoundingClientRect().top - top, query: activeChatQueryKeyRef.current }
    }
    setChatRows(next)
  }, [])
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null)
  const [explicitSenderSession, setExplicitSenderSession] = useState(0)
  const chatCacheRef = useRef(new Map<string, Chat>())
  for (const row of chats) chatCacheRef.current.set(row.id, row)
  if (selectedChat) chatCacheRef.current.set(selectedChat.id, selectedChat)
  const navigationGenerationRef = useRef(0)
  const nextRequestRef = useRef(false)
  const [composerFocusRequest, setComposerFocusRequest] = useState(0)
  const [compactSurface, setCompactSurface] = useState<CompactSurface>('list')

  // Filters & UI State
  const [filterDevices, setFilterDevices] = useState<string[]>([])
  const [chatKind, setChatKind] = useState<'all' | 'direct' | 'group'>('all')
  const [syncingGroups, setSyncingGroups] = useState(false)
  const [inboxView, setInboxViewState] = useState<InboxView>('all')
  const viewStorageRef = useRef('')
  const viewTouchedRef = useRef(false)
  const setInboxView = (view: InboxView) => {
    const nextView = chatKind === 'group' && view === 'pending' ? 'all' : view
    viewTouchedRef.current = true; setInboxViewState(nextView); if (viewStorageRef.current) localStorage.setItem(viewStorageRef.current, nextView)
  }
  const selectChatKind = (kind: 'all' | 'direct' | 'group') => {
    setChatKind(kind)
    if (kind === 'group') {
      viewTouchedRef.current = true
      if (inboxView === 'pending') setInboxView('all')
    }
  }
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/me', { signal: controller.signal, headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }).then(response => response.json()).then(data => {
      if (controller.signal.aborted || !data.user?.account_id || !data.user?.id) return
      const key = `clarin:inbox:${data.user.account_id}:${data.user.id}`
      viewStorageRef.current = key
      const stored = localStorage.getItem(key)
      if (!viewTouchedRef.current && (stored === 'all' || stored === 'unread' || stored === 'pending')) setInboxViewState(stored)
    }).catch(() => {})
    return () => controller.abort()
  }, [])
  const filterUnread = inboxView === 'unread'
  const filterPending = inboxView === 'pending'
  const setFilterUnread = (value: boolean | ((previous: boolean) => boolean)) => setInboxView((typeof value === 'function' ? value(filterUnread) : value) ? 'unread' : 'all')
  const canonicalStatesRef = useRef(new Map<string, ChatState>())
  const deletedChatIdsRef = useRef(new Set<string>())
  const inboxRevisionRef = useRef(0)
  const queueAnchorRef = useRef<{ id: string; waiting_since: string } | undefined>(undefined)
  const pinReconcileRef = useRef<() => void>(() => {})
  const pins = usePersonalChatPins((state, rollback) => {
    const patch = (chat: Chat) => chat.id !== state.chat_id ? chat : rollback ? { ...chat, is_pinned: state.is_pinned, pinned_at: state.pinned_at, pin_version: state.pin_version } : applyChatPin(chat, state)
    setChats(rows => orderInbox(rows.map(patch), inboxView))
    setSelectedChat(chat => chat ? patch(chat) : chat)
    inboxRevisionRef.current++; cursorRef.current = ''
    chatsRequestAbortRef.current?.abort(); chatsReconcileAbortRef.current?.abort()
    chatsRequestSequenceRef.current++; chatsReconcileSequenceRef.current++; setLoadingMore(false)
    pinReconcileRef.current()
  })
  const cursorRef = useRef('')
  const chatsRef = useRef(chats)
  chatsRef.current = chats
  useEffect(() => { if (selectedChat?.waiting_since) queueAnchorRef.current = { id: selectedChat.id, waiting_since: selectedChat.waiting_since } }, [selectedChat?.id, selectedChat?.waiting_since])
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
  const toolbarMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const filterTriggerRef = useRef<HTMLButtonElement>(null)
  const [filterPosition, setFilterPosition] = useState({ top: 8, left: 8, width: 360, maxHeight: 700 })
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
  const [filterDraft, setFilterDraft] = useState({ view: 'all' as InboxView, reaction: false, from: 'client' as 'any' | 'client' | 'me', emojis: [] as string[], range: '30d' as 'any' | '1d' | '7d' | '30d' | 'custom', customFrom: '', customTo: '' })
  const filterDialogRef = useRef<HTMLDivElement>(null)
  useAccessibleDialog(showMobileFilters, filterDialogRef, () => setShowMobileFilters(false))
  useChatHistoryLayer(showMobileFilters, '__clarinChatFilters', () => setShowMobileFilters(false))
  const openFilterDraft = () => {
    setFilterDraft({ view: inboxView, reaction: filterHasReaction, from: reactionFromMe, emojis: [...reactionEmojis], range: reactionRange, customFrom: reactionCustomFrom, customTo: reactionCustomTo })
    searchInputRef.current?.blur(); setShowMobileFilters(true)
  }
  const applyFilterDraft = () => {
    setInboxView(filterDraft.view); setFilterHasReaction(filterDraft.reaction); setReactionFromMe(filterDraft.from); setReactionEmojis(filterDraft.emojis); setReactionRange(filterDraft.range); setReactionCustomFrom(filterDraft.customFrom); setReactionCustomTo(filterDraft.customTo); setShowMobileFilters(false)
  }
  const chatQueryKey = JSON.stringify([pins.scope, chatKind, filterDevices, filterUnread, filterPending, debouncedSearch, filterHasReaction, reactionFromMe, reactionEmojis, reactionRange, reactionCustomFrom, reactionCustomTo])
  const activeChatQueryKeyRef = useRef(chatQueryKey)
  activeChatQueryKeyRef.current = chatQueryKey

  // Infinite scroll state
  const CHATS_PAGE_SIZE = 50
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [totalChats, setTotalChats] = useState(0)
  const offsetRef = useRef(0)
  const chatsRequestSequenceRef = useRef(0)
  const chatsReconcileSequenceRef = useRef(0)
  const chatsRequestAbortRef = useRef<AbortController | null>(null)
  const chatsReconcileAbortRef = useRef<AbortController | null>(null)
  const devicesRequestSequenceRef = useRef(0)
  const continuityAliasesRef = useRef(new Map<string, string>())
  const continuitySeenRef = useRef(new Map<string, number>())
  const continuityRequestsRef = useRef(new Map<string, AbortController>())
  const continuityScopeRef = useRef(pins.scope)
  if (continuityScopeRef.current !== pins.scope) {
    continuityScopeRef.current = pins.scope
    for (const request of continuityRequestsRef.current.values()) request.abort()
    continuityRequestsRef.current.clear(); continuityAliasesRef.current.clear(); continuitySeenRef.current.clear()
  }
  useEffect(() => () => { for (const request of continuityRequestsRef.current.values()) request.abort() }, [])
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const processedMessageEventsRef = useRef(new Map<string, number>())
  const selectedChatIdRef = useRef<string | null>(null)
  const compactHistoryDepthRef = useRef(0)
  const paginationQueryKeyRef = useRef(chatQueryKey)
  const queryStartedAtRef = useRef(Date.now())
  const preserveContinuityQueryRef = useRef(false)
  const continuitySilentQueryRef = useRef('')

  // A cursor and its rows belong to one filter/auth snapshot. Clear them before
  // the new scope paints, so scrolling cannot cancel its first page with an old cursor.
  useLayoutEffect(() => {
    if (paginationQueryKeyRef.current === chatQueryKey) return
    paginationQueryKeyRef.current = chatQueryKey
    if (preserveContinuityQueryRef.current) {
      preserveContinuityQueryRef.current = false; continuitySilentQueryRef.current = chatQueryKey
      chatsRequestAbortRef.current?.abort(); chatsReconcileAbortRef.current?.abort()
      chatsRequestSequenceRef.current++; chatsReconcileSequenceRef.current++
      cursorRef.current = ''; offsetRef.current = 0; setLoadingMore(false)
      if (listAnchorRef.current) listAnchorRef.current.query = chatQueryKey
      return
    }
    queryStartedAtRef.current = Date.now()
    chatsRequestAbortRef.current?.abort()
    chatsReconcileAbortRef.current?.abort()
    chatsRequestAbortRef.current = null
    chatsReconcileAbortRef.current = null
    chatsRequestSequenceRef.current++
    chatsReconcileSequenceRef.current++
    cursorRef.current = ''
    offsetRef.current = 0
    queueAnchorRef.current = undefined
    listAnchorRef.current = null
    chatsRef.current = []
    setChatRows([])
    setHasMore(false)
    setLoadingMore(false)
    setTotalChats(0)
    setChatListError('')
    setLoading(true)
    if (chatListRef.current) chatListRef.current.scrollTop = 0
  }, [chatQueryKey])

  // Responsive, resizable workspace
  const [containerWidth, setContainerWidth] = useState(1440)
  const [leftPanelWidth, setLeftPanelWidth] = useState(LEFT_PANEL_DEFAULT)
  const [rightPanelWidth, setRightPanelWidth] = useState(RIGHT_PANEL_DEFAULT)
  const resizingRef = useRef<{ panel: ResizePanel; startX: number; startWidth: number } | null>(null)

  // Contact info (3rd column)
  const [showContactInfo, setShowContactInfo] = useState(false)
  const contactPanelRef = useRef<ContactPanelHandle>(null)
  const groupPanelRef = useRef<GroupDetailsPanelHandle>(null)
  const participantCloseGuard = useRef<(() => boolean) | null>(null)
  const bindParticipantCloseGuard = useCallback((guard: (() => boolean) | null) => { participantCloseGuard.current = guard }, [])
  const participantScope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  const [participantPrivate, setParticipantPrivate] = useState<{ source: string; sourceDevice?: string; scope: string; chat: Chat } | null>(null)
  const participantChat = participantPrivate?.source === selectedChat?.id && participantPrivate?.sourceDevice === selectedChat?.device_id && participantPrivate?.scope === participantScope && !isAuthIdentityChanging(participantScope) ? participantPrivate.chat : null
  const changeParticipantChat = useCallback((chat: Chat | null) => {
    setParticipantPrivate(chat && selectedChat && chat.device_id === selectedChat.device_id ? { source: selectedChat.id, sourceDevice: selectedChat.device_id, scope: getAuthScope(), chat } : null)
  }, [selectedChat?.id, selectedChat?.device_id])
  useEffect(() => {
    setParticipantPrivate(current => current && (current.source !== selectedChat?.id || current.sourceDevice !== selectedChat?.device_id || current.scope !== participantScope) ? null : current)
  }, [selectedChat?.id, selectedChat?.device_id, participantScope])
  const navigateFromDetails = useCallback((navigate: () => void) => {
    if (participantCloseGuard.current?.() === false) return false
    if (isGroupChat(selectedChat) && groupPanelRef.current) return groupPanelRef.current.requestClose(navigate)
    if (contactPanelRef.current?.canClose() === false) return false
    navigate(); return true
  }, [selectedChat])

  // Virtualizer for chat list
  const chatVirtualizer = useVirtualizer({
    count: chats.length,
    getScrollElement: () => chatListRef.current,
    getItemKey: index => chats[index]?.id ?? index,
    estimateSize: () => 80,
    overscan: 10,
  })

  useLayoutEffect(() => {
    const anchor = listAnchorRef.current
    listAnchorRef.current = null
    if (!anchor || anchor.query !== chatQueryKey) return
    const index = chats.findIndex(chat => chat.id === anchor.id)
    if (index < 0) return
    const restore = () => {
      const container = chatListRef.current
      const row = container && Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-id]')).find(element => element.dataset.chatRowId === anchor.id)
      if (container && row) container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset
      return Boolean(row)
    }
    if (!restore()) {
      chatVirtualizer.scrollToIndex?.(index, { align: 'start', behavior: 'auto' })
      requestAnimationFrame(restore)
    }
  }, [chats, chatQueryKey, chatVirtualizer])

  const inlineDetailsWidth = leftPanelWidth + CHAT_PANEL_MIN + rightPanelWidth + WIDE_PANEL_SEPARATORS_WIDTH
  const layoutMode: LayoutMode = containerWidth < COMPACT_WORKSPACE_MAX ? 'compact' : containerWidth >= inlineDetailsWidth ? 'wide' : 'medium'

  useEffect(() => {
    const active = Boolean(selectedChat) && compactSurface !== 'list'
    setConversationActive(active)
    announceChatConversationActive(active)
    return () => {
      setConversationActive(false)
      announceChatConversationActive(false)
    }
  }, [compactSurface, selectedChat, setConversationActive])
  const chatListWidth = layoutMode === 'compact' ? containerWidth : leftPanelWidth
  const activeMobileFilterCount = Number(filterHasReaction)
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
    selectedChatIdRef.current = compactSurface === 'list' ? null : selectedChat?.id || null
  }, [compactSurface, layoutMode, selectedChat])

  const pushCompactHistory = useCallback((surface: 'conversation' | 'details', chatId: string) => {
    if (typeof window === 'undefined' || (pageRef.current?.getBoundingClientRect().width || containerWidth) >= COMPACT_WORKSPACE_MAX) return
    const current = (window.history.state || {}) as CompactHistoryState
    if (current.clarinChatSurface === surface && current.clarinChatId === chatId) return
    const nextDepth = compactHistoryDepthRef.current + 1
    window.history.pushState(
      { ...window.history.state, clarinChatSurface: surface, clarinChatId: chatId, clarinChatDepth: nextDepth },
      '',
      window.location.href,
    )
    compactHistoryDepthRef.current = nextDepth
  }, [containerWidth])

  const openChat = useCallback((chat: Chat, addHistory = true) => navigateFromDetails(() => {
    navigationGenerationRef.current++
    chatCacheRef.current.set(chat.id, chat)
    setSelectedChat(chat)
    setShowContactInfo(false)
    setCompactSurface('conversation')
    closeRowMenu()
    if (addHistory) pushCompactHistory('conversation', chat.id)
  }), [closeRowMenu, pushCompactHistory, navigateFromDetails])

  const openContactInfo = useCallback((addHistory = true) => {
    if (!selectedChat) return
    navigationGenerationRef.current++
    setShowContactInfo(true)
    setCompactSurface('details')
    if (addHistory) pushCompactHistory('details', selectedChat.id)
  }, [pushCompactHistory, selectedChat])

  const openChatDetails = useCallback((chat: Chat) => navigateFromDetails(() => {
    navigationGenerationRef.current++
    chatCacheRef.current.set(chat.id, chat)
    setSelectedChat(chat)
    setShowContactInfo(true)
    setCompactSurface('details')
    closeRowMenu()
    if (layoutMode === 'compact') {
      pushCompactHistory('conversation', chat.id)
      pushCompactHistory('details', chat.id)
    }
  }), [closeRowMenu, layoutMode, pushCompactHistory, navigateFromDetails])

  const returnFromCompactSurface = useCallback((surface: 'conversation' | 'details') => {
    navigationGenerationRef.current++
    if (layoutMode !== 'compact' || typeof window === 'undefined') {
      if (surface === 'details') {
        setShowContactInfo(false)
        setCompactSurface('conversation')
      }
      else {
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
      if (hasGroupMemberHistoryLayer(event.state)) return
      const generation = ++navigationGenerationRef.current
      const state = (event.state || {}) as CompactHistoryState
      if (showContactInfo && state.clarinChatSurface !== 'details' && (isGroupChat(selectedChat) ? groupPanelRef.current : contactPanelRef.current)?.canClose() === false) {
        window.history.pushState({ ...window.history.state, clarinChatSurface: 'details', clarinChatId: selectedChat?.id, clarinChatDepth: compactHistoryDepthRef.current }, '')
        return
      }
      if (state.clarinChatId && state.clarinChatSurface) {
        compactHistoryDepthRef.current = Math.max(1, Number(state.clarinChatDepth) || 1)
        const cached = chatCacheRef.current.get(state.clarinChatId)
        if (cached) setSelectedChat(applyChatState(cached, canonicalStatesRef.current.get(cached.id)))
        else {
          setSelectedChat(null)
          void fetch(`/api/chats/${state.clarinChatId}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
            .then(response => response.json()).then(data => {
              if (generation !== navigationGenerationRef.current) return
              if (!data.success || !data.chat) throw new Error('La conversación ya no está disponible.')
              const canonical = applyChatState(data.chat, data.chat_state)
              chatCacheRef.current.set(canonical.id, canonical)
              setSelectedChat(canonical)
            }).catch(() => { if (generation === navigationGenerationRef.current) { setListFeedback('No se pudo recuperar la conversación. Vuelve a abrirla.'); setCompactSurface('list') } })
        }
        setShowContactInfo(state.clarinChatSurface === 'details')
        setCompactSurface(state.clarinChatSurface)
        return
      }
      if (layoutMode !== 'compact') return
      setShowContactInfo(false)
      setCompactSurface('list')
      compactHistoryDepthRef.current = 0
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [layoutMode, showContactInfo, selectedChat?.id])

  const closeDetails = useCallback(() => navigateFromDetails(() => returnFromCompactSurface('details')), [navigateFromDetails, returnFromCompactSurface])
  const closeConversation = useCallback(() => navigateFromDetails(() => returnFromCompactSurface('conversation')), [navigateFromDetails, returnFromCompactSurface])

  const focusConversation = useCallback(() => {
    if (layoutMode !== 'wide') returnFromCompactSurface('details')
    setComposerFocusRequest(value => value + 1)
  }, [layoutMode, returnFromCompactSurface])

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

  useLayoutEffect(() => {
    if (!showMobileFilters) return
    const place = () => {
      const rect = filterTriggerRef.current?.getBoundingClientRect(), panel = filterDialogRef.current
      if (!rect || !panel) return
      const viewport = window.visualViewport, left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0, width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight
      const panelWidth = Math.min(380, width - 16), panelHeight = Math.min(panel.scrollHeight, height - 16)
      setFilterPosition({ left: Math.max(left + 8, Math.min(rect.right - panelWidth, left + width - panelWidth - 8)), top: layoutMode === 'compact' ? Math.max(top + 8, top + height - panelHeight - 8) : Math.max(top + 8, Math.min(rect.bottom + 6, top + height - panelHeight - 8)), width: panelWidth, maxHeight: height - 16 })
    }
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true); window.visualViewport?.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); window.visualViewport?.removeEventListener('resize', place) }
  }, [showMobileFilters, filterDraft.reaction, filterDraft.range, layoutMode])

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

  // Auto-open logic
  const autoOpenProcessedRef = useRef(false)

  function acceptContinuitySnapshot(snapshot: Chat, canonicalDevice?: Device | null, event?: ChatContinuityEvent) {
    if (getAuthScope() !== pins.scope || isAuthIdentityChanging(pins.scope)) return false
    const ids = continuityChatIds(snapshot)
    const previous = [...chatCacheRef.current.values()].find(row => ids.has(row.id))
      || { id: snapshot.id, jid: snapshot.jid, account_id: snapshot.account_id }
    const verified = verifiedChatContinuity(snapshot, previous, event)
    if (!(verified || restrictedChatContinuity(snapshot, previous, event)) || verified && event && !continuityDeviceMatches(snapshot, canonicalDevice)
      || (continuitySeenRef.current.get(snapshot.id) || 0) > bindingRevision(snapshot)) return false
    const known = [...chatCacheRef.current.values()].filter(row => ids.has(row.id))
    const oldDevices = known.map(row => row.device_id || '').filter(id => id !== snapshot.device_id)
    continuitySeenRef.current.set(snapshot.id, bindingRevision(snapshot))
    if (canonicalDevice && continuityDeviceMatches(snapshot, canonicalDevice)) setDevices(rows => [...rows.filter(row => row.id !== canonicalDevice.id), canonicalDevice])
    if (!known.length || known.every(row => row.id === snapshot.id && row.device_id === snapshot.device_id && bindingRevision(row) >= bindingRevision(snapshot))) return true
    for (const id of ids) {
      continuityAliasesRef.current.set(id, snapshot.id); chatCacheRef.current.set(id, snapshot)
      canonicalStatesRef.current.delete(id)
    }
    pins.remapContinuity(snapshot)
    if (listAnchorRef.current && ids.has(listAnchorRef.current.id)) listAnchorRef.current.id = snapshot.id
    if (queueAnchorRef.current && ids.has(queueAnchorRef.current.id)) queueAnchorRef.current.id = snapshot.id
    const state = window.history.state
    if (state?.clarinChatId && ids.has(state.clarinChatId)) window.history.replaceState({ ...state, clarinChatId: snapshot.id }, '')
    const removed = Math.max(0, chatsRef.current.filter(row => ids.has(row.id)).length - 1)
    if (removed) setTotalChats(total => Math.max(0, total - removed))
    setChats(rows => reconcileContinuityRows(rows, snapshot))
    setSelectedChat(current => current && ids.has(current.id) && (verifiedChatContinuity(snapshot, current, event) || restrictedChatContinuity(snapshot, current, event)) ? snapshot : current)
    setSelectedChats(current => remapContinuityIds(current, snapshot))
    setParticipantPrivate(current => current && ids.has(current.source) ? { ...current, source: snapshot.id, sourceDevice: snapshot.device_id } : current)
    setFilterDevices(current => {
      const next = verified ? remapContinuityDeviceFilter(current, oldDevices, snapshot.device_id!) : current
      if (next !== current) preserveContinuityQueryRef.current = true
      return next
    })
    cursorRef.current = ''; inboxRevisionRef.current++
    return true
  }

  // Foreground requests may show loading UI. WebSocket reconciliation is silent
  // and uses its own sequence so it can never cancel a user-triggered query.
  const fetchChats = useCallback(async (reset: boolean = true, options: { silent?: boolean; after?: { id: string; waiting_since: string } } = {}) => {
    const requestScope = pins.scope
    if (getAuthScope() !== requestScope || isAuthIdentityChanging(requestScope) || chatQueryKey !== activeChatQueryKeyRef.current) return null
    if (!reset && (paginationQueryKeyRef.current !== chatQueryKey || chatsRequestAbortRef.current || !cursorRef.current)) return null
    const silent = Boolean(options.silent && reset)
    const sequenceRef = silent ? chatsReconcileSequenceRef : chatsRequestSequenceRef
    const abortRef = silent ? chatsReconcileAbortRef : chatsRequestAbortRef
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const requestSequence = ++sequenceRef.current
    const requestQueryKey = chatQueryKey
    const token = localStorage.getItem('token')
    const requestRevision = inboxRevisionRef.current
    const offset = reset || filterPending ? 0 : offsetRef.current
    if (reset && !silent) {
      setLoading(true)
      setLoadingMore(false)
      setChatListError('')
    } else if (!reset) {
      setLoadingMore(true)
    }
    try {
      const params = new URLSearchParams({ kind: chatKind, pagination: 'cursor' })
      if (!filterPending && !reset && cursorRef.current) params.set('cursor', cursorRef.current)
      filterDevices.forEach(id => params.append('device_ids', id))
      if (filterUnread) params.append('unread_only', 'true')
      if (filterPending) { params.set('pending_only', 'true'); if (options.after) params.set('cursor', options.after.waiting_since + '|' + options.after.id); else if (!reset && cursorRef.current) params.set('cursor', cursorRef.current) }
      if (debouncedSearch) params.append('search', debouncedSearch)
      if (filterHasReaction) {
        params.append('has_reaction', 'true')
        if (reactionFromMe !== 'any') params.append('reaction_from_me', reactionFromMe === 'me' ? 'true' : 'false')
        reactionEmojis.forEach(e => params.append('reaction_emojis', e))
        // Cursor scope hashes include these timestamps; they must not drift
        // between pages or silent reconciliation of the same filter snapshot.
        const now = new Date(queryStartedAtRef.current)
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
      const requestLimit = CHATS_PAGE_SIZE
      params.append('limit', String(requestLimit))
      params.append('offset', String(offset))

      const res = await fetch(`/api/chats?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.success) throw new Error(chatReadError(data?.error, 'No se pudo cargar esta vista.', res.status))
      if (controller.signal.aborted || requestSequence !== sequenceRef.current || requestQueryKey !== activeChatQueryKeyRef.current || getAuthScope() !== requestScope) return
      if (data.success) {
        setChatListError('')
        let newChats: Chat[] = (data.chats || []).map((row: Chat) => {
          const canonicalId = continuityAliasesRef.current.get(row.id)
          const known = chatCacheRef.current.get(canonicalId || row.id)
          if (canonicalId && canonicalId !== row.id && known) return pins.project(known)
          if (known && bindingRevision(known) > bindingRevision(row)) return pins.project(known)
          return pins.project(row)
        })
        newChats = [...new Map(newChats.map(row => [row.id, row])).values()]
        for (const row of newChats) if (row.binding_state) acceptContinuitySnapshot(row)
        setSelectedChat(current => {
          if (!current) return current
          const canonicalId = continuityAliasesRef.current.get(current.id) || current.id
          const snapshot = newChats.find(row => row.id === canonicalId)
          if (!snapshot || snapshot.id !== current.id && !(verifiedChatContinuity(snapshot, current) || restrictedChatContinuity(snapshot, current))) return current
          return mergeChatSnapshot(current.id === snapshot.id ? current : null, snapshot)
        })
        const total: number = data.total ?? 0
        let serverOffset = offset + newChats.length
        let nextCursor = data.next_cursor || ''
        // Revalidate the whole loaded window, in bounded pages. Keeping omitted
        // rows blindly would retain chats that no longer match search/reactions.
        if (silent && !options.after) {
          const loadedCount = Math.max(CHATS_PAGE_SIZE, chatsRef.current.length)
          while (newChats.length < loadedCount && serverOffset < total && nextCursor) {
            const pageParams = new URLSearchParams(params)
            pageParams.set('offset', String(filterPending ? 0 : serverOffset))
            pageParams.set('cursor', nextCursor)
            const pageResponse = await fetch(`/api/chats?${pageParams}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
            const page = await pageResponse.json().catch(() => null)
            if (!pageResponse.ok || !page?.success || !Array.isArray(page.chats)) throw new Error(chatReadError(page?.error, 'No se pudieron actualizar las conversaciones.', pageResponse.status))
            if (controller.signal.aborted || requestSequence !== sequenceRef.current || requestQueryKey !== activeChatQueryKeyRef.current || getAuthScope() !== requestScope) return
            serverOffset += page.chats.length
            nextCursor = page.next_cursor || ''
            const known = new Set(newChats.map(chat => chat.id))
            const unique = (page.chats as Chat[]).filter(chat => !known.has(chat.id))
            newChats = [...newChats, ...unique.map(pins.project)]
            if (!page.chats.length || !unique.length) break
          }
        }
        newChats = newChats.filter(chat => !deletedChatIdsRef.current.has(chat.id))
        if (requestRevision === inboxRevisionRef.current) setTotalChats(total)

        if (reset) {
          setChats(current => reconcileInboxPage(current, newChats, canonicalStatesRef.current, inboxView, Boolean(options.after)))
          const visibleIds = new Set(newChats.map(chat => chat.id))
          if (!options.after) setSelectedChats(current => {
            const next = new Set(Array.from(current).filter(id => visibleIds.has(id)))
            return next.size === current.size ? current : next
          })
          if (!options.after) offsetRef.current = serverOffset
        } else {
          // Append with deduplication
          setChats(prev => {
            const existingIds = new Set(prev.map(c => c.id))
            const unique = newChats.filter(c => !existingIds.has(c.id))
            return reconcileInboxPage(prev, unique, canonicalStatesRef.current, inboxView, true)
          })
          offsetRef.current = offset + newChats.length
        }
        if (!options.after) {
          cursorRef.current = nextCursor
          setHasMore(Boolean(nextCursor))
        }
        return reconcileInboxPage([], newChats, canonicalStatesRef.current, inboxView, false)
      }
    } catch (err) {
      if (!controller.signal.aborted && requestSequence === sequenceRef.current && requestQueryKey === activeChatQueryKeyRef.current && getAuthScope() === requestScope) {
        if (silent) console.warn('Silent chat reconciliation failed', err)
        else {
          console.error('Failed to fetch chats', err)
          setChatListError(chatReadError(err, 'No se pudieron cargar las conversaciones. Reintenta.'))
        }
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      if (!controller.signal.aborted && requestSequence === sequenceRef.current && requestQueryKey === activeChatQueryKeyRef.current && getAuthScope() === requestScope) {
        if (!silent) setLoading(false)
        if (!reset) setLoadingMore(false)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins.project, chatQueryKey, chatKind, filterDevices, filterUnread, filterPending, debouncedSearch, filterHasReaction, reactionFromMe, reactionEmojis, reactionRange, reactionCustomFrom, reactionCustomTo])

  const loadMoreChats = useCallback(() => {
    if (loading || loadingMore || !hasMore) return
    fetchChats(false)
  }, [loading, loadingMore, hasMore, fetchChats])

  const handleChatListScroll = useCallback(() => {
    const el = chatListRef.current
    if (!el || loading || !hasMore || loadingMore) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
      loadMoreChats()
    }
  }, [loading, hasMore, loadingMore, loadMoreChats])

  const fetchDevices = useCallback(async () => {
    const requestSequence = ++devicesRequestSequenceRef.current
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/devices', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (requestSequence === devicesRequestSequenceRef.current && res.ok && data.success) {
        const snapshot: Device[] = data.devices || []
        setDevices(snapshot)
        setFilterDevices(current => reconcileChatDeviceFilters(current, snapshot))
      }
    } catch {}
  }, [])

  useEffect(() => {
    fetchChats(true, { silent: continuitySilentQueryRef.current === chatQueryKey })
    continuitySilentQueryRef.current = ''
    fetchDevices()
  }, [fetchChats, fetchDevices])

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchTerm])

  useEffect(() => () => {
    chatsRequestAbortRef.current?.abort()
    chatsReconcileAbortRef.current?.abort()
  }, [])

  const searchPending = searchTerm !== debouncedSearch

  const updateSearchTerm = (value: string) => {
    chatsRequestAbortRef.current?.abort()
    chatsReconcileAbortRef.current?.abort()
    chatsRequestSequenceRef.current += 1
    chatsReconcileSequenceRef.current += 1
    setLoading(false)
    setLoadingMore(false)
    setSearchTerm(value)
    if (!value) setDebouncedSearch('')
  }

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
  }, [closeRowMenu, searchTerm, chatKind, filterDevices, inboxView, filterHasReaction, reactionFromMe, reactionEmojis, reactionRange, reactionCustomFrom, reactionCustomTo])

  // Direct links get a list entry beneath the conversation, even with an empty/filtered inbox.
  useEffect(() => {
    if (autoOpenProcessedRef.current) return
    const params = new URLSearchParams(window.location.search)
    const openChatId = params.get('open')
    const jid = params.get('jid')
    const deviceId = params.get('device')
    const known = chats.find(chat => openChatId ? chat.id === openChatId : chat.jid === jid && chat.device_id === deviceId)
    if (!openChatId && !known) return
    autoOpenProcessedRef.current = true
    const generation = navigationGenerationRef.current
    const openDirect = (chat: Chat) => {
      if (navigationGenerationRef.current !== generation) return
      const { clarinChatSurface: _surface, clarinChatId: _id, clarinChatDepth: _depth, ...rest } = window.history.state || {}
      window.history.replaceState(rest, '', '/dashboard/chats')
      compactHistoryDepthRef.current = 0
      openChat(chat)
    }
    if (known) { openDirect(known); return }
    void fetch(`/api/chats/${encodeURIComponent(openChatId!)}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
      .then(response => response.json()).then(data => {
        if (!data.success || !data.chat) throw new Error('No se pudo abrir el chat del enlace.')
        openDirect(applyChatState(data.chat, data.chat_state))
      }).catch(() => { if (generation === navigationGenerationRef.current) setListFeedback('No se pudo abrir el chat del enlace. Reintenta desde la bandeja.') })
  }, [chats, openChat])

  const reconcileChatUnread = useCallback((chatId: string, unreadCount: number, state?: ChatState) => {
    if (!state) return
    const previous = canonicalStatesRef.current.get(chatId)
    if (previous && previous.state_version >= state.state_version) return
    canonicalStatesRef.current.set(chatId, state)
    inboxRevisionRef.current++
    const current = chatsRef.current.find(chat => chat.id === chatId)
    if (current && !matchesInbox(applyChatState(current, state), inboxView)) {
      setTotalChats(total => Math.max(0, total - 1))
      offsetRef.current = Math.max(0, offsetRef.current - 1)
    }
    setChats(rows => orderInbox(rows.map(chat => applyChatState(chat, state)).filter(chat => matchesInbox(chat, inboxView)), inboxView))
    setSelectedChat(chat => chat ? applyChatState(chat, state) : chat)
  }, [inboxView])

  const openNextPending = async () => {
    if (nextRequestRef.current) return
    nextRequestRef.current = true
    const generation = navigationGenerationRef.current
    const query = activeChatQueryKeyRef.current
    const currentId = selectedChatIdRef.current
    const current = () => navigationGenerationRef.current === generation && activeChatQueryKeyRef.current === query && selectedChatIdRef.current === currentId
    try {
      let fresh = await fetchChats(true, { silent: true, after: queueAnchorRef.current })
      if (!current()) return
      if (!fresh) return 'No se pudo comprobar la cola. Reintenta.'
      if (fresh.length === 0 && queueAnchorRef.current) fresh = await fetchChats(true, { silent: true })
      if (!current()) return
      if (!fresh) return 'No se pudo comprobar la cola. Reintenta.'
      const candidate = nextPendingChat(fresh, currentId, queueAnchorRef.current)
      if (!candidate) return 'No hay más conversaciones pendientes en estos filtros.'
      if (!openChat(candidate, false)) return
      if (layoutMode === 'compact') {
        window.history.replaceState({ ...window.history.state, clarinChatSurface: 'conversation', clarinChatId: candidate.id, clarinChatDepth: compactHistoryDepthRef.current || 1 }, '')
      }
    } finally { nextRequestRef.current = false }
  }

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
      if (messageTimestampValue(timestamp) < messageTimestampValue(existing.last_message_at)) return current
      const updated: Chat = {
        ...existing,
        last_message: chatPreviewFromMessage(message),
        last_message_from_name: message.from_name,
        last_message_from_me: message.is_from_me,
        last_message_at: timestamp,
        unread_count: existing.unread_count,
      }
      const next = current.slice()
      next[index] = updated
      return orderInbox(next, inboxView)
    })
  }, [inboxView])

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

  pinReconcileRef.current = scheduleChatReconciliation

  // WebSocket for List Updates
  useEffect(() => {
    const unsubscribe = subscribeWebSocket((data: unknown) => {
      const msg = data as { event?: string; type?: string; data?: unknown; message?: unknown }
      const eventType = msg.event || msg.type
      if (eventType === 'chat_deleted') {
        const payload = msg.data as { chat_ids?: unknown; all?: unknown }
        const all = payload?.all === true
        if (!all && !Array.isArray(payload?.chat_ids)) return
        const rawIds = all ? [...chatsRef.current.map(chat => chat.id), selectedChatIdRef.current] : payload.chat_ids as unknown[]
        const ids = new Set(rawIds.filter((id): id is string => typeof id === 'string' && !deletedChatIdsRef.current.has(id)))
        if (!all && !ids.size) return
        for (const id of ids) deletedChatIdsRef.current.add(id)
        chatsRequestAbortRef.current?.abort()
        chatsReconcileAbortRef.current?.abort()
        chatsRequestSequenceRef.current++
        chatsReconcileSequenceRef.current++
        setLoading(false)
        setLoadingMore(false)
        inboxRevisionRef.current++
        const removed = chatsRef.current.filter(chat => ids.has(chat.id)).length
        setChats(current => current.filter(chat => !ids.has(chat.id)))
        setTotalChats(total => all ? 0 : Math.max(0, total - removed))
        offsetRef.current = Math.max(0, offsetRef.current - removed)
        setSelectedChats(current => new Set([...current].filter(id => !ids.has(id))))
        if (all || ids.has(selectedChatIdRef.current || '')) {
          setShowContactInfo(false)
          setCompactSurface('list')
        }
        setSelectedChat(current => current && (all || ids.has(current.id)) ? null : current)
        closeRowMenu()
        scheduleChatReconciliation()
      } else if (eventType === 'new_message' || eventType === 'message_sent') {
        applyMessageToChatList(msg.data || msg.message)
      } else if (eventType === 'chat_continuity_reconciled') {
        const continuity = parseChatContinuityEvent(msg.data)
        if (!continuity || (continuitySeenRef.current.get(continuity.canonical_chat_id) || 0) > continuity.binding_revision) return
        continuityRequestsRef.current.get(continuity.canonical_chat_id)?.abort()
        const controller = new AbortController(), scope = pins.scope
        continuityRequestsRef.current.set(continuity.canonical_chat_id, controller)
        chatsRequestAbortRef.current?.abort(); chatsReconcileAbortRef.current?.abort(); chatsRequestSequenceRef.current++; chatsReconcileSequenceRef.current++
        void fetch('/api/chats/' + encodeURIComponent(continuity.canonical_chat_id), { credentials: 'include', cache: 'no-store', signal: controller.signal, headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })
          .then(response => response.ok ? response.json() : Promise.reject(new Error('continuity_unavailable'))).then(data => {
            if (controller.signal.aborted || getAuthScope() !== scope || isAuthIdentityChanging(scope) || !data.success || !data.chat) return
            if (acceptContinuitySnapshot(data.chat, data.device, continuity)) { void fetchDevices(); scheduleChatReconciliation() }
          }).catch(() => { if (!controller.signal.aborted && getAuthScope() === scope) scheduleChatReconciliation() })
          .finally(() => { if (continuityRequestsRef.current.get(continuity.canonical_chat_id) === controller) continuityRequestsRef.current.delete(continuity.canonical_chat_id) })
      } else if (eventType === 'chat_identity_reconciled') {
        const reconciliation = msg.data as ChatIdentityReconciliation
        if (reconciliation?.source_chat_id && reconciliation?.canonical_chat?.id) {
          setChats(current => reconcileChatIdentity(current, reconciliation))
          setSelectedChat(current => {
            if (!current) return current
            if (current.id === reconciliation.source_chat_id || current.id === reconciliation.canonical_chat.id) {
              return mergeReconciledChatIdentity([...chatsRef.current.filter(chat => chat.id !== current.id), current], reconciliation)
            }
            return current
          })
          setSelectedChats(current => {
            if (!current.has(reconciliation.source_chat_id)) return current
            const next = new Set(current)
            next.delete(reconciliation.source_chat_id)
            next.add(reconciliation.canonical_chat.id)
            return next
          })
          scheduleChatReconciliation()
        }
      } else if (eventType === 'chat_update') {
        const payload = (msg.data || {}) as ChatState
        if (payload.chat_id && typeof payload.state_version === 'number') {
          const known = chatsRef.current.some(chat => chat.id === payload.chat_id)
          reconcileChatUnread(payload.chat_id, payload.unread_count, payload)
          if (!known && (inboxView === 'all' || inboxView === 'unread' && payload.unread_count > 0 || inboxView === 'pending' && payload.needs_reply)) scheduleChatReconciliation()
        } else scheduleChatReconciliation()
      } else if (eventType === 'message_reaction' && filterHasReaction) {
        scheduleChatReconciliation()
      } else if (eventType === 'chat_group_updated' || eventType === 'groups_synced' || eventType === 'whatsapp_identity_updated') {
        scheduleChatReconciliation()
      } else if (eventType === 'contact_update') {
        scheduleChatReconciliation()
      } else if (eventType === 'device_status' || eventType === 'device_deletion') {
        fetchDevices()
        if (eventType === 'device_deletion') scheduleChatReconciliation()
      }
    })
    return () => unsubscribe()
  }, [applyMessageToChatList, closeRowMenu, fetchDevices, filterHasReaction, reconcileChatUnread, scheduleChatReconciliation, inboxView])

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
    const issue = ids.map(id => chatDeletionIssue(chatCacheRef.current.get(id))).find(Boolean)
    if (issue) { setListFeedback(issue); return }
    if (ids.length === 0) return
    setListFeedback('')
    setDeleteRequest({ ids, label: ids.length === 1 ? 'esta conversación' : `${ids.length} conversaciones` })
  }

  const requestSingleChatDeletion = (chat: Chat) => {
    const issue = chatDeletionIssue(chat)
    if (issue) { setListFeedback(issue); return }
    closeRowMenu()
    setListFeedback('')
    setDeleteRequest({ ids: [chat.id], label: `la conversación con ${getChatDisplayName(chat)}` })
  }

  const confirmDeleteChats = async () => {
    if (!deleteRequest || deleting) return
    const ids = [...deleteRequest.ids]
    const issue = ids.map(id => chatDeletionIssue(chatCacheRef.current.get(id))).find(Boolean)
    if (issue) { setDeleteRequest(null); setListFeedback(issue); return }
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

  const handleChatCreated = (chatId: string, confirmedDeviceId?: string) => {
    const generation = ++navigationGenerationRef.current
    void fetchChats(true, { silent: true })
    const token = localStorage.getItem('token')
    void fetch(`/api/chats/${chatId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(response => response.json()).then(data => {
        if (generation !== navigationGenerationRef.current) return
        if (!data.success || !data.chat) throw new Error('No se pudo abrir la conversación creada.')
        if (confirmedDeviceId && data.chat.device_id !== confirmedDeviceId) {
          setListFeedback('El canal cambió en otra sesión. Vuelve a elegir el número de envío; tu borrador se conserva.')
          return
        }
        if (openChat(applyChatState(data.chat, data.chat_state))) setExplicitSenderSession(value => value + 1)
      }).catch(() => {
        if (generation === navigationGenerationRef.current) setListFeedback('La conversación se creó, pero no se pudo abrir. Búscala en la lista para volver a intentarlo.')
      })
  }

  const groupSyncDevices = devices.filter(device => !filterDevices.length || filterDevices.includes(device.id))
  const identityRecovery = useGroupIdentityRecovery(chatKind === 'group' ? groupSyncDevices.filter(device => (device.provider || 'whatsapp_web') === 'whatsapp_web').map(device => device.id) : [], selectedChat?.account_id || chats[0]?.account_id)
  const groupSyncTargets = groupSyncDevices.filter(device => device.status === 'connected' && device.runtime_capabilities?.can_list_groups === true && (device.provider || 'whatsapp_web') === 'whatsapp_web')
  const groupSyncUnavailableReason = groupSyncDevices.some(device => device.runtime_capabilities?.can_list_groups === true && (device.provider || 'whatsapp_web') === 'whatsapp_web') ? 'Conecta un dispositivo de WhatsApp con soporte de grupos.' : 'La sincronización de grupos no está disponible para estos dispositivos.'
  const syncGroups = async () => {
    if (syncingGroups) return
    setSyncingGroups(true); setListFeedback('')
    const targets = groupSyncTargets
    try {
      if (!targets.length) throw new Error(groupSyncUnavailableReason)
      for (const device of targets) {
        const response = await fetch('/api/devices/' + device.id + '/groups/sync', { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } })
        const data = await response.json(); if (!response.ok || !data.success) throw new Error(data.error || 'No se pudieron actualizar los grupos.')
      }
      identityRecovery.refresh()
      await fetchChats(true, { silent: true })
    } catch (cause) { setListFeedback(cause instanceof Error ? cause.message : 'No se pudieron actualizar los grupos.') }
    finally { setSyncingGroups(false) }
  }

  const selectionDeleteIssue = [...selectedChats].map(id => chatDeletionIssue(chatCacheRef.current.get(id))).find(Boolean)
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
         <div data-chat-list-header className="shrink-0 space-y-2 border-b border-slate-200/70 bg-white px-3 py-2.5">
            {!collapseMobileListToolbar && (selectionMode ? (
              <div className="flex h-11 items-center justify-between gap-2 sm:h-10">
                <div className="flex min-w-0 items-center gap-1"><button type="button" onClick={() => { setSelectionMode(false); setSelectedChats(new Set()) }} className="flex h-10 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100" aria-label="Salir de selección"><X className="h-4 w-4" /></button><span className="text-xs font-semibold text-slate-700">{selectedChats.size} seleccionados</span></div>
                <div className="flex items-center gap-1"><button type="button" onClick={toggleSelectAll} disabled={chats.length === 0} className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-40" aria-label={selectedChats.size === chats.length && chats.length > 0 ? 'Quitar selección de chats cargados' : 'Seleccionar todos los chats cargados'} title={'Solo chats cargados (' + chats.length + ')'}><CheckSquare className="h-4 w-4" /></button><button type="button" onClick={requestSelectedChatsDeletion} disabled={deleting || selectedChats.size === 0 || Boolean(selectionDeleteIssue)} title={selectionDeleteIssue || undefined} aria-describedby={selectionDeleteIssue ? 'consolidated-delete-hint' : undefined} className="flex h-10 w-10 items-center justify-center rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-40" aria-label="Eliminar chats seleccionados"><Trash2 className="h-4 w-4" /></button></div>
              </div>
            ) : (
              <div className="flex h-11 min-w-0 items-center gap-1.5 sm:h-10">
                <DeviceSelector devices={devices} selectedDeviceIds={filterDevices} onDeviceChange={setFilterDevices} className="min-w-0 flex-1" compact />
                <button type="button" onClick={() => setShowNewChatModal(true)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white transition hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 sm:h-10 sm:w-10" aria-label="Nuevo chat" title="Nuevo chat"><Plus className="h-4 w-4" /></button>
                <button ref={toolbarMenuTriggerRef} type="button" onClick={() => setShowToolbarMenu(value => !value)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 sm:h-10 sm:w-9" aria-label="Más acciones de chats" aria-haspopup="menu" aria-expanded={showToolbarMenu}>{syncingGroups ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="h-4 w-4" />}</button>
                {showToolbarMenu && <ConversationMenu anchor={toolbarMenuTriggerRef} label="Acciones de chats" onClose={() => setShowToolbarMenu(false)}>
                  <button type="button" role="menuitem" onClick={() => { setShowOwnStatuses(true); setShowToolbarMenu(false) }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm text-slate-700 hover:bg-emerald-50"><Sparkles className="h-4 w-4 text-slate-500" />Mis estados</button>
                  <button type="button" role="menuitem" onClick={() => { setSelectionMode(true); setSelectedChats(new Set()); setShowToolbarMenu(false) }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm text-slate-700 hover:bg-slate-50"><ListChecks className="h-4 w-4 text-slate-500" />Seleccionar chats</button>
                  <button type="button" role="menuitem" disabled={syncingGroups || !groupSyncTargets.length} aria-describedby={!groupSyncTargets.length ? 'group-sync-unavailable' : undefined} onClick={() => { setShowToolbarMenu(false); void syncGroups() }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"><RefreshCw className="h-4 w-4 shrink-0 text-slate-500" /><span>Actualizar grupos de WhatsApp{!groupSyncTargets.length && <span id="group-sync-unavailable" className="mt-1 block text-xs font-normal leading-4">{groupSyncUnavailableReason}</span>}</span></button>
                </ConversationMenu>}
              </div>
            ))}
            <div className="flex h-11 min-w-0 items-center gap-1.5 sm:h-10">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input ref={searchInputRef} type="text" placeholder="Buscar chats..." value={searchTerm} onChange={event => updateSearchTerm(event.target.value)} onFocus={() => setListSearchFocused(true)} onBlur={() => setListSearchFocused(false)} aria-busy={searchPending || loading} className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-9 pr-14 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:bg-white focus:ring-2 focus:ring-emerald-500/20 sm:h-10" />
                {searchPending && <Loader2 aria-label="Esperando para buscar chats" className="absolute right-9 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-emerald-500" />}
                {searchTerm && <button type="button" onClick={() => updateSearchTerm('')} aria-label="Limpiar búsqueda de chats" className="absolute right-0.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>}
              </div>
              <button ref={filterTriggerRef} type="button" onClick={openFilterDraft} aria-label={'Abrir filtros de chats' + (activeMobileFilterCount ? ', ' + activeMobileFilterCount + ' activos' : '')} aria-haspopup="dialog" aria-expanded={showMobileFilters} className={'relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 sm:h-10 sm:w-9 ' + (activeMobileFilterCount ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-100')}><SlidersHorizontal className="h-4 w-4" />{activeMobileFilterCount > 0 && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-emerald-600" aria-hidden />}</button>
            </div>
            {!collapseMobileListToolbar && <div className="flex min-w-0 items-center gap-1">
              <div className="flex min-w-0 flex-1 items-center gap-0.5" role="group" aria-label="Vista de la bandeja">
                {([['all', 'Todos'], ['unread', 'No leídos'], ['pending', 'Pendientes']] as const).map(([view, label]) => <button key={view} type="button" onClick={() => setInboxView(view)} disabled={chatKind === 'group' && view === 'pending'} aria-describedby={chatKind === 'group' && view === 'pending' ? 'group-pending-hint' : undefined} aria-pressed={inboxView === view} title={view === 'pending' ? 'Primero quienes esperan más tiempo. Leer no marca la conversación como atendida.' : undefined} className={'h-11 min-w-0 flex-1 rounded-lg px-1 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-35 sm:h-9 ' + (inboxView === view ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800')}>{label}</button>)}
              </div>
              <span aria-hidden className="h-4 w-px shrink-0 bg-slate-200" />
              <ChatKindSelector value={chatKind} onChange={selectChatKind} />
            </div>}
            {chatKind === 'group' && !collapseMobileListToolbar && <p id="group-pending-hint" className="text-[11px] leading-4 text-slate-400">Los grupos no generan pendientes.</p>}
                        {selectionMode && selectionDeleteIssue && <p id="consolidated-delete-hint" className="text-xs leading-5 text-slate-500">{selectionDeleteIssue}</p>}
             {pins.error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-xs text-rose-700">{pins.error}</p>}
            {chatKind === 'group' && <GroupIdentityRecoveryNotice rows={identityRecovery.rows} devices={devices} retryHint />}
            {listFeedback && (
              <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs font-medium text-red-700" role="alert">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">{listFeedback}</span>
                <button type="button" onClick={() => setListFeedback('')} className="-m-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500" aria-label="Cerrar aviso"><X className="h-3.5 w-3.5" /></button>
              </div>
            )}

            {chatListError && chats.length > 0 && (
              <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 pl-3 pr-1 text-xs text-slate-600" role="alert">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
                <span className="min-w-0 flex-1">{chatListError}</span>
                <button type="button" onClick={() => void fetchChats()} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Reintentar"><RotateCcw className="h-3.5 w-3.5" /></button>
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
              <h3 className="text-sm font-semibold text-slate-700 mb-1">{filterPending ? 'No hay conversaciones pendientes' : filterUnread ? 'Todo leído' : 'No se encontraron chats'}</h3>
              <p className="text-xs leading-5 text-slate-500 max-w-[220px]">{filterUnread ? chatKind === 'group' ? 'Los grupos sin mensajes por leer salen de esta vista.' : 'Los mensajes ya leídos salen de esta vista. Revisa Pendientes para ver a quién falta responder.' : filterPending ? 'Las conversaciones que requieran atención aparecerán aquí.' : 'Prueba con otra búsqueda o desactiva algún filtro para ampliar los resultados.'}</p>
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
                        data-chat-row-id={chat.id}
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
                             {chatAvatar(chat) ? (
                              <img src={chatAvatar(chat)} alt="" className="h-11 w-11 rounded-full object-cover ring-1 ring-slate-200 shadow-sm" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden') }} />
                             ) : null}
                            <div className={`flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 ring-1 ring-emerald-100 shadow-sm ${chatAvatar(chat) ? 'hidden' : ''}`}>
                                <span className="text-base font-bold text-emerald-700">{isGroupChat(chat) ? <Users className="h-5 w-5" /> : getChatDisplayName(chat).charAt(0).toUpperCase()}</span>
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
                                <div className="flex shrink-0 items-center gap-1">{chat.is_pinned && <Pin aria-label="Chat fijado para ti" className="h-3 w-3 text-slate-500" />}
                                  <span className={`whitespace-nowrap pt-0.5 text-[10px] ${chat.unread_count > 0 ? 'font-bold text-emerald-700' : 'text-slate-400'}`}>
                                      {formatTime(chat.last_message_at)}
                                  </span>
                                </div>
                            </div>
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-xs text-slate-500 truncate block">
                                    {chatPreview(chat)}
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
                                 {isPendingChatIdentity(chat) && (
                                    <span title="WhatsApp aún no informó el número de este contacto. La conversación sigue disponible." className="inline-flex items-center gap-0.5 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                                        <AlertTriangle className="h-3 w-3" aria-hidden />
                                        Identidad pendiente
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
                                <button type="button" role="menuitem" disabled={pins.pending.has(chat.id)} onClick={() => { closeRowMenu(true); void pins.toggle(chat) }} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">{chat.is_pinned ? <PinOff className="h-4 w-4 text-slate-400" /> : <Pin className="h-4 w-4 text-slate-400" />}{chat.is_pinned ? 'Desfijar para mí' : 'Fijar para mí'}</button>
                                <button type="button" role="menuitem" onClick={() => openChatDetails(chat)} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><PanelRight className="h-4 w-4 text-slate-400" /> Ver detalles</button>
                                <button type="button" role="menuitem" onClick={() => { setSelectionMode(true); setSelectedChats(new Set([chat.id])); closeRowMenu() }} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><CheckSquare className="h-4 w-4 text-slate-400" /> Seleccionar</button>
                                <div className="my-1 border-t border-slate-100" />
                                <button type="button" role="menuitem" disabled={Boolean(chatDeletionIssue(chat))} title={chatDeletionIssue(chat) || undefined} onClick={() => requestSingleChatDeletion(chat)} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs font-semibold text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"><Trash2 className="h-4 w-4" /> <span className="min-w-0"><span className="block">Eliminar del CRM</span>{chatDeletionIssue(chat) && <span className="block text-[10px] font-normal leading-4">{chatDeletionIssue(chat)}</span>}</span></button>
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
        {selectedChat && (
              <div className={compactSurface === 'list' ? 'hidden' : 'flex min-h-0 min-w-0 flex-1 flex-col'}>
	            <ChatPanel
	                chatId={selectedChat.id}
                    explicitSenderSession={explicitSenderSession}
	                deviceId={selectedChat.device_id || ''}
	                device={selectedDevice}
	                initialChat={selectedChat}
                    participantChat={participantChat}
                    onParticipantChatChange={changeParticipantChat}
                    onParticipantCloseGuardChange={bindParticipantCloseGuard}
                  onTogglePin={() => void pins.toggle(selectedChat)}
                  pinPending={pins.pending.has(selectedChat.id)}
	                readOnly={selectedChatReadOnly}
	                onClose={closeConversation}
	                onContactInfoToggle={show => {
	                  if (show) openContactInfo()
	                  else closeDetails()
	                }}
	                contactInfoOpen={showContactInfo}
	                onRequestDelete={() => requestSingleChatDeletion(selectedChat)}
	                isActive={Boolean(participantChat) || (compactSurface !== 'list' && (layoutMode !== 'compact' || compactSurface === 'conversation'))}
	                onRead={reconcileChatUnread}
                  focusRequest={composerFocusRequest}
                  attentionMode={filterPending}
                  onNext={openNextPending}
	            />
              </div>
        )}
        {(!selectedChat || compactSurface === 'list') && (
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
      {showContactInfo && selectedChat && (
        <>
          {layoutMode === 'wide' && <div
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
          </div>}
          {layoutMode === 'medium' && !participantChat && <button type="button" className="absolute inset-0 z-20 bg-slate-950/20" onClick={() => closeDetails()} aria-label="Cerrar detalles" />}
          <ChatDetailsSurface
            key="conversation-details-surface"
            mode={layoutMode} width={rightPanelWidth} suspended={Boolean(participantChat)}
          >
            {isGroupChat(selectedChat) ? <GroupDetailsPanel ref={groupPanelRef} chat={selectedChat} suspended={Boolean(participantChat)} onOpenChat={changeParticipantChat} onClose={() => returnFromCompactSurface('details')} /> : <ContactPanel
              ref={contactPanelRef}
              chatId={selectedChat.id}
              isOpen={true}
              onClose={() => returnFromCompactSurface('details')}
              onFocusConversation={focusConversation}
              focusConversationClosesDetails={layoutMode !== 'wide'}
              deviceName={selectedDeviceName}
              devicePhone={selectedDevicePhone}
              chatPhone={formatPhone(selectedChat.jid, selectedChat.contact_phone)}
            />}
          </ChatDetailsSurface>
        </>
      )}

      {showMobileFilters && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[90]" onMouseDown={event => { if (event.target === event.currentTarget) setShowMobileFilters(false) }}><div ref={filterDialogRef} tabIndex={-1} style={filterPosition} className="fixed flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/15" role="dialog" aria-modal="true" aria-labelledby="mobile-chat-filters-title">
          <div className="flex min-h-14 shrink-0 items-center justify-between border-b border-slate-200 px-4">
            <div className="min-w-0">
              <h2 id="mobile-chat-filters-title" className="font-bold text-slate-900">Filtros de chats</h2>
              <p className="text-xs text-slate-500">{activeMobileFilterCount ? `${activeMobileFilterCount} activo${activeMobileFilterCount === 1 ? '' : 's'}` : 'Sin filtros activos'}</p>
            </div>
            <button type="button" onClick={() => setShowMobileFilters(false)} className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Cerrar filtros"><X className="h-5 w-5" /></button>
          </div>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
            <section aria-labelledby="mobile-basic-chat-filters" className="space-y-2">
              <h3 id="mobile-basic-chat-filters" className="text-xs font-bold uppercase tracking-wider text-slate-400">Mostrar</h3>
              <button type="button" onClick={() => setFilterDraft(draft => ({ ...draft, view: draft.view === 'unread' ? 'all' : 'unread' }))} className={`flex min-h-12 w-full items-center justify-between rounded-xl border px-4 text-sm font-semibold ${(filterDraft.view === 'unread') ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-700'}`} aria-pressed={(filterDraft.view === 'unread')}>
                <span className="flex items-center gap-3"><MessageCircle className="h-5 w-5" />Solo no leídos</span>
                <span className={`h-5 w-9 rounded-full p-0.5 transition ${(filterDraft.view === 'unread') ? 'bg-emerald-600' : 'bg-slate-200'}`}><span className={`block h-4 w-4 rounded-full bg-white shadow transition ${(filterDraft.view === 'unread') ? 'translate-x-4' : ''}`} /></span>
              </button>
              <button type="button" data-testid="mobile-filter-reaction-toggle" onClick={() => setFilterDraft(draft => ({ ...draft, reaction: !draft.reaction }))} className={`flex min-h-12 w-full items-center justify-between rounded-xl border px-4 text-sm font-semibold ${filterDraft.reaction ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-700'}`} aria-pressed={filterDraft.reaction}>
                <span className="flex items-center gap-3"><Heart className={`h-5 w-5 ${filterDraft.reaction ? 'fill-emerald-500' : ''}`} />Con reacción</span>
                <span className={`h-5 w-9 rounded-full p-0.5 transition ${filterDraft.reaction ? 'bg-emerald-600' : 'bg-slate-200'}`}><span className={`block h-4 w-4 rounded-full bg-white shadow transition ${filterDraft.reaction ? 'translate-x-4' : ''}`} /></span>
              </button>
            </section>

            {filterDraft.reaction && (
              <section className="space-y-4 rounded-2xl border border-emerald-100 bg-emerald-50/40 p-4" aria-labelledby="mobile-reaction-options">
                <h3 id="mobile-reaction-options" className="text-xs font-bold uppercase tracking-wider text-emerald-700">Opciones de reacción</h3>
                <div>
                  <p className="mb-2 text-xs font-semibold text-slate-600">¿De quién?</p>
                  <div className="grid grid-cols-3 gap-2">
                    {([{ v: 'client' as const, label: chatKind === 'group' ? 'Otros' : 'Cliente' }, { v: 'me' as const, label: chatKind === 'group' ? 'Mi número' : 'Operador' }, { v: 'any' as const, label: 'Cualquiera' }]).map(option => (
                      <button key={option.v} type="button" onClick={() => setFilterDraft(draft => ({ ...draft, from: option.v }))} className={`min-h-11 rounded-xl border px-2 text-xs font-semibold ${filterDraft.from === option.v ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-200 bg-white text-slate-600'}`}>{option.label}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold text-slate-600">Emojis opcionales</p>
                  <div className="flex flex-wrap gap-2">
                    {['👍','❤️','😂','😮','😢','🙏','🔥'].map(emoji => {
                      const active = filterDraft.emojis.includes(emoji)
                      return <button key={emoji} type="button" onClick={() => setFilterDraft(draft => ({ ...draft, emojis: active ? draft.emojis.filter(value => value !== emoji) : [...draft.emojis, emoji] }))} className={`flex h-11 w-11 items-center justify-center rounded-xl border text-base ${active ? 'border-emerald-400 bg-emerald-100 ring-2 ring-emerald-200' : 'border-slate-200 bg-white'}`} aria-pressed={active}>{emoji}</button>
                    })}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold text-slate-600">Período</p>
                  <div className="flex flex-wrap gap-2">
                    {([{ v: '1d' as const, label: 'Hoy' }, { v: '7d' as const, label: '7 días' }, { v: '30d' as const, label: '30 días' }, { v: 'any' as const, label: 'Siempre' }, { v: 'custom' as const, label: 'Rango' }]).map(option => (
                      <button key={option.v} type="button" onClick={() => setFilterDraft(draft => ({ ...draft, range: option.v }))} className={`min-h-11 rounded-xl border px-3 text-xs font-semibold ${filterDraft.range === option.v ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-200 bg-white text-slate-600'}`}>{option.label}</button>
                    ))}
                  </div>
                  {filterDraft.range === 'custom' && <div className="mt-3 grid grid-cols-1 gap-2 min-[380px]:grid-cols-2"><label className="text-xs text-slate-500">Desde<input type="date" value={filterDraft.customFrom} onChange={event => setFilterDraft(draft => ({ ...draft, customFrom: event.target.value }))} className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-slate-700" /></label><label className="text-xs text-slate-500">Hasta<input type="date" value={filterDraft.customTo} onChange={event => setFilterDraft(draft => ({ ...draft, customTo: event.target.value }))} className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-slate-700" /></label></div>}
                </div>
              </section>
            )}
          </div>
          <div className="flex shrink-0 gap-2 border-t border-slate-200 bg-white p-3">
            <button type="button" onClick={() => setFilterDraft({ view: 'all', reaction: false, from: 'client', emojis: [], range: '30d', customFrom: '', customTo: '' })} className="min-h-12 flex-1 rounded-xl border border-slate-200 text-sm font-semibold text-slate-600">Limpiar</button>
            <button type="button" onClick={() => setShowMobileFilters(false)} className="min-h-12 flex-1 rounded-xl border border-slate-200 text-sm font-semibold text-slate-600">Cancelar</button>
            <button type="button" onClick={applyFilterDraft} className="min-h-12 flex-1 rounded-xl bg-emerald-600 text-sm font-bold text-white hover:bg-emerald-700">Aplicar</button>
          </div>
        </div></div>,
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
