'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, KeyRound, Laptop, Loader2, LockKeyhole, RefreshCw, ShieldAlert, ShieldCheck, Trash2, UserRound, X } from 'lucide-react'
import { AdminFormDialog } from './AdminFormDialog'
import {
  approveAdminEnrollment,
  createAdminOfflineControl,
  listAdminEnrollmentRequests,
  listAdminGrants,
  rejectAdminEnrollment,
  type AdminOfflineControlInput,
  type AdminOfflineControlScope,
  type AdminOfflineGrant,
  type EnrollmentRequestStatus,
} from '@/offline-v3/onlineClient'
import type { OfflineAction } from '@/offline-v3/types'

type Account = { id: string; name: string; is_active: boolean }
type User = { id: string; username: string; display_name: string; is_active: boolean; accounts?: { account_id: string }[] }

export interface OfflineV3ApprovalDraft {
  accountId: string
  actions: OfflineAction[]
}

const allActions: Array<{ id: OfflineAction; label: string; detail: string }> = [
  { id: 'tasks.read', label: 'Leer tareas', detail: 'Listas y tareas elegidas por el usuario' },
  { id: 'tasks.create', label: 'Crear tareas', detail: 'Sólo dentro de listas preparadas' },
  { id: 'tasks.complete', label: 'Completar tareas', detail: 'Con versión y reconciliación del servidor' },
  { id: 'contacts.read', label: 'Leer contactos', detail: 'Sólo contactos elegidos' },
  { id: 'programs.read', label: 'Leer programas', detail: 'Roster, sesiones y asistencia' },
  { id: 'whiteboards.read', label: 'Leer pizarras', detail: 'Vista completa de solo lectura' },
]

const defaultActions: OfflineAction[] = ['tasks.read', 'contacts.read', 'programs.read', 'whiteboards.read']
const FIVE_GIB = 5 * 1024 * 1024 * 1024

export function defaultOfflineV3Approval(user: User | undefined, accounts: Account[]): OfflineV3ApprovalDraft[] {
  const membership = new Set((user?.accounts || []).map(item => item.account_id))
  const account = accounts.find(item => item.is_active && membership.has(item.id))
  return account ? [{ accountId: account.id, actions: [...defaultActions] }] : [{ accountId: '', actions: [] }]
}

export function validateOfflineV3Approval(drafts: OfflineV3ApprovalDraft[]) {
  if (drafts.length === 0 || drafts.some(item => !item.accountId || item.actions.length === 0)) return 'Cada cuenta necesita al menos un permiso.'
  if (new Set(drafts.map(item => item.accountId)).size !== drafts.length) return 'No repitas la misma cuenta.'
  if (drafts.some(item => (item.actions.includes('tasks.create') || item.actions.includes('tasks.complete')) && !item.actions.includes('tasks.read'))) return 'Crear o completar tareas requiere permiso para leer tareas.'
  return ''
}

export function buildOfflineV3Control(grant: AdminOfflineGrant, scope: AdminOfflineControlScope, action: 'lock' | 'wipe'): AdminOfflineControlInput {
  const targets: Record<AdminOfflineControlScope, string> = {
    installation: grant.installation_id,
    windows_principal: grant.windows_principal_id,
    browser_profile: grant.browser_profile_id,
    authorization: grant.authorization_id,
    grant: grant.grant_id,
    account: grant.account_id,
    user: grant.user_id,
    installation_account: grant.account_id,
    installation_user: grant.user_id,
  }
  const aggregate = ['account', 'user', 'installation_account', 'installation_user'].includes(scope)
  if (aggregate && action !== 'wipe') throw new Error('Ese alcance sólo admite revocación y borrado local.')
  return {
    scope,
    scope_id: targets[scope],
    ...(scope.startsWith('installation_') ? { installation_id: grant.installation_id } : {}),
    action,
  }
}

const controlScopes: Array<{ id: AdminOfflineControlScope; label: string; detail: string; wipeOnly?: boolean }> = [
  { id: 'grant', label: 'PC + navegador + usuario + cuenta', detail: 'Sólo esta autorización exacta' },
  { id: 'authorization', label: 'Navegador + usuario Clarin', detail: 'Todas sus cuentas autorizadas en este navegador' },
  { id: 'browser_profile', label: 'Navegador en esta PC', detail: 'Todos los usuarios offline de este navegador' },
  { id: 'windows_principal', label: 'Usuario de Windows', detail: 'Todos sus navegadores y usuarios Clarin en esta PC' },
  { id: 'installation', label: 'PC completa', detail: 'Toda identidad offline instalada en este equipo' },
  { id: 'installation_account', label: 'Cuenta en esta PC', detail: 'La cuenta seleccionada, sólo en esta PC', wipeOnly: true },
  { id: 'installation_user', label: 'Usuario Clarin en esta PC', detail: 'El usuario seleccionado, sólo en esta PC', wipeOnly: true },
  { id: 'account', label: 'Cuenta Clarin global', detail: 'La cuenta en todos los equipos', wipeOnly: true },
  { id: 'user', label: 'Usuario Clarin global', detail: 'El usuario en todos los equipos', wipeOnly: true },
]

function shortID(id: string) {
  return id ? `${id.slice(0, 8)}…` : '—'
}

function stateTone(state: string) {
  if (state === 'active' || state === 'available' || state === 'approved') return 'bg-emerald-50 text-emerald-700'
  if (state === 'requested' || state === 'pending' || state === 'preparing') return 'bg-amber-50 text-amber-800'
  if (state === 'revoked' || state === 'rejected') return 'bg-red-50 text-red-700'
  return 'bg-slate-100 text-slate-600'
}

export default function OfflineAccessAdminV3({ accounts, users }: { accounts: Account[]; users: User[] }) {
  const [requests, setRequests] = useState<EnrollmentRequestStatus[]>([])
  const [grants, setGrants] = useState<AdminOfflineGrant[]>([])
  const [reviewing, setReviewing] = useState<EnrollmentRequestStatus | null>(null)
  const [approval, setApproval] = useState<OfflineV3ApprovalDraft[]>([])
  const [controlling, setControlling] = useState<AdminOfflineGrant | null>(null)
  const [scope, setScope] = useState<AdminOfflineControlScope>('grant')
  const [action, setAction] = useState<'lock' | 'wipe'>('lock')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [requestPage, grantPage] = await Promise.all([listAdminEnrollmentRequests(), listAdminGrants()])
      setRequests(requestPage.items || [])
      setGrants(grantPage.items || [])
    } catch (requestError) {
      setError((requestError as Error).message || 'No se pudo cargar el control offline v3.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  function beginReview(request: EnrollmentRequestStatus) {
    setReviewing(request)
    setApproval(defaultOfflineV3Approval(users.find(user => user.id === request.user_id), accounts))
    setError('')
  }

  function accountOptions(index: number) {
    const user = users.find(item => item.id === reviewing?.user_id)
    const membership = new Set((user?.accounts || []).map(item => item.account_id))
    return accounts.filter(account => account.is_active && membership.has(account.id) && !approval.some((draft, draftIndex) => draftIndex !== index && draft.accountId === account.id))
  }

  function toggleAction(index: number, nextAction: OfflineAction) {
    setApproval(current => current.map((draft, draftIndex) => {
      if (draftIndex !== index) return draft
      const selected = new Set(draft.actions)
      if (selected.has(nextAction)) {
        selected.delete(nextAction)
        if (nextAction === 'tasks.read') { selected.delete('tasks.create'); selected.delete('tasks.complete') }
      } else {
        selected.add(nextAction)
        if (nextAction === 'tasks.create' || nextAction === 'tasks.complete') selected.add('tasks.read')
      }
      return { ...draft, actions: allActions.map(item => item.id).filter(item => selected.has(item)) }
    }))
  }

  async function approve() {
    if (!reviewing || busy) return
    const validation = validateOfflineV3Approval(approval)
    if (validation) { setError(validation); return }
    setBusy('approve')
    setError('')
    try {
      await approveAdminEnrollment(reviewing.id, approval.map(item => ({ account_id: item.accountId, actions: item.actions, max_resources: 20, quota_bytes: FIVE_GIB })))
      setReviewing(null)
      await load()
    } catch (approvalError) {
      setError((approvalError as Error).message)
    } finally { setBusy('') }
  }

  async function reject(request: EnrollmentRequestStatus) {
    if (!window.confirm(`¿Rechazar la solicitud de “${request.display_name}”?`)) return
    setBusy(`reject:${request.id}`)
    try { await rejectAdminEnrollment(request.id); setReviewing(null); await load() } catch (rejectError) { setError((rejectError as Error).message) } finally { setBusy('') }
  }

  function beginControl(grant: AdminOfflineGrant) {
    setControlling(grant)
    setScope('grant')
    setAction('lock')
    setError('')
  }

  async function applyControl() {
    if (!controlling || busy) return
    setBusy('control')
    setError('')
    try {
      await createAdminOfflineControl(buildOfflineV3Control(controlling, scope, action))
      setControlling(null)
      await load()
    } catch (controlError) {
      setError((controlError as Error).message)
    } finally { setBusy('') }
  }

  const requested = requests.filter(item => item.state === 'requested')
  const selectedScope = controlScopes.find(item => item.id === scope)
  const activeUser = useMemo(() => users.find(user => user.id === reviewing?.user_id), [reviewing?.user_id, users])

  return <div className="space-y-5 p-5">
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div><div className="flex items-center gap-2 font-semibold text-slate-900"><ShieldCheck className="h-5 w-5 text-emerald-600" />Autorizaciones offline web</div><p className="mt-1 text-sm text-slate-600">Controla la combinación exacta de PC, Windows, navegador, usuario y cuenta. El usuario elige después los recursos permitidos.</p></div>
      <button type="button" onClick={() => void load()} disabled={loading || Boolean(busy)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
    </div>

    {error && !reviewing && !controlling && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

    <section className="overflow-hidden rounded-xl border border-slate-200">
      <header className="border-b border-slate-100 px-4 py-3"><h3 className="font-semibold text-slate-900">Solicitudes pendientes</h3><p className="text-sm text-slate-500">Sólo un superadmin puede aprobarlas.</p></header>
      {loading ? <div className="flex items-center justify-center p-10 text-slate-500"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Cargando…</div> : requested.length === 0 ? <div className="p-10 text-center text-sm text-slate-500"><Laptop className="mx-auto mb-2 h-8 w-8 text-slate-300" />No hay solicitudes pendientes.</div> : <div className="divide-y divide-slate-100">{requested.map(request => <article key={request.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between"><div className="min-w-0"><div className="font-medium text-slate-900">{request.display_name}</div><div className="mt-1 text-sm text-slate-600">{request.user_display_name || users.find(user => user.id === request.user_id)?.display_name || request.user_id} · Windows: {request.principal_display_name || 'identidad comprobada'}</div><div className="mt-1 text-xs text-slate-400">Navegador {shortID(request.browser_profile_id)} · solicitado {new Date(request.requested_at).toLocaleString('es-PE')}</div></div><div className="flex gap-2"><button type="button" onClick={() => beginReview(request)} disabled={Boolean(busy)} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white"><Check className="h-4 w-4" />Revisar</button><button type="button" onClick={() => void reject(request)} disabled={Boolean(busy)} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-red-200 px-3 text-sm text-red-700"><X className="h-4 w-4" />Rechazar</button></div></article>)}</div>}
    </section>

    <section className="overflow-hidden rounded-xl border border-slate-200">
      <header className="border-b border-slate-100 px-4 py-3"><h3 className="font-semibold text-slate-900">Autorizaciones por identidad</h3><p className="text-sm text-slate-500">Cada fila es un grant aislado; una cuenta nunca hereda datos de otra.</p></header>
      {loading ? <div className="p-10 text-center text-sm text-slate-500">Cargando autorizaciones…</div> : grants.length === 0 ? <div className="p-10 text-center text-sm text-slate-500">Todavía no hay autorizaciones v3.</div> : <div className="divide-y divide-slate-100">{grants.map(grant => <article key={grant.grant_id} className="flex flex-col gap-3 p-4 xl:flex-row xl:items-center xl:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="text-slate-900">{grant.account_name}</strong><span className="text-slate-400">·</span><span className="text-slate-700">{grant.display_user}</span><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${stateTone(grant.state)}`}>{grant.state}</span></div><div className="mt-1 text-sm text-slate-600">{grant.installation_name || `PC ${shortID(grant.installation_id)}`} · {grant.principal_name || 'Windows'} · {grant.browser_name || `Navegador ${shortID(grant.browser_profile_id)}`}</div><div className="mt-2 flex flex-wrap gap-1.5">{grant.actions.map(permission => <span key={permission} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">{allActions.find(item => item.id === permission)?.label || permission}</span>)}</div></div><button type="button" onClick={() => beginControl(grant)} disabled={Boolean(busy) || grant.state === 'revoked'} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 disabled:opacity-40"><KeyRound className="h-4 w-4" />Controlar alcance</button></article>)}</div>}
    </section>

    <AdminFormDialog open={Boolean(reviewing)} size="user" title="Aprobar acceso offline" description={reviewing ? `${activeUser?.display_name || reviewing.user_display_name || reviewing.user_id} · ${reviewing.display_name}` : ''} icon={Laptop} busy={busy === 'approve'} onClose={() => { if (!busy) { setReviewing(null); setError('') } }} footer={<><button type="button" onClick={() => reviewing && void reject(reviewing)} disabled={Boolean(busy)} className="min-h-11 rounded-lg border border-red-200 px-4 text-sm text-red-700">Rechazar</button><button type="button" onClick={() => void approve()} disabled={Boolean(busy)} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white">{busy === 'approve' && <Loader2 className="h-4 w-4 animate-spin" />}Aprobar</button></>}>
      <div className="space-y-4"><div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">Límite por cuenta: 20 recursos, 5 GB y lease offline acotado por el servidor. Las claves privadas no salen del equipo.</div>{approval.map((draft, index) => <div key={index} className="rounded-xl border border-slate-200 p-4"><div className="flex gap-2"><select aria-label={`Cuenta ${index + 1}`} value={draft.accountId} onChange={event => setApproval(current => current.map((item, itemIndex) => itemIndex === index ? { accountId: event.target.value, actions: [] } : item))} className="min-h-11 min-w-0 flex-1 rounded-lg border border-slate-200 px-3"><option value="">Seleccionar cuenta…</option>{accountOptions(index).map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select>{approval.length > 1 && <button type="button" aria-label="Quitar cuenta" onClick={() => setApproval(current => current.filter((_, itemIndex) => itemIndex !== index))} className="min-h-11 min-w-11 rounded-lg text-red-600"><Trash2 className="mx-auto h-4 w-4" /></button>}</div><div className="mt-3 grid gap-2 sm:grid-cols-2">{allActions.map(permission => { const checked = draft.actions.includes(permission.id); return <button type="button" key={permission.id} disabled={!draft.accountId} onClick={() => toggleAction(index, permission.id)} className={`flex min-h-14 items-start gap-2 rounded-lg border p-3 text-left text-sm ${checked ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-slate-200 text-slate-600 disabled:opacity-40'}`}><span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${checked ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300'}`}>{checked && <Check className="h-3.5 w-3.5" />}</span><span><span className="block font-medium">{permission.label}</span><span className="block text-xs opacity-75">{permission.detail}</span></span></button>})}</div></div>)}<button type="button" disabled={approval.length >= 5 || accountOptions(approval.length).length === 0} onClick={() => setApproval(current => [...current, { accountId: '', actions: [] }])} className="min-h-11 text-sm font-semibold text-emerald-700 disabled:opacity-40">Añadir otra cuenta</button>{error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}</div>
    </AdminFormDialog>

    <AdminFormDialog open={Boolean(controlling)} size="user" title="Controlar acceso offline" description={controlling ? `${controlling.account_name} · ${controlling.display_user}` : ''} icon={ShieldAlert} busy={busy === 'control'} onClose={() => { if (!busy) { setControlling(null); setError('') } }} footer={<button type="button" onClick={() => void applyControl()} disabled={Boolean(busy)} className={`inline-flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-semibold text-white ${action === 'wipe' ? 'bg-red-600' : 'bg-amber-600'}`}>{busy === 'control' ? <Loader2 className="h-4 w-4 animate-spin" /> : action === 'wipe' ? <Trash2 className="h-4 w-4" /> : <LockKeyhole className="h-4 w-4" />}{action === 'wipe' ? 'Revocar y ordenar borrado' : 'Bloquear ahora'}</button>}>
      <div className="space-y-4"><label className="block text-sm font-medium text-slate-700">Alcance<select value={scope} onChange={event => { const next = event.target.value as AdminOfflineControlScope; setScope(next); if (controlScopes.find(item => item.id === next)?.wipeOnly) setAction('wipe') }} className="mt-1 min-h-11 w-full rounded-lg border border-slate-200 px-3">{controlScopes.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label><div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700"><strong>{selectedScope?.label}</strong><p className="mt-1 text-slate-500">{selectedScope?.detail}</p></div><div className="grid gap-2 sm:grid-cols-2"><button type="button" disabled={selectedScope?.wipeOnly} onClick={() => setAction('lock')} className={`min-h-14 rounded-lg border p-3 text-left ${action === 'lock' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-slate-200 disabled:opacity-40'}`}><LockKeyhole className="mb-1 h-4 w-4" /><strong className="block text-sm">Bloquear</strong><span className="text-xs">Invalida sesiones y conserva la copia cifrada; este control no se puede desbloquear desde aquí.</span></button><button type="button" onClick={() => setAction('wipe')} className={`min-h-14 rounded-lg border p-3 text-left ${action === 'wipe' ? 'border-red-300 bg-red-50 text-red-900' : 'border-slate-200'}`}><Trash2 className="mb-1 h-4 w-4" /><strong className="block text-sm">Revocar y borrar</strong><span className="text-xs">Emite control firmado y elimina el alcance cuando el equipo sincronice.</span></button></div>{action === 'wipe' && <div className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"><ShieldAlert className="h-5 w-5 shrink-0" />La revocación es inmediata en el servidor. Un equipo totalmente desconectado aplicará el borrado al recibir el control firmado.</div>}{error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}</div>
    </AdminFormDialog>
  </div>
}
