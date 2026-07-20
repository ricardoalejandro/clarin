'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, CheckCheck, ChevronDown, Clock, CloudCog, FileText, Loader2,
  MessageCircle, Plus, RefreshCw, Search, Send, Settings, ShieldCheck, X,
} from 'lucide-react'
import { apiGet, apiPost, subscribeWebSocket } from '@/lib/api'
import type { Chat, Message } from '@/types/chat'
import { formatPhone, getChatDisplayName } from '@/utils/chat'

interface CloudChat extends Chat {
  customer_service_window_expires_at?: string
  last_inbound_at?: string
  last_outbound_at?: string
}

interface CloudChannel {
  id: string
  name?: string
  phone?: string
  status?: string
  api_display_phone?: string
  api_sending_enabled: boolean
  api_templates_enabled: boolean
}

interface MetaTemplateComponent {
  type?: string
  format?: string
  text?: string
  buttons?: Array<{ type?: string; text?: string; url?: string }>
}

interface MetaTemplate {
  id: string
  device_id?: string
  name: string
  language: string
  category: string
  status: string
  components?: MetaTemplateComponent[]
}

interface TemplateVariable {
  key: string
  component: 'header' | 'body'
  position: number
  label: string
}

interface ChatsResponse { chats: CloudChat[]; total: number }
interface ChannelsResponse { channels: CloudChannel[] }
interface TemplatesResponse { templates: MetaTemplate[] }
interface MessagesResponse { messages: Message[] }
interface SendResponse { message?: Message; chat?: CloudChat; warning?: string }

function timeLabel(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  return date.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
}

function dateLabel(value: string) {
  const date = new Date(value)
  return date.toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' })
}

function messagePreview(message: Message) {
  if (message.body?.trim()) return message.body
  const labels: Record<string, string> = {
    image: '📷 Imagen', video: '🎥 Video', audio: '🎵 Audio', document: '📄 Documento', sticker: 'Sticker',
  }
  return labels[message.message_type || ''] || 'Mensaje'
}

function isWindowOpen(chat: CloudChat | null) {
  if (!chat?.customer_service_window_expires_at) return false
  return new Date(chat.customer_service_window_expires_at).getTime() > Date.now()
}

function templateText(template?: MetaTemplate) {
  const body = template?.components?.find(component => component.type?.toUpperCase() === 'BODY')
  return body?.text || `[Plantilla: ${template?.name || ''}]`
}

function templateVariables(template?: MetaTemplate): TemplateVariable[] {
  if (!template?.components) return []
  const variables: TemplateVariable[] = []
  for (const component of template.components) {
    const type = component.type?.toLowerCase()
    if (type !== 'header' && type !== 'body') continue
    const matches = Array.from((component.text || '').matchAll(/\{\{(\d+)\}\}/g))
    const positions = Array.from(new Set(matches.map(match => Number(match[1])))).sort((a, b) => a - b)
    for (const position of positions) {
      variables.push({
        key: `${type}-${position}`,
        component: type,
        position,
        label: `${type === 'header' ? 'Encabezado' : 'Mensaje'} · variable ${position}`,
      })
    }
  }
  return variables
}

function templateIsSupportedInInbox(template?: MetaTemplate) {
  if (!template?.components) return true
  for (const component of template.components) {
    const type = component.type?.toUpperCase()
    if (type === 'HEADER' && component.format && component.format.toUpperCase() !== 'TEXT') return false
    if (type === 'BUTTONS' && component.buttons?.some(button => button.url?.includes('{{'))) return false
    const placeholders = Array.from((component.text || '').matchAll(/\{\{([^}]+)\}\}/g))
    if (placeholders.some(match => !/^\d+$/.test(match[1]))) return false
  }
  return true
}

function buildTemplateComponents(variables: TemplateVariable[], values: Record<string, string>) {
  const result: Array<{ type: string; parameters: Array<{ type: 'text'; text: string }> }> = []
  for (const component of ['header', 'body'] as const) {
    const entries = variables.filter(variable => variable.component === component).sort((a, b) => a.position - b.position)
    if (entries.length === 0) continue
    result.push({
      type: component,
      parameters: entries.map(entry => ({ type: 'text', text: values[entry.key]?.trim() || '' })),
    })
  }
  return result
}

function displayName(chat: CloudChat) {
  return getChatDisplayName(chat) || formatPhone(chat.contact_phone || chat.jid)
}

export default function ChatAPIPage() {
  const [chats, setChats] = useState<CloudChat[]>([])
  const [channels, setChannels] = useState<CloudChannel[]>([])
  const [templates, setTemplates] = useState<MetaTemplate[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [selectedChat, setSelectedChat] = useState<CloudChat | null>(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [sending, setSending] = useState(false)
  const [body, setBody] = useState('')
  const [composerMode, setComposerMode] = useState<'text' | 'template'>('text')
  const [selectedTemplateID, setSelectedTemplateID] = useState('')
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({})
  const [feedback, setFeedback] = useState('')
  const [showNewConversation, setShowNewConversation] = useState(false)
  const [newPhone, setNewPhone] = useState('')
  const [newChannelID, setNewChannelID] = useState('')
  const [newTemplateID, setNewTemplateID] = useState('')
  const [newTemplateValues, setNewTemplateValues] = useState<Record<string, string>>({})
  const [newOptInConfirmed, setNewOptInConfirmed] = useState(false)
  const [newOptInSource, setNewOptInSource] = useState('')
  const [newOptInNote, setNewOptInNote] = useState('')
  const [startingConversation, setStartingConversation] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const selectedChatIDRef = useRef<string | null>(null)
  const autoOpenedRef = useRef(false)
  const sendingRef = useRef(false)
  const startingConversationRef = useRef(false)

  selectedChatIDRef.current = selectedChat?.id || null

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [search])

  const loadChannelsAndTemplates = useCallback(async () => {
    const [channelsResponse, templatesResponse] = await Promise.all([
      apiGet<ChannelsResponse>('/api/chat-api/channels'),
      apiGet<TemplatesResponse>('/api/chat-api/templates'),
    ])
    if (channelsResponse.success) {
      const nextChannels = channelsResponse.data?.channels || []
      setChannels(nextChannels)
      setNewChannelID(current => nextChannels.some(channel => channel.id === current && channel.api_sending_enabled && channel.api_templates_enabled)
        ? current
        : nextChannels.find(channel => channel.api_sending_enabled && channel.api_templates_enabled)?.id || '')
    }
    if (templatesResponse.success) setTemplates(templatesResponse.data?.templates || [])
  }, [])

  const loadChats = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    const params = new URLSearchParams({ limit: '100' })
    if (debouncedSearch) params.set('search', debouncedSearch)
    const response = await apiGet<ChatsResponse>(`/api/chat-api/chats?${params.toString()}`)
    if (response.success) {
      const nextChats = response.data?.chats || []
      setChats(current => nextChats.map(chat => {
        const existing = current.find(item => item.id === chat.id)
        return existing && JSON.stringify(existing) === JSON.stringify(chat) ? existing : chat
      }))
      setSelectedChat(current => current ? nextChats.find(chat => chat.id === current.id) || current : current)
      setFeedback('')
    } else if (!silent) {
      setFeedback(response.error || 'No se pudieron cargar los chats oficiales')
    }
    if (!silent) setLoading(false)
  }, [debouncedSearch])

  useEffect(() => {
    void Promise.all([loadChannelsAndTemplates(), loadChats()])
  }, [loadChannelsAndTemplates, loadChats])

  const loadMessages = useCallback(async (chatID: string, silent = false) => {
    if (!silent) setLoadingMessages(true)
    const response = await apiGet<MessagesResponse>(`/api/chat-api/chats/${chatID}/messages?limit=100`)
    if (response.success && selectedChatIDRef.current === chatID) {
      setMessages(response.data?.messages || [])
      setFeedback('')
    } else if (!response.success && !silent) {
      setFeedback(response.error || 'No se pudieron cargar los mensajes')
    }
    if (!silent) setLoadingMessages(false)
  }, [])

  const openChat = useCallback((chat: CloudChat) => {
    selectedChatIDRef.current = chat.id
    setSelectedChat(chat)
    setMessages([])
    setBody('')
    setSelectedTemplateID('')
    setTemplateValues({})
    setComposerMode(isWindowOpen(chat) ? 'text' : 'template')
    void loadMessages(chat.id)
    if (chat.unread_count > 0) {
      void apiPost(`/api/chat-api/chats/${chat.id}/read`, {}).then(() => {
        setChats(current => current.map(item => item.id === chat.id ? { ...item, unread_count: 0 } : item))
      })
    }
  }, [loadMessages])

  useEffect(() => {
    if (autoOpenedRef.current || chats.length === 0 || typeof window === 'undefined') return
    const openID = new URLSearchParams(window.location.search).get('open')
    if (!openID) {
      autoOpenedRef.current = true
      return
    }
    const chat = chats.find(item => item.id === openID)
    if (chat) {
      autoOpenedRef.current = true
      openChat(chat)
    }
  }, [chats, openChat])

  useEffect(() => {
    const unsubscribe = subscribeWebSocket((event) => {
      const payload = event as { event?: string; data?: { chat_id?: string; message?: Message } }
      const chatID = payload.data?.chat_id
      if (payload.event === 'new_message' && chatID && payload.data?.message) {
        if (chatID === selectedChatIDRef.current && (payload.data.message as Message & { provider?: string }).provider === 'whatsapp_cloud_api') {
          setMessages(current => current.some(message => message.message_id === payload.data?.message?.message_id) ? current : [...current, payload.data!.message!])
        }
        void loadChats(true)
      } else if (payload.event === 'chat_update' || payload.event === 'message_status' || payload.event === 'device_status') {
        void loadChats(true)
        if (selectedChatIDRef.current) void loadMessages(selectedChatIDRef.current, true)
      }
    })
    return unsubscribe
  }, [loadChats, loadMessages])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  const selectedTemplate = templates.find(template => template.id === selectedTemplateID)
  const selectedVariables = useMemo(() => templateVariables(selectedTemplate), [selectedTemplate])
  const newTemplate = templates.find(template => template.id === newTemplateID)
  const newVariables = useMemo(() => templateVariables(newTemplate), [newTemplate])
  const channelTemplates = useMemo(() => templates.filter(template => !newChannelID || template.device_id === newChannelID), [templates, newChannelID])
  const windowOpen = isWindowOpen(selectedChat)
  const selectedChannel = channels.find(channel => channel.id === selectedChat?.device_id)
  const selectedChannelTemplatesReady = selectedChannel?.api_templates_enabled === true

  useEffect(() => {
    if (!windowOpen && composerMode === 'text') setComposerMode('template')
  }, [composerMode, windowOpen])

  const sendCurrentMessage = async () => {
    if (!selectedChat || sendingRef.current) return
    if (composerMode === 'text' && !body.trim()) return
    if (composerMode === 'template' && !selectedTemplate) return
    if (composerMode === 'template' && !templateIsSupportedInInbox(selectedTemplate)) {
      setFeedback('Esta plantilla requiere archivos, botones dinámicos o parámetros que esta primera versión de la bandeja todavía no admite.')
      return
    }
    if (composerMode === 'template' && selectedVariables.some(variable => !templateValues[variable.key]?.trim())) {
      setFeedback('Completa todas las variables de la plantilla.')
      return
    }
    sendingRef.current = true
    setSending(true)
    setFeedback('')
    const response = await apiPost<SendResponse>('/api/chat-api/messages/send', {
      chat_id: selectedChat.id,
      type: composerMode,
      body: composerMode === 'text' ? body.trim() : undefined,
      template_id: composerMode === 'template' ? selectedTemplate?.id : undefined,
      template_components: composerMode === 'template' ? buildTemplateComponents(selectedVariables, templateValues) : undefined,
    })
    sendingRef.current = false
    setSending(false)
    if (!response.success) {
      setFeedback(response.error || 'No se pudo enviar el mensaje')
      if (response.error?.includes('ventana')) setComposerMode('template')
      return
    }
    if (response.data?.message) {
      setMessages(current => current.some(message => message.message_id === response.data?.message?.message_id) ? current : [...current, response.data!.message!])
    }
    if (response.data?.warning) setFeedback(response.data.warning)
    setBody('')
    setTemplateValues({})
    setSelectedTemplateID('')
    await loadChats(true)
  }

  const startConversation = async () => {
    if (!newPhone.trim() || !newChannelID || !newTemplate || startingConversationRef.current) return
    if (!templateIsSupportedInInbox(newTemplate)) {
      setFeedback('Esta plantilla requiere archivos, botones dinámicos o parámetros que esta primera versión de la bandeja todavía no admite.')
      return
    }
    if (newVariables.some(variable => !newTemplateValues[variable.key]?.trim())) {
      setFeedback('Completa todas las variables de la plantilla.')
      return
    }
    startingConversationRef.current = true
    setStartingConversation(true)
    setFeedback('')
    const response = await apiPost<SendResponse>('/api/chat-api/messages/send', {
      device_id: newChannelID,
      to: newPhone,
      type: 'template',
      template_id: newTemplate.id,
      template_components: buildTemplateComponents(newVariables, newTemplateValues),
      opt_in_confirmed: newOptInConfirmed,
      opt_in_source: newOptInSource,
      opt_in_note: newOptInNote.trim(),
    })
    startingConversationRef.current = false
    setStartingConversation(false)
    if (!response.success) {
      setFeedback(response.error || 'No se pudo iniciar la conversación')
      return
    }
    setShowNewConversation(false)
    setNewPhone('')
    setNewTemplateID('')
    setNewTemplateValues({})
    setNewOptInConfirmed(false)
    setNewOptInSource('')
    setNewOptInNote('')
    await loadChats(true)
    if (response.data?.chat) openChat(response.data.chat)
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-white">
      <aside className={`${selectedChat ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r border-slate-200 bg-white md:w-[360px]`}>
        <div className="border-b border-slate-200 px-4 pb-3 pt-4">
          <div className="flex items-center justify-between gap-3">
            <div><div className="flex items-center gap-2"><CloudCog className="h-5 w-5 text-sky-600" /><h1 className="text-base font-bold text-slate-900">Chat API</h1></div><p className="mt-0.5 text-xs text-slate-500">WhatsApp oficial · directo con Meta</p></div>
            <button type="button" onClick={() => setShowNewConversation(true)} disabled={!channels.some(channel => channel.api_sending_enabled && channel.api_templates_enabled) || templates.length === 0} className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40" aria-label="Nueva conversación con plantilla"><Plus className="h-4 w-4" /></button>
          </div>
          <div className="relative mt-3"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar conversación" className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-9 pr-9 text-sm text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20" />{search && <button type="button" onClick={() => setSearch('')} className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-200"><X className="h-3.5 w-3.5" /></button>}</div>
        </div>

        {channels.length === 0 && !loading ? (
          <div className="m-4 rounded-2xl border border-dashed border-slate-300 p-5 text-center"><ShieldCheck className="mx-auto h-7 w-7 text-sky-600" /><p className="mt-3 text-sm font-semibold text-slate-800">Falta conectar un número oficial</p><p className="mt-1 text-xs leading-5 text-slate-500">Un administrador debe completar Embedded Signup con Meta.</p><Link href="/dashboard/settings" className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-xs font-bold text-white"><Settings className="h-4 w-4" /> Ir a configuración</Link></div>
        ) : loading ? (
          <div className="flex flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-emerald-600" /></div>
        ) : chats.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center"><MessageCircle className="h-8 w-8 text-slate-300" /><p className="mt-3 text-sm font-semibold text-slate-700">Sin conversaciones API</p><p className="mt-1 text-xs leading-5 text-slate-500">Cuando llegue un webhook aparecerá aquí, o inicia una conversación con una plantilla aprobada.</p></div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {chats.map(chat => (
              <button key={chat.id} type="button" onClick={() => openChat(chat)} className={`flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50 ${selectedChat?.id === chat.id ? 'bg-emerald-50/60' : ''}`}>
                <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-sky-100 to-emerald-100 text-sm font-bold text-sky-800">{chat.contact_avatar_url ? <img src={chat.contact_avatar_url} alt="" className="h-full w-full object-cover" /> : displayName(chat).slice(0, 1).toUpperCase()}</div>
                <div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><p className="truncate text-sm font-semibold text-slate-900">{displayName(chat)}</p><span className="shrink-0 text-[11px] text-slate-400">{timeLabel(chat.last_message_at)}</span></div><div className="mt-1 flex items-center gap-2"><p className="min-w-0 flex-1 truncate text-xs text-slate-500">{chat.last_message || 'Sin mensajes'}</p>{chat.unread_count > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-600 px-1 text-[10px] font-bold text-white">{chat.unread_count}</span>}</div><p className="mt-1 truncate text-[10px] text-sky-600">{chat.device_name || 'Meta Cloud API'} · {isWindowOpen(chat) ? 'ventana abierta' : 'requiere plantilla'}</p></div>
              </button>
            ))}
          </div>
        )}
      </aside>

      <main className={`${selectedChat ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col bg-[#efeae2]`}>
        {!selectedChat ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center"><div className="rounded-3xl bg-white/80 p-5 shadow-sm"><CloudCog className="h-10 w-10 text-sky-600" /></div><h2 className="mt-5 text-lg font-bold text-slate-800">Bandeja oficial separada</h2><p className="mt-2 max-w-md text-sm leading-6 text-slate-600">Los chats de Cloud API viven aquí. La vista Chats y sus sesiones QR no se modifican.</p></div>
        ) : (
          <>
            <header className="flex min-h-16 items-center gap-3 border-b border-slate-200 bg-white px-3 sm:px-4">
              <button type="button" onClick={() => setSelectedChat(null)} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100 md:hidden"><ArrowLeft className="h-5 w-5" /></button>
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-100 font-bold text-sky-800">{displayName(selectedChat).slice(0, 1).toUpperCase()}</div>
              <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-bold text-slate-900">{displayName(selectedChat)}</h2><p className="truncate text-xs text-slate-500">{formatPhone(selectedChat.contact_phone || selectedChat.jid)} · {selectedChat.device_name || 'Meta Cloud API'}</p></div>
              <div className={`hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold sm:flex ${windowOpen ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}><Clock className="h-3.5 w-3.5" />{windowOpen ? `Abierta hasta ${timeLabel(selectedChat.customer_service_window_expires_at)}` : 'Ventana cerrada'}</div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
              {loadingMessages ? <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-emerald-600" /></div> : messages.length === 0 ? <div className="flex h-full items-center justify-center"><span className="rounded-full bg-white/80 px-4 py-2 text-xs text-slate-500 shadow-sm">Sin mensajes guardados</span></div> : (
                <div className="mx-auto flex max-w-4xl flex-col gap-2">
                  {messages.map((message, index) => {
                    const previous = messages[index - 1]
                    const showDate = !previous || new Date(previous.timestamp).toDateString() !== new Date(message.timestamp).toDateString()
                    return <div key={message.id || message.message_id}>
                      {showDate && <div className="my-3 flex justify-center"><span className="rounded-lg bg-white/85 px-3 py-1 text-[11px] font-medium text-slate-500 shadow-sm">{dateLabel(message.timestamp)}</span></div>}
                      <div className={`flex ${message.is_from_me ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[85%] rounded-2xl px-3 py-2 shadow-sm sm:max-w-[70%] ${message.is_from_me ? 'rounded-tr-md bg-[#d9fdd3]' : 'rounded-tl-md bg-white'}`}><p className="whitespace-pre-wrap break-words text-sm leading-5 text-slate-800">{messagePreview(message)}</p><div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-slate-400"><span>{timeLabel(message.timestamp)}</span>{message.is_from_me && <CheckCheck className={`h-3.5 w-3.5 ${message.status === 'read' ? 'text-sky-500' : ''}`} />}</div></div></div>
                    </div>
                  })}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>

            <footer className="border-t border-slate-200 bg-white p-3">
              <div className="mx-auto max-w-4xl">
                {feedback && <div className="mb-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">{feedback}</div>}
                <div className="mb-2 flex items-center gap-2"><button type="button" onClick={() => setComposerMode('text')} disabled={!windowOpen} className={`min-h-9 rounded-lg px-3 text-xs font-semibold ${composerMode === 'text' ? 'bg-emerald-100 text-emerald-800' : 'text-slate-500 hover:bg-slate-100'} disabled:cursor-not-allowed disabled:opacity-40`}>Mensaje libre</button><button type="button" onClick={() => setComposerMode('template')} disabled={!selectedChannelTemplatesReady} className={`min-h-9 rounded-lg px-3 text-xs font-semibold ${composerMode === 'template' ? 'bg-sky-100 text-sky-800' : 'text-slate-500 hover:bg-slate-100'} disabled:cursor-not-allowed disabled:opacity-40`}>Plantilla</button>{!windowOpen && <span className="text-[11px] text-amber-700">{selectedChannelTemplatesReady ? 'La ventana cerró; Meta exige plantilla.' : 'La ventana cerró y las plantillas deben sincronizarse.'}</span>}</div>
                {composerMode === 'text' ? (
                  <div className="flex items-end gap-2"><textarea value={body} onChange={event => setBody(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendCurrentMessage() } }} rows={1} maxLength={4096} placeholder="Escribe un mensaje" className="max-h-32 min-h-11 flex-1 resize-none rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20" /><button type="button" onClick={() => void sendCurrentMessage()} disabled={sending || !body.trim()} className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40">{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button></div>
                ) : (
                  <div className="space-y-2"><div className="relative"><select value={selectedTemplateID} onChange={event => { setSelectedTemplateID(event.target.value); setTemplateValues({}) }} className="h-11 w-full appearance-none rounded-xl border border-slate-200 bg-white px-3 pr-9 text-sm text-slate-800 outline-none focus:border-sky-500"><option value="">Selecciona una plantilla aprobada</option>{templates.filter(template => template.device_id === selectedChat.device_id).map(template => <option key={template.id} value={template.id} disabled={!templateIsSupportedInInbox(template)}>{template.name} · {template.language}{templateIsSupportedInInbox(template) ? '' : ' · no compatible aún'}</option>)}</select><ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /></div>{selectedTemplate && <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600"><p className="whitespace-pre-wrap">{templateText(selectedTemplate)}</p></div>}{selectedVariables.map(variable => <input key={variable.key} value={templateValues[variable.key] || ''} onChange={event => setTemplateValues(current => ({ ...current, [variable.key]: event.target.value }))} placeholder={variable.label} className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-sky-500" />)}<button type="button" onClick={() => void sendCurrentMessage()} disabled={sending || !selectedTemplate} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 text-sm font-bold text-white hover:bg-sky-700 disabled:opacity-40">{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Enviar plantilla</button></div>
                )}
              </div>
            </footer>
          </>
        )}
      </main>

      {showNewConversation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4" role="dialog" aria-modal="true" aria-label="Nueva conversación API">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h2 className="text-base font-bold text-slate-900">Nueva conversación API</h2><p className="mt-0.5 text-xs text-slate-500">Meta exige una plantilla aprobada para iniciar.</p></div><button type="button" onClick={() => setShowNewConversation(false)} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"><X className="h-4 w-4" /></button></div>
            <div className="max-h-[70vh] space-y-3 overflow-y-auto p-5"><div><label className="mb-1 block text-xs font-semibold text-slate-600">Canal oficial</label><select value={newChannelID} onChange={event => { setNewChannelID(event.target.value); setNewTemplateID(''); setNewTemplateValues({}) }} className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm"><option value="">Selecciona un canal</option>{channels.filter(channel => channel.api_sending_enabled && channel.api_templates_enabled).map(channel => <option key={channel.id} value={channel.id}>{channel.name || channel.api_display_phone || channel.phone}</option>)}</select></div><div><label className="mb-1 block text-xs font-semibold text-slate-600">Número con código de país</label><input value={newPhone} onChange={event => setNewPhone(event.target.value)} placeholder="51999999999" inputMode="tel" className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" /></div><div><label className="mb-1 block text-xs font-semibold text-slate-600">Plantilla aprobada</label><select value={newTemplateID} onChange={event => { setNewTemplateID(event.target.value); setNewTemplateValues({}) }} className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm"><option value="">Selecciona una plantilla</option>{channelTemplates.map(template => <option key={template.id} value={template.id} disabled={!templateIsSupportedInInbox(template)}>{template.name} · {template.language}{templateIsSupportedInInbox(template) ? '' : ' · no compatible aún'}</option>)}</select></div>{newTemplate && <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600"><p className="whitespace-pre-wrap">{templateText(newTemplate)}</p></div>}{newVariables.map(variable => <input key={variable.key} value={newTemplateValues[variable.key] || ''} onChange={event => setNewTemplateValues(current => ({ ...current, [variable.key]: event.target.value }))} placeholder={variable.label} className="h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" />)}<div className="rounded-xl border border-amber-200 bg-amber-50 p-3"><p className="text-xs font-bold text-amber-900">Consentimiento requerido por WhatsApp</p><p className="mt-1 text-[11px] leading-4 text-amber-800">Registra cómo autorizó esta persona recibir mensajes. No uses listas compradas ni números sin permiso.</p><select value={newOptInSource} onChange={event => setNewOptInSource(event.target.value)} className="mt-3 h-11 w-full rounded-xl border border-amber-200 bg-white px-3 text-sm text-slate-800"><option value="">Origen del consentimiento</option><option value="website_form">Formulario web</option><option value="in_person">Autorización presencial</option><option value="phone_call">Llamada telefónica</option><option value="contract">Contrato o matrícula</option><option value="imported_evidence">Evidencia importada</option></select><textarea value={newOptInNote} onChange={event => setNewOptInNote(event.target.value)} maxLength={500} rows={2} placeholder="Referencia opcional: formulario, fecha, campaña de captación…" className="mt-2 w-full resize-none rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm" /><label className="mt-2 flex items-start gap-2 text-xs font-semibold text-amber-900"><input type="checkbox" checked={newOptInConfirmed} onChange={event => setNewOptInConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-amber-300 text-emerald-600" /><span>Confirmo que existe autorización verificable para contactar este número por WhatsApp.</span></label></div></div>
            <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-4"><button type="button" onClick={() => setShowNewConversation(false)} className="min-h-11 rounded-xl px-4 text-sm font-semibold text-slate-600 hover:bg-slate-100">Cancelar</button><button type="button" onClick={() => void startConversation()} disabled={startingConversation || !newPhone.trim() || !newChannelID || !newTemplateID || !newOptInConfirmed || !newOptInSource} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-sky-600 px-4 text-sm font-bold text-white hover:bg-sky-700 disabled:opacity-40">{startingConversation ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Enviar plantilla</button></div>
          </div>
        </div>
      )}
    </div>
  )
}
