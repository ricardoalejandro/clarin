'use client'

import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { X, Search, Send, User, Users, Check, RefreshCw, Forward, AlertCircle } from 'lucide-react'
import type { Chat, Message } from '@/types/chat'
import { SEARCH_DEBOUNCE_MS } from '@/lib/useDebouncedValue'
import { SearchRequestLifecycle, type SearchRequestLease } from '@/lib/searchRequestLifecycle'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import { OPERATIONAL_OVERLAY_LAYERS, useOperationalOverlayPortal, useOperationalOverlayRegistration } from '@/components/operational-window/OperationalOverlayContext'
import { restoreDialogFocus, useDialogTabTrap } from '@/components/programs/useDialogTabTrap'
import { bindingRevision } from './chatContinuity'
import { chatAvatar, isGroupChat } from '@/utils/chatGroups'
import { formatPhone, getChatDisplayName, isPendingChatIdentity } from '@/utils/chat'
import { forwardValidationCodes, forwardDestinationIssue, forwardingLabel, forwardingSessionKey, forwardLimits, forwardSourceIssue, forwardActionIssue, parseForwardReceipt, rememberForwardBatch, restoreForwardBatch, type ForwardBatchRequest, type ForwardDestinationResult, type StoredForwardBatch, type ForwardMode, type ForwardContentVariant } from './messageForwarding'

interface Props {
  message: Message
  sourceChat?: Chat | null
  deviceId: string
  chatId: string
  onClose: () => void
  onSuccess: () => void
  suspended?: boolean
  nativeForwardEnabled?: boolean
  copyEnabled?: boolean
}
const PAGE_SIZE = 50
const resultLabel: Record<ForwardDestinationResult['state'], string> = { pending: 'Pendiente', sending: 'Enviando', sent: 'Enviado', failed: 'No enviado', uncertain: 'Resultado por comprobar' }

export default function ForwardMessageModal(props: Props) {
  const scope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  if (isAuthIdentityChanging(scope)) return null
  return <ForwardMessageSession key={`${scope}:${props.deviceId}:${props.chatId}:${props.message.id}`} {...props} scope={scope} />
}

function ForwardMessageSession({ message, sourceChat, deviceId, chatId, onClose, onSuccess, suspended = false, nativeForwardEnabled = false, copyEnabled = true, scope }: Props & { scope: string }) {
  const key = forwardingSessionKey(scope, chatId, message.id, deviceId)
  const suspendedRef = useRef(suspended); suspendedRef.current = suspended
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const writeLease = useRef<AbortController | null>(null)
  const searchLifecycle = useRef(new SearchRequestLifecycle())
  const searchEdited = useRef(false)
  const current = useCallback(() => mounted.current && getAuthScope() === scope && !isAuthIdentityChanging(scope), [scope])
  const nativeCapabilityIssue = 'El reenvío nativo aún no está verificado para este dispositivo.'
  const [capabilityRejected, setCapabilityRejected] = useState(false)
  const initial = useRef<StoredForwardBatch | null | undefined>(undefined)
  if (initial.current === undefined) {
    const restored = restoreForwardBatch(key)
    initial.current = restored?.request.source_chat_id === chatId && restored.request.source_message_id === message.id && restored.request.device_id === deviceId ? restored : null
  }
  const [batch, setBatch] = useState<StoredForwardBatch | null>(initial.current)
  const batchRef = useRef(batch); batchRef.current = batch
  const nativeIssue = forwardSourceIssue(message, deviceId, 'native', 'original', sourceChat) || (!nativeForwardEnabled || capabilityRejected ? nativeCapabilityIssue : null)
  const copyIssue = forwardActionIssue(message, deviceId, sourceChat) || (!copyEnabled ? 'El dispositivo no está disponible para enviar una copia.' : null)
  const [chosenMode, setChosenMode] = useState<ForwardMode>(() => initial.current?.request.mode ?? (initial.current ? 'native' : nativeIssue ? 'copy' : 'native'))
  const [chosenVariant, setChosenVariant] = useState<ForwardContentVariant>(() => initial.current?.request.content_variant ?? 'original')
  const mode = batch ? batch.request.mode ?? 'native' : chosenMode
  const variant = batch ? batch.request.content_variant ?? 'original' : chosenVariant
  const sourceIssue = mode === 'native' ? nativeIssue : copyIssue || forwardSourceIssue(message, deviceId, mode, variant, sourceChat)
  const sourceIssueRef = useRef(sourceIssue); sourceIssueRef.current = sourceIssue
  const optionsRef = useRef({ mode, variant }); optionsRef.current = { mode, variant }
  const needsAudioDocument = message.message_type === 'audio'
  const limits = forwardLimits(message)

  const [chats, setChats] = useState<Chat[]>([])
  const [selected, setSelected] = useState<Chat[]>([])
  const [search, setSearch] = useState('')
  const [settledSearch, setSettledSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [total, setTotal] = useState(0)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [missingReceipt, setMissingReceipt] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const portal = useOperationalOverlayPortal()
  useOperationalOverlayRegistration(!suspended, `forward-message:${message.id}`)
  useDialogTabTrap(!suspended, dialog)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; searchLifecycle.current.invalidate(); writeLease.current?.abort() }
  }, [])
  useEffect(() => {
    if (suspended) { searchLifecycle.current.invalidate(); return }
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const timer = window.setTimeout(() => (batchRef.current ? dialog.current : searchInput.current)?.focus({ preventScroll: true }), 0)
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !inFlight.current) { event.preventDefault(); event.stopPropagation(); onClose() }
    }
    document.addEventListener('keydown', escape)
    return () => { window.clearTimeout(timer); document.removeEventListener('keydown', escape); if (current()) restoreDialogFocus([invoker]) }
  }, [suspended, onClose, current])

  const fetchChats = useCallback(async (offset: number, append: boolean, query: string, lease: SearchRequestLease) => {
    if (!current() || suspendedRef.current) return
    if (append) setLoadingMore(true); else setLoading(true)
    setLoadError('')
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), device_ids: deviceId, kind: 'all' })
    if (query) params.set('search', query)
    const controller = new AbortController()
    const abort = () => controller.abort()
    lease.signal.addEventListener('abort', abort, { once: true })
    const timeout = window.setTimeout(abort, 20000)
    try {
      const response = await fetch(`/api/chats?${params}`, { credentials: 'include', cache: 'no-store', signal: controller.signal })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success || !Array.isArray(data.chats)) throw new Error(data.error || 'No se pudieron cargar los chats.')
      if (!current() || !searchLifecycle.current.isCurrent(lease)) return
      setChats(rows => append ? [...rows, ...data.chats.filter((chat: Chat) => !rows.some(row => row.id === chat.id))] : data.chats)
      setTotal(typeof data.total === 'number' ? data.total : data.chats.length)
    } catch (cause) {
      if (!current() || !searchLifecycle.current.isCurrent(lease)) return
      setLoadError(cause instanceof Error && cause.name !== 'AbortError' ? cause.message : 'La consulta tardó demasiado. Puedes reintentar.')
    } finally {
      window.clearTimeout(timeout); lease.signal.removeEventListener('abort', abort)
      if (current() && searchLifecycle.current.finish(lease)) { setLoading(false); setLoadingMore(false) }
    }
  }, [deviceId, current])
  const runSearch = useCallback((offset = 0, append = false, query = settledSearch) => {
    if (!current() || suspendedRef.current) return
    void fetchChats(offset, append, query, searchLifecycle.current.begin())
  }, [current, fetchChats, settledSearch])
  useEffect(() => {
    if (suspended || batch || sourceIssue) return
    const timer = window.setTimeout(() => {
      setSettledSearch(search.trim())
      void fetchChats(0, false, search.trim(), searchLifecycle.current.begin())
    }, searchEdited.current ? SEARCH_DEBOUNCE_MS : 0)
    return () => { window.clearTimeout(timer); searchLifecycle.current.invalidate() }
  }, [suspended, batch, sourceIssue, search, fetchChats])
  const updateSearch = (value: string) => {
    searchEdited.current = true
    searchLifecycle.current.invalidate(); setLoading(false); setLoadingMore(false); setSearch(value)
  }
  const persist = (next: StoredForwardBatch | null) => { batchRef.current = next; setBatch(next); rememberForwardBatch(key, next) }
  const reconcileResult = (data: unknown, operation: StoredForwardBatch) => {
    const receipt = parseForwardReceipt(data, operation.request)
    persist({ request: operation.request, binding_revision: operation.binding_revision, receipt }); setMissingReceipt(false)
    if (receipt.results.every(result => result.state === 'sent') && !suspendedRef.current) {
      rememberForwardBatch(key, null); onSuccess(); onClose()
    }
  }
  const postOperation = async (operation: StoredForwardBatch) => {
    if (inFlight.current || suspendedRef.current || !current()) return
    if ((operation.request.mode ?? 'native') !== optionsRef.current.mode || (operation.request.content_variant ?? 'original') !== optionsRef.current.variant) return
    if (sourceIssueRef.current) { setSendError(sourceIssueRef.current); return }
    inFlight.current = true; setSending(true); setSendError(''); setMissingReceipt(false)
    persist(operation)
    const controller = new AbortController(); writeLease.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 45000)
    try {
      const response = await fetch('/api/messages/forward/batch', { method: 'POST', credentials: 'include', cache: 'no-store', signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(operation.binding_revision ? { 'X-Chat-ID': operation.request.source_chat_id, 'X-Chat-Binding-Revision': String(operation.binding_revision) } : {}) }, body: JSON.stringify(operation.request) })
      const data = await response.json().catch(() => ({}))
      if (!current()) return
      if (!response.ok || data.success !== true) {
        // The canonical endpoint rejects validation before creating/sending an operation.
        if (([400, 403, 404, 409, 422].includes(response.status) || data.code === 'forward_capability_unverified') && forwardValidationCodes.has(data.code)) persist(null)
        if (data.code === 'forward_capability_unverified') setCapabilityRejected(true)
        throw new Error(data.error || 'No pudimos confirmar el reenvío. Comprueba su estado antes de volver a enviar.')
      }
      reconcileResult(data, operation)
    } catch (cause) {
      if (current()) setSendError(cause instanceof Error && cause.name !== 'AbortError' ? cause.message : 'El resultado está pendiente. Comprueba el estado; no enviaremos otra copia automáticamente.')
    } finally {
      window.clearTimeout(timeout)
      inFlight.current = false
      if (current()) setSending(false)
    }
  }
  const beginForward = async (destinations = selected) => {
    if (!current() || suspendedRef.current || inFlight.current || sourceIssueRef.current || mode !== optionsRef.current.mode || variant !== optionsRef.current.variant || destinations.length === 0 || destinations.some(chat => forwardDestinationIssue(chat, destinations.filter(row => row.id !== chat.id), message, deviceId))) return
    const request: ForwardBatchRequest = { mode, content_variant: variant, source_chat_id: chatId, source_message_id: message.id, device_id: deviceId, destination_chat_ids: destinations.map(chat => chat.id), client_operation_id: crypto.randomUUID() }
    await postOperation({ request, binding_revision: sourceChat?.binding_state === 'verified_continuity' ? bindingRevision(sourceChat) || undefined : undefined })
  }
  const checkStatus = async () => {
    const operation = batchRef.current
    if (!operation || inFlight.current || suspendedRef.current || !current()) return
    inFlight.current = true; setSending(true); setSendError('')
    const controller = new AbortController(); writeLease.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 20000)
    try {
      const response = await fetch(`/api/messages/forward/batch/${encodeURIComponent(operation.request.client_operation_id)}`, { credentials: 'include', cache: 'no-store', signal: controller.signal })
      const data = await response.json().catch(() => ({}))
      if (!current()) return
      if (!response.ok || data.success !== true) {
        if (response.status === 404) setMissingReceipt(true)
        throw new Error(response.status === 404 ? 'La operación todavía no está registrada. Puedes confirmar de nuevo la misma operación sin cambiar sus destinos.' : data.error || 'No pudimos comprobar el estado. Puedes volver a consultarlo.')
      }
      reconcileResult(data, operation)
    } catch (cause) { if (current()) setSendError(cause instanceof Error && cause.name !== 'AbortError' ? cause.message : 'La consulta tardó demasiado. Puedes volver a comprobar el estado.') }
    finally { window.clearTimeout(timeout); inFlight.current = false; if (current()) setSending(false) }
  }
  const chooseMode = (next: ForwardMode) => {
    if (!current() || suspendedRef.current || batchRef.current || inFlight.current || (next === 'native' ? nativeIssue : copyIssue)) return
    setChosenMode(next)
    if (next === 'native') setChosenVariant('original')
    setSendError('')
  }
  const toggle = (chat: Chat) => {
    if (batchRef.current || suspendedRef.current || !current()) return
    setSelected(rows => rows.some(row => row.id === chat.id) ? rows.filter(row => row.id !== chat.id) : forwardDestinationIssue(chat, rows, message, deviceId) ? rows : [...rows, chat])
  }
  const results: ForwardDestinationResult[] = batch?.receipt?.results || batch?.request.destination_chat_ids.map(chat_id => ({ chat_id, state: 'uncertain' as const })) || []
  const unfinished = results.some(result => ['pending', 'sending', 'uncertain'].includes(result.state))
  const safeRetry = results.filter(result => result.state === 'failed' && result.can_retry)
  const retryChats = safeRetry.map(result => selected.find(chat => chat.id === result.chat_id) || chats.find(chat => chat.id === result.chat_id)).filter((chat): chat is Chat => Boolean(chat))
  const closeAndRefresh = () => {
    if (!current() || suspendedRef.current || inFlight.current || !batchRef.current?.receipt || !results.some(result => result.state === 'failed') || unfinished) return
    rememberForwardBatch(key, null); onSuccess(); onClose()
  }
  const nameFor = (id: string) => getChatDisplayName(selected.find(chat => chat.id === id) || chats.find(chat => chat.id === id) || { id, jid: '', name: 'Chat seleccionado' } as Chat)
  if (suspended) return null
  return createPortal(
    <div data-chat-overlay="forward-message" className="app-viewport pointer-events-auto fixed inset-0 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.dialog }} onMouseDown={event => { if (event.target === event.currentTarget && !sending) onClose() }}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="forward-message-title" aria-describedby="forward-message-rule" className="flex h-[var(--app-height,100dvh)] w-full flex-col overflow-hidden bg-white shadow-2xl outline-none sm:h-auto sm:max-h-[85dvh] sm:max-w-md sm:rounded-2xl">
        <header className="flex shrink-0 items-center gap-3 border-b border-slate-100 px-4 py-2"><Forward className="h-5 w-5 shrink-0 text-emerald-600" /><h3 id="forward-message-title" className="min-w-0 flex-1 text-lg font-bold text-slate-800">Reenviar mensaje</h3><button type="button" onClick={onClose} disabled={sending} aria-label="Cerrar reenvío" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40"><X className="h-5 w-5" /></button></header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-4 mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3"><p className="mb-1 text-xs italic text-slate-500">{forwardingLabel(message.forwarding) || (message.is_from_me ? 'Mensaje propio' : 'Mensaje recibido')}</p><p className="line-clamp-3 break-words text-sm text-slate-700">{message.message_type === 'document' ? message.media_filename || 'Documento' : message.body || ({ image: 'Imagen', video: 'Video', gif: 'GIF', audio: message.audio_ptt ? 'Nota de voz' : 'Audio', sticker: 'Sticker' }[message.message_type || ''] || 'Mensaje')}</p></div>
          <div role="group" aria-label="Modo de envío" className="grid grid-cols-2 gap-2 px-4 pt-3">
            <button type="button" aria-pressed={mode === 'native'} disabled={Boolean(batch) || sending || Boolean(nativeIssue)} title={nativeIssue || undefined} onClick={() => chooseMode('native')} className={`min-h-11 rounded-xl border px-3 py-2 text-sm font-semibold focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50 ${mode === 'native' ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}>Reenvío de WhatsApp</button>
            <button type="button" aria-pressed={mode === 'copy'} disabled={Boolean(batch) || sending || Boolean(copyIssue)} title={copyIssue || undefined} onClick={() => chooseMode('copy')} className={`min-h-11 rounded-xl border px-3 py-2 text-sm font-semibold focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50 ${mode === 'copy' ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}>Enviar una copia</button>
          </div>
          {mode === 'copy' && <p className="px-4 pt-3 text-xs leading-5 text-slate-600">Se enviará una copia del contenido, sin la etiqueta de reenvío de WhatsApp. Los límites conocidos se conservan en Clarin.</p>}
          {nativeIssue && mode === 'copy' && <p className="px-4 pt-1 text-xs leading-5 text-slate-500">Reenvío de WhatsApp: {nativeIssue}</p>}
          {needsAudioDocument && mode === 'copy' && !copyIssue && <label className="mx-4 mt-3 flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700"><input type="checkbox" checked={variant === 'audio_document'} disabled={Boolean(batch) || sending} onChange={event => { if (!batchRef.current && !inFlight.current && current() && !suspendedRef.current) { setChosenVariant(event.target.checked ? 'audio_document' : 'original'); setSendError('') } }} className="h-5 w-5 shrink-0 accent-emerald-600" /><span>Enviar como archivo adjunto<span className="block text-xs leading-5 text-slate-500">Conserva el archivo de audio sin suponer que sea una nota de voz.</span></span></label>}
          <p id="forward-message-rule" className="px-4 py-3 text-xs leading-5 text-slate-500">{limits.maxChats === 1 ? 'Este mensaje permite seleccionar un solo chat.' : limits.maxGroups === 1 ? 'Selecciona hasta cinco chats, incluido un máximo de un grupo.' : 'Selecciona hasta cinco chats de este dispositivo.'} Los permisos y los límites se verifican otra vez al enviar.</p>
          {sourceIssue && <p role="alert" className="mx-4 mb-3 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-800">{sourceIssue}</p>}
          {!batch && !sourceIssue && <>
            {selected.length > 0 && <div className="flex flex-wrap gap-1.5 px-4 pb-2">{selected.map(chat => <span key={chat.id} className="inline-flex max-w-full items-center gap-1 rounded-full bg-emerald-50 pl-3 text-xs font-semibold text-emerald-800"><span className="min-w-0 break-words">{getChatDisplayName(chat)}</span><button type="button" onClick={() => toggle(chat)} aria-label={`Quitar ${getChatDisplayName(chat)}`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-emerald-100"><X className="h-3 w-3" /></button></span>)}</div>}
            <div className="relative mx-4 mb-2"><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" /><input ref={searchInput} value={search} onChange={event => updateSearch(event.target.value)} placeholder="Buscar por nombre, teléfono..." aria-label="Buscar destino de reenvío" aria-busy={loading || search.trim() !== settledSearch} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-20 text-sm text-slate-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" />{search.trim() !== settledSearch && <RefreshCw aria-label="Esperando para buscar chats" className="absolute right-12 top-3.5 h-4 w-4 animate-spin text-emerald-500 motion-reduce:animate-none" />}{search && <button type="button" onClick={() => updateSearch('')} aria-label="Limpiar búsqueda de chats" className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-xl text-slate-400"><X className="h-4 w-4" /></button>}</div>
            {loadError && <div role="alert" className="mx-4 my-2 rounded-xl bg-rose-50 p-3 text-xs text-rose-700"><p>{loadError}</p><button type="button" onClick={() => runSearch()} className="min-h-11 font-semibold">Reintentar chats</button></div>}
            {loading && !chats.length && <p role="status" className="px-4 py-8 text-center text-sm text-slate-500">Cargando chats…</p>}
            {!loading && !loadError && !chats.length && <p className="px-4 py-8 text-center text-sm text-slate-500">No se encontraron chats</p>}
            <ul className="px-2 pb-2">{chats.map(chat => {
              const checked = selected.some(row => row.id === chat.id)
              const reason = forwardDestinationIssue(chat, selected, message, deviceId)
              const avatar = chatAvatar(chat)
              return <li key={chat.id}><button type="button" aria-pressed={checked} disabled={Boolean(reason)} title={reason || undefined} onClick={() => toggle(chat)} className={`flex min-h-16 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50 ${checked ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}><span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${checked ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300'}`}>{checked && <Check className="h-3 w-3" />}</span>{avatar ? <img src={avatar} className="h-10 w-10 shrink-0 rounded-full object-cover" alt="" /> : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">{isGroupChat(chat) ? <Users className="h-5 w-5" /> : <User className="h-5 w-5" />}</span>}<span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium text-slate-800">{getChatDisplayName(chat)}</span><span className="block break-words text-xs text-slate-500">{reason || (isGroupChat(chat) ? 'Grupo de WhatsApp' : isPendingChatIdentity(chat) ? 'Identidad pendiente' : formatPhone(chat.jid, chat.contact_phone) || 'Sin teléfono')}</span></span></button></li>
            })}</ul>
            {chats.length < total && <button type="button" onClick={() => runSearch(chats.length, true)} disabled={loadingMore || loading || search.trim() !== settledSearch} className="mx-auto flex min-h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-emerald-700 disabled:opacity-50">{loadingMore ? 'Cargando…' : 'Cargar más'}</button>}
          </>}
          {batch && <section className="px-4 pb-4" aria-label="Resultado del reenvío"><p role="status" className="mb-2 text-xs leading-5 text-slate-600">{unfinished ? 'Hay destinos cuyo resultado aún no está confirmado. Comprobar el estado conserva la misma operación.' : 'Estos son los resultados confirmados de la operación.'}</p><ul className="divide-y divide-slate-100">{results.map(result => <li key={result.chat_id} className="py-3"><p className="break-words text-sm font-semibold text-slate-800">{nameFor(result.chat_id)}</p><p className={`mt-1 text-xs ${result.state === 'sent' ? 'text-emerald-700' : result.state === 'failed' ? 'text-rose-700' : 'text-amber-800'}`}>{resultLabel[result.state]}</p>{result.error && <p className="mt-1 break-words text-xs leading-5 text-slate-500">{result.error}</p>}</li>)}</ul>{results.some(result => result.state === 'uncertain') && <p className="mt-2 text-xs leading-5 text-slate-500">No se reenviarán copias de los destinos con resultado incierto. Puedes cerrar y volver a consultar esta operación.</p>}</section>}
        </div>
        <footer className="shrink-0 border-t border-slate-100 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 sm:pb-3">
          {sendError && <p role="alert" className="mb-2 rounded-xl border border-rose-100 bg-rose-50 p-3 text-xs leading-5 text-rose-700"><AlertCircle className="mr-1 inline h-4 w-4" />{sendError}</p>}
          {batch ? <><button type="button" onClick={() => void (missingReceipt ? postOperation(batch) : checkStatus())} disabled={sending || (missingReceipt && Boolean(sourceIssue))} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${sending ? 'animate-spin motion-reduce:animate-none' : ''}`} />{sending ? 'Comprobando…' : missingReceipt ? 'Confirmar la misma operación' : 'Comprobar estado'}</button>{!unfinished && safeRetry.length > 0 && retryChats.length === safeRetry.length && <button type="button" onClick={() => void beginForward(retryChats)} disabled={sending || Boolean(sourceIssue)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm font-semibold text-slate-700 disabled:opacity-50">Reintentar solo los destinos no enviados</button>}{!unfinished && results.some(result => result.state === 'failed') && <button type="button" onClick={closeAndRefresh} disabled={sending} className="mt-2 min-h-11 w-full rounded-xl px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cerrar y actualizar</button>}</> : <button type="button" onClick={() => void beginForward()} disabled={sending || Boolean(sourceIssue) || !selected.length} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"><Send className="h-4 w-4" />{sending ? 'Confirmando envío…' : `${mode === 'copy' ? 'Enviar copia' : 'Reenviar'} a ${selected.length} ${selected.length === 1 ? 'chat' : 'chats'}`}</button>}
        </footer>
      </div>
    </div>, portal || document.body,
  )
}
