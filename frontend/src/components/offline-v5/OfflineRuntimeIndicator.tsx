'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2, CloudOff, Loader2, RefreshCw, Wifi, X } from 'lucide-react'
import { useClarinRuntime } from './ClarinRuntimeProvider'
import { offlineRuntimeIndicatorState } from './runtimeState'

const tones = {
  emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  amber: 'border-amber-200 bg-amber-50 text-amber-900',
  rose: 'border-rose-200 bg-rose-50 text-rose-800',
  slate: 'border-slate-200 bg-slate-50 text-slate-700',
} as const

export default function OfflineRuntimeIndicator() {
  const router = useRouter()
  const { snapshot, sync, acknowledgeConflicts, beginOnlineReauthentication, notice, clearNotice } = useClarinRuntime()
  const [switchingOnline, setSwitchingOnline] = useState(false)
  const state = offlineRuntimeIndicatorState(snapshot)
  if (!state && !notice) return null

  const goOnline = async () => {
    if (switchingOnline) return
    setSwitchingOnline(true)
    const ready = await beginOnlineReauthentication()
    if (ready) router.push('/login?offline_reauth=1')
    else setSwitchingOnline(false)
  }

  const Icon = snapshot.mode === 'syncing'
    ? Loader2
    : snapshot.mode === 'conflict' || snapshot.conflictCount > 0
      ? AlertTriangle
      : snapshot.mode === 'offline'
        ? CloudOff
        : CheckCircle2

  return <aside
    data-testid="offline-v5-runtime-indicator"
    data-offline-mode={snapshot.mode}
    role={notice ? 'alert' : 'status'}
    aria-live="polite"
    className={`flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5 text-xs sm:px-4 ${tones[state?.tone || 'rose']}`}
  >
    <Icon aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${snapshot.mode === 'syncing' ? 'animate-spin motion-reduce:animate-none' : ''}`} />
    {state && <><strong className="font-bold">{state.label}</strong><span className="min-w-0 flex-1 truncate">{state.detail}</span></>}
    {notice && <span className="min-w-[220px] flex-1 font-medium">{notice}</span>}
    {snapshot.conflictCount > 0 && <button
      type="button"
      onClick={() => void acknowledgeConflicts()}
      className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-current/15 bg-white/70 px-2.5 font-bold outline-none transition hover:bg-white focus-visible:ring-2 focus-visible:ring-current/30"
    >Aceptar versión del servidor</button>}
    {state?.canSync && snapshot.conflictCount === 0 && <button
      type="button"
      onClick={() => void sync()}
      className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-current/15 bg-white/70 px-2.5 font-bold outline-none transition hover:bg-white focus-visible:ring-2 focus-visible:ring-current/30"
      aria-label="Sincronizar cambios offline"
    ><RefreshCw className="h-3.5 w-3.5" />Sincronizar</button>}
    {snapshot.active && <button
      type="button"
      disabled={switchingOnline}
      onClick={() => void goOnline()}
      className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-current/15 bg-white/70 px-2.5 font-bold outline-none transition hover:bg-white focus-visible:ring-2 focus-visible:ring-current/30 disabled:cursor-wait disabled:opacity-60"
      title="Comprobar la conexión y autenticar la misma identidad antes de salir del modo offline"
    >{switchingOnline ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <Wifi className="h-3.5 w-3.5" />}Volver online</button>}
    {notice && <button type="button" onClick={clearNotice} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-white/70" aria-label="Cerrar aviso"><X className="h-3.5 w-3.5" /></button>}
  </aside>
}
