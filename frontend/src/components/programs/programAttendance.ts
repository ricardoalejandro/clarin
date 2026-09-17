import type {
  ProgramAttendanceObservation,
  ProgramParticipant,
  ProgramSessionRosterEntry,
} from '@/types/program'

export type ProgramAttendanceStatus = '' | 'confirmed' | 'present' | 'absent' | 'late'
export type ProgramAttendanceView = 'list' | 'board'

export interface ProgramAttendanceDraftEntry {
  status: ProgramAttendanceStatus
  original_status: ProgramAttendanceStatus
  observation_count: number
  observation_preview: ProgramAttendanceObservation[]
}

export type ProgramAttendanceDraft = Record<string, ProgramAttendanceDraftEntry>

export interface ProgramAttendanceConflict {
  participant_id: string
  current_status: ProgramAttendanceStatus
}

export interface ProgramAttendanceBatchRecord {
  participant_id: string
  status: ProgramAttendanceStatus
  expected_status: ProgramAttendanceStatus
}

export interface ProgramAttendanceSaveIdentity {
  generation: number
  session_id: string
}

export const PROGRAM_ATTENDANCE_BOARD_MIN_WIDTH = 820

export const PROGRAM_ATTENDANCE_STATUS_CATALOG: ReadonlyArray<{
  status: ProgramAttendanceStatus
  label: string
  shortLabel: string
  description: string
  color: string
  columnClassName: string
  activeClassName: string
  dotClassName: string
}> = [
  {
    status: '',
    label: 'Sin estado',
    shortLabel: '—',
    description: 'Aún no se registró un estado',
    color: '#94A3B8',
    columnClassName: 'border-slate-200 bg-slate-50/70',
    activeClassName: 'bg-slate-200 text-slate-700 ring-2 ring-slate-300',
    dotClassName: 'bg-slate-400',
  },
  {
    status: 'confirmed',
    label: 'Confirmado',
    shortLabel: 'C',
    description: 'Confirmó su participación',
    color: '#3B82F6',
    columnClassName: 'border-blue-200 bg-blue-50/60',
    activeClassName: 'bg-blue-100 text-blue-700 ring-2 ring-blue-300',
    dotClassName: 'bg-blue-500',
  },
  {
    status: 'present',
    label: 'Presente',
    shortLabel: 'P',
    description: 'Asistió a la sesión',
    color: '#10B981',
    columnClassName: 'border-emerald-200 bg-emerald-50/60',
    activeClassName: 'bg-emerald-100 text-emerald-700 ring-2 ring-emerald-300',
    dotClassName: 'bg-emerald-500',
  },
  {
    status: 'absent',
    label: 'Faltó',
    shortLabel: 'F',
    description: 'No asistió a la sesión',
    color: '#EF4444',
    columnClassName: 'border-red-200 bg-red-50/60',
    activeClassName: 'bg-red-100 text-red-700 ring-2 ring-red-300',
    dotClassName: 'bg-red-500',
  },
  {
    status: 'late',
    label: 'Tarde',
    shortLabel: 'T',
    description: 'Asistió con tardanza',
    color: '#F59E0B',
    columnClassName: 'border-amber-200 bg-amber-50/60',
    activeClassName: 'bg-amber-100 text-amber-800 ring-2 ring-amber-300',
    dotClassName: 'bg-amber-500',
  },
]

const PROGRAM_ATTENDANCE_STATUS_SET = new Set<ProgramAttendanceStatus>(
  PROGRAM_ATTENDANCE_STATUS_CATALOG.map(item => item.status),
)

export function normalizeProgramAttendanceStatus(value: unknown): ProgramAttendanceStatus {
  return typeof value === 'string' && PROGRAM_ATTENDANCE_STATUS_SET.has(value as ProgramAttendanceStatus)
    ? value as ProgramAttendanceStatus
    : ''
}

export function normalizeParticipantSearch(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/\s+/g, ' ')
    .trim()
}

export function filterProgramAttendanceParticipants<T extends Pick<ProgramParticipant, 'contact_name' | 'contact_phone'>>(
  participants: T[],
  query: string,
) {
  const normalizedQuery = normalizeParticipantSearch(query)
  if (!normalizedQuery) return participants
  const normalizedPhoneQuery = normalizedQuery.replace(/\D/g, '')
  return participants.filter(participant => {
    const normalizedName = normalizeParticipantSearch(participant.contact_name || '')
    const normalizedPhone = (participant.contact_phone || '').replace(/\D/g, '')
    return normalizedName.includes(normalizedQuery)
      || (normalizedPhoneQuery.length > 0 && normalizedPhone.includes(normalizedPhoneQuery))
  })
}

export function normalizeProgramAttendanceView(value: unknown): ProgramAttendanceView {
  return value === 'board' ? 'board' : 'list'
}

export function programAttendanceViewPreferenceKey(accountID: string, actorID: string) {
  return accountID && actorID ? `clarin:program-attendance:view:v1:${accountID}:${actorID}` : ''
}

export function effectiveProgramAttendanceView(
  preferred: ProgramAttendanceView,
  availableWidth: number,
): ProgramAttendanceView {
  return preferred === 'board' && availableWidth >= PROGRAM_ATTENDANCE_BOARD_MIN_WIDTH ? 'board' : 'list'
}

export function createProgramAttendanceDraft(roster: ProgramSessionRosterEntry[]): ProgramAttendanceDraft {
  return Object.fromEntries(roster.map(entry => {
    const status = normalizeProgramAttendanceStatus(entry.attendance_status)
    return [entry.participant_id, {
      status,
      original_status: status,
      observation_count: entry.observation_count || 0,
      observation_preview: Array.isArray(entry.observation_preview) ? entry.observation_preview : [],
    }]
  }))
}

export function setProgramAttendanceDraftStatus(
  draft: ProgramAttendanceDraft,
  participantID: string,
  status: ProgramAttendanceStatus,
): ProgramAttendanceDraft {
  const current = draft[participantID]
  if (!current || current.status === status) return draft
  return { ...draft, [participantID]: { ...current, status } }
}

export function programAttendanceDirtyParticipantIDs(draft: ProgramAttendanceDraft) {
  return Object.entries(draft)
    .filter(([, entry]) => entry.status !== entry.original_status)
    .map(([participantID]) => participantID)
}

export function buildProgramAttendanceBatchRecords(
  draft: ProgramAttendanceDraft,
  expectedStatusOverrides: Readonly<Record<string, ProgramAttendanceStatus>> = {},
): ProgramAttendanceBatchRecord[] {
  return Object.entries(draft).flatMap(([participantID, entry]) => (
    entry.status === entry.original_status
      ? []
      : [{
          participant_id: participantID,
          status: entry.status,
          expected_status: expectedStatusOverrides[participantID] ?? entry.original_status,
        }]
  ))
}

export function acceptProgramAttendanceConflicts(
  draft: ProgramAttendanceDraft,
  conflicts: ProgramAttendanceConflict[],
): ProgramAttendanceDraft {
  let next = draft
  conflicts.forEach(conflict => {
    const current = next[conflict.participant_id]
    if (!current) return
    const serverStatus = normalizeProgramAttendanceStatus(conflict.current_status)
    if (next === draft) next = { ...draft }
    next[conflict.participant_id] = {
      ...current,
      status: serverStatus,
      original_status: serverStatus,
    }
  })
  return next
}

export function programAttendanceConflictExpectedStatuses(conflicts: ProgramAttendanceConflict[]) {
  return Object.fromEntries(conflicts.map(conflict => [
    conflict.participant_id,
    normalizeProgramAttendanceStatus(conflict.current_status),
  ])) as Record<string, ProgramAttendanceStatus>
}

export function groupProgramAttendanceParticipants<T extends Pick<ProgramParticipant, 'id' | 'contact_name'>>(
  participants: T[],
  draft: ProgramAttendanceDraft,
): Record<ProgramAttendanceStatus, T[]> {
  const grouped = Object.fromEntries(
    PROGRAM_ATTENDANCE_STATUS_CATALOG.map(item => [item.status, [] as T[]]),
  ) as Record<ProgramAttendanceStatus, T[]>
  [...participants].sort((first, second) => (
    (first.contact_name || '').localeCompare(second.contact_name || '', 'es', { sensitivity: 'base' })
    || first.id.localeCompare(second.id)
  )).forEach(participant => {
    grouped[normalizeProgramAttendanceStatus(draft[participant.id]?.status)].push(participant)
  })
  return grouped
}

export function nextProgramAttendanceStatus(
  current: ProgramAttendanceStatus,
  direction: -1 | 1,
): ProgramAttendanceStatus {
  const currentIndex = PROGRAM_ATTENDANCE_STATUS_CATALOG.findIndex(item => item.status === current)
  const nextIndex = Math.max(0, Math.min(PROGRAM_ATTENDANCE_STATUS_CATALOG.length - 1, currentIndex + direction))
  return PROGRAM_ATTENDANCE_STATUS_CATALOG[nextIndex]?.status ?? ''
}

export function isProgramAttendanceSaveCurrent(
  request: ProgramAttendanceSaveIdentity,
  currentGeneration: number,
  currentSessionID: string,
) {
  return request.generation === currentGeneration && request.session_id === currentSessionID
}
