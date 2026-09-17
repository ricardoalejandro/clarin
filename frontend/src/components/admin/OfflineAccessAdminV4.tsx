'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CloudOff, Loader2, RefreshCw, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import { AdminFormDialog } from './AdminFormDialog'
import type { OfflineAction } from '@/offline-v3/types'
import { adminGrantsV4, adminRequestsV4, approveRequestV4, rejectRequestV4, revokeScopeV4, type ControlScopeV4, type EnrollmentV4, type OnlineGrantV4 } from '@/components/offline-v4/online'
import { controlTargetV4, permissionLabelsV4, stateLabelV4, togglePermissionV4, validateApprovalV4 } from '@/components/offline-v4/uiState'

type Approval = { account_id: string; actions: OfflineAction[] }
const scopes: Array<{ id: ControlScopeV4; label: string; detail: string }> = [
  { id: 'grant', label: 'Esta autorización exacta', detail: 'Solo este navegador + usuario + cuenta.' },
  { id: 'browser_profile', label: 'Este perfil del navegador', detail: 'Todos los usuarios y cuentas autorizados en este perfil. No afecta automáticamente otros navegadores de la PC.' },
  { id: 'user', label: 'Usuario Clarin, en todos los navegadores', detail: 'Revoca todas las copias offline de este usuario.' },
  { id: 'account', label: 'Cuenta Clarin, en todos los navegadores', detail: 'Revoca las copias de esta cuenta para todos sus usuarios.' },
]
const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white disabled:opacity-50'
const secondary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 disabled:opacity-50'

export default function OfflineAccessAdminV4() {
  const [requests, setRequests] = useState<EnrollmentV4[]>([])
  const [grants, setGrants] = useState<OnlineGrantV4[]>([])
  const [review, setReview] = useState<EnrollmentV4 | null>(null)
  const [drafts, setDrafts] = useState<Approval[]>([])
  const [rejecting, setRejecting] = useState<EnrollmentV4 | null>(null)
  const [control, setControl] = useState<OnlineGrantV4 | null>(null)
  const [scope, setScope] = useState<ControlScopeV4>('grant')
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  const mounted = useRef(false)

  const load = useCallback(async () => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true); setError('')
    try {
      const [requestPage, grantPage] = await Promise.all([adminRequestsV4(controller.signal), adminGrantsV4(controller.signal)])
      if (!controller.signal.aborted) { setRequests(requestPage.items); setGrants(grantPage.items) }
    } catch (requestError) { if (!controller.signal.aborted) setError((requestError as Error).message) } finally { if (!controller.signal.aborted) setLoading(false) }
  }, [])
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; controllerRef.current?.abort() } }, [load])

  async function mutate(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true); setError('')
    try {
      await action()
      if (!mounted.current) return
      setReview(null); setRejecting(null); setControl(null); setConfirmed(false)
      await load()
    } catch (mutationError) { if (mounted.current) setError((mutationError as Error).message) } finally { if (mounted.current) setBusy(false) }
  }
  function approve() {
    if (!review) return
    const invalid = validateApprovalV4(drafts, (review.accounts || []).map(item => item.id))
    if (invalid) { setError(invalid); return }
    void mutate(() => approveRequestV4(review.id, drafts.map(item => ({ ...item, max_resources: 20, quota_bytes: 5 * 1024 ** 3 }))))
  }
  const pending = requests.filter(item => ['requested', 'pending'].includes(item.state))
  const modalError = error && (review || rejecting || control) ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null

  return <section className="space-y-5 p-4 sm:p-5" aria-label="Administrar acceso offline web">
    <header className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="flex items-center gap-2 font-semibold text-slate-900"><ShieldCheck className="h-5 w-5 text-emerald-600" />Autorizaciones offline del navegador</h2><p className="mt-1 max-w-3xl text-sm text-slate-600">Solo un superadmin puede aprobar cada combinación de perfil de navegador, usuario y cuenta. El usuario decide después qué recursos guardar.</p></div><button type="button" className={secondary} onClick={() => void load()} disabled={loading || busy}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button></header>
    <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Sin instalar nada, la web identifica un perfil de navegador, no una PC física ni todos sus navegadores. No se promete control global del equipo. Cada copia vence en un máximo de 24 horas.</p>
    {error && !review && !rejecting && !control && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
    <section className="overflow-hidden rounded-xl border border-slate-200"><header className="border-b border-slate-100 px-4 py-3"><h3 className="font-semibold text-slate-900">Solicitudes pendientes</h3></header>{loading && !requests.length ? <p role="status" className="flex items-center gap-2 p-6 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Cargando…</p> : !pending.length ? <div className="p-8 text-center text-sm text-slate-500"><CloudOff className="mx-auto mb-2 h-7 w-7 text-slate-300" />No hay solicitudes pendientes.</div> : <div className="divide-y divide-slate-100">{pending.map(request => <article key={request.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between"><div className="min-w-0"><h4 className="break-words font-medium text-slate-900">{request.username || request.user_id}</h4><p className="mt-1 text-sm text-slate-600">{request.display_name || request.browser_name || 'Perfil del navegador'}</p><p className="mt-1 break-all text-xs text-slate-400">Perfil {request.browser_profile_id}{request.requested_at && ` · ${new Date(request.requested_at).toLocaleString('es-PE')}`}</p></div><div className="flex gap-2"><button type="button" className={primary} disabled={busy || loading} onClick={() => { setReview(request); setDrafts([]); setError('') }}><Check className="h-4 w-4" />Revisar</button><button type="button" className={secondary} disabled={busy || loading} onClick={() => { setRejecting(request); setError('') }}><X className="h-4 w-4" />Rechazar</button></div></article>)}</div>}</section>
    <section className="overflow-hidden rounded-xl border border-slate-200"><header className="border-b border-slate-100 px-4 py-3"><h3 className="font-semibold text-slate-900">Autorizaciones por identidad</h3><p className="text-sm text-slate-500">Cada fila aísla una cuenta y usuario de todas las demás copias.</p></header>{!grants.length ? <p className="p-8 text-center text-sm text-slate-500">{loading ? 'Cargando autorizaciones…' : 'Todavía no hay autorizaciones para la web offline.'}</p> : <div className="divide-y divide-slate-100">{grants.map(grant => <article key={grant.grant_id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="text-slate-900">{grant.account_name}</strong><span className="text-sm text-slate-600">{grant.display_user || grant.username || grant.user_id}</span><span className={`rounded-full px-2 py-1 text-xs ${grant.state === 'revoked' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{stateLabelV4(grant.state)}</span></div><p className="mt-1 break-all text-xs text-slate-400">Perfil {grant.browser_profile_id}</p><div className="mt-2 flex flex-wrap gap-1">{grant.actions.map(action => <span key={action} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">{permissionLabelsV4[action]}</span>)}</div></div><button type="button" className={secondary} disabled={busy || loading || grant.state === 'revoked'} onClick={() => { setControl(grant); setScope('grant'); setConfirmed(false); setError('') }}><ShieldAlert className="h-4 w-4" />Revocar acceso</button></article>)}</div>}</section>

    <AdminFormDialog open={Boolean(review)} title="Aprobar acceso offline" description={`${review?.username || ''} · ${review?.display_name || 'Este perfil del navegador'}`} icon={ShieldCheck} size="user" busy={busy} onClose={() => { if (!busy) { setReview(null); setError('') } }} footer={<button type="button" className={primary} disabled={busy || !drafts.length} onClick={approve}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Aprobar cuentas seleccionadas</button>}>
      <div className="space-y-4"><p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">Hasta 5 cuentas por solicitud; 20 recursos y 5 GB por autorización, sujetos al espacio real del navegador. Contactos, Programas y Pizarras se consultan en lectura. La autorización no amplía los permisos online del usuario.</p>{!review?.accounts?.length ? <p className="text-sm text-amber-800">No hay cuentas activas elegibles para este usuario. Actualiza su acceso antes de aprobar.</p> : review.accounts.map(account => { const draft = drafts.find(item => item.account_id === account.id); return <fieldset key={account.id} className="rounded-xl border border-slate-200 p-3"><legend className="px-1 text-sm font-semibold text-slate-900">{account.name}</legend><label className="flex min-h-11 items-center gap-2 text-sm text-slate-700"><input type="checkbox" disabled={busy || (!draft && drafts.length >= 5)} checked={Boolean(draft)} onChange={event => setDrafts(current => event.target.checked ? [...current, { account_id: account.id, actions: [] }] : current.filter(item => item.account_id !== account.id))} className="h-4 w-4 accent-emerald-600" />Autorizar esta cuenta</label>{draft && <div className="grid gap-1 sm:grid-cols-2">{(Object.keys(permissionLabelsV4) as OfflineAction[]).map(action => <label key={action} className="flex min-h-11 items-center gap-2 rounded-lg bg-slate-50 px-3 text-sm text-slate-700"><input type="checkbox" className="h-4 w-4 accent-emerald-600" disabled={busy} checked={draft.actions.includes(action)} onChange={() => setDrafts(current => current.map(item => item.account_id === account.id ? { ...item, actions: togglePermissionV4(item.actions, action) } : item))} />{permissionLabelsV4[action]}</label>)}</div>}</fieldset>})}{modalError}</div>
    </AdminFormDialog>
    <AdminFormDialog open={Boolean(rejecting)} title="Rechazar solicitud offline" description={rejecting?.username || rejecting?.user_id || ''} icon={ShieldAlert} size="user" busy={busy} onClose={() => { if (!busy) { setRejecting(null); setError('') } }} footer={<button type="button" className="min-h-11 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => rejecting && void mutate(() => rejectRequestV4(rejecting.id))}>Confirmar rechazo</button>}><p className="text-sm text-slate-600">Esta solicitud no podrá preparar datos offline. No se modifica la sesión online del usuario.</p>{modalError}</AdminFormDialog>
    <AdminFormDialog open={Boolean(control)} title="Revocar acceso offline" description={`${control?.account_name || ''} · ${control?.display_user || control?.username || ''}`} icon={ShieldAlert} size="user" busy={busy} onClose={() => { if (!busy) { setControl(null); setError('') } }} footer={<button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || !confirmed} onClick={() => control && void mutate(() => revokeScopeV4(scope, controlTargetV4(control, scope)))}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Confirmar revocación</button>}>
      <div className="space-y-3"><fieldset className="space-y-2"><legend className="mb-2 text-sm font-semibold text-slate-900">Alcance de la revocación</legend>{scopes.map(option => <label key={option.id} className={`flex gap-3 rounded-lg border p-3 ${scope === option.id ? 'border-red-200 bg-red-50' : 'border-slate-200'}`}><input type="radio" name="offline-revoke-scope" disabled={busy} checked={scope === option.id} onChange={() => { setScope(option.id); setConfirmed(false) }} className="mt-1" /><span><strong className="block text-sm text-slate-800">{option.label}</strong><span className="text-xs text-slate-500">{option.detail}</span></span></label>)}</fieldset><p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">El servidor rechaza la sincronización inmediatamente. Una copia totalmente desconectada no recibe la revocación hasta reconectarse o agotar su vigencia, de hasta 24 horas. No es un borrado remoto instantáneo.</p><label className="flex items-start gap-2 text-sm text-slate-700"><input type="checkbox" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1" />He revisado el alcance y confirmo la revocación.</label>{modalError}</div>
    </AdminFormDialog>
  </section>
}
