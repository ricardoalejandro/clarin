'use client'

import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { getOnlineSessionTiming, subscribeOnlineSessionNotice } from '@/lib/api'
import EditorPopover from '@/components/documents/EditorPopover'

/** Read-only server timing; rendering this never refreshes or extends a session. */
export function SessionTimingSummary({ accountId, compact = false }: { accountId?: string; compact?: boolean }) {
  const [timing, setTiming] = useState<ReturnType<typeof getOnlineSessionTiming>>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const update = () => setTiming(getOnlineSessionTiming())
    update()
    return subscribeOnlineSessionNotice(update)
  }, [])
  if (!timing || accountId && timing.session.account_id !== accountId) return null
  const expires = new Date(timing.deadlineAt)
  if (compact) return <div className="border-t border-slate-200 px-2 py-1">
    <button type="button" className="utility-control inline-flex w-full items-center gap-1.5 rounded-lg px-1 text-left text-[11px] text-slate-500 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-600" aria-label="Duración de tu sesión" aria-haspopup="dialog" aria-expanded={Boolean(anchor)} onClick={event => { const target = event.currentTarget; setAnchor(current => current ? null : target) }}><Clock size={12} aria-hidden />{timing.session.idle_timeout_minutes} min de inactividad</button>
    {anchor && <EditorPopover anchor={anchor} label="Detalle de la sesión" onClose={() => setAnchor(null)} width={272}><div className="space-y-2 p-1 text-xs leading-5"><p>{timing.session.idle_timeout_minutes} minutos por inactividad.</p><p>Sin nueva actividad, vence <time dateTime={expires.toISOString()}>{expires.toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })}</time>.</p><p>El guardado automático no amplía este plazo.</p><button type="button" className="utility-control rounded-lg px-2 text-slate-700 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-600" onClick={() => setAnchor(null)}>Cerrar detalle de sesión</button></div></EditorPopover>}
  </div>
  return <div aria-label="Duración de tu sesión" className="space-y-1 border-t border-slate-200 px-3 py-2 text-[11px] leading-4 text-slate-500">
    <p className="flex items-center gap-1.5"><Clock size={12} aria-hidden />{timing.session.idle_timeout_minutes} minutos por inactividad</p>
    <p>Sin nueva actividad, vence <time dateTime={expires.toISOString()}>{expires.toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })}</time>.</p>
  </div>
}
