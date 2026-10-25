'use client'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type ForwardedRef } from 'react'
import { AlertCircle, Loader2, RefreshCw, Search, Shield, Users, X } from 'lucide-react'
import type { Chat, GroupParticipant, WhatsAppGroup } from '@/types/chat'
import { SEARCH_DEBOUNCE_MS } from '@/lib/useDebouncedValue'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import { subscribeWebSocket } from '@/lib/api'
import { isIdentityRevision } from './groupIdentityRecovery'
import { groupParticipantLabel, groupParticipantPhone, mergeParticipantPage, sameParticipant } from './groupParticipantIdentity'
import { parseGroupIdentityRevisions, type GroupIdentityRevisions, type OpenParticipantChat } from './groupParticipantTypes'
import GroupParticipantProfile, { type GroupParticipantProfileHandle } from './GroupParticipantProfile'
import WebText from '@/components/WebText'

class ParticipantsCursorResetError extends Error {}

type Props = { chat: Chat; onClose: () => void; onOpenChat?: OpenParticipantChat; suspended?: boolean }

export interface GroupDetailsPanelHandle {
  canClose: () => boolean
  /** Consume the participant Back step before closing or navigating elsewhere. */
  requestClose: (afterClose?: () => void) => boolean
}

function GroupDetailsPanelImpl(props: Props, forwardedRef: ForwardedRef<GroupDetailsPanelHandle>) {
  const scope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  return isAuthIdentityChanging(scope) ? null : <GroupDetailsSession forwardedRef={forwardedRef} key={scope + ':' + props.chat.id + ':' + props.chat.device_id} {...props} scope={scope} />
}

function GroupDetailsSession({ chat, onClose, onOpenChat, suspended = false, scope, forwardedRef }: Props & { scope: string; forwardedRef: ForwardedRef<GroupDetailsPanelHandle> }) {
  const [group, setGroup] = useState<WhatsAppGroup | null>(chat.group || null)
  const [members, setMembers] = useState<GroupParticipant[]>([])
  const [search, setSearch] = useState('')
  const [settled, setSettled] = useState('')
  const [cursor, setCursor] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<GroupParticipant | null>(null)
  const profileRef = useRef<GroupParticipantProfileHandle>(null)
  const historyOwned = useRef(false)
  const historySnapshot = useRef<Record<string, unknown> | null>(null)
  const pendingNavigation = useRef<(() => void) | null>(null)
  const historyMarker = '__clarinGroupParticipant'
  const historyIdentity = `${scope}:${chat.id}`
  const lease = useRef<AbortController | null>(null)
  const sequence = useRef(0)
  const identitySnapshot = useRef<GroupIdentityRevisions | null>(null)
  const minimumIdentityRevision = useRef(0)
  const minimumGroupRevision = useRef(0)
  const observedCrmRevision = useRef<number | undefined>(undefined)
  const membersRef = useRef(members)
  const lastQuery = useRef(settled)
  const listScroll = useRef<HTMLDivElement>(null)
  const savedScroll = useRef(0)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const pendingListScroll = useRef<number | null>(null)
  const restoreListOnReturn = useRef(false)
  const invoker = useRef<HTMLButtonElement | null>(null)
  const active = useRef(!suspended)
  active.current = !suspended
  membersRef.current = members
  useEffect(() => {
    if (search === settled) return
    const timer = setTimeout(() => { setSettled(search); setRevision(value => value + 1) }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search, settled])
  const updateSearch = (value: string) => {
    lease.current?.abort(); sequence.current++; setLoading(false); setSearch(value)
  }
  useEffect(() => subscribeWebSocket((raw: unknown) => {
    const event = raw as { event?: string; type?: string; account_id?: string; data?: { chat_id?: string; device_id?: string; account_id?: string; identity_revision?: number; group_revision?: number; crm_identity_revision?: number } }
    const type = event.event || event.type
    if (getAuthScope() !== scope || isAuthIdentityChanging(scope)) return
    if (chat.account_id && [event.account_id, event.data?.account_id].some(account => account && account !== chat.account_id)) return
    const crmRevision = event.data?.crm_identity_revision
    const crmUpdate = type === 'whatsapp_crm_identity_updated' && Boolean(chat.account_id)
      && [event.account_id, event.data?.account_id].includes(chat.account_id)
      && (crmRevision === undefined || isIdentityRevision(crmRevision) && (observedCrmRevision.current === undefined || crmRevision > observedCrmRevision.current))
    if (crmUpdate && isIdentityRevision(crmRevision)) observedCrmRevision.current = crmRevision
    if (crmUpdate || type === 'contact_update' || type === 'chat_group_updated' && event.data?.chat_id === chat.id
      || (type === 'whatsapp_identity_updated' || type === 'device_status' || type === 'device_deletion') && event.data?.device_id === chat.device_id) {
      if (event.data?.device_id === chat.device_id && isIdentityRevision(event.data?.identity_revision)) minimumIdentityRevision.current = Math.max(minimumIdentityRevision.current, event.data.identity_revision)
      if (event.data?.chat_id === chat.id && isIdentityRevision(event.data?.group_revision)) minimumGroupRevision.current = Math.max(minimumGroupRevision.current, event.data.group_revision)
      lease.current?.abort(); sequence.current++; setLoading(false); setRevision(value => value + 1)
    }
  }), [chat.id, chat.device_id, chat.account_id, scope])
  const load = useCallback(async (after = '', refresh = false) => {
    if (!active.current || getAuthScope() !== scope || isAuthIdentityChanging(scope)) return
    lease.current?.abort()
    const controller = new AbortController(); lease.current = controller
    const generation = ++sequence.current
    const preserveCount = lastQuery.current === settled ? membersRef.current.length : 0
    lastQuery.current = settled
    const isCurrent = () => active.current && !controller.signal.aborted && generation === sequence.current && getAuthScope() === scope && !isAuthIdentityChanging(scope)
    setLoading(true); setError('')
    try {
      const request = async (url: string) => {
        const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal: controller.signal })
        const data = await response.json()
        if (!response.ok || !data.success) {
          if (response.status === 409 && data.code === 'participants_cursor_reset') throw new ParticipantsCursorResetError(data.error || 'Los integrantes cambiaron durante la consulta.')
          throw new Error(data.error || 'No se pudo consultar el grupo.')
        }
        return data
      }
      const metadataRequest = request('/api/chats/' + chat.id + '/group' + (refresh ? '?refresh=true' : ''))
      const page = async (cursor: string) => {
        const params = new URLSearchParams({ limit: '50', search: settled, order: 'admins_first' }); if (cursor) params.set('cursor', cursor)
        const data = await request('/api/chats/' + chat.id + '/group/participants?' + params)
        if (!Array.isArray(data.participants)) throw new Error('No se pudieron cargar los participantes.')
        if (data.order !== 'admins_first') throw new Error('El servidor no confirmó el orden de participantes. Vuelve a intentarlo.')
        return data
      }
      const readPages = async (pageCursor: string) => {
        // A provider refresh must commit before reading its participant snapshot.
        const [metadata, first] = refresh ? [await metadataRequest, await page(pageCursor)] : await Promise.all([metadataRequest, page(pageCursor)])
        const snapshot = parseGroupIdentityRevisions(first)
        if (snapshot.identity_revision < minimumIdentityRevision.current || snapshot.group_revision < minimumGroupRevision.current) throw new Error('La respuesta del grupo está desactualizada. Vuelve a actualizarlo.')
        const previous = identitySnapshot.current
        if (previous && (snapshot.identity_revision < previous.identity_revision || snapshot.group_revision < previous.group_revision)) throw new Error('La respuesta del grupo está desactualizada. Vuelve a actualizarlo.')
        if (pageCursor && previous && (snapshot.identity_revision !== previous.identity_revision || snapshot.group_revision !== previous.group_revision)) throw new ParticipantsCursorResetError('Los integrantes cambiaron durante la consulta.')
        let rows = mergeParticipantPage([], first.participants)
        let next = first.next_cursor || ''
        const seen = new Set<string>()
        while (!pageCursor && next && rows.length < preserveCount && !seen.has(next)) {
          seen.add(next)
          const extra = await page(next)
          if (!isCurrent()) return null
          const extraSnapshot = parseGroupIdentityRevisions(extra)
          if (extraSnapshot.identity_revision !== snapshot.identity_revision || extraSnapshot.group_revision !== snapshot.group_revision) throw new ParticipantsCursorResetError('Los integrantes cambiaron durante la consulta.')
          rows = mergeParticipantPage(rows, extra.participants, true)
          next = extra.next_cursor || ''
        }
        return { metadata, snapshot, rows, next, append: Boolean(pageCursor) }
      }
      let accepted
      try { accepted = await readPages(after) }
      catch (cause) {
        if (!(cause instanceof ParticipantsCursorResetError) || !isCurrent()) throw cause
        // Restart once inside the same request lease; keep mounted rows and UI state.
        accepted = await readPages('')
      }
      if (!accepted) return
      const { metadata, snapshot, rows, next, append } = accepted
      if (!isCurrent()) return
      if (!selectedRef.current) pendingListScroll.current = listScroll.current?.scrollTop || 0
      identitySnapshot.current = snapshot
      setGroup(metadata.group)
      setMembers(current => mergeParticipantPage(current, rows, append))
      setSelected(current => current ? rows.find(row => sameParticipant(row, current)) || current : null)
      setCursor(next)

    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : 'No se pudo cargar el grupo.') }
    finally { if (isCurrent()) setLoading(false) }
  }, [chat.id, settled, scope])
  useEffect(() => {
    if (!suspended) void load()
    return () => { lease.current?.abort(); sequence.current++ }
  }, [load, revision, suspended])
  const pending = search !== settled
  useLayoutEffect(() => {
    if (selected) return
    // Restore in the same visible commit; queued frames can sample a hidden list
    // or overwrite the position restored by returning from a participant profile.
    const returning = restoreListOnReturn.current
    const top = returning ? savedScroll.current : pendingListScroll.current
    if (top !== null && listScroll.current) listScroll.current.scrollTop = top
    if (returning && !suspended) invoker.current?.focus({ preventScroll: true })
    pendingListScroll.current = null
    restoreListOnReturn.current = false
  }, [members, selected, suspended])
  const backToList = () => {
    restoreListOnReturn.current = true
    setSelected(null)
  }
  const backToListRef = useRef(backToList)
  backToListRef.current = backToList
  const canClose = useCallback(() => profileRef.current?.canClose() ?? true, [])
  const requestClose = useCallback((afterClose?: () => void) => {
    if (!canClose()) return false
    const finish = afterClose || onClose
    if (historyOwned.current && window.history.state?.[historyMarker] === historyIdentity) {
      pendingNavigation.current = finish
      window.history.go(window.history.state?.__clarinGroupMemberChat ? -2 : -1)
    } else { backToListRef.current(); finish() }
    return true
  }, [canClose, onClose, historyIdentity])
  useImperativeHandle(forwardedRef, () => ({ canClose, requestClose }), [canClose, requestClose])
  const back = useCallback(() => {
    if (profileRef.current?.back() === false) return
    if (historyOwned.current && window.history.state?.[historyMarker] === historyIdentity) window.history.back()
    else backToListRef.current()
  }, [historyIdentity])

  useEffect(() => {
    if (!selected) return
    const claim = window.setTimeout(() => {
      const state = { ...(window.history.state || {}), [historyMarker]: historyIdentity }
      window.history.pushState(state, '')
      historySnapshot.current = state; historyOwned.current = true
    }, 0)
    const pop = (event: PopStateEvent) => {
      if (!historyOwned.current || event.state?.[historyMarker] === historyIdentity) return
      // Private chat has its own step above this one and keeps the profile mounted.
      const navigate = pendingNavigation.current
      if (!active.current && !navigate) return
      event.stopImmediatePropagation()
      if (!navigate && profileRef.current?.back() === false) {
        // A Contact draft may block Back, or Back may have closed only its nested ficha.
        window.history.pushState(historySnapshot.current, '')
        return
      }
      historyOwned.current = false; pendingNavigation.current = null
      backToListRef.current()
      navigate?.()
    }
    window.addEventListener('popstate', pop, true)
    return () => {
      window.clearTimeout(claim); window.removeEventListener('popstate', pop, true)
      // Forced account/device teardown must never navigate back into the old identity.
      if (historyOwned.current && window.history.state?.[historyMarker] === historyIdentity) {
        const state = { ...window.history.state }; delete state[historyMarker]
        window.history.replaceState(state, '')
      }
      historyOwned.current = false; pendingNavigation.current = null
    }
  }, [Boolean(selected), historyIdentity])
  useEffect(() => {
    if (suspended) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (Array.from(document.querySelectorAll<HTMLElement>('[data-chat-overlay], [data-operational-picker-backdrop], [data-operational-confirmation], [data-contact-tag-menu], [data-operational-date-picker]')).some(element => !element.closest('[hidden], [inert]'))) return
      event.preventDefault(); event.stopImmediatePropagation()
      if (selected) back()
      else requestClose()
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [suspended, selected, back, requestClose])
  return <div className="h-full min-h-0">
    <section hidden={Boolean(selected)} inert={Boolean(selected) || suspended} style={selected ? { display: 'none' } : undefined} className="flex h-full min-h-0 flex-col bg-white" aria-label="Detalles del grupo">
      <header className="flex min-h-16 shrink-0 items-center justify-between border-b border-slate-200 px-4"><h2 className="font-bold text-slate-900">Detalles</h2><button type="button" onClick={() => requestClose()} aria-label="Cerrar detalles" className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-500"><X className="h-5 w-5" /></button></header>
      <div ref={listScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="border-b border-slate-200 p-4"><div className="flex items-center gap-3">{group?.avatar_url ? <img src={group.avatar_url} alt="" className="h-14 w-14 rounded-full object-cover" /> : <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700"><Users className="h-6 w-6" /></div>}<div className="min-w-0"><h3 className="break-words font-semibold text-slate-900">{group?.subject || chat.name || 'Grupo de WhatsApp'}</h3><p className="mt-1 text-xs text-slate-500">{group?.participant_count ?? '—'} participantes · {chat.device_name || 'WhatsApp'}</p></div></div>{group?.description && <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600"><WebText text={group.description} /></p>}{group && !group.can_send && <p role="status" className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-800">{group.send_disabled_reason || (group.membership_status === 'left' ? 'Este número ya no pertenece al grupo.' : group.announce ? 'Solo los administradores pueden enviar mensajes.' : 'Permisos de envío pendientes de confirmar.')}</p>}</div>
        <div className="p-4"><div className="mb-3 flex items-center justify-between"><h4 className="text-sm font-semibold text-slate-800">Participantes</h4><button type="button" onClick={() => void load('', true)} disabled={loading || suspended} aria-label="Actualizar participantes" className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-40"><RefreshCw className={'h-4 w-4 ' + (loading ? 'animate-spin' : '')} /></button></div><div className="relative"><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" /><input value={search} onChange={event => updateSearch(event.target.value)} placeholder="Buscar participante" aria-label="Buscar participante" aria-busy={pending || loading} className="h-11 w-full rounded-xl border border-slate-200 pl-9 pr-10 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" />{search && <button type="button" aria-label="Limpiar búsqueda de participantes" onClick={() => updateSearch('')} className="absolute right-0 top-0 flex h-11 w-10 items-center justify-center text-slate-400"><X className="h-4 w-4" /></button>}</div>
          {error && <div role="alert" className="mt-3 rounded-xl bg-rose-50 p-3 text-xs text-rose-700"><AlertCircle className="mr-1 inline h-4 w-4" />{error}<button type="button" onClick={() => void load()} className="mt-1 block min-h-11 font-semibold underline">Reintentar</button></div>}
          {loading && members.length === 0 && <div className="flex min-h-24 items-center justify-center gap-2 text-xs text-slate-500" role="status"><Loader2 className="h-4 w-4 animate-spin" />Cargando participantes…</div>}
          <ul className="mt-3 divide-y divide-slate-100">{members.map(member => <li key={member.lid || member.jid}><button type="button" onClick={event => { savedScroll.current = listScroll.current?.scrollTop || 0; invoker.current = event.currentTarget; setSelected(member) }} className="flex min-h-16 w-full items-center gap-3 rounded-xl px-1 py-2 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label={'Ver integrante: ' + groupParticipantLabel(member)}>
            <ParticipantAvatar member={member} /><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium text-slate-800">{groupParticipantLabel(member)}{member.is_self && <span className="ml-1 text-xs text-slate-500">(Tú)</span>}</p><p className="break-words text-xs text-slate-500">{groupParticipantPhone(member)}</p>{member.username && <p className="break-words text-xs text-slate-500">Usuario: @{member.username.replace(/^@/, '')}</p>}</div>{member.role !== 'member' && <span title="Administrador del grupo" className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-emerald-700"><Shield className="h-3 w-3" />Admin</span>}
          </button></li>)}</ul>
          {!loading && !pending && !error && !members.length && <p className="py-8 text-center text-sm text-slate-500">{settled ? 'No hay participantes que coincidan.' : 'Todavía no hay participantes disponibles.'}</p>}{cursor && <button type="button" onClick={() => void load(cursor)} disabled={loading || pending} className="mt-3 min-h-11 w-full rounded-xl border border-slate-200 text-sm font-semibold text-emerald-700 disabled:opacity-40">{loading ? 'Cargando…' : 'Mostrar más'}</button>}
        </div>
      </div>
    </section>
    {selected && <GroupParticipantProfile ref={profileRef} snapshotRevision={revision} identityRevision={Math.max(identitySnapshot.current?.identity_revision || 0, minimumIdentityRevision.current)} groupRevision={Math.max(identitySnapshot.current?.group_revision || 0, minimumGroupRevision.current)} key={selected.lid || selected.jid} chat={chat} member={selected} scope={scope} suspended={suspended} onBack={back} onClose={() => requestClose()} onOpenChat={onOpenChat} />}
  </div>
}

function ParticipantAvatar({ member }: { member: GroupParticipant }) {
  const [failedURL, setFailedURL] = useState('')
  if (member.avatar_url && failedURL !== member.avatar_url) return <img src={member.avatar_url} loading="lazy" alt="" onError={() => setFailedURL(member.avatar_url || '')} className="h-11 w-11 shrink-0 rounded-full object-cover" />
  return <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-500">{Array.from(groupParticipantLabel(member))[0]}</span>
}

const GroupDetailsPanel = forwardRef<GroupDetailsPanelHandle, Props>(GroupDetailsPanelImpl)
GroupDetailsPanel.displayName = 'GroupDetailsPanel'
export default GroupDetailsPanel
