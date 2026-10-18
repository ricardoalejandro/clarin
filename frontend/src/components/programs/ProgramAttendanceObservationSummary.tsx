'use client'

import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { NotebookPen, Plus } from 'lucide-react'
import type { ProgramParticipant } from '@/types/program'
import type { ProgramAttendanceDraft } from './programAttendance'

export type AttendanceObservationIntent = 'view' | 'add'
export type OpenAttendanceObservations = (participant: ProgramParticipant, trigger: HTMLElement | null, intent?: AttendanceObservationIntent) => void

export default function ProgramAttendanceObservationSummary({ participant, draft, disabled = false, showPreview = true, onOpenObservations }: {
  participant: ProgramParticipant
  draft: ProgramAttendanceDraft
  disabled?: boolean
  showPreview?: boolean
  onOpenObservations: OpenAttendanceObservations
}) {
  const entry = draft[participant.id]
  const preview = entry?.observation_preview?.[0]
  const count = entry?.observation_count || 0
  const name = participant.contact_name?.trim() || 'Participante sin nombre'
  const actionClass = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-40'

  return <div className="min-w-0">
    {showPreview && preview && <div className="border-l-2 border-slate-200 pl-3">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Última observación</p>
      <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm leading-5 text-slate-700">{preview.notes}</p>
      <p className="mt-1 text-[11px] text-slate-400">{preview.created_by_name || 'Autor no registrado'} · {format(new Date(preview.created_at), 'dd MMM, HH:mm', { locale: es })}</p>
    </div>}
    <div className={`flex flex-wrap items-center justify-end gap-1 ${showPreview && preview ? 'mt-1' : ''}`}>
      {count > 0 && <button type="button" disabled={disabled} className={actionClass} onClick={event => onOpenObservations(participant, event.currentTarget, 'view')} aria-label={`Ver ${count} observaciones de asistencia de ${name}`}><NotebookPen className="h-3.5 w-3.5"/>Ver {count}</button>}
      <button type="button" disabled={disabled} className={actionClass} onClick={event => onOpenObservations(participant, event.currentTarget, 'add')} aria-label={`Añadir observación de asistencia de ${name}`}><Plus className="h-3.5 w-3.5"/>Añadir</button>
    </div>
  </div>
}
