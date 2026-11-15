'use client'

import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { getOnlineSessionTiming, subscribeOnlineSessionNotice } from '@/lib/api'

/** Read-only server timing; rendering this never refreshes or extends a session. */
export function SessionTimingSummary({ accountId }: { accountId?: string }) {
  const [timing, setTiming] = useState<ReturnType<typeof getOnlineSessionTiming>>(null)
  useEffect(() => {
    const update = () => setTiming(getOnlineSessionTiming())
    update()
    return subscribeOnlineSessionNotice(update)
  }, [])
  if (!timing || accountId && timing.session.account_id !== accountId) return null
  const expires = new Date(timing.deadlineAt)
  return <div aria-label="Duración de tu sesión" className="space-y-1 border-t border-slate-200 px-3 py-2 text-[11px] leading-4 text-slate-500">
    <p className="flex items-center gap-1.5"><Clock size={12} aria-hidden />{timing.session.idle_timeout_minutes} minutos por inactividad</p>
    <p>Sin nueva actividad, vence <time dateTime={expires.toISOString()}>{expires.toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })}</time>.</p>
  </div>
}
