'use client'

import { forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState, type ForwardedRef } from 'react'
import type { ContactDetailSurfaceHandle } from '@/components/contact-details/ContactDetailSurface'
import { AlertCircle, ArrowLeft, ImageOff, Loader2, MessageCircle, RefreshCw, Shield, UserRound, Users, X } from 'lucide-react'
import type { Chat, GroupParticipant } from '@/types/chat'
import { getAuthScope, isAuthIdentityChanging } from '@/lib/authScope'
import { groupParticipantLabel, groupParticipantPath, groupParticipantPhone, sameParticipant } from './groupParticipantIdentity'
import type { GroupParticipantProfile as Profile, OpenParticipantChat, ParticipantCommonGroup } from './groupParticipantTypes'
import { parseGroupParticipantProfile } from './groupParticipantTypes'
import WebText from '@/components/WebText'

const ContactDetailSurface = lazy(() => import('@/components/contact-details/ContactDetailSurface'))
type Phase = 'loading' | 'ready' | 'error'
type SenderConfirmation = { device_id: string; device_phone: string; history_revision: number }

async function readJSON(response: Response) {
  const data = await response.json()
  if (!response.ok || !data.success) throw Object.assign(new Error(data.error || 'No pudimos completar la consulta.'), { code: data.code, payload: data })
  return data
}

export interface GroupParticipantProfileHandle {
  canClose: () => boolean
  /** Returns true only when Back may leave the participant profile. */
  back: () => boolean
}

function GroupParticipantProfileImpl({ chat, member, scope, suspended = false, snapshotRevision = 0, identityRevision, groupRevision, onBack, onClose, onOpenChat }: {
  chat: Chat; member: GroupParticipant; scope: string; suspended?: boolean; snapshotRevision?: number; identityRevision?: number; groupRevision?: number
  onBack: () => void; onClose: () => void; onOpenChat?: OpenParticipantChat
}, forwardedRef: ForwardedRef<GroupParticipantProfileHandle>) {
  const path = groupParticipantPath(chat.id, member.jid)
  const requestKey = `${scope}:${path}:${chat.device_id}:${snapshotRevision}:${identityRevision}:${groupRevision}`
  const requestKeyRef = useRef(requestKey)
  requestKeyRef.current = requestKey
  const [snapshot, setSnapshot] = useState<{ key: string; profile: Profile } | null>(null)
  const profile = snapshot?.key === requestKey ? snapshot.profile : null
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [about, setAbout] = useState<{ phase: Phase; text: string; error: string }>({ phase: 'loading', text: '', error: '' })
  const [aboutRetry, setAboutRetry] = useState(0)
  const [groups, setGroups] = useState<ParticipantCommonGroup[]>([])
  const [groupsPhase, setGroupsPhase] = useState<Phase>('loading')
  const [groupsError, setGroupsError] = useState('')
  const [cursor, setCursor] = useState('')
  const [syncedAt, setSyncedAt] = useState<string | null>(null)
  const [photo, setPhoto] = useState<{ url: string; phase: Phase; message: string }>({ url: '', phase: 'ready', message: '' })
  const [failedPhoto, setFailedPhoto] = useState('')
  const [photoRequested, setPhotoRequested] = useState(false)
  const [photoRetry, setPhotoRetry] = useState(0)
  const [opening, setOpening] = useState(false)
  const [messageError, setMessageError] = useState('')
  const [confirmation, setConfirmation] = useState<SenderConfirmation | null>(null)
  const [showContact, setShowContact] = useState(false)
  const [contactContext, setContactContext] = useState<Profile['contact_context']>()
  const contactSurface = useRef<ContactDetailSurfaceHandle>(null)
  const canClose = useCallback(() => contactSurface.current?.canClose() ?? true, [])
  const back = useCallback(() => {
    if (!showContact) return true
    if (canClose()) setShowContact(false)
    return false
  }, [showContact, canClose])
  useImperativeHandle(forwardedRef, () => ({ canClose, back }), [canClose, back])
  const active = useRef(true)
  const groupLease = useRef<AbortController | null>(null)
  const groupsGeneration = useRef(0)
  const messageLease = useRef<AbortController | null>(null)
  const openingRef = useRef(false)
  const messageButton = useRef<HTMLButtonElement>(null)
  const wasSuspended = useRef(suspended)
  active.current = !suspended && getAuthScope() === scope && !isAuthIdentityChanging(scope)
  const current = useCallback((controller: AbortController) => active.current && !controller.signal.aborted && requestKeyRef.current === requestKey && getAuthScope() === scope && !isAuthIdentityChanging(scope), [scope, requestKey])
  const fallbackMember = member.name_source === 'contact' || member.avatar_source === 'contact'
    ? { ...member, name: member.whatsapp_name || '', avatar_url: undefined, avatar_source: 'none' as const } : member
  const base = profile?.participant || fallbackMember
  const capabilities = profile?.capabilities
  const photoCandidate = photo.url || (base.avatar_source === 'contact' ? base.avatar_url : '')
  const displayedPhoto = photoCandidate !== failedPhoto ? photoCandidate : ''

  useEffect(() => {
    if (wasSuspended.current && !suspended) requestAnimationFrame(() => messageButton.current?.focus({ preventScroll: true }))
    wasSuspended.current = suspended
    if (suspended) { messageLease.current?.abort(); openingRef.current = false; setOpening(false) }
  }, [suspended])

  useEffect(() => {
    if (suspended) return
    const controller = new AbortController()
    messageLease.current?.abort(); openingRef.current = false; setOpening(false)
    setPhase('loading'); setError(''); setConfirmation(null); setSnapshot(null)
    setAbout({ phase: 'loading', text: '', error: '' }); setGroups([]); setCursor(''); setSyncedAt(null); setGroupsError(''); setGroupsPhase('loading')
    void fetch(path, { credentials: 'include', cache: 'no-store', signal: controller.signal }).then(readJSON).then(data => {
      if (!current(controller)) return
      const parsed = parseGroupParticipantProfile(data.profile)
      if (identityRevision !== undefined && parsed.identity_revision < identityRevision || groupRevision !== undefined && parsed.group_revision < groupRevision) throw new Error('La información del integrante cambió. Vuelve a consultar el perfil.')
      if (!sameParticipant(parsed.participant, member)) throw new Error('La identidad del integrante cambió. Vuelve a consultar el perfil.')
      if (parsed.device_id !== chat.device_id) throw new Error('El dispositivo del grupo cambió. Vuelve a consultar el integrante.')
      setSnapshot({ key: requestKey, profile: parsed }); setPhase('ready')
    }).catch(cause => { if (current(controller)) { setSnapshot(null); setPhase('error'); setAbout({ phase: 'ready', text: '', error: '' }); setGroupsPhase('ready'); setError(cause instanceof Error ? cause.message : 'No pudimos consultar al integrante.') } })
    return () => controller.abort()
  }, [path, revision, suspended, current, requestKey, chat.device_id])

  useEffect(() => {
    if (suspended || !capabilities) return
    if (!capabilities.can_query_about) { setAbout({ phase: 'ready', text: '', error: '' }); return }
    const controller = new AbortController()
    setAbout(value => ({ ...value, phase: 'loading', error: '' }))
    void fetch(path + '/about', { credentials: 'include', cache: 'no-store', signal: controller.signal }).then(readJSON).then(data => {
      if (current(controller)) setAbout(data.about?.state === 'unavailable' ? { phase: 'error', text: '', error: 'WhatsApp no pudo entregar la información del perfil.' } : { phase: 'ready', text: data.about?.text || '', error: '' })
    }).catch(() => { if (current(controller)) setAbout({ phase: 'error', text: '', error: 'WhatsApp no pudo entregar la información del perfil.' }) })
    return () => controller.abort()
  }, [path, capabilities?.can_query_about, suspended, aboutRetry, current])

  const loadGroups = useCallback(async (after = '') => {
    if (!active.current) return
    groupLease.current?.abort()
    const controller = new AbortController(); groupLease.current = controller
    const generation = ++groupsGeneration.current
    setGroupsPhase('loading'); setGroupsError('')
    try {
      const params = new URLSearchParams({ limit: '50' }); if (after) params.set('cursor', after)
      const data = await fetch(path + '/common-groups?' + params, { credentials: 'include', cache: 'no-store', signal: controller.signal }).then(readJSON)
      if (!current(controller) || generation !== groupsGeneration.current) return
      setGroups(rows => after ? [...rows, ...(data.groups || []).filter((item: ParticipantCommonGroup) => !rows.some(row => row.chat_id === item.chat_id))] : data.groups || [])
      setCursor(data.next_cursor || ''); setSyncedAt(data.synced_at || null); setGroupsPhase('ready')
    } catch { if (current(controller) && generation === groupsGeneration.current) { setGroupsPhase('error'); setGroupsError('No pudimos consultar los grupos sincronizados en común.') } }
  }, [path, current])

  useEffect(() => {
    if (suspended || !capabilities) return
    if (capabilities.can_list_common_groups) void loadGroups()
    else { setGroupsPhase('ready'); setGroups([]); setCursor('') }
    return () => { groupLease.current?.abort(); groupsGeneration.current++ }
  }, [capabilities?.can_list_common_groups, suspended, loadGroups])

  const contactAccessConfirmed = Boolean(profile?.contact_context && contactContext && profile.contact_context.contact_id === contactContext.contact_id && profile.contact_context.context === contactContext.context && profile.contact_context.chat_id === contactContext.chat_id)
  useEffect(() => {
    if (profile && contactContext && !contactAccessConfirmed) { setShowContact(false); setContactContext(undefined) }
  }, [profile, contactContext, contactAccessConfirmed])

  const queryPhoto = Boolean(capabilities?.can_query_avatar && (base.avatar_source !== 'contact' || photoRequested))
  useEffect(() => {
    if (suspended || !queryPhoto) return
    const controller = new AbortController()
    let objectURL = ''
    setPhoto(value => ({ ...value, phase: 'loading', message: '' }))
    void (async () => {
      try {
        const response = await fetch(path + '/avatar', { credentials: 'include', cache: 'no-store', signal: controller.signal })
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          const message = data.code === 'photo_private' ? 'La foto no está disponible por privacidad.' : data.code === 'photo_not_set' ? 'Este integrante no tiene una foto disponible.' : 'WhatsApp no pudo entregar la foto.'
          if (current(controller)) setPhoto({ url: '', phase: data.code === 'photo_private' || data.code === 'photo_not_set' ? 'ready' : 'error', message })
          return
        }
        if (!response.headers.get('content-type')?.startsWith('image/')) throw new Error('invalid_photo')
        const blob = await response.blob()
        if (!current(controller)) return
        objectURL = URL.createObjectURL(blob)
        setPhoto({ url: objectURL, phase: 'ready', message: '' })
      } catch { if (current(controller)) setPhoto({ url: '', phase: 'error', message: 'No pudimos cargar la foto. Puedes reintentar.' }) }
    })()
    return () => { controller.abort(); if (objectURL) URL.revokeObjectURL(objectURL); setPhoto({ url: '', phase: 'ready', message: '' }) }
  }, [path, queryPhoto, photoRetry, suspended, current])

  useEffect(() => {
    active.current = !suspended && getAuthScope() === scope && !isAuthIdentityChanging(scope)
    return () => { active.current = false; messageLease.current?.abort(); groupLease.current?.abort() }
  }, [scope, suspended])

  const openMessage = async (senderConfirmation?: SenderConfirmation) => {
    if (openingRef.current || !profile?.capabilities.can_message || !onOpenChat || !active.current) return
    openingRef.current = true; setOpening(true); setMessageError('')
    const controller = new AbortController(); messageLease.current = controller
    try {
      const response = await fetch(path + '/chat', { method: 'POST', credentials: 'include', cache: 'no-store', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity_fingerprint: profile.identity_fingerprint, ...(senderConfirmation ? { sender_confirmation: senderConfirmation } : {}) }) })
      const data = await response.json()
      if (!current(controller)) return
      if (!response.ok || !data.success || !data.chat) {
        if (data.code === 'sender_confirmation_required' && data.sender_confirmation) { setConfirmation(data.sender_confirmation); return }
        if (response.status === 409 || response.status === 404) { setSnapshot(null); setRevision(value => value + 1) }
        throw new Error(data.error || 'No se pudo abrir la conversación privada.')
      }
      setConfirmation(null)
      onOpenChat(data.chat)
    } catch (cause) { if (current(controller)) setMessageError(cause instanceof Error ? cause.message : 'No se pudo abrir la conversación privada.') }
    finally { if (current(controller)) { openingRef.current = false; setOpening(false) } }
  }

  if (showContact && contactContext) {
    const context = contactContext
    return <div className="h-full min-h-0">
      <div className="h-full min-h-0" hidden={!contactAccessConfirmed} inert={!contactAccessConfirmed || suspended} style={!contactAccessConfirmed ? { display: 'none' } : undefined}><Suspense fallback={<div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Cargando ficha Clarin…</div>}><ContactDetailSurface ref={contactSurface} contactId={context.contact_id} context={{ type: context.context, id: context.context === 'chat' ? context.chat_id! : context.contact_id }} readOnly={!contactAccessConfirmed || suspended} title="Ficha del contacto" onClose={() => setShowContact(false)} /></Suspense></div>
      {!contactAccessConfirmed && <div className="p-4 text-sm text-slate-500" role={error ? 'alert' : 'status'}>{error || 'Comprobando acceso a la ficha del contacto…'}{error && <button type="button" onClick={() => setRevision(value => value + 1)} className="block min-h-11 font-semibold text-emerald-700">Reintentar perfil</button>}</div>}
    </div>
  }

  return <section className="flex h-full min-h-0 flex-col bg-white" aria-label="Perfil del integrante">
    <header className="flex min-h-16 shrink-0 items-center gap-2 border-b border-slate-200 px-3"><button type="button" onClick={onBack} aria-label="Volver a participantes" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-500"><ArrowLeft className="h-5 w-5" /></button><h2 className="min-w-0 flex-1 font-semibold text-slate-900">Integrante del grupo</h2><button type="button" onClick={onClose} aria-label="Cerrar detalles" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-500"><X className="h-5 w-5" /></button></header>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="border-b border-slate-100 px-5 py-6 text-center">
        {displayedPhoto ? <img src={displayedPhoto} onError={() => setFailedPhoto(displayedPhoto || '')} alt="Foto del integrante" className="mx-auto h-28 w-28 rounded-full object-cover" /> : <span className="mx-auto flex h-28 w-28 items-center justify-center rounded-full bg-emerald-50 text-3xl font-semibold text-emerald-700">{Array.from(groupParticipantLabel(base))[0]}</span>}
        {photo.url && <p className="mt-2 text-[11px] text-slate-500">Foto de WhatsApp · vista temporal</p>}
        {photo.phase === 'loading' && base.avatar_source !== 'contact' && <p role="status" className="mt-2 flex items-center justify-center gap-2 text-xs text-slate-500"><Loader2 className="h-3 w-3 animate-spin" />Consultando foto…</p>}
        <h3 className="mt-4 break-words text-xl font-semibold text-slate-900">{groupParticipantLabel(base)}{base.is_self && <span className="ml-1 text-sm font-normal text-slate-500">(Tú)</span>}</h3>
        <p className="mt-2 break-words text-sm text-slate-500">{groupParticipantPhone(base)}</p>{base.username && <p className="mt-2 break-words text-sm text-slate-600">Usuario: @{base.username.replace(/^@/, '')}</p>}
        {base.whatsapp_name && base.whatsapp_name !== base.name && <p className="mt-2 break-words text-xs text-slate-500">Nombre en WhatsApp: {base.whatsapp_name}</p>}
        {base.role !== 'member' && <p className="mt-2 inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700"><Shield className="h-3 w-3" />Admin. del grupo</p>}
        {base.avatar_source === 'contact' && capabilities?.can_query_avatar && <button type="button" onClick={() => { setPhotoRequested(true); setPhotoRetry(value => value + 1) }} disabled={photo.phase === 'loading' || suspended} className="mt-3 block min-h-11 w-full text-xs font-semibold text-emerald-700 disabled:opacity-50">{photo.phase === 'loading' ? 'Consultando foto…' : 'Ver foto de WhatsApp'}</button>}
        {photo.message && <p role="status" className="mt-2 text-xs text-slate-500"><ImageOff className="mr-1 inline h-3 w-3" />{photo.message}{photo.phase === 'error' && <button type="button" onClick={() => setPhotoRetry(value => value + 1)} className="ml-1 inline-flex min-h-11 items-center font-semibold text-emerald-700">Reintentar foto</button>}</p>}
        <button ref={messageButton} type="button" onClick={() => void openMessage()} disabled={!capabilities?.can_message || phase !== 'ready' || opening || suspended || !onOpenChat || Boolean(confirmation)} className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40">{opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}{opening ? 'Abriendo conversación…' : 'Mensaje'}</button>
        <p className="mt-2 text-xs leading-5 text-slate-500">{capabilities?.can_message ? `Desde ${chat.device_name || 'el dispositivo de este grupo'}. Abrir no envía ningún mensaje.` : capabilities?.message_disabled_reason || (phase === 'loading' ? 'Comprobando identidad y dispositivo…' : 'No se puede iniciar una conversación con esta identidad.')}</p>
        {profile?.contact_context && <button type="button" onClick={() => { setContactContext(profile.contact_context); setShowContact(true) }} className="mt-2 inline-flex min-h-11 items-center gap-2 text-xs font-semibold text-slate-700"><UserRound className="h-4 w-4" />Abrir ficha Clarin</button>}
      </div>
      {phase === 'loading' && <p role="status" className="flex items-center gap-2 p-4 text-xs text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Actualizando los datos del integrante…</p>}
      {error && <div role="alert" className="m-4 rounded-xl bg-rose-50 p-3 text-xs text-rose-700"><AlertCircle className="mr-1 inline h-4 w-4" />{error}<button type="button" onClick={() => setRevision(value => value + 1)} className="block min-h-11 font-semibold">Reintentar perfil</button></div>}
      {messageError && <p role="alert" className="m-4 rounded-xl bg-rose-50 p-3 text-xs text-rose-700">{messageError}</p>}
      {confirmation && <div role="alert" className="m-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900"><p>El número emisor difiere del historial de esta conversación. Continuarás desde el número del dispositivo de este grupo.</p><p className="mt-2 break-words font-semibold">Número del dispositivo: +{confirmation.device_phone.replace(/^\+/, '')}</p><button type="button" disabled={opening} onClick={() => void openMessage(confirmation)} className="mt-2 min-h-11 rounded-xl bg-amber-900 px-3 font-semibold text-white disabled:opacity-50">Confirmar este número</button><button type="button" onClick={() => setConfirmation(null)} disabled={opening} className="ml-2 min-h-11 px-2 font-semibold">Cancelar</button></div>}
      <section className="border-b border-slate-100 p-4" aria-label="Información de WhatsApp"><h4 className="text-sm font-semibold text-slate-800">Info.</h4>{about.phase === 'loading' ? <p className="mt-2 text-xs text-slate-500" role="status">Consultando información disponible…</p> : about.error ? <div className="mt-2 text-xs text-slate-500"><p>{about.error}</p><button type="button" onClick={() => setAboutRetry(value => value + 1)} className="min-h-11 font-semibold text-emerald-700">Reintentar información</button></div> : <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-600">{about.text ? <WebText text={about.text} /> : 'Sin información de perfil disponible.'}</p>}</section>
      <section className="p-4" aria-label="Grupos sincronizados en común"><h4 className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Users className="h-4 w-4 text-slate-400" />Grupos sincronizados en común</h4><p className="mt-2 text-xs leading-5 text-slate-500">Solo los grupos conocidos de este dispositivo.{syncedAt && !Number.isNaN(Date.parse(syncedAt)) ? ` Grupo de origen actualizado: ${new Date(syncedAt).toLocaleString('es-PE')}.` : ' La información puede estar incompleta.'}</p><ul className="mt-3 divide-y divide-slate-100">{groups.map(item => <li key={item.chat_id} className="flex min-h-14 items-center gap-3 py-2"><Users className="h-5 w-5 shrink-0 text-emerald-600" /><div className="min-w-0"><p className="break-words text-sm font-medium text-slate-700">{item.subject}</p><p className="text-xs text-slate-500">{item.participant_count} participantes</p></div></li>)}</ul>{groupsPhase === 'loading' && <p role="status" className="flex min-h-11 items-center gap-2 text-xs text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Consultando grupos…</p>}{groupsError && <div className="mt-2 text-xs text-slate-500"><p>{groupsError}</p><button type="button" onClick={() => void loadGroups()} className="inline-flex min-h-11 items-center gap-2 font-semibold text-emerald-700"><RefreshCw className="h-3 w-3" />Reintentar grupos</button></div>}{groupsPhase === 'ready' && groups.length === 0 && <p className="py-4 text-xs text-slate-500">No tenemos grupos sincronizados en común para este integrante.</p>}{cursor && <button type="button" disabled={groupsPhase === 'loading'} onClick={() => void loadGroups(cursor)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 text-xs font-semibold text-emerald-700 disabled:opacity-50">Mostrar más grupos</button>}</section>
    </div>
  </section>
}

const GroupParticipantProfile = forwardRef<GroupParticipantProfileHandle, Parameters<typeof GroupParticipantProfileImpl>[0]>(GroupParticipantProfileImpl)
GroupParticipantProfile.displayName = 'GroupParticipantProfile'
export default GroupParticipantProfile
