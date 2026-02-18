'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { Search, Plus, X, Trash2, CheckSquare, Square, MessageCircle } from 'lucide-react'
import { formatTime } from '@/utils/format'
import { createWebSocket } from '@/lib/api'
import DeviceSelector from '@/components/chat/DeviceSelector'
import TagSelector from '@/components/chat/TagSelector'
import NewChatModal from '@/components/chat/NewChatModal'
import ChatPanel from '@/components/chat/ChatPanel'
import { Chat, Device } from '@/types/chat'
import { getChatDisplayName, formatPhone } from '@/utils/chat'

export default function ChatsPage() {
  const [chats, setChats] = useState<Chat[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [tags, setTags] = useState<{ id: string; name: string; color: string }[]>([])
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null)

  // Filters & UI State
  const [filterDevices, setFilterDevices] = useState<string[]>([])
  const [filterTags, setFilterTags] = useState<string[]>([])
  const [filterUnread, setFilterUnread] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showNewChatModal, setShowNewChatModal] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedChats, setSelectedChats] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)

  // Resizable sidebar
  const [leftPanelWidth, setLeftPanelWidth] = useState(384) // default lg:w-96 = 384px
  const resizingRef = useRef<'left' | null>(null)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  // Responsive
  const [isMdScreen, setIsMdScreen] = useState(true)
  useEffect(() => {
    const checkScreen = () => setIsMdScreen(window.matchMedia('(min-width: 768px)').matches)
    checkScreen()
    window.addEventListener('resize', checkScreen)
    return () => window.removeEventListener('resize', checkScreen)
  }, [])

  // Auto-open logic
  const autoOpenProcessedRef = useRef(false)

  // Fetch Data
  const fetchChats = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const params = new URLSearchParams()
      filterDevices.forEach(id => params.append('device_ids', id))
      filterTags.forEach(id => params.append('tag_ids', id))
      if (filterUnread) params.append('unread_only', 'true')
      if (debouncedSearch) params.append('search', debouncedSearch)

      const res = await fetch(`/api/chats?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      if (data.success) setChats(data.chats || [])
    } catch (err) {
      console.error('Failed to fetch chats', err)
    } finally {
      setLoading(false)
    }
  }, [filterDevices, filterTags, filterUnread, debouncedSearch])

  const fetchDevices = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/devices', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) setDevices(data.devices || [])
    } catch {}
  }, [])

  const fetchTags = useCallback(async () => {
    const token = localStorage.getItem('token')
    try {
      const res = await fetch('/api/tags', { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data.success) setTags(data.tags || [])
    } catch {}
  }, [])

  useEffect(() => {
    fetchChats()
    fetchDevices()
    fetchTags()
  }, [fetchChats, fetchDevices, fetchTags])

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), 500)
    return () => clearTimeout(timer)
  }, [searchTerm])

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
          autoOpenProcessedRef.current = true
          window.history.replaceState({}, '', '/dashboard/chats')
       }
    }
  }, [chats, fetchChats])

  // WebSocket for List Updates
  useEffect(() => {
    const ws = createWebSocket((data: unknown) => {
      const msg = data as { event?: string }
      if (msg.event && ['new_message', 'message_sent'].includes(msg.event)) {
        fetchChats()
      }
    })
    if (!ws) return
    return () => ws.close()
  }, [fetchChats])

  // Resize Handlers
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = 'left'
    startXRef.current = e.clientX
    startWidthRef.current = leftPanelWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (resizingRef.current === 'left') {
        const delta = e.clientX - startXRef.current
        setLeftPanelWidth(Math.min(600, Math.max(260, startWidthRef.current + delta)))
      }
    }
    const handleMouseUp = () => {
      resizingRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // Selection Logic (Simplified)
  const toggleChatSelection = (chatId: string) => {
    const newSelected = new Set(selectedChats)
    if (newSelected.has(chatId)) newSelected.delete(chatId)
    else newSelected.add(chatId)
    setSelectedChats(newSelected)
  }

  const toggleSelectAll = () => {
     if (selectedChats.size === chats.length) setSelectedChats(new Set())
     else setSelectedChats(new Set(chats.map(c => c.id)))
  }

  const deleteSelectedChats = async () => {
    if (!confirm(`¿Eliminar ${selectedChats.size} chats?`)) return
    setDeleting(true)
    const token = localStorage.getItem('token')
    try {
        await fetch('/api/chats/batch', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ ids: Array.from(selectedChats) })
        })
        setSelectedChats(new Set())
        setSelectionMode(false)
        if (selectedChat && selectedChats.has(selectedChat.id)) setSelectedChat(null)
        fetchChats()
    } catch (e) {
        console.error(e)
        alert('Error al eliminar chats')
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
            if (data.success && data.chat) setSelectedChat(data.chat)
        })
    }, 500)
  }

  return (
    <div className="flex-1 min-h-0 flex bg-white md:rounded-xl md:border border-slate-200 overflow-hidden">
      {/* Sidebar - Chat List */}
      <div
        className={`border-r border-slate-200 flex flex-col min-h-0 overflow-hidden shrink-0 ${selectedChat ? 'hidden md:flex' : 'flex w-full md:w-auto'}`}
        style={isMdScreen ? { width: leftPanelWidth } : undefined}
      >
         <div className="p-3 border-b border-slate-100 space-y-2.5">
            {/* Header / Selection Mode */}
            {selectionMode ? (
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <button onClick={() => { setSelectionMode(false); setSelectedChats(new Set()) }} className="p-1.5 text-slate-600 hover:bg-slate-100 rounded-lg"><X className="w-4 h-4" /></button>
                        <span className="text-xs font-medium text-slate-600">{selectedChats.size} seleccionados</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <button onClick={toggleSelectAll} className="p-1.5 text-slate-600 hover:bg-slate-100 rounded-lg"><CheckSquare className="w-4 h-4" /></button>
                        <button onClick={deleteSelectedChats} disabled={deleting || selectedChats.size === 0} className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg"><Trash2 className="w-4 h-4" /></button>
                    </div>
                </div>
            ) : (
                <div className="flex items-center gap-2">
                    <DeviceSelector
                        devices={devices}
                        selectedDeviceIds={filterDevices}
                        onDeviceChange={setFilterDevices}
                    />
                    <div className="flex-1" />
                    <button onClick={() => setShowNewChatModal(true)} className="p-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 shadow-sm transition-all hover:shadow flex items-center gap-2 text-xs font-medium">
                        <Plus className="w-4 h-4" />
                        <span className="hidden sm:inline">Nuevo Chat</span>
                    </button>
                </div>
            )}

            {/* Search */}
             <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                type="text"
                placeholder="Buscar chats..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all placeholder:text-slate-400"
                />
            </div>

            {/* Tags + Unread filter */}
            <div className="flex items-center gap-2">
                <TagSelector
                    tags={tags}
                    selectedTagIds={filterTags}
                    onTagChange={setFilterTags}
                />
                <button
                    onClick={() => setFilterUnread(!filterUnread)}
                    className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                        filterUnread
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-300 shadow-sm'
                            : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300 hover:text-slate-700'
                    }`}
                >
                    <MessageCircle className="w-3.5 h-3.5" />
                    No leídos
                </button>
            </div>
         </div>

         {/* Chat List Items */}
         <div className="flex-1 overflow-y-auto">
            {loading ? (
                <div className="flex justify-center p-8"><div className="animate-spin rounded-full h-6 w-6 border-2 border-emerald-200 border-t-emerald-600" /></div>
            ) : chats.length === 0 ? (
                <div className="p-8 text-center text-slate-500 text-sm">No se encontraron chats</div>
            ) : (
                chats.map(chat => (
                    <div
                        key={chat.id}
                        onContextMenu={(e) => { e.preventDefault(); setSelectionMode(true); toggleChatSelection(chat.id) }}
                        onClick={() => {
                            if (selectionMode) toggleChatSelection(chat.id)
                            else setSelectedChat(chat)
                        }}
                        className={`group px-3 py-3 flex items-start gap-3 cursor-pointer border-b border-fuchsia-50/50 hover:bg-slate-50 transition-all relative ${selectedChat?.id === chat.id ? 'bg-emerald-100 border-l-4 border-l-emerald-500 hover:bg-emerald-100' : ''}`}
                    >
                        {selectionMode && (
                             <div className={`shrink-0 mt-2 ${selectedChats.has(chat.id) ? 'text-emerald-600' : 'text-slate-300'}`}>
                                 {selectedChats.has(chat.id) ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5" />}
                             </div>
                        )}

                        <div className="relative shrink-0">
                             {chat.contact_avatar_url ? (
                                <img src={chat.contact_avatar_url} alt="" className="w-12 h-12 rounded-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden') }} />
                             ) : null}
                             <div className={`w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center ${chat.contact_avatar_url ? 'hidden' : ''}`}>
                                <span className="text-emerald-700 font-bold text-lg">{getChatDisplayName(chat).charAt(0).toUpperCase()}</span>
                             </div>
                             {chat.unread_count > 0 && (
                                <div className="absolute -top-1 -right-1 bg-emerald-500 text-white text-[10px] font-bold h-5 min-w-[1.25rem] px-1 rounded-full flex items-center justify-center shadow-sm ring-2 ring-white">
                                    {chat.unread_count}
                                </div>
                             )}
                        </div>

                        <div className="flex-1 min-w-0">
                            <div className="flex justify-between items-baseline mb-0.5">
                                <h3 className={`text-sm font-semibold truncate pr-2 ${chat.unread_count > 0 ? 'text-slate-900' : 'text-slate-700'}`}>
                                    {getChatDisplayName(chat)}
                                </h3>
                                <span className={`text-[10px] whitespace-nowrap ${chat.unread_count > 0 ? 'text-emerald-600 font-bold' : 'text-slate-400'}`}>
                                    {formatTime(chat.last_message_at)}
                                </span>
                            </div>
                            <div className="flex items-center gap-1.5">
                                <span className="text-xs text-slate-500 truncate block max-w-[180px]">
                                    {chat.last_message || 'Sin mensajes'}
                                </span>
                            </div>
                            {/* Device & Phone Labels */}
                            <div className="flex items-center gap-2 mt-1.5">
                                 {chat.device_name && (
                                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600 border border-slate-200">
                                        {chat.device_name}
                                    </span>
                                 )}
                                 {formatPhone(chat.jid, chat.contact_phone) && formatPhone(chat.jid, chat.contact_phone) !== getChatDisplayName(chat) && (
                                    <span className="text-[10px] text-slate-400 truncate">
                                        {formatPhone(chat.jid, chat.contact_phone)}
                                    </span>
                                 )}
                            </div>
                        </div>
                    </div>
                ))
            )}
         </div>
      </div>

      {/* Resizer */}
      {isMdScreen && (
        <div
            onMouseDown={startResize}
            className="hidden md:flex w-1 hover:w-1.5 bg-slate-100 hover:bg-emerald-400/50 cursor-col-resize shrink-0 transition-all active:bg-emerald-500/50 z-10"
        />
      )}

      {/* Main Chat Panel */}
      <div className="flex-1 flex flex-col min-h-0 bg-slate-50/50 relative overflow-hidden">
        {selectedChat ? (
            <ChatPanel
                chatId={selectedChat.id}
                deviceId={selectedChat.device_id || devices[0]?.id || ''}
                initialChat={selectedChat}
                onClose={() => setSelectedChat(null)}
            />
        ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-slate-400">
                <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                    <div className="w-8 h-8 rounded-full bg-emerald-100" />
                </div>
                <p>Selecciona un chat para comenzar</p>
            </div>
        )}
      </div>

       <NewChatModal
        isOpen={showNewChatModal}
        onClose={() => setShowNewChatModal(false)}
        onChatCreated={handleChatCreated}
        devices={devices}
      />
    </div>
  )
}
