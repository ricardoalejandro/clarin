'use client'
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { AtSign, Loader2, X } from 'lucide-react'
import WhatsAppTextInput, { type WhatsAppTextInputHandle, type WhatsAppTextInputProps } from '../WhatsAppTextInput'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import type { GroupParticipant } from '@/types/chat'
import { insertMention, mentionQuery, reconcileMentionRanges, type MentionDraft, type MentionRange } from '@/utils/chatMentions'
import { SEARCH_DEBOUNCE_MS } from '@/lib/useDebouncedValue'
import { OPERATIONAL_OVERLAY_LAYERS, useOperationalOverlayPortal, useOperationalOverlayRegistration } from '@/components/operational-window/OperationalOverlayContext'

interface Props extends WhatsAppTextInputProps { chatId: string; mentions: MentionRange[]; onMentionsChange: (mentions: MentionRange[]) => void }
const GroupMentionSession = forwardRef<WhatsAppTextInputHandle, Props & { scope: string }>(function GroupMentionSession({ scope, chatId, mentions, onMentionsChange, value, onChange, onKeyDown, ...props }, ref) {
  const input = useRef<WhatsAppTextInputHandle>(null)
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const portal = useOperationalOverlayPortal()
  const id = useId()
  const [query, setQuery] = useState<ReturnType<typeof mentionQuery>>(null)
  const [members, setMembers] = useState<GroupParticipant[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState({ top: 0, left: 8, width: 300, maxHeight: 250 })
  const current = useRef<MentionDraft>({ text: value, mentions }); current.current = { text: value, mentions }
  const history = useRef<MentionDraft[]>([])
  const redo = useRef<MentionDraft[]>([])
  useOperationalOverlayRegistration(Boolean(query), 'group-mention-picker')
  const queryKey = query ? `${query.start}:${query.query}` : ''
  useEffect(() => { history.current = []; redo.current = []; setQuery(null); setMembers([]) }, [chatId])
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), blur: () => input.current?.blur(), clear: () => { input.current?.clear(); setQuery(null) }, insertAtCaret: (text, options) => input.current?.insertAtCaret(text, options), getSelection: () => input.current?.getSelection?.() || { start: value.length, end: value.length }, setSelection: selection => input.current?.setSelection?.(selection) }), [value.length])
  const commit = (draft: MentionDraft, remember = true) => {
    if (getAuthScope() !== scope || isAuthIdentityChanging(scope)) return
    if (remember) { history.current.push(current.current); if (history.current.length > 100) history.current.shift(); redo.current = [] }
    current.current = draft; onMentionsChange(draft.mentions); onChange(draft.text)
  }
  const updateQuery = useCallback((text: string, caret: number) => {
    const next = mentionQuery(text, caret)
    if (next && current.current.mentions.some(mention => next?.start === mention.start)) setQuery(null)
    else setQuery(next)
  }, [])
  useEffect(() => {
    if (!query || getAuthScope() !== scope || isAuthIdentityChanging(scope)) return
    const controller = new AbortController()
    setLoading(true); setError(''); setMembers([]); setActive(0)
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ search: query.query, limit: '50' })
        const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/group/participants?${params}`, { signal: controller.signal, credentials: 'include' })
        const data = await response.json()
        if (!response.ok || !data.success || !Array.isArray(data.participants)) throw new Error(data.error || 'No se pudieron buscar participantes.')
        if (!controller.signal.aborted && getAuthScope() === scope) setMembers(data.participants)
      } catch (cause) { if (!controller.signal.aborted && getAuthScope() === scope) setError(cause instanceof Error ? cause.message : 'No se pudieron buscar participantes.') }
      finally { if (!controller.signal.aborted && getAuthScope() === scope) setLoading(false) }
    }, SEARCH_DEBOUNCE_MS)
    return () => { clearTimeout(timer); controller.abort() }
  }, [chatId, queryKey, retry, scope])
  useEffect(() => {
    if (!query) return
    const place = () => {
      const rect = root.current?.getBoundingClientRect(); if (!rect) return
      const viewport = window.visualViewport, left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0, width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight
      const menuWidth = Math.min(360, width - 16), above = rect.top - top - 8, below = top + height - rect.bottom - 8, menuHeight = Math.max(48, Math.min(300, Math.max(above, below)))
      setPosition({ left: Math.max(left + 8, Math.min(rect.left, left + width - menuWidth - 8)), top: above >= below ? Math.max(top + 8, rect.top - Math.min(menuHeight, menu.current?.scrollHeight || menuHeight) - 4) : rect.bottom + 4, width: menuWidth, maxHeight: menuHeight })
    }
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setQuery(null) }
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true); window.visualViewport?.addEventListener('resize', place); document.addEventListener('pointerdown', outside)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); window.visualViewport?.removeEventListener('resize', place); document.removeEventListener('pointerdown', outside) }
  }, [queryKey, members.length, loading, error])
  const select = (member: GroupParticipant) => {
    if (!query || getAuthScope() !== scope) return
    const draft = insertMention(current.current, query, member)
    const caret = query.start + (member.name || member.jid.split('@')[0]).length + 2
    commit(draft); setQuery(null)
    requestAnimationFrame(() => input.current?.setSelection?.({ start: caret, end: caret }))
  }
  return <div ref={root} className="min-w-0">
    <WhatsAppTextInput {...props} ref={input} value={value} onChange={(text, source) => { commit({ text, mentions: reconcileMentionRanges(value, text, mentions, source === 'format') }); updateQuery(text, input.current?.getSelection?.().end ?? text.length) }} ariaControls={query ? id : undefined} ariaExpanded={Boolean(query)} ariaActiveDescendant={query && members[active] ? id + '-' + active : undefined} onSelectionChange={selection => { if (selection.start === selection.end) updateQuery(current.current.text, selection.end) }} onKeyDown={event => {
      if (event.nativeEvent.isComposing) { onKeyDown?.(event); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        const from = event.shiftKey ? redo.current : history.current, to = event.shiftKey ? history.current : redo.current
        event.preventDefault(); const previous = from.pop(); if (previous) { to.push(current.current); commit(previous, false); setQuery(null) } return
      }
      if (query && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(event.key)) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setQuery(null); return }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(index => members.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + members.length) % members.length : 0); return }
        if (members[active]) { event.preventDefault(); event.stopPropagation(); select(members[active]); return }
        if (event.key === 'Enter') { event.preventDefault(); return }
      }
      onKeyDown?.(event)
    }} />
    {mentions.length > 0 && <div className="mt-1 flex flex-wrap gap-1" aria-label="Personas mencionadas">{mentions.map((mention, index) => <span key={`${mention.jid}:${mention.start}`} className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-lg bg-emerald-50 pl-2 text-xs font-medium text-emerald-800"><AtSign className="h-3 w-3 shrink-0" /><span className="truncate">{mention.name || 'Participante'}</span><button type="button" onClick={() => commit({ text: value, mentions: mentions.filter((_, item) => item !== index) })} aria-label={`Quitar mención de ${mention.name || 'participante'}`} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-emerald-100"><X className="h-3 w-3" /></button></span>)}</div>}
    {query && typeof document !== 'undefined' && createPortal(<div ref={menu} data-chat-overlay="mention-menu" role="listbox" id={id} aria-label="Mencionar participante" className="fixed overflow-y-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl" style={{ ...position, zIndex: OPERATIONAL_OVERLAY_LAYERS.picker }} onPointerDown={event => event.preventDefault()}>
      <p className="px-3 py-2 text-[11px] font-semibold text-slate-500">Mencionar a un participante</p>{loading ? <p role="status" className="flex items-center gap-2 px-3 py-4 text-xs text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Buscando…</p> : error ? <button type="button" onClick={() => setRetry(value => value + 1)} className="min-h-11 px-3 text-left text-xs text-rose-700">{error} Reintentar</button> : members.length ? members.map((member, index) => <button type="button" key={member.jid} id={id + '-' + index} role="option" aria-selected={index === active} onClick={() => select(member)} className={`flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left ${index === active ? 'bg-emerald-50 text-emerald-900' : 'text-slate-700 hover:bg-slate-50'}`}><AtSign className="h-4 w-4 shrink-0 text-emerald-600" /><span className="min-w-0"><span className="block truncate text-sm font-medium">{member.name || 'Participante'}{member.is_self ? ' (Tú)' : ''}</span>{member.phone && <span className="text-xs text-slate-500">{member.phone}</span>}</span></button>) : <p className="px-3 py-4 text-xs text-slate-500">No hay participantes que coincidan.</p>}
    </div>, portal || document.body)}
  </div>
})
const GroupMentionInput = forwardRef<WhatsAppTextInputHandle, Props>(function GroupMentionInput(props, ref) {
  const scope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  return isAuthIdentityChanging(scope) ? null : <GroupMentionSession key={scope + ':' + props.chatId} {...props} ref={ref} scope={scope} />
})
export default GroupMentionInput
