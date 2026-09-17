'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, Laptop, Loader2, RefreshCw, ShieldAlert, Trash2, WifiOff, X } from 'lucide-react'
import { AdminFormDialog } from './AdminFormDialog'

type Account = { id: string; name: string; is_active: boolean }
type User = { id: string; username: string; display_name: string; is_active: boolean; is_super_admin: boolean; accounts?: { account_id: string }[] }
export type OfflineGrantDraft = { accountId: string; modules: string[] }
type TerminalState = 'pending' | 'requested' | 'approved' | 'active' | 'rejected' | 'revoked'
export type BitLockerStatus = 'enabled' | 'disabled' | 'unknown'
export type WindowsHelloStatus = 'configured' | 'not_configured' | 'unknown'
export type Terminal = {
  id: string
  user_id: string
  user_display_name?: string
  display_name: string
  state: TerminalState
  client_version?: string
	bitlocker_status: BitLockerStatus
	windows_hello_status: WindowsHelloStatus
	posture_reported_at?: string
  requested_at?: string
  approved_at?: string
  last_sync_at?: string
  wipe_acknowledged_at?: string
  grants?: { id: string; account_id: string; account_name?: string; modules: string[]; state: string }[]
}

const modules = [
  { id: 'whiteboards', label: 'Pizarra', detail: 'Solo lectura' },
  { id: 'tasks', label: 'Tareas', detail: 'Leer, crear y completar' },
  { id: 'contacts', label: 'Contactos', detail: 'Solo lectura' },
  { id: 'programs', label: 'Programas', detail: 'Solo lectura' },
]

const stateLabels: Record<TerminalState, string> = {
  pending: 'Pendiente (flujo anterior)', requested: 'Solicitada', approved: 'Aprobada · esperando equipo', active: 'Activa', rejected: 'Rechazada', revoked: 'Revocada',
}

export function validateOfflineTerminalDraft(name: string, userId: string, grants: OfflineGrantDraft[]) {
  if (!name.trim() || !userId) return 'Indica el equipo y el usuario autorizado.'
  if (grants.length === 0 || grants.some((grant) => !grant.accountId || grant.modules.length === 0)) return 'Cada cuenta necesita al menos un módulo autorizado.'
  if (new Set(grants.map((grant) => grant.accountId)).size !== grants.length) return 'No repitas la misma cuenta.'
  return ''
}

export function offlinePostureRequiresRiskAcknowledgement(terminal: Pick<Terminal, 'bitlocker_status' | 'windows_hello_status'>) {
	return terminal.bitlocker_status !== 'enabled' || terminal.windows_hello_status !== 'configured'
}

export function offlinePostureLabel(kind: 'bitlocker' | 'windows_hello', status: string) {
	if (kind === 'bitlocker') {
		if (status === 'enabled') return 'BitLocker activo'
		if (status === 'disabled') return 'BitLocker desactivado'
		return 'BitLocker desconocido'
	}
	if (status === 'configured') return 'Windows Hello configurado'
	if (status === 'not_configured') return 'Windows Hello no configurado'
	return 'Windows Hello desconocido'
}

export function buildOfflineApprovalPayload(grants: OfflineGrantDraft[], riskAcknowledged: boolean) {
	return {
		grants: grants.map((grant) => ({ account_id: grant.accountId, modules: grant.modules })),
		acknowledge_device_risk: riskAcknowledged,
	}
}

export function offlineTerminalGrants(terminal: Pick<Terminal, 'grants'>) {
	return terminal.grants || []
}

export function defaultOfflineApproval(user: User, accounts: Account[]): OfflineGrantDraft[] {
  const allowed = new Set((user.accounts || []).map((item) => item.account_id))
  const first = accounts.find((account) => account.is_active && allowed.has(account.id))
  return first ? [{ accountId: first.id, modules: modules.map((item) => item.id) }] : [{ accountId: '', modules: [] }]
}

export function OfflineTerminalsPanel({ accounts, users }: { accounts: Account[]; users: User[] }) {
  const [terminals, setTerminals] = useState<Terminal[]>([])
  const [enabled, setEnabled] = useState(false)
  const [installerAvailable, setInstallerAvailable] = useState(false)
  const [installerFilename, setInstallerFilename] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [reviewing, setReviewing] = useState<Terminal | null>(null)
  const [grants, setGrants] = useState<OfflineGrantDraft[]>([{ accountId: '', modules: [] }])
	const [riskAcknowledged, setRiskAcknowledged] = useState(false)
  const [error, setError] = useState('')
  const headers = useMemo(() => ({ Authorization: `Bearer ${typeof window === 'undefined' ? '' : localStorage.getItem('token') || ''}`, 'Content-Type': 'application/json' }), [])

  async function load() {
    setLoading(true)
    try {
      const response = await fetch('/api/admin/offline-terminals/', { headers })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudieron consultar las terminales offline.')
      setTerminals(data.terminals || [])
      setEnabled(Boolean(data.enabled))
      setInstallerAvailable(Boolean(data.installer_available))
      setInstallerFilename(data.installer_filename || '')
      setError('')
    } catch (requestError) {
      setError((requestError as Error).message || 'No se pudo conectar con el servidor.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  function beginReview(terminal: Terminal) {
    const user = users.find((item) => item.id === terminal.user_id)
    setReviewing(terminal)
    setGrants(user ? defaultOfflineApproval(user, accounts) : [{ accountId: '', modules: [] }])
		setRiskAcknowledged(false)
    setError('')
  }

  function toggleModule(index: number, module: string) {
    setGrants((current) => current.map((grant, i) => i !== index ? grant : { ...grant, modules: grant.modules.includes(module) ? grant.modules.filter((item) => item !== module) : [...grant.modules, module] }))
  }

  function accountOptions(index: number) {
    const user = users.find((item) => item.id === reviewing?.user_id)
    const allowed = new Set((user?.accounts || []).map((item) => item.account_id))
    return accounts.filter((account) => account.is_active && allowed.has(account.id) && !grants.some((grant, grantIndex) => grantIndex !== index && grant.accountId === account.id))
  }

  async function approve() {
    if (!reviewing || busy) return
    const validation = validateOfflineTerminalDraft(reviewing.display_name, reviewing.user_id, grants)
    if (validation) return setError(validation)
		if (offlinePostureRequiresRiskAcknowledgement(reviewing) && !riskAcknowledged) return setError('Confirma que autorizas el equipo sin todas las protecciones recomendadas.')
    setBusy(`approve:${reviewing.id}`)
    try {
		const response = await fetch(`/api/admin/offline-terminals/${reviewing.id}/approve`, { method: 'POST', headers, body: JSON.stringify(buildOfflineApprovalPayload(grants, riskAcknowledged)) })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo aprobar la terminal.')
		setReviewing(null)
		setRiskAcknowledged(false)
      await load()
    } catch (requestError) {
      setError((requestError as Error).message || 'No se pudo conectar con el servidor.')
    } finally {
      setBusy('')
    }
  }

  async function reject(terminal: Terminal) {
    if (!confirm(`¿Rechazar la solicitud de “${terminal.display_name}”?`)) return
    setBusy(`reject:${terminal.id}`)
    try {
      const response = await fetch(`/api/admin/offline-terminals/${terminal.id}/reject`, { method: 'POST', headers })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo rechazar la solicitud.')
      setReviewing(null)
      await load()
    } catch (requestError) {
      setError((requestError as Error).message || 'No se pudo conectar con el servidor.')
    } finally {
      setBusy('')
    }
  }

  async function revoke(terminal: Terminal) {
    if (!confirm(`¿Revocar “${terminal.display_name}”? El equipo recibirá una orden firmada de borrado.`)) return
    setBusy(`revoke:${terminal.id}`)
    try {
      const response = await fetch(`/api/admin/offline-terminals/${terminal.id}/revoke`, { method: 'POST', headers })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data.error || 'No se pudo revocar la terminal.')
      await load()
    } catch (requestError) {
      setError((requestError as Error).message || 'No se pudo conectar con el servidor.')
    } finally {
      setBusy('')
    }
  }

  return <div className="space-y-5 p-5">
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div><div className="flex items-center gap-2 font-semibold text-slate-900"><Laptop className="h-4 w-4 text-emerald-600" />Terminales offline Windows</div><p className="mt-1 text-sm text-slate-500">El usuario solicita acceso desde su PC. Aquí autorizas sus cuentas y módulos; no tienes que pedirle IDs, claves ni certificados.</p></div>
      <button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
    </div>

    {!enabled && <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" /><div><div className="font-medium">Activación cerrada</div><div className="mt-1 text-amber-800">La infraestructura está instalada, pero las banderas del piloto siguen apagadas.</div></div></div>}
    {enabled && !installerAvailable && <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" /><div><div className="font-medium">Falta publicar el instalador interno</div><div className="mt-1 text-amber-800">No se aceptan solicitudes hasta que Clarín publique el ejecutable y verifique su SHA-256. No se requiere certificado de firma.</div></div></div>}
    {enabled && installerAvailable && <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">Instalador interno publicado: <span className="font-medium">{installerFilename}</span>.</div>}
    {error && !reviewing && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

    <div className="overflow-hidden rounded-xl border border-slate-200">
      {loading ? <div className="flex items-center justify-center p-12 text-slate-400"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Cargando terminales…</div> : terminals.length === 0 ? <div className="p-12 text-center text-sm text-slate-500"><WifiOff className="mx-auto mb-3 h-8 w-8 text-slate-300" />Todavía no hay solicitudes. El usuario inicia el alta desde Configuración → Offline en la app de Windows.</div> : <div className="divide-y divide-slate-100">{terminals.map((terminal) => {
        const terminalBusy = busy.endsWith(terminal.id)
        const tone = terminal.state === 'active' ? 'bg-emerald-50 text-emerald-700' : terminal.state === 'requested' ? 'bg-amber-50 text-amber-800' : terminal.state === 'approved' ? 'bg-sky-50 text-sky-700' : 'bg-slate-100 text-slate-600'
		const postureSecure = !offlinePostureRequiresRiskAcknowledgement(terminal)
		const postureTone = postureSecure ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'
		return <div key={terminal.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-medium text-slate-900">{terminal.display_name}</span><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{stateLabels[terminal.state]}</span></div><div className="mt-1 text-xs text-slate-500">{terminal.user_display_name || terminal.user_id}{terminal.client_version ? ` · cliente v${terminal.client_version}` : ''}{terminal.last_sync_at ? ` · sincronizó ${new Date(terminal.last_sync_at).toLocaleString('es-PE')}` : ''}</div><div className="mt-2 flex flex-wrap gap-1.5"><span className={`rounded-md px-2 py-1 text-xs font-medium ${postureTone}`}>{offlinePostureLabel('bitlocker', terminal.bitlocker_status)}</span><span className={`rounded-md px-2 py-1 text-xs font-medium ${postureTone}`}>{offlinePostureLabel('windows_hello', terminal.windows_hello_status)}</span>{terminal.posture_reported_at && <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-500">Comprobado {new Date(terminal.posture_reported_at).toLocaleString('es-PE')}</span>}</div><div className="mt-2 flex flex-wrap gap-1.5">{offlineTerminalGrants(terminal).map((grant) => <span key={grant.id} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">{grant.account_name || grant.account_id}: {grant.modules.map((module) => modules.find((item) => item.id === module)?.label || module).join(', ')}</span>)}</div></div><div className="flex flex-wrap gap-2 self-start">{terminal.state === 'requested' && <><button type="button" disabled={!enabled || !installerAvailable || Boolean(busy)} onClick={() => beginReview(terminal)} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white disabled:opacity-45"><Check className="h-4 w-4" />Revisar y aprobar</button><button type="button" disabled={Boolean(busy)} onClick={() => void reject(terminal)} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 disabled:opacity-45"><X className="h-4 w-4" />Rechazar</button></>}{(terminal.state === 'approved' || terminal.state === 'active' || terminal.state === 'pending') && <button type="button" disabled={terminalBusy || Boolean(busy && !terminalBusy)} onClick={() => void revoke(terminal)} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-red-200 px-3 text-sm text-red-700 disabled:opacity-45">{terminalBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Revocar</button>}</div></div>
      })}</div>}
    </div>

	<AdminFormDialog open={Boolean(reviewing)} size="user" title="Aprobar acceso offline" description={reviewing ? `${reviewing.user_display_name || reviewing.user_id} · ${reviewing.display_name}` : ''} icon={Laptop} busy={busy.startsWith('approve:')} onClose={() => { if (!busy) { setReviewing(null); setRiskAcknowledged(false); setError('') } }} footer={<><button type="button" disabled={Boolean(busy)} onClick={() => reviewing && void reject(reviewing)} className="min-h-11 rounded-lg border border-red-200 px-4 text-sm text-red-700 disabled:opacity-50">Rechazar</button><button type="button" disabled={Boolean(busy) || Boolean(reviewing && offlinePostureRequiresRiskAcknowledgement(reviewing) && !riskAcknowledged)} onClick={() => void approve()} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white disabled:opacity-50">{busy.startsWith('approve:') && <Loader2 className="h-4 w-4 animate-spin" />}Aprobar terminal</button></>}>
		<div className="space-y-4"><div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">Límite fijo: 24 horas sin conexión, 5 GB locales y hasta 20 recursos por cuenta. Las claves privadas permanecen en Windows.</div>{reviewing && <div className={`rounded-xl border p-4 text-sm ${offlinePostureRequiresRiskAcknowledgement(reviewing) ? 'border-amber-200 bg-amber-50 text-amber-950' : 'border-emerald-200 bg-emerald-50 text-emerald-950'}`}><div className="font-medium">Protección informada por el equipo</div><div className="mt-2 flex flex-wrap gap-2"><span className="rounded-md bg-white/75 px-2 py-1 text-xs">{offlinePostureLabel('bitlocker', reviewing.bitlocker_status)}</span><span className="rounded-md bg-white/75 px-2 py-1 text-xs">{offlinePostureLabel('windows_hello', reviewing.windows_hello_status)}</span></div>{offlinePostureRequiresRiskAcknowledgement(reviewing) && <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-amber-300 bg-white/70 p-3"><input type="checkbox" checked={riskAcknowledged} onChange={(event) => { setRiskAcknowledged(event.target.checked); setError('') }} className="mt-0.5 h-5 w-5 rounded border-amber-400 text-emerald-600" /><span>Confirmo que autorizo este equipo sin BitLocker o Windows Hello. Los datos seguirán protegidos por la cuenta de Windows y los límites offline.</span></label>}</div>}{grants.map((grant, index) => <div key={index} className="rounded-xl border border-slate-200 p-4"><div className="flex items-center gap-2"><select value={grant.accountId} onChange={(event) => setGrants((current) => current.map((item, i) => i === index ? { accountId: event.target.value, modules: [] } : item))} className="min-h-11 min-w-0 flex-1 rounded-lg border border-slate-200 px-3 text-sm"><option value="">Seleccionar cuenta…</option>{accountOptions(index).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select>{grants.length > 1 && <button type="button" onClick={() => setGrants((current) => current.filter((_, i) => i !== index))} className="min-h-11 min-w-11 rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Quitar cuenta"><Trash2 className="h-4 w-4" /></button>}</div><div className="mt-3 grid gap-2 sm:grid-cols-2">{modules.map((module) => <button type="button" key={module.id} disabled={!grant.accountId} onClick={() => toggleModule(index, module.id)} className={`flex min-h-14 items-center gap-2 rounded-lg border px-3 text-left text-sm ${grant.modules.includes(module.id) ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-600 disabled:opacity-40'}`}>{grant.modules.includes(module.id) && <Check className="h-4 w-4 shrink-0" />}<span><span className="block font-medium">{module.label}</span><span className="block text-xs opacity-75">{module.detail}</span></span></button>)}</div></div>)}<button type="button" disabled={grants.length >= 5 || accountOptions(grants.length).length === 0} onClick={() => setGrants((current) => [...current, { accountId: '', modules: [] }])} className="min-h-11 text-sm font-medium text-emerald-700 disabled:opacity-40">Añadir otra cuenta</button>{error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}</div>
    </AdminFormDialog>
  </div>
}
