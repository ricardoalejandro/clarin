'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CloudOff, Loader2, RefreshCw, ShieldAlert, ShieldCheck, SlidersHorizontal, X } from 'lucide-react'
import { AdminFormDialog } from './AdminFormDialog'
import { browserOfflineV5Client } from '@/offline-v5/client'
import {
  adminGrantsV5,
  adminRequestsV5,
  approveRequestV5,
  offlineV5ApprovalConflict,
  offlineV5RequestIsPending,
  rejectRequestV5,
  revokeGrantV5,
  upgradeGrantV5,
  type OfflineEnrollmentV5,
  type OfflineGrantV5,
} from '@/components/offline-v5/online'
import {
  normalizeOfflineV5Modules,
  offlineModulesV5,
  toggleOfflineV5Module,
  validateOfflineV5Approval,
  type OfflineV5ApprovalDraft,
  type OfflineV5Module,
} from '@/components/offline-v5/uiState'

const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50'
const secondary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50'

export async function revokeOfflineV5GrantAndLocalCopy(
  grantID: string,
  revoke: (id: string) => Promise<unknown> = revokeGrantV5,
  purge: (id: string) => Promise<unknown> = id => browserOfflineV5Client.purgeLocalGrant(id),
) {
  await revoke(grantID)
  await purge(grantID)
}

function stateLabel(state: string) {
  return ({
    requested: 'Pendiente de aprobación',
    pending: 'Pendiente de aprobación',
    approved: 'Autorizado',
    active: 'Autorizado',
    available: 'Copia preparada',
    preparing: 'Preparando copia',
    expired: 'Autorización vencida',
    revoked: 'Revocado',
    rejected: 'Rechazado',
  } as Record<string, string>)[state] || 'No disponible'
}

export default function OfflineAccessAdminV5() {
  const [requests, setRequests] = useState<OfflineEnrollmentV5[]>([])
  const [grants, setGrants] = useState<OfflineGrantV5[]>([])
  const [review, setReview] = useState<OfflineEnrollmentV5 | null>(null)
  const [drafts, setDrafts] = useState<OfflineV5ApprovalDraft[]>([])
  const [rejecting, setRejecting] = useState<OfflineEnrollmentV5 | null>(null)
  const [editing, setEditing] = useState<OfflineGrantV5 | null>(null)
  const [editingModules, setEditingModules] = useState<OfflineV5Module[]>([])
  const [revoking, setRevoking] = useState<OfflineGrantV5 | null>(null)
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
    setLoading(true)
    setError('')
    try {
      const [requestPage, grantPage] = await Promise.all([
        adminRequestsV5(controller.signal),
        adminGrantsV5(controller.signal),
      ])
      if (!controller.signal.aborted) {
        setRequests(requestPage.items)
        setGrants(grantPage.items)
        return { requests: requestPage.items, grants: grantPage.items }
      }
    } catch (requestError) {
      if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : 'No se pudieron cargar las autorizaciones.')
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
    return null
  }, [])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      controllerRef.current?.abort()
    }
  }, [load])

  async function mutate(action: () => Promise<unknown>, conflictRequestID?: string) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
      if (!mounted.current) return
      setReview(null)
      setRejecting(null)
      setEditing(null)
      setRevoking(null)
      setConfirmed(false)
      await load()
    } catch (mutationError) {
      if (conflictRequestID && offlineV5ApprovalConflict(mutationError)) {
        const refreshed = await load()
        if (!mounted.current) return
        if (refreshed && !offlineV5RequestIsPending(refreshed.requests, conflictRequestID)) {
          setReview(null)
          setRejecting(null)
          setEditing(null)
          setRevoking(null)
          setConfirmed(false)
          setError('')
          return
        }
      }
      if (mounted.current) setError(mutationError instanceof Error ? mutationError.message : 'No se pudo completar la operación.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  function approve() {
    if (!review) return
    const invalid = validateOfflineV5Approval(drafts, (review.accounts || []).map(account => account.id))
    if (invalid) {
      setError(invalid)
      return
    }
    void mutate(() => approveRequestV5(review.id, drafts.map(draft => ({
      ...draft,
      max_resources: 20,
      quota_bytes: 5 * 1024 ** 3,
    }))), review.id)
  }

  function saveModules() {
    if (!editing || editingModules.length === 0) {
      setError('Selecciona al menos un módulo para esta autorización.')
      return
    }
    void mutate(() => upgradeGrantV5(editing.grant_id, editingModules))
  }

  const pending = requests.filter(request => ['requested', 'pending'].includes(request.state))
  const modalError = error && (review || rejecting || editing || revoking)
    ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>
    : null

  return <section className="space-y-5 p-4 sm:p-5" aria-label="Administrar acceso offline web">
    <header className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 className="flex items-center gap-2 font-semibold text-slate-900"><ShieldCheck className="h-5 w-5 text-emerald-600" />Autorizaciones offline del navegador</h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">Aprueba la combinación exacta de perfil de navegador, usuario, cuenta y módulos. El usuario elige después hasta 20 recursos concretos.</p>
      </div>
      <button type="button" className={secondary} onClick={() => void load()} disabled={loading || busy}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} />Actualizar</button>
    </header>
    <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">La autorización no amplía los permisos normales del usuario. Solo se prepara y puede modificarse el contenido propio de los recursos que el usuario seleccione; ninguna otra cuenta o recurso se descarga.</p>
    {error && !review && !rejecting && !editing && !revoking && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}

    <section className="overflow-hidden rounded-xl border border-slate-200">
      <header className="border-b border-slate-100 px-4 py-3"><h3 className="font-semibold text-slate-900">Solicitudes pendientes</h3></header>
      {loading && !requests.length
        ? <p role="status" className="flex items-center gap-2 p-6 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />Cargando…</p>
        : !pending.length
          ? <div className="p-8 text-center text-sm text-slate-500"><CloudOff className="mx-auto mb-2 h-7 w-7 text-slate-300" />No hay solicitudes pendientes.</div>
          : <div className="divide-y divide-slate-100">{pending.map(request => <article key={request.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0"><h4 className="break-words font-medium text-slate-900">{request.username || request.user_id}</h4><p className="mt-1 text-sm text-slate-600">{request.display_name || request.browser_name || 'Perfil del navegador'}</p><p className="mt-1 break-all text-xs text-slate-400">Perfil {request.browser_profile_id}{request.requested_at && ` · ${new Date(request.requested_at).toLocaleString('es-PE')}`}</p></div>
            <div className="flex gap-2"><button type="button" className={primary} disabled={busy || loading} onClick={() => { setReview(request); setDrafts([]); setError('') }}><Check className="h-4 w-4" />Revisar</button><button type="button" className={secondary} disabled={busy || loading} onClick={() => { setRejecting(request); setError('') }}><X className="h-4 w-4" />Rechazar</button></div>
          </article>)}</div>}
    </section>

    <section className="overflow-hidden rounded-xl border border-slate-200">
      <header className="border-b border-slate-100 px-4 py-3"><h3 className="font-semibold text-slate-900">Autorizaciones exactas</h3><p className="text-sm text-slate-500">Cada fila aísla una cuenta, un usuario y un perfil de navegador.</p></header>
      {!grants.length
        ? <p className="p-8 text-center text-sm text-slate-500">{loading ? 'Cargando autorizaciones…' : 'Todavía no hay autorizaciones para la web offline.'}</p>
        : <div className="divide-y divide-slate-100">{grants.map(grant => {
          const modules = normalizeOfflineV5Modules(grant.modules || [])
          return <article key={grant.grant_id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-slate-900">{grant.account_name}</strong><span className="text-sm text-slate-600">{grant.display_user || grant.username || grant.user_id}</span><span className={`rounded-full px-2 py-1 text-xs ${grant.state === 'revoked' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{stateLabel(grant.state)}</span></div><p className="mt-1 break-all text-xs text-slate-400">Perfil {grant.browser_profile_id}</p><div className="mt-2 flex flex-wrap gap-1">{modules.map(module => <span key={module} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">{offlineModulesV5.find(item => item.id === module)?.label}</span>)}</div></div>
            <div className="flex flex-wrap gap-2"><button type="button" className={secondary} disabled={busy || loading || grant.state === 'revoked'} onClick={() => { setEditing(grant); setEditingModules(modules); setError('') }}><SlidersHorizontal className="h-4 w-4" />Editar módulos</button><button type="button" className={secondary} disabled={busy || loading || grant.state === 'revoked'} onClick={() => { setRevoking(grant); setConfirmed(false); setError('') }}><ShieldAlert className="h-4 w-4" />Revocar</button></div>
          </article>
        })}</div>}
    </section>

    <AdminFormDialog open={Boolean(review)} title="Aprobar acceso offline" description={`${review?.username || ''} · ${review?.display_name || 'Este perfil del navegador'}`} icon={ShieldCheck} size="user" busy={busy} onClose={() => { if (!busy) { setReview(null); setError('') } }} footer={<button type="button" className={primary} disabled={busy || !drafts.length} onClick={approve}>{busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}Aprobar cuentas seleccionadas</button>}>
      <div className="space-y-4"><p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">Selecciona las cuentas y módulos que podrán prepararse. Dentro de cada recurso elegido, los cambios de datos siguen sujetos a los permisos reales del usuario; los archivos, fotos y adjuntos requieren conexión.</p>{modalError}{!review?.accounts?.length ? <p className="text-sm text-amber-800">No hay cuentas activas elegibles para este usuario.</p> : review.accounts.map(account => { const draft = drafts.find(item => item.account_id === account.id); return <fieldset key={account.id} className="rounded-xl border border-slate-200 p-3"><legend className="px-1 text-sm font-semibold text-slate-900">{account.name}</legend><label className="flex min-h-11 items-center gap-2 text-sm text-slate-700"><input type="checkbox" disabled={busy || (!draft && drafts.length >= 5)} checked={Boolean(draft)} onChange={event => setDrafts(current => event.target.checked ? [...current, { account_id: account.id, modules: [] }] : current.filter(item => item.account_id !== account.id))} className="h-4 w-4 accent-emerald-600" />Autorizar esta cuenta</label>{draft && <div className="grid gap-2 sm:grid-cols-2">{offlineModulesV5.map(module => <label key={module.id} className="flex min-h-14 items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700"><input type="checkbox" className="mt-1 h-4 w-4 accent-emerald-600" disabled={busy} checked={draft.modules.includes(module.id)} onChange={() => setDrafts(current => current.map(item => item.account_id === account.id ? { ...item, modules: toggleOfflineV5Module(item.modules, module.id) } : item))} /><span><strong className="block text-slate-800">{module.label}</strong><span className="text-xs text-slate-500">{module.detail}</span></span></label>)}</div>}</fieldset>})}</div>
    </AdminFormDialog>

    <AdminFormDialog open={Boolean(editing)} title="Editar módulos offline" description={`${editing?.account_name || ''} · ${editing?.display_user || editing?.username || ''}`} icon={SlidersHorizontal} size="user" busy={busy} onClose={() => { if (!busy) { setEditing(null); setError('') } }} footer={<button type="button" className={primary} disabled={busy || editingModules.length === 0} onClick={saveModules}>{busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}Guardar autorización</button>}>
      <div className="space-y-3"><p className="text-sm text-slate-600">Este cambio no selecciona recursos ni amplía permisos. El usuario deberá actualizar su copia para aplicar el nuevo alcance.</p>{offlineModulesV5.map(module => <label key={module.id} className="flex min-h-14 items-start gap-3 rounded-xl border border-slate-200 p-3"><input type="checkbox" className="mt-1 h-4 w-4 accent-emerald-600" disabled={busy} checked={editingModules.includes(module.id)} onChange={() => setEditingModules(current => toggleOfflineV5Module(current, module.id))} /><span><strong className="block text-sm text-slate-800">{module.label}</strong><span className="text-xs text-slate-500">{module.detail}</span></span></label>)}{modalError}</div>
    </AdminFormDialog>

    <AdminFormDialog open={Boolean(rejecting)} title="Rechazar solicitud offline" description={rejecting?.username || rejecting?.user_id || ''} icon={ShieldAlert} size="user" busy={busy} onClose={() => { if (!busy) { setRejecting(null); setError('') } }} footer={<button type="button" className="min-h-11 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => rejecting && void mutate(() => rejectRequestV5(rejecting.id))}>Confirmar rechazo</button>}><p className="text-sm text-slate-600">Esta solicitud no podrá preparar datos offline. Su sesión online no cambia.</p>{modalError}</AdminFormDialog>

    <AdminFormDialog open={Boolean(revoking)} title="Revocar autorización exacta" description={`${revoking?.account_name || ''} · ${revoking?.display_user || revoking?.username || ''}`} icon={ShieldAlert} size="user" busy={busy} onClose={() => { if (!busy) { setRevoking(null); setError('') } }} footer={<button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || !confirmed} onClick={() => revoking && void mutate(() => revokeOfflineV5GrantAndLocalCopy(revoking.grant_id))}>{busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}Confirmar revocación</button>}>
      <div className="space-y-3"><p className="text-sm text-slate-600">Se revocará únicamente esta combinación de perfil de navegador, usuario y cuenta. No afectará otras autorizaciones.</p><p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">La copia de este mismo perfil se borrará inmediatamente y dejará de aparecer en el inicio de sesión. Si otro equipo está totalmente desconectado, aplicará la revocación al reconectarse o al vencer su autorización, como máximo en 24 horas.</p><label className="flex items-start gap-2 text-sm text-slate-700"><input type="checkbox" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1" />He revisado la identidad exacta y confirmo la revocación.</label>{modalError}</div>
    </AdminFormDialog>
  </section>
}
