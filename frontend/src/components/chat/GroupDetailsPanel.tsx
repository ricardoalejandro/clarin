'use client'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AlertCircle, Loader2, RefreshCw, Search, Shield, Users, X } from 'lucide-react'
import type { Chat, GroupParticipant, WhatsAppGroup } from '@/types/chat'
import { participantName } from '@/utils/chatGroups'
import { SEARCH_DEBOUNCE_MS } from '@/lib/useDebouncedValue'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import { subscribeWebSocket } from '@/lib/api'

export default function GroupDetailsPanel(props: { chat: Chat; onClose: () => void }) {
  const scope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  return isAuthIdentityChanging(scope) ? null : <GroupDetailsSession key={scope + ':' + props.chat.id} {...props} scope={scope} />
}
function GroupDetailsSession({ chat, onClose, scope }: { chat: Chat; onClose: () => void; scope: string }) {
  const [group, setGroup] = useState<WhatsAppGroup | null>(chat.group || null)
  const [members, setMembers] = useState<GroupParticipant[]>([])
  const [search, setSearch] = useState('')
  const [settled, setSettled] = useState('')
  const [cursor, setCursor] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const lease = useRef<AbortController | null>(null)
  const sequence = useRef(0)
  useEffect(() => { setGroup(chat.group || null); setMembers([]); setSearch(''); setSettled(''); setCursor('') }, [chat.id])
  const searchMounted = useRef(false)
  useEffect(() => {
    if (!searchMounted.current) { searchMounted.current = true; return }
    const timer = setTimeout(() => { setSettled(search); setRevision(value => value + 1) }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])
  const updateSearch = (value: string) => { lease.current?.abort(); sequence.current++; setLoading(false); setSearch(value) }
  useEffect(() => subscribeWebSocket((raw: unknown) => { const event = raw as { event?: string; data?: { chat_id?: string } }; if (getAuthScope() === scope && event.event === 'chat_group_updated' && event.data?.chat_id === chat.id) setRevision(value => value + 1) }), [chat.id])
  const load = useCallback(async (after = '', refresh = false) => {
    if (getAuthScope() !== scope || isAuthIdentityChanging(scope)) return
    lease.current?.abort(); const controller = new AbortController(); lease.current = controller; const generation = ++sequence.current
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ limit: '50', search: settled }); if (after) params.set('cursor', after)
      const credentials = 'include' as const
      const metadataRequest = fetch('/api/chats/' + chat.id + '/group' + (refresh ? '?refresh=true' : ''), { credentials, signal: controller.signal }).then(async response => { const data = await response.json(); if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo actualizar el grupo.'); return data })
      // Explicit refresh must commit the provider snapshot before reading its participants.
      const fetchPage = () => fetch('/api/chats/' + chat.id + '/group/participants?' + params, { credentials, signal: controller.signal }).then(async response => { const data = await response.json(); if (!response.ok || !data.success || !Array.isArray(data.participants)) throw new Error(data.error || 'No se pudieron cargar los participantes.'); return data })
      const [metadata, page] = refresh ? [await metadataRequest, await fetchPage()] : await Promise.all([metadataRequest, fetchPage()])
      if (controller.signal.aborted || generation !== sequence.current || getAuthScope() !== scope) return
      setGroup(metadata.group); setMembers(current => after ? [...current, ...page.participants.filter((member: GroupParticipant) => !current.some(row => row.jid === member.jid))] : page.participants); setCursor(page.next_cursor || '')
    } catch (cause) { if (!controller.signal.aborted && generation === sequence.current && getAuthScope() === scope) setError(cause instanceof Error ? cause.message : 'No se pudo cargar el grupo.') }
    finally { if (!controller.signal.aborted && generation === sequence.current && getAuthScope() === scope) setLoading(false) }
  }, [chat.id, settled, scope])
  useEffect(() => { void load(); return () => { lease.current?.abort(); sequence.current++ } }, [load, revision])
  const pending = search !== settled
  return <section className="flex h-full min-h-0 flex-col bg-white" aria-label="Detalles del grupo">
    <header className="flex min-h-16 shrink-0 items-center justify-between border-b border-slate-200 px-4"><h2 className="font-bold text-slate-900">Detalles</h2><button type="button" onClick={onClose} aria-label="Cerrar detalles" className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-500"><X className="h-5 w-5" /></button></header>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="border-b border-slate-200 p-4"><div className="flex items-center gap-3">{group?.avatar_url ? <img src={group.avatar_url} alt="" className="h-14 w-14 rounded-full object-cover" /> : <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700"><Users className="h-6 w-6" /></div>}<div className="min-w-0"><h3 className="break-words font-semibold text-slate-900">{group?.subject || chat.name || 'Grupo de WhatsApp'}</h3><p className="mt-1 text-xs text-slate-500">{group?.participant_count ?? '—'} participantes · {chat.device_name || 'WhatsApp'}</p></div></div>{group?.description && <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{group.description}</p>}{group && !group.can_send && <p role="status" className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-800">{group.send_disabled_reason || (group.membership_status === 'left' ? 'Este número ya no pertenece al grupo.' : group.announce ? 'Solo los administradores pueden enviar mensajes.' : 'Permisos de envío pendientes de confirmar.')}</p>}</div>
      <div className="p-4"><div className="mb-3 flex items-center justify-between"><h4 className="text-sm font-semibold text-slate-800">Participantes</h4><button type="button" onClick={() => void load('', true)} disabled={loading} aria-label="Actualizar participantes" className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button></div><div className="relative"><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" /><input value={search} onChange={event => updateSearch(event.target.value)} placeholder="Buscar participante" aria-label="Buscar participante" aria-busy={pending || loading} className="h-11 w-full rounded-xl border border-slate-200 pl-9 pr-10 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" />{search && <button type="button" aria-label="Limpiar búsqueda de participantes" onClick={() => updateSearch('')} className="absolute right-0 top-0 flex h-11 w-10 items-center justify-center text-slate-400"><X className="h-4 w-4" /></button>}</div>
        {error && <div role="alert" className="mt-3 rounded-xl bg-rose-50 p-3 text-xs text-rose-700"><AlertCircle className="mr-1 inline h-4 w-4" />{error}<button type="button" onClick={() => void load()} className="mt-1 block min-h-11 font-semibold underline">Reintentar</button></div>}
        {loading && members.length === 0 && <div className="flex min-h-24 items-center justify-center gap-2 text-xs text-slate-500" role="status"><Loader2 className="h-4 w-4 animate-spin" />Cargando participantes…</div>}
        <ul className="mt-3 divide-y divide-slate-100">{members.map(member => <li key={member.jid} className="flex min-h-16 items-center gap-3 py-2"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-500">{participantName(member.jid, member.name).charAt(0)}</span><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium text-slate-800">{participantName(member.jid, member.name)}{member.is_self && <span className="ml-1 text-xs text-slate-500">(Tú)</span>}</p>{member.phone && <p className="text-xs text-slate-500">{member.phone}</p>}</div>{member.role !== 'member' && <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-emerald-700"><Shield className="h-3 w-3" />Admin</span>}</li>)}</ul>
        {!loading && !pending && !error && !members.length && <p className="py-8 text-center text-sm text-slate-500">{settled ? 'No hay participantes que coincidan.' : 'Todavía no hay participantes disponibles.'}</p>}{cursor && <button type="button" onClick={() => void load(cursor)} disabled={loading || pending} className="mt-3 min-h-11 w-full rounded-xl border border-slate-200 text-sm font-semibold text-emerald-700 disabled:opacity-40">{loading ? 'Cargando…' : 'Mostrar más'}</button>}
      </div>
    </div>
  </section>
}
