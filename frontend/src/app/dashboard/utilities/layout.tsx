'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { api, subscribeWebSocket } from '@/lib/api'

export default function UtilitiesLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [attempt, setAttempt] = useState(0)
  const [access, setAccess] = useState<{ path: string; phase: 'allowed' | 'denied' | 'error' } | null>(null)

  useEffect(() => {
    let request: AbortController | undefined
    const check = async () => {
      if (request) return
      const controller = new AbortController()
      request = controller
      try {
        const response = await api('/api/utilities/access', { signal: controller.signal })
        if (controller.signal.aborted) return
        const phase = response.success ? 'allowed' : response.status === 403 ? 'denied' : 'error'
        setAccess({ path: pathname, phase })
      } finally {
        request = undefined
      }
    }

    void check()
    window.addEventListener('focus', check)
    const unsubscribe = subscribeWebSocket(() => {}, undefined, check)
    return () => {
      request?.abort()
      window.removeEventListener('focus', check)
      unsubscribe()
    }
  }, [pathname, attempt])

  if (!access || access.path !== pathname) return <p role="status" className="p-4 text-sm text-slate-600">Verificando acceso a Utilitarios…</p>
  if (access.phase === 'allowed') return children
  return <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5">
    <h1 className="font-semibold text-slate-900">{access.phase === 'denied' ? 'No tienes acceso a Utilitarios' : 'No se pudo verificar el acceso'}</h1>
    <p className="text-sm text-slate-600">{access.phase === 'denied' ? 'El permiso de Utilitarios se asigna por rol en esta cuenta.' : 'Revisa tu conexión y vuelve a intentarlo.'}</p>
    {access.phase === 'error'
      ? <button type="button" onClick={() => { setAccess(null); setAttempt(value => value + 1) }} className="min-h-11 rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white">Reintentar</button>
      : <Link href="/dashboard" className="inline-flex min-h-11 items-center text-sm font-semibold text-emerald-800 underline">Volver al panel</Link>}
  </section>
}
