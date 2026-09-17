'use client'

import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { Columns3, LayoutList, NotebookPen } from 'lucide-react'
import type { ProgramParticipant } from '@/types/program'
import ProgramAttendanceBoard from './ProgramAttendanceBoard'
import ProgramAttendanceParticipantAvatar from './ProgramAttendanceParticipantAvatar'
import {
  PROGRAM_ATTENDANCE_STATUS_CATALOG,
  type ProgramAttendanceDraft,
  type ProgramAttendanceStatus,
  type ProgramAttendanceView,
} from './programAttendance'

interface ProgramAttendanceRosterProps {
  participants: ProgramParticipant[]
  totalParticipants?: number
  searchActive?: boolean
  draft: ProgramAttendanceDraft
  preferredView: ProgramAttendanceView
  effectiveView: ProgramAttendanceView
  boardAvailable: boolean
  disabled?: boolean
  onPreferredViewChange: (view: ProgramAttendanceView) => void
  onStatusChange: (participantID: string, status: ProgramAttendanceStatus) => void
  onOpenObservations: (participant: ProgramParticipant, trigger: HTMLElement | null) => void
  onClearSearch?: () => void
  onDragStateChange?: (dragging: boolean) => void
}

const MARKED_STATUSES = PROGRAM_ATTENDANCE_STATUS_CATALOG.filter(item => item.status !== '')

function participantName(participant: ProgramParticipant) {
  return participant.contact_name?.trim() || 'Participante sin nombre'
}

function ObservationSummary({
  participant,
  draft,
  compact,
  disabled,
  onOpenObservations,
}: {
  participant: ProgramParticipant
  draft: ProgramAttendanceDraft
  compact: boolean
  disabled: boolean
  onOpenObservations: ProgramAttendanceRosterProps['onOpenObservations']
}) {
  const entry = draft[participant.id]
  const preview = entry?.observation_preview?.[0]
  const name = participantName(participant)
  return (
    <div className={compact ? 'rounded-xl border border-slate-200 bg-slate-50/60 p-3' : 'min-w-[260px]'}>
      {preview ? (
        <>
          <p className={`leading-5 text-slate-700 ${compact ? 'line-clamp-2 text-sm' : 'line-clamp-2 text-xs'}`}>{preview.notes}</p>
          <p className="mt-0.5 text-[10px] text-slate-400">{preview.created_by_name || 'Autor no registrado'} · {format(new Date(preview.created_at), 'dd MMM, HH:mm', { locale: es })}</p>
        </>
      ) : <p className="text-xs text-slate-400">Sin observaciones</p>}
      <div className={compact ? 'mt-2 flex justify-end' : 'mt-1'}>
        <button
          type="button"
          disabled={disabled}
          onClick={event => onOpenObservations(participant, event.currentTarget)}
          aria-label={`Abrir observaciones de asistencia de ${name}`}
          className={`inline-flex items-center gap-1.5 font-semibold text-emerald-700 transition hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-40 ${compact ? 'min-h-11 rounded-xl bg-white px-3 text-xs ring-1 ring-inset ring-emerald-200' : 'min-h-9 rounded-lg px-2 text-[11px]'}`}
        >
          <NotebookPen className="h-3.5 w-3.5" />Observaciones
          {(entry?.observation_count || 0) > 1 && <span>{compact ? `+${(entry?.observation_count || 0) - 1} más` : `· +${(entry?.observation_count || 0) - 1} más`}</span>}
        </button>
      </div>
    </div>
  )
}

function StatusButtons({
  participant,
  draft,
  compact,
  disabled,
  onStatusChange,
}: {
  participant: ProgramParticipant
  draft: ProgramAttendanceDraft
  compact: boolean
  disabled: boolean
  onStatusChange: ProgramAttendanceRosterProps['onStatusChange']
}) {
  const selectedStatus = draft[participant.id]?.status || ''
  const name = participantName(participant)
  return (
    <div className={compact ? 'mt-3 grid grid-cols-4 gap-2' : 'flex gap-1'} aria-label={`Estado de ${name}`}>
      {MARKED_STATUSES.map(item => {
        const selected = selectedStatus === item.status
        return (
          <button
            key={item.status}
            type="button"
            disabled={disabled}
            onClick={() => onStatusChange(participant.id, selected ? '' : item.status)}
            aria-label={`${item.label}: ${name}`}
            aria-pressed={selected}
            title={`${item.label}. Pulsa otra vez para dejar sin estado.`}
            className={`${compact ? 'min-h-11 rounded-xl' : 'h-8 w-8 rounded-lg'} text-xs font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-45 ${selected ? item.activeClassName : 'bg-slate-100 text-slate-400 hover:bg-slate-200'}`}
          >
            {item.shortLabel}<span className="sr-only"> {item.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export default function ProgramAttendanceRoster({
  participants,
  totalParticipants = participants.length,
  searchActive = false,
  draft,
  preferredView,
  effectiveView,
  boardAvailable,
  disabled = false,
  onPreferredViewChange,
  onStatusChange,
  onOpenObservations,
  onClearSearch,
  onDragStateChange,
}: ProgramAttendanceRosterProps) {
  if (participants.length === 0) {
    if (searchActive) {
      return (
        <div data-testid="program-attendance-no-results" className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 text-center">
          <p className="font-semibold text-slate-600">Sin coincidencias</p>
          <p className="mt-1 text-xs leading-5 text-slate-400">No encontramos participantes con ese nombre o teléfono.</p>
          {onClearSearch && <button type="button" onClick={onClearSearch} disabled={disabled} className="mt-3 min-h-11 rounded-xl border border-emerald-200 bg-white px-4 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-40">Limpiar búsqueda</button>}
        </div>
      )
    }
    return <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 text-center text-sm leading-6 text-slate-500">No hay participantes cuyo periodo de incorporación incluya esta sesión.</div>
  }

  return (
    <>
      <div className="mb-3 flex min-h-11 items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-700">{searchActive ? `Mostrando ${participants.length} de ${totalParticipants} participantes` : `${participants.length} participante${participants.length === 1 ? '' : 's'}`}</p>
          <p className="truncate text-[10px] text-slate-400">Confirmado no modifica los porcentajes de asistencia.</p>
        </div>
        {boardAvailable && (
          <div className="flex shrink-0 items-center rounded-xl border border-slate-200 bg-slate-50 p-1" role="group" aria-label="Vista de asistencia">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPreferredViewChange('list')}
              aria-pressed={preferredView === 'list'}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-40 ${preferredView === 'list' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              <LayoutList className="h-3.5 w-3.5" />Lista
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPreferredViewChange('board')}
              aria-pressed={preferredView === 'board'}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-40 ${preferredView === 'board' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              <Columns3 className="h-3.5 w-3.5" />Tablero
            </button>
          </div>
        )}
      </div>

      {effectiveView === 'board' ? (
        <ProgramAttendanceBoard
          participants={participants}
          draft={draft}
          disabled={disabled}
          onStatusChange={onStatusChange}
          onOpenObservations={onOpenObservations}
          onDragStateChange={onDragStateChange}
        />
      ) : (
        <>
          <div className="space-y-3 md:hidden">
            {participants.map(participant => (
              <article key={participant.id} className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-center gap-2">
                  <ProgramAttendanceParticipantAvatar participant={participant} />
                  <span className="min-w-0 truncate text-sm font-semibold text-slate-800">{participantName(participant)}</span>
                </div>
                <StatusButtons participant={participant} draft={draft} compact disabled={disabled} onStatusChange={onStatusChange} />
                <div className="mt-3"><ObservationSummary participant={participant} draft={draft} compact disabled={disabled} onOpenObservations={onOpenObservations} /></div>
              </article>
            ))}
          </div>

          <table className="hidden w-full min-w-[760px] text-left text-sm md:table">
            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 text-slate-600">
              <tr><th className="px-4 py-3 font-medium">Participante</th><th className="px-4 py-3 font-medium">Estado</th><th className="px-4 py-3 font-medium">Observaciones</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {participants.map(participant => (
                <tr key={participant.id} className="transition-colors hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <ProgramAttendanceParticipantAvatar participant={participant} sizeClassName="h-8 w-8" />
                      <span className="text-sm font-medium text-slate-800">{participantName(participant)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3"><StatusButtons participant={participant} draft={draft} compact={false} disabled={disabled} onStatusChange={onStatusChange} /></td>
                  <td className="px-4 py-3"><ObservationSummary participant={participant} draft={draft} compact={false} disabled={disabled} onOpenObservations={onOpenObservations} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  )
}
