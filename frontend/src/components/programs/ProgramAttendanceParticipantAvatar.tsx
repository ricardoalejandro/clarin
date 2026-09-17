'use client'

import type { ProgramParticipant } from '@/types/program'

export default function ProgramAttendanceParticipantAvatar({
  participant,
  sizeClassName = 'h-9 w-9',
}: {
  participant: ProgramParticipant
  sizeClassName?: string
}) {
  const name = participant.contact_name?.trim() || 'Participante sin nombre'
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?'
  return (
    <span className={`${sizeClassName} relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-emerald-50 text-xs font-bold text-emerald-700 ring-1 ring-emerald-100`} aria-hidden="true">
      {initials}
      {participant.avatar_url && <img src={participant.avatar_url} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true }} className="absolute inset-0 h-full w-full object-cover" />}
    </span>
  )
}
