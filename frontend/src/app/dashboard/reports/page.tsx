'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import WhatsAppGroupCoverageReport from '@/components/reports/WhatsAppGroupCoverageReport'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'

type AccessState = 'loading' | 'allowed' | 'denied' | 'error'

export default function ReportsPage() {
  const scope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  const [snapshot, setSnapshot] = useState<{ scope: string; access: AccessState }>({ scope: '', access: 'loading' })
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setSnapshot({ scope, access: 'loading' })
    if (isAuthIdentityChanging(scope)) return () => controller.abort()
    const accept = (access: AccessState) => {
      if (!controller.signal.aborted && getAuthScope() === scope && !isAuthIdentityChanging()) setSnapshot({ scope, access })
    }
    void (async () => {
      try {
        const token = localStorage.getItem('token')
        const response = await fetch('/api/me', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: 'include', cache: 'no-store', signal: controller.signal,
        })
        if (response.status === 401 || response.status === 403) { accept('denied'); return }
        const data = await response.json()
        if (!response.ok || !data.user) throw new Error('access_unavailable')
        const user = data.user
        const allowed = Boolean(user.is_admin || user.is_super_admin || user.permissions?.includes('*') || user.permissions?.includes('reports'))
        accept(allowed ? 'allowed' : 'denied')
      } catch {
        accept('error')
      }
    })()
    return () => controller.abort()
  }, [scope, retry])

  const access = !isAuthIdentityChanging(scope) && snapshot.scope === scope ? snapshot.access : 'loading'
  if (access === 'allowed') return <WhatsAppGroupCoverageReport />
  if (access === 'loading') return <div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-slate-500"><Loader2 className="h-5 w-5 animate-spin" />Comprobando acceso a Reportería…</div>
  return <main className="flex h-full items-center justify-center bg-slate-50 p-6">
    <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
      <ShieldAlert className="mx-auto h-9 w-9 text-amber-500" />
      <h1 className="mt-4 text-xl font-bold text-slate-800">{access === 'denied' ? 'Acceso restringido' : 'No pudimos comprobar el acceso'}</h1>
      <p className="mt-2 text-sm text-slate-500">{access === 'denied' ? 'Necesitas el permiso de Reportería para consultar esta sección.' : 'Vuelve a intentarlo para abrir el reporte de WhatsApp por grupos.'}</p>
      {access === 'error' && <button type="button" onClick={() => setRetry(value => value + 1)} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700"><RefreshCw className="h-4 w-4" />Reintentar</button>}
    </div>
  </main>
}
