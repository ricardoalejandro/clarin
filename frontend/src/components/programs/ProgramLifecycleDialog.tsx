'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { programLifecycleAction, type ProgramLifecycleAction } from '@/lib/programLifecycle'
import type { Program } from '@/types/program'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'

export function ProgramLifecycleDialog({ program, action, suspended = false, onClose, onSaved, onCanonical }: {
  program: Program | null; action: ProgramLifecycleAction | null; suspended?: boolean
  onClose: () => void; onSaved: (program: Program) => void; onCanonical?: (program: Program) => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const busy = useRef(false)
  const identity = `${program?.account_id}:${program?.id}:${action}`
  const current = useRef({ identity, suspended, mounted: true })
  const callbacks = useRef({ onSaved, onClose, onCanonical })
  callbacks.current = { onSaved, onClose, onCanonical }
  current.current.identity = identity
  current.current.suspended = suspended
  useEffect(() => { current.current.mounted = true; return () => { current.current.mounted = false } }, [])
  useEffect(() => { setError(''); setConflict(false); setSaving(false); busy.current = false }, [identity])
  const panel = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const close = () => { if (current.current.mounted && current.current.identity === identity && !current.current.suspended && !busy.current) callbacks.current.onClose() }
  useAccessibleDialog(Boolean(program && action && !suspended), panel, close, cancel)
  if (!program || !action || typeof document === 'undefined') return null
  const operation = programLifecycleAction(program, action)
  const confirm = async () => {
    if (!current.current.mounted || current.current.identity !== identity || current.current.suspended || busy.current || !operation.allowed || conflict) return
    busy.current = true; setSaving(true); setError('')
    const response = await api<Program | { program?: Program }>(`/api/programs/${program.id}`, { method: 'PUT', body: JSON.stringify(operation.payload) })
      .catch(() => ({ success: false as const, status: 0, data: undefined, error: 'No se pudo conectar. Tus datos se conservaron; vuelve a intentarlo.' }))
    if (!current.current.mounted || current.current.identity !== identity) return
    busy.current = false; setSaving(false)
    if (response.success && response.data && 'id' in response.data) { callbacks.current.onSaved(response.data); callbacks.current.onClose(); return }
    if (response.status === 409) {
      setConflict(true)
      const canonical = response.data && 'program' in response.data ? response.data.program : undefined
      if (canonical) callbacks.current.onCanonical?.(canonical)
    }
    setError(response.error || 'No se pudo cambiar el estado. Tus datos se conservaron.')
  }
  return createPortal(<div hidden={suspended} inert={suspended || undefined} data-operational-confirmation
    style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.confirmation, ...(suspended ? { display: 'none' } : {}) }}
    className="fixed inset-0 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-[2px]" onMouseDown={event => { if (event.currentTarget === event.target) close() }}>
    <div ref={panel} role="alertdialog" aria-modal="true" aria-labelledby="program-lifecycle-title" aria-describedby="program-lifecycle-description" tabIndex={-1} className="w-full max-w-md rounded-3xl border border-white/80 bg-white p-5 shadow-2xl">
      <div className="flex items-center justify-between"><CheckCircle2 className="h-6 w-6 text-emerald-600" /><button type="button" onClick={close} disabled={saving} aria-label="Cerrar confirmación" className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button></div>
      <h2 id="program-lifecycle-title" className="mt-2 text-lg font-semibold text-slate-900">{operation.label}</h2>
      <p className="mt-1 break-words text-sm font-medium text-slate-700">{program.name}</p>
      <p id="program-lifecycle-description" className="mt-3 text-sm leading-6 text-slate-500">{operation.explanation}</p>
      {error && <div role="alert" className="mt-3 flex gap-2 rounded-xl bg-rose-50 p-3 text-sm text-rose-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}{conflict && ' Cierra esta confirmación y revisa el estado actualizado antes de intentarlo de nuevo.'}</span></div>}
      <div className="mt-5 flex justify-end gap-2"><button ref={cancel} type="button" onClick={close} disabled={saving} className="min-h-11 rounded-xl px-4 text-sm font-semibold text-slate-600 hover:bg-slate-100">Cancelar</button><button type="button" onClick={() => void confirm()} disabled={saving || conflict || !operation.allowed} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{saving && <Loader2 className="h-4 w-4 animate-spin" />}{saving ? 'Guardando…' : operation.label}</button></div>
    </div>
  </div>, document.body)
}
