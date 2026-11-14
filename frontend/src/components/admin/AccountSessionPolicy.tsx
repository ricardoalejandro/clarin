'use client'

import { useEffect, useRef, useState } from 'react'
import { Clock } from 'lucide-react'
import { apiPut, getOnlineSessionTiming, subscribeOnlineSessionNotice } from '@/lib/api'

interface Props {
  accountId: string
  minutes: number
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onSaved: (minutes: number) => void
}

export function AccountSessionPolicy({ accountId, minutes, disabled, onBusyChange, onSaved }: Props) {
  const [draft, setDraft] = useState(String(minutes))
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null)
  const requestInProgress = useRef(false)
  const [timing, setTiming] = useState<ReturnType<typeof getOnlineSessionTiming>>(null)
  useEffect(() => {
    const update = () => setTiming(getOnlineSessionTiming())
    update()
    return subscribeOnlineSessionNotice(update)
  }, [])
  const currentSession = timing?.session.account_id === accountId ? timing : null

  async function save() {
    if (requestInProgress.current || disabled || draft === String(minutes)) return
    const value = Number(draft)
    if (!/^\d+$/.test(draft) || value < 5 || value > 1440) {
      setNotice({ error: true, message: 'Ingresa un número entero entre 5 y 1440 minutos.' })
      return
    }
    requestInProgress.current = true
    setPending(true)
    onBusyChange(true)
    setNotice(null)
    try {
      const result = await apiPut<{ session_idle_timeout_minutes: number }>(`/api/admin/accounts/${accountId}/session-policy`, { session_idle_timeout_minutes: value })
      const saved = result.data?.session_idle_timeout_minutes
      if (!result.success || typeof saved !== 'number') {
        setNotice({ error: true, message: result.error || 'No se pudo guardar el plazo. Inténtalo nuevamente.' })
        return
      }
      setDraft(String(saved))
      onSaved(saved)
      setNotice({ error: false, message: 'Plazo de inactividad guardado. Se aplicará al iniciar sesión o volver a seleccionar esta cuenta; las sesiones abiertas conservan su plazo actual.' })
    } catch {
      setNotice({ error: true, message: 'No se pudo guardar el plazo. Inténtalo nuevamente.' })
    } finally {
      requestInProgress.current = false
      setPending(false)
      onBusyChange(false)
    }
  }

  return (
    <section aria-labelledby="account-session-policy-title" className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
      <h3 id="account-session-policy-title" className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Clock aria-hidden="true" size={16} /> Seguridad de sesión</h3>
      <p id="account-session-policy-help" className="text-xs leading-5 text-slate-600">Elige entre 5 y 1440 minutos. El plazo nuevo se aplica al iniciar sesión o al volver a seleccionar esta cuenta. El máximo total de una sesión es de 7 días.</p>
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <div><dt className="text-slate-500">Plazo configurado de la cuenta</dt><dd className="mt-0.5 font-semibold text-slate-800">{minutes} minutos por inactividad</dd></div>
        {currentSession && <div><dt className="text-slate-500">Plazo efectivo de esta sesión</dt><dd className="mt-0.5 font-semibold text-slate-800">{currentSession.session.idle_timeout_minutes} minutos por inactividad</dd></div>}
      </dl>
      {currentSession && <p className="text-xs leading-5 text-slate-600">Vencimiento estimado sin nueva actividad: <time dateTime={new Date(currentSession.deadlineAt).toISOString()}>{new Date(currentSession.deadlineAt).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })}</time>.{currentSession.session.idle_timeout_minutes !== minutes && ' El plazo configurado es diferente del de esta sesión. Vuelve a seleccionar la cuenta para adoptar el nuevo plazo.'}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-sm font-medium text-slate-700">
          Cerrar por inactividad (minutos)
          <input
            type="text"
            inputMode="numeric"
            maxLength={4}
            value={draft}
            onChange={event => { setDraft(event.target.value); setNotice(null) }}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void save() } }}
            disabled={pending || disabled}
            aria-invalid={notice?.error || undefined}
            aria-describedby={`account-session-policy-help${notice ? ' account-session-policy-notice' : ''}`}
            className="mt-1.5 block min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:bg-slate-100"
          />
        </label>
        <button type="button" onClick={() => void save()} disabled={pending || disabled || draft === String(minutes)} className="min-h-11 rounded-xl border border-emerald-200 bg-white px-3 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:border-slate-200 disabled:text-slate-500">
          {pending ? 'Guardando…' : 'Guardar plazo'}
        </button>
      </div>
      {notice && <p id="account-session-policy-notice" role={notice.error ? 'alert' : 'status'} className={`text-xs font-medium ${notice.error ? 'text-red-700' : 'text-emerald-800'}`}>{notice.message}</p>}
    </section>
  )
}
