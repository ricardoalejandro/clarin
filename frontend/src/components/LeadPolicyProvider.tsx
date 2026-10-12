'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { subscribeWebSocket } from '@/lib/api'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import { parseLeadPolicy, reconcileLeadPolicy, type LeadPolicy } from '@/lib/leadPolicy'

export interface LeadPolicyState {
  policy: LeadPolicy | null
  ready: boolean
  leadsEnabled: boolean
  automationEnabled: boolean
  error: string
  refresh: () => void
}

// Isolated legacy surfaces/tests can render without the dashboard. Production
// always supplies an account-scoped value and never enables unknown policy.
const LeadPolicyContext = createContext<LeadPolicyState>({ policy: null, ready: true, leadsEnabled: true, automationEnabled: true, error: '', refresh: () => {} })
export const LeadPolicyProvider = LeadPolicyContext.Provider
export function useLeadPolicy() { return useContext(LeadPolicyContext) }

export function useAccountLeadPolicy(accountId?: string, offline = false): LeadPolicyState {
  const authScope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  const scope = `${authScope}:${accountId || ''}:${offline}`
  const [snapshot, setSnapshot] = useState<{ scope: string; policy: LeadPolicy | null; error: string }>({ scope: '', policy: null, error: '' })
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  const generation = useRef(0)

  useEffect(() => {
    const requestGeneration = ++generation.current
    const controller = new AbortController()
    if (!accountId || offline || isAuthIdentityChanging(authScope)) return () => controller.abort()
    const accept = (raw: unknown) => {
      const policy = parseLeadPolicy(raw)
      if (!policy || (policy.account_id && policy.account_id !== accountId) || generation.current !== requestGeneration || controller.signal.aborted || getAuthScope() !== authScope || isAuthIdentityChanging()) return false
      setSnapshot(current => ({ scope, policy: reconcileLeadPolicy(current.scope === scope ? current.policy : null, policy, accountId), error: '' }))
      return true
    }
    let activeLoad: AbortController | null = null
    let loadVersion = 0
    const load = async () => {
      activeLoad?.abort()
      const loadController = new AbortController()
      activeLoad = loadController
      const currentLoad = ++loadVersion
      try {
        const response = await fetch('/api/settings/lead-policy', { credentials: 'include', cache: 'no-store', signal: loadController.signal })
        const data = await response.json()
        if (loadController.signal.aborted || currentLoad !== loadVersion) return
        if (!response.ok || !data.success || !accept(data.policy)) throw new Error('policy_unavailable')
      } catch {
        if (!controller.signal.aborted && !loadController.signal.aborted && currentLoad === loadVersion && generation.current === requestGeneration && getAuthScope() === authScope && !isAuthIdentityChanging()) {
          setSnapshot(current => ({ scope, policy: current.scope === scope ? current.policy : null, error: 'No pudimos verificar la configuración de Leads. Vuelve a intentarlo.' }))
        }
      }
    }
    void load()
    const unsubscribe = subscribeWebSocket((event: any) => {
      if ((event.type || event.event) !== 'account_capabilities_changed') return
      const data = event.data || event.payload || event
      if (data.account_id && data.account_id !== accountId) return
      if (!accept(data.policy || data)) refresh()
    })
    const onFocus = () => { void load() }
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onFocus)
    return () => { controller.abort(); activeLoad?.abort(); unsubscribe(); window.removeEventListener('focus', onFocus); window.removeEventListener('online', onFocus) }
  }, [accountId, authScope, offline, refresh, revision, scope])

  const current = snapshot.scope === scope ? snapshot : null
  const policy = offline || isAuthIdentityChanging(authScope) ? null : current?.policy || null
  return { policy, ready: offline || Boolean(policy), leadsEnabled: Boolean(policy?.leads_enabled), automationEnabled: Boolean(policy?.leads_enabled && policy.lead_automation_enabled), error: current?.error || '', refresh }
}

export function LeadModuleUnavailable({ state }: { state: LeadPolicyState }) {
  return <section role="status" className="m-auto max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-center">
    <h1 className="text-lg font-semibold text-slate-800">{state.error ? 'Configuración pendiente' : state.ready ? 'Leads está desactivado en esta cuenta' : 'Comprobando disponibilidad…'}</h1>
    <p className="mt-2 text-sm text-slate-500">{state.error || (state.ready ? 'Tus datos se conservan. La administración global puede habilitar el módulo cuando lo necesites.' : 'Estamos consultando la configuración de la cuenta.')}</p>
    {state.error && <button type="button" onClick={state.refresh} className="mt-4 min-h-11 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white">Reintentar</button>}
  </section>
}
