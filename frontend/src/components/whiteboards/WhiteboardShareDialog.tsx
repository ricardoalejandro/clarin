'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Clipboard, KeyRound, Link2, Loader2, RefreshCw, Search, Trash2, UserPlus, X } from 'lucide-react'
import {
  buildWhiteboardAccessUpdate,
  filterWhiteboardAccountUsers,
  sameWhiteboardAccessGrants,
  WHITEBOARD_SHARE_EXPORT_DEFAULT,
  type WhiteboardAccessPolicy,
  type WhiteboardAccountUser,
  type WhiteboardGrant,
  type WhiteboardShareLink,
} from '@/lib/whiteboards'
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/lib/useDebouncedValue'
import {
  createWhiteboardShareLink,
  getWhiteboardAccess,
  listWhiteboardShareLinks,
  revokeWhiteboardShareLink,
  searchWhiteboardAccountUsers,
  updateWhiteboardAccess,
} from '@/lib/whiteboardsApi'
import WhiteboardModal from './WhiteboardModal'

function failure(status?: number, fallback?: string) {
  if (status === 403) return 'No tienes permiso para administrar el acceso de esta pizarra.'
  if (status === 409) return 'El acceso cambió en otra sesión. Actualiza antes de continuar.'
  return fallback || 'No se pudo actualizar el acceso.'
}

export default function WhiteboardShareDialog({ boardID, onClose }: { boardID: string; onClose: () => void }) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [policy, setPolicy] = useState<WhiteboardAccessPolicy | null>(null)
  const [links, setLinks] = useState<WhiteboardShareLink[]>([])
  const [linksNextCursor, setLinksNextCursor] = useState<string | null>(null)
  const [linksLoadingMore, setLinksLoadingMore] = useState(false)
  const [accessMode, setAccessMode] = useState<'private' | 'account'>('private')
  const [grants, setGrants] = useState<WhiteboardGrant[]>([])
  const [label, setLabel] = useState('Invitación')
  const [linkAccess, setLinkAccess] = useState<'view' | 'edit'>('view')
  const [allowExport, setAllowExport] = useState(WHITEBOARD_SHARE_EXPORT_DEFAULT)
  const [password, setPassword] = useState('')
  const [expiryDays, setExpiryDays] = useState('7')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [createdURL, setCreatedURL] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [memberQuery, setMemberQuery] = useState('')
  const [settledMemberQuery, setSettledMemberQuery] = useDebouncedValue(memberQuery, SEARCH_DEBOUNCE_MS)
  const [memberResults, setMemberResults] = useState<WhiteboardAccountUser[]>([])
  const [memberSearching, setMemberSearching] = useState(false)
  const memberGenerationRef = useRef(0)
  const loadGenerationRef = useRef(0)
  const linksPageGenerationRef = useRef(0)
  const linksPageControllerRef = useRef<AbortController | null>(null)

  const accessDirty = Boolean(policy) && (policy?.access_mode !== accessMode || !sameWhiteboardAccessGrants(policy?.grants || [], grants))
  const excludedUserIDs = useMemo(() => new Set(grants.map(grant => grant.user_id)), [grants])
  const availableMembers = useMemo(() => filterWhiteboardAccountUsers(memberResults, settledMemberQuery, excludedUserIDs), [excludedUserIDs, memberResults, settledMemberQuery])

  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGenerationRef.current
    linksPageControllerRef.current?.abort()
    linksPageGenerationRef.current += 1
    setLinksLoadingMore(false)
    setPhase('loading')
    setError(null)
    const [accessResponse, linksResponse] = await Promise.all([
      getWhiteboardAccess(boardID, signal),
      listWhiteboardShareLinks(boardID, { signal }),
    ])
    if (signal?.aborted || generation !== loadGenerationRef.current) return
    if (!accessResponse.success || !accessResponse.data?.access) {
      setError(failure(accessResponse.status, accessResponse.error))
      setPhase('error')
      return
    }
    setPolicy(accessResponse.data.access)
    setAccessMode(accessResponse.data.access.access_mode)
    setGrants(accessResponse.data.access.grants)
    setLinks(linksResponse.success ? linksResponse.data?.share_links || [] : [])
    setLinksNextCursor(linksResponse.success ? linksResponse.data?.next_cursor || null : null)
    if (!linksResponse.success) setError(failure(linksResponse.status, linksResponse.error))
    setPhase('ready')
  }, [boardID])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => {
      controller.abort()
      linksPageControllerRef.current?.abort()
    }
  }, [load])

  const loadMoreLinks = async () => {
    if (!linksNextCursor || linksLoadingMore) return
    linksPageControllerRef.current?.abort()
    const controller = new AbortController()
    linksPageControllerRef.current = controller
    const generation = ++linksPageGenerationRef.current
    const cursor = linksNextCursor
    setLinksLoadingMore(true)
    setError(null)
    const response = await listWhiteboardShareLinks(boardID, { cursor, signal: controller.signal })
    if (controller.signal.aborted || generation !== linksPageGenerationRef.current) return
    setLinksLoadingMore(false)
    if (!response.success || !response.data) {
      setError(failure(response.status, response.error || 'No se pudieron cargar los enlaces anteriores.'))
      return
    }
    setLinks(current => {
      const known = new Set(current.map(link => link.id))
      return [...current, ...(response.data!.share_links || []).filter(link => !known.has(link.id))]
    })
    setLinksNextCursor(response.data.next_cursor || null)
  }

  useEffect(() => {
    const query = settledMemberQuery.trim()
    if (phase !== 'ready' || !query) {
      setMemberResults([])
      setMemberSearching(false)
      return
    }
    const controller = new AbortController()
    const generation = ++memberGenerationRef.current
    setMemberSearching(true)
    void searchWhiteboardAccountUsers(query, controller.signal).then(response => {
      if (controller.signal.aborted || generation !== memberGenerationRef.current) return
      setMemberSearching(false)
      if (!response.success) {
        setMemberResults([])
        setError(failure(response.status, response.error || 'No se pudieron buscar miembros de la cuenta.'))
        return
      }
      setMemberResults(response.data?.users || [])
    })
    return () => controller.abort()
  }, [phase, settledMemberQuery])

  const saveVisibility = async () => {
    if (!policy || busy) return
    setBusy('visibility')
    setError(null)
    const response = await updateWhiteboardAccess(boardID, buildWhiteboardAccessUpdate(policy, accessMode, grants))
    if (!response.success || !response.data?.access) {
      if (response.status === 409) {
        const canonical = await getWhiteboardAccess(boardID)
        setBusy(null)
        if (canonical.success && canonical.data?.access) {
          setPolicy(canonical.data.access)
          setAccessMode(canonical.data.access.access_mode)
          setGrants(canonical.data.access.grants)
          setError('El acceso cambió en otra sesión. Recargamos la política actual; revisa el cambio antes de guardarlo de nuevo.')
          return
        }
        setError(failure(canonical.status, canonical.error))
        return
      }
      setBusy(null)
      setError(failure(response.status, response.error))
      return
    }
    setBusy(null)
    setPolicy(response.data.access)
    setAccessMode(response.data.access.access_mode)
    setGrants(response.data.access.grants)
  }

  const addMember = (member: WhiteboardAccountUser) => {
    setGrants(current => current.some(grant => grant.user_id === member.id) ? current : [...current, {
      id: `draft-${member.id}`,
      user_id: member.id,
      display_name: member.display_name || member.username,
      username: member.username,
      access_level: 'view',
      can_manage_access: false,
    }])
    setMemberQuery('')
    setSettledMemberQuery('')
    setMemberResults([])
  }

  const updateGrantLevel = (userID: string, accessLevel: WhiteboardGrant['access_level']) => {
    setGrants(current => current.map(grant => grant.user_id === userID
      ? { ...grant, access_level: accessLevel, can_manage_access: accessLevel === 'manage' }
      : grant))
  }

  const createLink = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy('create')
    setError(null)
    setCreatedURL(null)
    const expiresAt = new Date(Date.now() + Number(expiryDays) * 86_400_000).toISOString()
    const response = await createWhiteboardShareLink(boardID, {
      label: label.trim(),
      access_level: linkAccess,
      allow_export: allowExport,
      password: password || undefined,
      expires_at: expiresAt,
    })
    setBusy(null)
    if (!response.success || !response.data?.share_link || !response.data.token) {
      setError(failure(response.status, response.error))
      return
    }
    setLinks(current => [response.data!.share_link, ...current])
    setCreatedURL(`${window.location.origin}/shared/whiteboards/${encodeURIComponent(response.data.share_link.id)}#${response.data.token}`)
    setPassword('')
  }

  const revoke = async (linkID: string) => {
    if (busy) return
    setBusy(linkID)
    setError(null)
    const response = await revokeWhiteboardShareLink(boardID, linkID)
    setBusy(null)
    if (!response.success) {
      setError(failure(response.status, response.error))
      return
    }
    setLinks(current => current.filter(link => link.id !== linkID))
  }

  const copyCreatedURL = async () => {
    if (!createdURL) return
    try {
      await navigator.clipboard.writeText(createdURL)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('No se pudo copiar el enlace. Selecciónalo y cópialo manualmente.')
    }
  }

  return <WhiteboardModal title="Compartir pizarra" description="El acceso y los enlaces se gestionan dentro de Clarin; el motor de edición no recibe esta información." onClose={onClose} wide>
    {phase === 'loading' && <div className="flex min-h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /><span className="sr-only">Cargando acceso</span></div>}
    {phase === 'error' && <div className="flex min-h-64 flex-col items-center justify-center p-6 text-center"><p className="max-w-md text-sm text-rose-700">{error}</p><button type="button" onClick={() => void load()} className="mt-4 flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white"><RefreshCw className="h-4 w-4" />Reintentar</button></div>}
    {phase === 'ready' && <div className="divide-y divide-slate-100">
      {error && <div className="m-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{error}</div>}
      <section className="p-5">
        <h3 className="text-sm font-black text-slate-900">Visibilidad dentro de la cuenta</h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">Compartir con la cuenta concede lectura a sus miembros activos. Los permisos directos de abajo pueden elevar el acceso de personas concretas.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {(['private', 'account'] as const).map(mode => <button key={mode} type="button" onClick={() => setAccessMode(mode)} aria-pressed={accessMode === mode} className={`min-h-16 rounded-2xl border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${accessMode === mode ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}><span className="block text-sm font-black">{mode === 'private' ? 'Restringida' : 'Toda la cuenta'}</span><span className="mt-1 block text-xs">{mode === 'private' ? 'Solo personas con acceso explícito.' : 'Lectura para usuarios de la cuenta.'}</span></button>)}
        </div>
      </section>

      <section className="p-5">
        <div className="flex items-center gap-2"><UserPlus className="h-4 w-4 text-emerald-600" /><h3 className="text-sm font-black text-slate-900">Personas con acceso directo</h3></div>
        <p className="mt-1 text-xs leading-5 text-slate-500">La búsqueda consulta sólo miembros activos de la cuenta. Comentar permite participar sin modificar el lienzo; Administrar permite también cambiar esta política.</p>
        <label className="relative mt-3 block">
          <span className="sr-only">Buscar miembro de la cuenta</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={memberQuery} onChange={event => { const value = event.target.value; setMemberQuery(value); if (!value) setSettledMemberQuery('') }} placeholder="Buscar por nombre o usuario…" className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-10 text-sm outline-none focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-100" />
          {(memberSearching || memberQuery !== settledMemberQuery) && <Loader2 className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-600" aria-label="Buscando miembros" />}
          {!memberSearching && memberQuery === settledMemberQuery && memberQuery && <button type="button" onClick={() => { setMemberQuery(''); setSettledMemberQuery(''); setMemberResults([]) }} aria-label="Limpiar búsqueda de miembros" className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>}
        </label>
        {settledMemberQuery && !memberSearching && <div className="mt-2 max-h-52 overflow-y-auto rounded-2xl border border-slate-200 p-1.5" role="listbox" aria-label="Resultados de miembros">
          {availableMembers.length
            ? availableMembers.map(member => <button key={member.id} type="button" role="option" aria-selected="false" onClick={() => addMember(member)} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-emerald-50"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-black text-slate-600">{(member.display_name || member.username).slice(0, 2).toLocaleUpperCase('es')}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-slate-700">{member.display_name || member.username}</span><span className="block truncate text-[10px] text-slate-400">@{member.username}</span></span><UserPlus className="h-4 w-4 text-emerald-600" /></button>)
            : <p className="px-3 py-5 text-center text-xs text-slate-400">No hay miembros disponibles para esa búsqueda.</p>}
        </div>}
        {grants.length === 0
          ? <p className="mt-3 rounded-xl bg-slate-50 px-3 py-4 text-sm text-slate-500">No hay permisos directos. La visibilidad general sigue aplicándose.</p>
          : <div className="mt-3 space-y-2">{grants.map(grant => <article key={grant.user_id} className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-black text-slate-800">{grant.display_name || grant.username || grant.email || 'Miembro de la cuenta'}</p><p className="truncate text-[10px] text-slate-400">{grant.username ? `@${grant.username}` : grant.email || 'Acceso directo'}</p></div><select value={grant.access_level} onChange={event => updateGrantLevel(grant.user_id, event.target.value as WhiteboardGrant['access_level'])} aria-label={`Permiso de ${grant.display_name || grant.username || 'miembro'}`} className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"><option value="view">Ver</option><option value="comment">Comentar</option><option value="edit">Editar</option><option value="manage">Administrar</option></select><button type="button" onClick={() => setGrants(current => current.filter(item => item.user_id !== grant.user_id))} aria-label={`Quitar acceso de ${grant.display_name || grant.username || 'miembro'}`} className="flex h-11 w-11 items-center justify-center rounded-xl text-rose-600 hover:bg-rose-50"><Trash2 className="h-4 w-4" /></button></article>)}</div>}
        <div className="mt-4 flex justify-end"><button type="button" onClick={() => void saveVisibility()} disabled={busy === 'visibility' || !accessDirty} className="flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white disabled:opacity-40">{busy === 'visibility' && <Loader2 className="h-4 w-4 animate-spin" />}Guardar acceso</button></div>
      </section>

      <section className="p-5">
        <div className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-emerald-600" /><h3 className="text-sm font-black text-slate-900">Nuevo enlace temporal</h3></div>
        <form onSubmit={createLink} className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-bold text-slate-600 sm:col-span-2">Nombre<input value={label} onChange={event => setLabel(event.target.value)} maxLength={160} className="mt-1 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm font-medium outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100" /></label>
          <label className="text-xs font-bold text-slate-600">Permiso<select value={linkAccess} onChange={event => setLinkAccess(event.target.value as 'view' | 'edit')} className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"><option value="view">Solo lectura</option><option value="edit">Puede editar</option></select></label>
          <label className="text-xs font-bold text-slate-600">Vigencia<select value={expiryDays} onChange={event => setExpiryDays(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"><option value="1">1 día</option><option value="7">7 días</option><option value="30">30 días</option><option value="90">90 días</option></select></label>
          <label className="text-xs font-bold text-slate-600 sm:col-span-2">Contraseña opcional<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" maxLength={128} className="mt-1 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100" /></label>
          <label className="flex min-h-11 items-center gap-3 rounded-xl border border-slate-200 px-3 text-sm font-semibold text-slate-600 sm:col-span-2"><input type="checkbox" checked={allowExport} onChange={event => setAllowExport(event.target.checked)} className="h-4 w-4 accent-emerald-600" />Permitir exportar una copia</label>
          <div className="flex justify-end sm:col-span-2"><button type="submit" disabled={!label.trim() || Boolean(busy)} className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-black text-white hover:bg-emerald-700 disabled:opacity-40">{busy === 'create' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}Crear enlace</button></div>
        </form>
        {createdURL && <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-3"><p className="text-xs font-black uppercase tracking-wide text-emerald-700">Cópialo ahora; el secreto no se vuelve a mostrar</p><p className="mt-1 text-xs leading-5 text-emerald-800">El secreto viaja en el fragmento del enlace y Clarin lo borra de la barra al abrirlo.</p><div className="mt-2 flex gap-2"><input readOnly value={createdURL} onFocus={event => event.currentTarget.select()} className="h-11 min-w-0 flex-1 rounded-xl border border-emerald-200 bg-white px-3 text-xs text-slate-700" /><button type="button" onClick={() => void copyCreatedURL()} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-700 text-white" aria-label="Copiar enlace">{copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}</button></div></div>}
      </section>

      <section className="p-5">
        <h3 className="text-sm font-black text-slate-900">Enlaces activos recientes</h3>
        {links.filter(link => !link.revoked_at).length === 0 ? <p className="mt-3 rounded-xl bg-slate-50 px-3 py-4 text-sm text-slate-500">No hay enlaces activos en esta página.</p> : <div className="mt-3 space-y-2">{links.filter(link => !link.revoked_at).map(link => <article key={link.id} className="flex items-center gap-3 rounded-2xl border border-slate-200 p-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600"><Link2 className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-black text-slate-800">{link.label || 'Enlace'}</p><p className="mt-0.5 text-xs text-slate-500">{link.access_level === 'edit' ? 'Edición' : 'Lectura'} · {link.session_count} sesiones{link.password_protected ? ' · con contraseña' : ''}</p></div><button type="button" onClick={() => void revoke(link.id)} disabled={Boolean(busy)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-rose-600 hover:bg-rose-50 disabled:opacity-40" aria-label={`Revocar ${link.label || 'enlace'}`}>{busy === link.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}</button></article>)}</div>}
        {linksNextCursor && <div className="mt-3 flex justify-center"><button type="button" onClick={() => void loadMoreLinks()} disabled={linksLoadingMore} className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-xs font-black text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40">{linksLoadingMore && <Loader2 className="h-4 w-4 animate-spin" />}Cargar enlaces anteriores</button></div>}
      </section>
    </div>}
  </WhiteboardModal>
}
