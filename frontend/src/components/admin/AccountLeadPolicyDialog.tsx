'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Handshake, Loader2 } from 'lucide-react'
import { AdminFormDialog } from './AdminFormDialog'
import { parseLeadPolicy, type LeadPolicy } from '@/lib/leadPolicy'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'

export default function AccountLeadPolicyDialog({ account, onClose }: { account: { id: string; name: string } | null; onClose: () => void }) {
  const authScope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  if (!account || isAuthIdentityChanging(authScope)) return null
  return <AccountLeadPolicyForm key={`${authScope}:${account.id}`} account={account} onClose={onClose} authScope={authScope} />
}

function AccountLeadPolicyForm({ account, onClose, authScope }: { account: { id: string; name: string }; onClose: () => void; authScope: string }) {
  const [policy, setPolicy] = useState<LeadPolicy | null>(null)
  const [draft, setDraft] = useState({ leads_enabled: true, lead_automation_enabled: true })
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  const saveInFlight = useRef(false)
  const saveAbort = useRef<AbortController | null>(null)
  const keepEditingRef = useRef<HTMLButtonElement | null>(null)
  const dirty = Boolean(policy && (draft.leads_enabled !== policy.leads_enabled || draft.lead_automation_enabled !== policy.lead_automation_enabled))

  useEffect(() => {
    if (!discard) return
    keepEditingRef.current?.focus()
    keepEditingRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [discard])

  useEffect(() => {
    const current = ++generation.current
    const controller = new AbortController()
    setPolicy(null); setLoading(true); setError(''); setConflict(false); setDiscard(false)
    if (!account) return () => controller.abort()
    void (async () => {
      try {
        const response = await fetch(`/api/admin/accounts/${account.id}/lead-policy`, { credentials: 'include', cache: 'no-store', signal: controller.signal })
        const data = await response.json()
        const loaded = parseLeadPolicy(data.policy)
        if (!response.ok || !data.success || !loaded || loaded.account_id !== account.id) throw new Error(data.error || 'No pudimos consultar la configuración.')
        if (controller.signal.aborted || generation.current !== current || getAuthScope() !== authScope) return
        setPolicy(loaded); setDraft({ leads_enabled: loaded.leads_enabled, lead_automation_enabled: loaded.lead_automation_enabled })
      } catch (cause) {
        if (!controller.signal.aborted && generation.current === current) setError(cause instanceof Error ? cause.message : 'No pudimos consultar la configuración.')
      } finally { if (!controller.signal.aborted && generation.current === current) setLoading(false) }
    })()
    return () => { controller.abort(); saveAbort.current?.abort(); generation.current += 1 }
  }, [account?.id, retry])

  const save = async () => {
    if (!account || !policy || !dirty || conflict || saveInFlight.current || getAuthScope() !== authScope || isAuthIdentityChanging()) return
    const current = generation.current
    saveInFlight.current = true; setBusy(true); setError('')
    const controller = new AbortController()
    saveAbort.current = controller
    try {
      const response = await fetch(`/api/admin/accounts/${account.id}/lead-policy`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...draft, expected_version: policy.leads_policy_version }), signal: controller.signal })
      const data = await response.json()
      if (controller.signal.aborted || current !== generation.current || getAuthScope() !== authScope || isAuthIdentityChanging()) return
      if (response.status === 409) { setConflict(true); setError('La configuración cambió en otra sesión. Actualízala y revisa tus cambios antes de guardar.'); return }
      const saved = parseLeadPolicy(data.policy)
      if (!response.ok || !data.success || !saved || saved.account_id !== account.id || saved.leads_policy_version < policy.leads_policy_version) throw new Error(data.error || 'No pudimos guardar la configuración.')
      setPolicy(saved); onClose()
    } catch (cause) { if (!controller.signal.aborted && current === generation.current && getAuthScope() === authScope) setError(cause instanceof Error ? cause.message : 'No pudimos guardar la configuración.') }
    finally { if (saveAbort.current === controller) { saveInFlight.current = false; saveAbort.current = null; if (!controller.signal.aborted) setBusy(false) } }
  }

  const close = () => { if (!busy) { if (dirty) setDiscard(true); else onClose() } }
  return <AdminFormDialog open={Boolean(account)} size="account" title="Leads de la cuenta" description={account?.name || ''} icon={Handshake} busy={busy} onClose={close} footer={<>
    <button type="button" disabled={busy} onClick={close} className="min-h-11 rounded-xl border border-slate-200 px-4 text-sm text-slate-600">Cancelar</button>
    <button type="button" disabled={busy || loading || !dirty || conflict} onClick={() => void save()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white disabled:opacity-40">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Guardar configuración</button>
  </>}>
    {loading ? <p role="status" className="py-6 text-center text-sm text-slate-500">Cargando configuración…</p> : <div className="space-y-4">
      {error && <div role="alert" className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700"><p>{error}</p>{(!policy || conflict) && <button type="button" onClick={() => setRetry(value => value + 1)} className="mt-2 min-h-11 font-semibold text-emerald-700">Actualizar configuración</button>}</div>}
      {policy && <>
        <PolicySwitch label="Módulo Leads" description="Muestra oportunidades, pipelines y herramientas comerciales en esta cuenta." checked={draft.leads_enabled} disabled={busy} onChange={value => { setDiscard(false); setDraft(current => ({ ...current, leads_enabled: value })) }} />
        <PolicySwitch label="Automatización de Leads" description="Crea oportunidades y ejecuta los flujos comerciales ante actividad nueva." checked={draft.lead_automation_enabled} disabled={busy || !draft.leads_enabled} onChange={value => { setDiscard(false); setDraft(current => ({ ...current, lead_automation_enabled: value })) }} />
        <div role="status" className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-600">
          {!draft.leads_enabled ? 'Leads quedará desactivado. Sus registros y vínculos se conservarán; Contactos, Chats, Programas y Eventos seguirán disponibles.' : !draft.lead_automation_enabled ? 'Leads seguirá disponible para trabajo manual. La creación automática y los flujos comerciales quedarán detenidos.' : 'Leads y sus automatismos estarán disponibles.'}
          <p className="mt-2">Al reactivar se procesará solo actividad nueva. Los pasos pendientes anteriores no se reanudarán. Los mensajes que WhatsApp ya haya aceptado no pueden retirarse.</p>
        </div>
      </>}
      {discard && <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-slate-700"><p>Hay cambios sin guardar.</p><div className="mt-2 flex flex-wrap gap-3"><button ref={keepEditingRef} type="button" onClick={() => setDiscard(false)} className="min-h-11 font-semibold text-slate-700">Seguir editando</button><button type="button" onClick={onClose} className="min-h-11 font-semibold text-amber-800">Descartar cambios</button></div></div>}
    </div>}
  </AdminFormDialog>
}

function PolicySwitch({ label, description, checked, disabled, onChange }: { label: string; description: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className="flex min-h-11 w-full items-center justify-between gap-4 rounded-xl border border-slate-200 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50">
    <span><span className="block text-sm font-semibold text-slate-800">{label}</span><span className="mt-1 block text-xs text-slate-500">{description}</span></span>
    <span aria-hidden="true" className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 ${checked ? 'justify-end bg-emerald-600' : 'justify-start bg-slate-300'}`}><span className="h-5 w-5 rounded-full bg-white shadow-sm" /></span>
  </button>
}
