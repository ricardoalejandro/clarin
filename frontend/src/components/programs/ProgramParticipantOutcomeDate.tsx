'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import { CalendarDays, Check, Edit2, Loader2, X } from 'lucide-react'
import { api } from '@/lib/api'
import type { ProgramParticipant } from '@/types/program'
import { formatCalendarDate, limaDateInputValue } from '@/utils/calendarDate'
import { es } from 'date-fns/locale'

interface ProgramParticipantOutcomeDateProps {
  programId: string
  participant: ProgramParticipant
  readOnly?: boolean
  onDirtyChange?: (dirty: boolean) => void
  onChange: (endedOn: string) => void
}

const dateKey = (value?: string | null) => value ? value.slice(0, 10) : ''

export default function ProgramParticipantOutcomeDate({ programId, participant, onChange, readOnly = false, onDirtyChange }: ProgramParticipantOutcomeDateProps) {
  const isDropped = participant.status === 'dropped'
  const current = dateKey(isDropped ? participant.dropped_at : participant.completed_at)
  const label = isDropped ? 'Fecha de retiro' : 'Fecha de finalización'
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const busyRef = useRef(false)
  const identity = `${programId}:${participant.id}`
  const identityRef = useRef(identity)
  identityRef.current = identity
  useEffect(() => { identityRef.current = identity; return () => { identityRef.current = '' } }, [identity])
  const [editing, setEditing] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const confirmationRef = useRef<HTMLDivElement>(null)
  useAccessibleDialog(confirmOpen && !readOnly, confirmationRef, () => setConfirmOpen(false))
  const [draft, setDraft] = useState(current)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { onDirtyChange?.(editing && draft !== current) }, [draft, editing, onDirtyChange, current])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  const maximumDate = useMemo(() => limaDateInputValue(), [])
  const minimumDate = dateKey(participant.enrolled_at)

  useEffect(() => {
    if (!editing) setDraft(current)
  }, [current, editing])

  const cancel = () => {
    if (readOnlyRef.current || saving) return
    setDraft(current)
    setError('')
    setEditing(false)
  }

  const save = async () => {
    if (readOnlyRef.current || identityRef.current !== identity || busyRef.current) return
    if (!draft || saving || draft === current) {
      if (draft === current) setEditing(false)
      return
    }
    if (draft < minimumDate || draft > maximumDate) {
      setError('La fecha debe estar entre la incorporación y el día actual de Lima.')
      return
    }
    setConfirmOpen(true)
  }

  const commit = async () => {
    if (readOnlyRef.current || identityRef.current !== identity || busyRef.current) return
    setConfirmOpen(false)
    busyRef.current = true
    const requestIdentity = identity
    setSaving(true)
    setError('')
    const result = await api<{ success: boolean; ended_on: string }>(
      `/api/programs/${programId}/participants/${participant.id}/outcome-date`,
      { method: 'PATCH', body: JSON.stringify({ ended_on: draft }) },
    )
    busyRef.current = false
    if (identityRef.current !== requestIdentity) return
    setSaving(false)
    if (!result.success || !result.data?.success || !result.data.ended_on) {
      setError(result.error || 'No se pudo actualizar la fecha de cierre.')
      return
    }
    onChange(result.data.ended_on)
    setEditing(false)
  }

  if (participant.status === 'active' || !current) return null

  return (
    <>
    <div className="rounded-xl bg-slate-50 px-3 py-2.5 sm:col-span-2">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
          {(!editing || readOnly) && <p className="mt-0.5 font-semibold text-slate-700">{formatCalendarDate(current, 'dd MMM yyyy', { locale: es })}</p>}
        </div>
        {!editing && !readOnly && <button type="button" onClick={() => { if (readOnlyRef.current) return; setEditing(true); setError('') }} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-emerald-700 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label={`Modificar ${label.toLocaleLowerCase('es')}`}><Edit2 className="h-3.5 w-3.5" />Modificar</button>}
      </div>
      {!editing && <p className="mt-1 text-[10px] leading-relaxed text-slate-400">Es el primer día fuera del programa; una sesión en esta fecha queda excluida.</p>}
      {editing && (
        <div hidden={readOnly} inert={readOnly} className="mt-2">
          <label className="block"><span className="sr-only">Nueva {label.toLocaleLowerCase('es')}</span><input type="date" value={draft} min={minimumDate} max={maximumDate} onChange={event => { setDraft(event.target.value); setError('') }} disabled={saving} className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base font-medium text-slate-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:opacity-60 sm:text-sm" /></label>
          {error && <p className="mt-2 text-xs leading-relaxed text-red-600" role="alert">{error}</p>}
          <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-slate-400"><CalendarDays className="mt-0.5 h-3.5 w-3.5 shrink-0" />Se recalcularán el periodo y las métricas sin eliminar asistencias históricas.</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button type="button" onClick={cancel} disabled={saving} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-50"><X className="h-4 w-4" />Cancelar</button>
            <button type="button" onClick={() => void save()} disabled={saving || !draft || draft === current} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 text-xs font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-45">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{saving ? 'Guardando…' : 'Guardar'}</button>
          </div>
        </div>
      )}
    </div>
    {confirmOpen && !readOnly && typeof document !== 'undefined' && createPortal(
      <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/50 p-4">
        <div ref={confirmationRef} role="alertdialog" aria-modal="true" aria-label="Confirmar fecha de cierre" tabIndex={-1} className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl">
          <p className="text-sm text-slate-700">Las métricas se recalcularán. Las asistencias fuera del nuevo periodo seguirán visibles como historial y una sesión en la fecha de cierre quedará excluida.</p>
          <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setConfirmOpen(false)} className="min-h-11 rounded-xl px-3">Cancelar</button><button type="button" onClick={() => void commit()} className="min-h-11 rounded-xl bg-emerald-600 px-3 text-white">Confirmar</button></div>
        </div>
      </div>, document.body,
    )}
    </>
  )
}
