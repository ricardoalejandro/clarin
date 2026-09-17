import { describe, expect, it } from 'vitest'
import type { ProgramParticipant, ProgramSessionRosterEntry } from '@/types/program'
import {
  PROGRAM_ATTENDANCE_STATUS_CATALOG,
  acceptProgramAttendanceConflicts,
  buildProgramAttendanceBatchRecords,
  createProgramAttendanceDraft,
  effectiveProgramAttendanceView,
  filterProgramAttendanceParticipants,
  groupProgramAttendanceParticipants,
  isProgramAttendanceSaveCurrent,
  nextProgramAttendanceStatus,
  normalizeProgramAttendanceStatus,
  normalizeProgramAttendanceView,
  normalizeParticipantSearch,
  programAttendanceConflictExpectedStatuses,
  programAttendanceDirtyParticipantIDs,
  programAttendanceViewPreferenceKey,
  setProgramAttendanceDraftStatus,
} from './programAttendance'

function rosterEntry(participantID: string, name: string, status: ProgramSessionRosterEntry['attendance_status']): ProgramSessionRosterEntry {
  return {
    participant_id: participantID,
    contact_id: `contact-${participantID}`,
    contact_name: name,
    participation_status: 'active',
    enrolled_at: '2026-01-01',
    attendance_status: status,
    observation_count: 0,
    observation_preview: [],
  }
}

function participant(id: string, name: string): ProgramParticipant {
  return { id, program_id: 'program-1', contact_id: `contact-${id}`, status: 'active', enrolled_at: '2026-01-01', contact_name: name }
}

describe('program attendance state', () => {
  it('keeps the canonical five-state order and normalizes unknown values safely', () => {
    expect(PROGRAM_ATTENDANCE_STATUS_CATALOG.map(item => item.status)).toEqual(['', 'confirmed', 'present', 'absent', 'late'])
    expect(normalizeProgramAttendanceStatus('confirmed')).toBe('confirmed')
    expect(normalizeProgramAttendanceStatus('excused')).toBe('')
    expect(normalizeProgramAttendanceView('board')).toBe('board')
    expect(normalizeProgramAttendanceView('unknown')).toBe('list')
  })

  it('filters attendance participants by normalized name or phone without mutating the roster', () => {
    const roster = [
      { ...participant('p-1', 'Ángela Núñez'), contact_phone: '+51 999 123 456' },
      { ...participant('p-2', 'Bruno Pérez'), contact_phone: '51987654321' },
    ]
    expect(normalizeParticipantSearch('  ANGELA  NUNEZ ')).toBe('angela nunez')
    expect(filterProgramAttendanceParticipants(roster, 'angela nunez').map(item => item.id)).toEqual(['p-1'])
    expect(filterProgramAttendanceParticipants(roster, '987 654 321').map(item => item.id)).toEqual(['p-2'])
    expect(filterProgramAttendanceParticipants(roster, 'no existe')).toEqual([])
    expect(filterProgramAttendanceParticipants(roster, '')).toBe(roster)
    expect(roster.map(item => item.id)).toEqual(['p-1', 'p-2'])
  })

  it('captures original status once and removes dirty when the draft returns to it', () => {
    const initial = createProgramAttendanceDraft([
      rosterEntry('p-1', 'Ana', 'confirmed'),
      rosterEntry('p-2', 'Bruno', ''),
    ])
    expect(initial['p-1']).toMatchObject({ status: 'confirmed', original_status: 'confirmed' })

    const changed = setProgramAttendanceDraftStatus(initial, 'p-1', 'present')
    expect(programAttendanceDirtyParticipantIDs(changed)).toEqual(['p-1'])
    const restored = setProgramAttendanceDraftStatus(changed, 'p-1', 'confirmed')
    expect(programAttendanceDirtyParticipantIDs(restored)).toEqual([])
    expect(setProgramAttendanceDraftStatus(restored, 'p-1', 'confirmed')).toBe(restored)
  })

  it('builds only dirty batch records with original or explicitly rebased expectations', () => {
    let draft = createProgramAttendanceDraft([
      rosterEntry('p-1', 'Ana', ''),
      rosterEntry('p-2', 'Bruno', 'confirmed'),
    ])
    draft = setProgramAttendanceDraftStatus(draft, 'p-1', 'present')
    draft = setProgramAttendanceDraftStatus(draft, 'p-2', 'late')
    expect(buildProgramAttendanceBatchRecords(draft)).toEqual([
      { participant_id: 'p-1', status: 'present', expected_status: '' },
      { participant_id: 'p-2', status: 'late', expected_status: 'confirmed' },
    ])
    expect(buildProgramAttendanceBatchRecords(draft, { 'p-2': 'absent' })[1]).toEqual({ participant_id: 'p-2', status: 'late', expected_status: 'absent' })
  })

  it('accepts only conflicting server states and preserves unrelated drafts', () => {
    let draft = createProgramAttendanceDraft([
      rosterEntry('p-1', 'Ana', ''),
      rosterEntry('p-2', 'Bruno', 'present'),
    ])
    draft = setProgramAttendanceDraftStatus(draft, 'p-1', 'late')
    draft = setProgramAttendanceDraftStatus(draft, 'p-2', 'absent')
    const accepted = acceptProgramAttendanceConflicts(draft, [{ participant_id: 'p-1', current_status: 'confirmed' }])

    expect(accepted['p-1']).toMatchObject({ status: 'confirmed', original_status: 'confirmed' })
    expect(accepted['p-2']).toMatchObject({ status: 'absent', original_status: 'present' })
    expect(programAttendanceDirtyParticipantIDs(accepted)).toEqual(['p-2'])
    expect(programAttendanceConflictExpectedStatuses([{ participant_id: 'p-1', current_status: 'confirmed' }])).toEqual({ 'p-1': 'confirmed' })
  })

  it('groups every participant once in deterministic alphabetical order without mutating input', () => {
    const participants = [participant('p-3', 'zoé'), participant('p-1', 'Álvaro'), participant('p-2', 'alvaro')]
    const originalOrder = participants.map(item => item.id)
    let draft = createProgramAttendanceDraft([
      rosterEntry('p-1', 'Álvaro', 'present'),
      rosterEntry('p-2', 'alvaro', 'present'),
      rosterEntry('p-3', 'zoé', ''),
    ])
    draft = setProgramAttendanceDraftStatus(draft, 'p-3', 'confirmed')
    const grouped = groupProgramAttendanceParticipants(participants, draft)

    expect(grouped.present.map(item => item.id)).toEqual(['p-1', 'p-2'])
    expect(grouped.confirmed.map(item => item.id)).toEqual(['p-3'])
    expect(Object.values(grouped).flat().map(item => item.id).sort()).toEqual(['p-1', 'p-2', 'p-3'])
    expect(participants.map(item => item.id)).toEqual(originalOrder)
  })

  it('scopes preference by account and actor while mobile width only changes the effective view', () => {
    expect(programAttendanceViewPreferenceKey('account-1', 'user-1')).toBe('clarin:program-attendance:view:v1:account-1:user-1')
    expect(programAttendanceViewPreferenceKey('', 'user-1')).toBe('')
    expect(effectiveProgramAttendanceView('board', 1_200)).toBe('board')
    expect(effectiveProgramAttendanceView('board', 819)).toBe('list')
    expect(effectiveProgramAttendanceView('list', 1_200)).toBe('list')
  })

  it('moves keyboard destinations through five columns and clamps at both edges', () => {
    expect(nextProgramAttendanceStatus('', 1)).toBe('confirmed')
    expect(nextProgramAttendanceStatus('confirmed', 1)).toBe('present')
    expect(nextProgramAttendanceStatus('late', 1)).toBe('late')
    expect(nextProgramAttendanceStatus('', -1)).toBe('')
  })

  it('rejects stale save completions after a close or a different session opens', () => {
    const request = { generation: 4, session_id: 'session-a' }
    expect(isProgramAttendanceSaveCurrent(request, 4, 'session-a')).toBe(true)
    expect(isProgramAttendanceSaveCurrent(request, 5, 'session-a')).toBe(false)
    expect(isProgramAttendanceSaveCurrent(request, 4, 'session-b')).toBe(false)
  })
})
