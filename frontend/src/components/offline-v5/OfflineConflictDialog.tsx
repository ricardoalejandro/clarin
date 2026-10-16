'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import { offlineV5ConflictCanMerge } from '@/offline-v5/conflicts'
import type { OfflineV5Conflict } from '@/offline-v5/types'
import { useClarinRuntime } from './ClarinRuntimeProvider'

const labels: Record<string, string> = {
  title: 'Título', name: 'Nombre', description: 'Descripción', notes: 'Notas', priority: 'Prioridad',
  status_id: 'Estado', assigned_to: 'Responsable', due_at: 'Fecha límite', start_at: 'Fecha de inicio',
  email: 'Correo', phone: 'Teléfono', first_name: 'Nombre', last_name: 'Apellidos', color: 'Color',
}
function fieldValue(value: unknown) { return value == null ? 'Sin valor' : typeof value === 'string' ? value : JSON.stringify(value, null, 2) }

export default function OfflineConflictDialog({ onClose }: { onClose: () => void }) {
  const { snapshot, conflicts, resolveConflict } = useClarinRuntime()
  const dialog = useRef<HTMLDialogElement>(null)
  const [items, setItems] = useState<OfflineV5Conflict[]>([])
  const [loading, setLoading] = useState(true)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [decision, setDecision] = useState<{ operationId: string; fields: Record<string, 'local' | 'server'> }>({ operationId: '', fields: {} })
  const current = items[0]
  const choices = decision.operationId === current?.operation_id ? decision.fields : {}

  useEffect(() => {
    const element = dialog.current, previous = document.activeElement as HTMLElement | null
    element?.showModal?.()
    return () => { element?.close?.(); previous?.focus() }
  }, [])
  useEffect(() => {
    let active = true
    setLoading(true)
    void conflicts().then(result => { if (active) { setItems(result); setError('') } })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'No se pudieron abrir los cambios guardados.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [conflicts, snapshot.accountId, snapshot.userId, snapshot.conflictCount, loadAttempt])

  const settle = async (choice: 'server' | 'fields') => {
    if (!current || pending) return
    setPending(true); setError('')
    try {
      await resolveConflict(choice === 'server'
        ? { operation_id: current.operation_id, choice }
        : { operation_id: current.operation_id, choice, fields: choices })
      setItems(previous => previous.filter(item => item.operation_id !== current.operation_id))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No se pudo guardar la decisión. Tus cambios siguen guardados.') }
    finally { setPending(false) }
  }
  const mergeable = current && offlineV5ConflictCanMerge(current)
  const selectedAll = Boolean(current?.fields?.every(field => choices[field]))
  const value = (side: 'local' | 'server', field: string) => (current?.[side] as Record<string, unknown> | undefined)?.[field]

  return createPortal(<dialog ref={dialog} onCancel={event => { event.preventDefault(); if (!pending) onClose() }}
    aria-labelledby="offline-conflict-title" className="fixed inset-0 m-auto max-h-[min(85dvh,760px)] w-[min(50rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-0 text-slate-800 shadow-2xl backdrop:bg-slate-900/45">
    <div className="flex max-h-[min(85dvh,760px)] flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <h2 id="offline-conflict-title" className="text-sm font-semibold">Revisar cambios sin sincronizar</h2>
        <button type="button" onClick={onClose} disabled={pending} aria-label="Cerrar revisión de conflictos" className="rounded-lg p-2 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-emerald-600 disabled:opacity-50"><X className="h-4 w-4" /></button>
      </header>
      <div className="min-h-0 overflow-y-auto px-4 py-4 text-sm">
        {loading ? <p role="status" className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />Abriendo cambios guardados…</p> : !current ? !error && <p>No quedan conflictos por revisar. Los cambios que conservaste se enviarán al sincronizar.</p> : <>
          <p className="mb-4 text-slate-600">{items.length} cambio{items.length === 1 ? '' : 's'} por revisar. La copia local y la versión del servidor se conservan hasta que elijas.</p>
          {mergeable ? <div className="space-y-4">{current.fields!.map(field => <fieldset key={field} className="rounded-lg border border-slate-200 p-3">
            <legend className="px-1 text-xs font-semibold">{labels[field] || field}</legend>
            <div className="grid gap-2 sm:grid-cols-2">{(['local', 'server'] as const).map(side => <label key={side} className={`flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border p-3 ${choices[field] === side ? 'border-emerald-600 bg-emerald-50' : 'border-slate-200'}`}>
              <input type="radio" name={`conflict-${field}`} value={side} checked={choices[field] === side} disabled={pending} onChange={() => setDecision({ operationId: current.operation_id, fields: { ...choices, [field]: side } })} className="mt-0.5 accent-emerald-700" />
              <span className="min-w-0"><strong className="text-xs">{side === 'local' ? 'Mi cambio local' : 'Versión del servidor'}</strong><span className="mt-1 block whitespace-pre-wrap break-words text-xs">{fieldValue(value(side, field))}</span></span>
            </label>)}</div>
          </fieldset>)}<p className="text-xs text-slate-500">Los campos que no entraron en conflicto conservarán tus cambios. La decisión se comprobará de nuevo al sincronizar.</p></div> : <>
            <p className="mb-3 rounded-lg bg-amber-50 p-3 text-amber-900">Este cambio necesita revisión con conexión antes de volver a enviarse. Puedes cerrar esta ventana y conservarlo, o aceptar la versión del servidor.</p>
            <details className="rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-xs font-medium">Ver cambios locales guardados</summary><pre className="mt-2 whitespace-pre-wrap break-words text-xs">{fieldValue(current.local)}</pre></details>
          </>}
        </>}
      </div>
      <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-slate-200 px-4 py-3">
        {error && <p role="alert" className="w-full rounded-lg bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
        <button type="button" onClick={onClose} disabled={pending} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold">{current ? 'Revisar después' : 'Cerrar'}</button>
        {!current && error && !loading && <button type="button" onClick={() => setLoadAttempt(value => value + 1)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold">Reintentar</button>}
        {current && !loading && <button type="button" disabled={pending} onClick={() => void settle('server')} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold disabled:opacity-50">Aceptar servidor para este cambio</button>}
        {mergeable && !loading && <button type="button" disabled={pending || !selectedAll} onClick={() => void settle('fields')} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{pending ? 'Guardando…' : 'Guardar selección'}</button>}
      </footer>
    </div>
  </dialog>, document.body)
}
