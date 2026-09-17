import type { OfflineProgram, OfflineProgramParticipant } from './types'

export function offlineCalendarDay(value?: string): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null
  const day = value.slice(0, 10)
  const parsed = new Date(`${day}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null
}

export function offlineDateLabel(value?: string) {
  const day = offlineCalendarDay(value)
  return day ? new Date(`${day}T12:00:00Z`).toLocaleDateString('es-PE', { timeZone: 'UTC' }) : 'Fecha no disponible'
}

export function offlineProgramParticipantEligible(participant: OfflineProgramParticipant, date: string) {
  const day = offlineCalendarDay(date), enrolled = offlineCalendarDay(participant.enrolled_at)
  if (!day || !enrolled || day < enrolled) return false
  for (const boundary of [participant.dropped_at, participant.completed_at]) {
    if (boundary) { const last = offlineCalendarDay(boundary); if (!last || day >= last) return false }
  }
  return true
}

export function offlineProgramRosters(program: OfflineProgram) {
  const active = program.active_roster || (program.participants || []).filter(item => !item.dropped_at && !item.completed_at && !['dropped', 'completed'].includes(item.status))
  const history = program.historical_participations || (program.participants || []).filter(item => item.dropped_at || item.completed_at || ['dropped', 'completed'].includes(item.status))
  return { active, history, all: [...active, ...history] }
}

export function offlineAttendanceLabel(status?: string) {
  const names: Record<string, string> = { present: 'Presente', attended: 'Presente', absent: 'Ausente', late: 'Tarde', justified: 'Justificado', excused: 'Justificado', pending: 'Pendiente' }
  return status ? names[status] || status : 'Pendiente'
}
