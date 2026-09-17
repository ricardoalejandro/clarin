'use client'

import { useEffect, useRef, useState } from 'react'
import { CloudOff, Loader2, LockKeyhole, X } from 'lucide-react'
import {
  dismissOfflineV5FallbackOffer,
  enterOfflineV5,
  hasPreparedOfflineV5Copy,
  refreshOfflineV5FallbackOffer,
} from '@/lib/offlineV5Runtime'
import { useClarinRuntime } from './ClarinRuntimeProvider'
import { offlineAvailabilityV5, offlineV5FailureAllowsFallback } from './online'

export interface OfflineConnectionBannerV5Props {
  userId: string
  accountId: string
  username: string
}

export default function OfflineConnectionBannerV5({ userId, accountId, username }: OfflineConnectionBannerV5Props) {
  const { snapshot } = useClarinRuntime()
  const [available, setAvailable] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [unlockOpen, setUnlockOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)

  useEffect(() => {
    if (snapshot.active && snapshot.mode !== 'online') {
      setAvailable(false)
      setUnlockOpen(false)
      setPassword('')
      return
    }
    const epoch = ++generation.current
    setAvailable(false)
    setWaiting(false)
    setUnlockOpen(false)
    setError('')
    setBusy(false)
    let probeInFlight = false
    let activeProbe: AbortController | null = null

    const probe = async () => {
      if (probeInFlight) return
      probeInFlight = true
      const controller = new AbortController()
      activeProbe = controller
      let timedOut = false
      const timeout = window.setTimeout(() => {
        timedOut = true
        controller.abort()
      }, 8_000)
      try {
        const [prepared, offeredByRuntime, apiUnavailable] = await Promise.all([
          hasPreparedOfflineV5Copy(userId, accountId),
          refreshOfflineV5FallbackOffer(),
          offlineAvailabilityV5(controller.signal).then(() => false).catch(error => timedOut || offlineV5FailureAllowsFallback(error)),
        ])
        if (generation.current !== epoch) return
        const outageDetected = offeredByRuntime || apiUnavailable || navigator.onLine === false
        setAvailable(prepared && outageDetected)
        if (!outageDetected) {
          setWaiting(false)
          setUnlockOpen(false)
          setPassword('')
        }
      } catch {
        if (generation.current === epoch) setAvailable(false)
      } finally {
        window.clearTimeout(timeout)
        if (activeProbe === controller) activeProbe = null
        probeInFlight = false
      }
    }

    void probe()
    const timer = window.setInterval(() => { void probe() }, 5_000)
    const onConnectivityChange = () => { void probe() }
    window.addEventListener('online', onConnectivityChange)
    window.addEventListener('offline', onConnectivityChange)
    return () => {
      ++generation.current
      activeProbe?.abort()
      window.clearInterval(timer)
      window.removeEventListener('online', onConnectivityChange)
      window.removeEventListener('offline', onConnectivityChange)
    }
  }, [accountId, snapshot.active, userId])

  async function enter() {
    if (busy || !password) return
    const epoch = generation.current
    const secret = password
    setPassword('')
    setBusy(true)
    setError('')
    try {
      if (!await hasPreparedOfflineV5Copy(userId, accountId)) throw new Error('Esta cuenta ya no dispone de una copia local preparada.')
      if (epoch !== generation.current) return
      await enterOfflineV5({ username, password: secret, userId, accountId })
      if (epoch === generation.current) {
        setAvailable(false)
        setUnlockOpen(false)
      }
    } catch (entryError) {
      if (epoch === generation.current) {
        setError(entryError instanceof Error ? entryError.message : 'No se pudo abrir la copia offline.')
        setBusy(false)
      }
    }
  }

  if (!available) return null
  return <aside
    role="status"
    className="z-10 shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 sm:px-4"
    aria-label="Conexión con Clarin no disponible"
  >
    <div className="flex flex-wrap items-center gap-2.5">
      <CloudOff className="h-4 w-4 shrink-0" />
      <span className="min-w-[220px] flex-1">
        {waiting
          ? 'Esperando a que Clarin vuelva a responder. Tu copia offline sigue disponible.'
          : 'Clarin o la protección de acceso no están respondiendo. Puedes esperar o continuar aquí con tu copia autorizada.'}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => { setUnlockOpen(true); setWaiting(false); setError('') }}
        className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-slate-900 px-3 font-semibold text-white disabled:opacity-50"
      ><LockKeyhole className="h-4 w-4" />Seguir sin conexión</button>
      {!waiting && <button type="button" disabled={busy} onClick={() => { void dismissOfflineV5FallbackOffer(); setWaiting(true); setUnlockOpen(false); setPassword('') }} className="min-h-10 rounded-lg border border-amber-200 bg-white px-3">Esperar</button>}
    </div>
    {unlockOpen && <form
      className="mt-2 flex flex-col gap-2 rounded-xl border border-amber-200 bg-white/80 p-3 sm:flex-row sm:items-end"
      autoComplete="off"
      onSubmit={event => { event.preventDefault(); void enter() }}
    >
      <label className="min-w-[220px] flex-1 text-xs font-semibold text-slate-700">
        Confirma la contraseña actual de {username}
        <input
          autoFocus
          type="password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          autoComplete="off"
          maxLength={1024}
          data-1p-ignore
          disabled={busy}
          className="mt-1 min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
        />
      </label>
      <button type="submit" disabled={busy || !password} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-bold text-white disabled:opacity-45">
        {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <CloudOff className="h-4 w-4" />}
        Entrar offline
      </button>
      <button type="button" disabled={busy} onClick={() => { setUnlockOpen(false); setPassword(''); setError('') }} className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100" aria-label="Cancelar acceso offline"><X className="h-4 w-4" /></button>
    </form>}
    {error && <p role="alert" className="mt-2 text-sm font-medium text-red-700">{error}</p>}
  </aside>
}
