'use client'

import { useEffect, useRef, useState } from 'react'
import { CloudOff, Loader2 } from 'lucide-react'
import { probeAvailabilityV4 } from './availability'
import { storeEntryIdentityV4 } from './entryIdentity'
import { isOfflinePathSupported } from '@/offline-v3/navigation'
import { setOfflineV4Mode } from '@/lib/offlineV4ServiceWorker'

export default function OfflineConnectionBannerV4({ userId, accountId }: { userId: string; accountId: string }) {
  const [available, setAvailable] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)

  useEffect(() => {
    const epoch = ++generation.current
    const controller = new AbortController()
    let running = false
    setAvailable(false); setWaiting(false); setError(''); setBusy(false)
    const probe = async () => {
      if (running) return
      running = true
      try {
        const { hasPreparedCopy } = await import('@/offline-v4/client')
        if (!await hasPreparedCopy(userId, accountId)) { if (generation.current === epoch) setAvailable(false); return }
        const remote = await probeAvailabilityV4(controller.signal)
        if (controller.signal.aborted || generation.current !== epoch) return
        setAvailable(remote.state === 'infrastructure_unavailable')
        if (remote.state === 'available') setWaiting(false)
      } catch { if (!controller.signal.aborted && generation.current === epoch) setAvailable(false) } finally { running = false }
    }
    void probe()
    const timer = window.setInterval(() => void probe(), 15_000)
    window.addEventListener('online', probe); window.addEventListener('offline', probe)
    return () => { ++generation.current; controller.abort(); window.clearInterval(timer); window.removeEventListener('online', probe); window.removeEventListener('offline', probe) }
  }, [userId, accountId])

  async function enter() {
    if (busy) return
    if (!window.confirm('Se abrirá tu copia offline en esta pestaña. Los borradores sin guardar y las solicitudes online sin confirmación no se trasladan ni se reenvían automáticamente. ¿Deseas continuar?')) return
    const epoch = generation.current
    setBusy(true); setError('')
    try {
      const { hasPreparedCopy } = await import('@/offline-v4/client')
      if (!await hasPreparedCopy(userId, accountId)) throw new Error('Esta cuenta ya no dispone de una copia local preparada.')
      if (epoch !== generation.current) return
      storeEntryIdentityV4(window.sessionStorage, { user_id: userId, account_id: accountId })
      if (!await setOfflineV4Mode('offline')) throw new Error('No se pudo abrir el modo offline de forma segura.')
      window.location.assign(isOfflinePathSupported(window.location.pathname) ? window.location.pathname : '/dashboard')
    } catch (entryError) { if (epoch === generation.current) { setError((entryError as Error).message); setBusy(false) } }
  }

  if (!available) return null
  return <aside role="status" className="z-10 shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950" aria-label="Conexión con Clarin no disponible"><div className="flex flex-wrap items-center gap-3"><CloudOff className="h-5 w-5 shrink-0" /><span className="min-w-0 flex-1">{waiting ? 'Esperando a que Clarin vuelva a responder. Tu copia offline sigue disponible si la necesitas.' : 'Clarin o la protección de acceso no están respondiendo. Puedes esperar o continuar con la copia offline de esta cuenta.'}</span><button type="button" disabled={busy} onClick={() => void enter()} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-slate-900 px-3 font-semibold text-white disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Seguir sin conexión</button>{!waiting && <button type="button" disabled={busy} onClick={() => setWaiting(true)} className="min-h-11 rounded-lg border border-amber-200 bg-white px-3">Esperar</button>}</div>{error && <p role="alert" className="mt-2 text-red-700">{error}</p>}</aside>
}
