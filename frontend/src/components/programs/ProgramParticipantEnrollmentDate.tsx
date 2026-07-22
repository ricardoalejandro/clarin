'use client'

import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Check, Edit2, Loader2, X } from 'lucide-react'
import { api } from '@/lib/api'
import type { ProgramParticipant } from '@/types/program'
import { localDateInputValue } from '@/utils/calendarDate'

interface ProgramParticipantEnrollmentDateProps {
  programId: string
  participant: ProgramParticipant
  onChange: (enrolledAt: string) => void
}

const dateKey = (value?: string | null) => value ? value.slice(0, 10) : ''

const displayDate = (value: string) => {
  const key = dateKey(value)
  const [year, month, day] = key.split('-').map(Number)
  if (!year || !month || !day) return 'Fecha no disponible'
  return new Date(year, month - 1, day, 12).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function ProgramParticipantEnrollmentDate({ programId, participant, onChange }: ProgramParticipantEnrollmentDateProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(dateKey(participant.enrolled_at))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const maximumDate = useMemo(() => {
    const candidates = [localDateInputValue(), dateKey(participant.dropped_at), dateKey(participant.completed_at)].filter(Boolean).sort()
    return candidates[0]
  }, [participant.completed_at, participant.dropped_at])

  useEffect(() => {
    if (!editing) setDraft(dateKey(participant.enrolled_at))
  }, [editing, participant.enrolled_at])

  const cancel = () => {
    if (saving) return
    setDraft(dateKey(participant.enrolled_at))
    setError('')
    setEditing(false)
  }

  const save = async () => {
    if (!draft || saving || draft === dateKey(participant.enrolled_at)) {
      if (draft === dateKey(participant.enrolled_at)) setEditing(false)
      return
    }
    if (draft > maximumDate) {
      setError('La fecha no puede estar en el futuro ni después del cierre de la participación.')
      return
    }
    setSaving(true)
    setError('')
    const result = await api<{ success: boolean; enrolled_at: string }>(
      `/api/programs/${programId}/participants/${participant.id}/enrollment`,
      { method: 'PATCH', body: JSON.stringify({ enrolled_at: draft }) },
    )
    setSaving(false)
    if (!result.success || !result.data?.success || !result.data.enrolled_at) {
      setError(result.error || 'No se pudo actualizar la fecha de incorporación.')
      return
    }
    onChange(result.data.enrolled_at)
    setEditing(false)
  }

  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2.5 sm:col-span-2">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Fecha de incorporación</p>
          {!editing && <p className="mt-0.5 font-semibold text-slate-700">{displayDate(participant.enrolled_at)}</p>}
        </div>
        {!editing && <button type="button" onClick={() => { setEditing(true); setError('') }} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-emerald-700 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label="Modificar fecha de incorporación"><Edit2 className="h-3.5 w-3.5" />Modificar</button>}
      </div>
      {!editing && <p className="mt-1 text-[10px] leading-relaxed text-slate-400">Se asigna automáticamente al inscribir al participante.</p>}
      {editing && (
        <div className="mt-2">
          <label className="block"><span className="sr-only">Nueva fecha de incorporación</span><input type="date" value={draft} max={maximumDate} onChange={event => { setDraft(event.target.value); setError('') }} disabled={saving} className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base font-medium text-slate-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:opacity-60 sm:text-sm" /></label>
          {error && <p className="mt-2 text-xs leading-relaxed text-red-600" role="alert">{error}</p>}
          <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-slate-400"><CalendarDays className="mt-0.5 h-3.5 w-3.5 shrink-0" />La asistencia se recalculará desde esta fecha; los registros anteriores seguirán visibles como historial.</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button type="button" onClick={cancel} disabled={saving} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-50"><X className="h-4 w-4" />Cancelar</button>
            <button type="button" onClick={() => void save()} disabled={saving || !draft || draft === dateKey(participant.enrolled_at)} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 text-xs font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-45">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{saving ? 'Guardando…' : 'Guardar'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
