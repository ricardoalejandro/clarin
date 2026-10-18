import { describe, expect, it } from 'vitest'
import { attendanceCloseDecision, EMPTY_SESSION_OBSERVATION_STATE, programAttendanceDetailsVisible } from './programAttendanceDetails'
import { acceptSavedProgramAttendance, buildProgramAttendanceBatchRecords, programAttendanceDirtyParticipantIDs } from './programAttendance'

describe('attendance context and pending work', () => {
  it('hides context for raw search immediately without mutating the expansion preference', () => {
    expect(programAttendanceDetailsVisible('a', true)).toBe(false)
    expect(programAttendanceDetailsVisible('', true)).toBe(true)
    expect(programAttendanceDetailsVisible('   ', true)).toBe(true)
    expect(programAttendanceDetailsVisible('', false)).toBe(false)
  })
  it('blocks closing during a submitted comment and protects comment-only drafts', () => {
    expect(attendanceCloseDecision(0, { ...EMPTY_SESSION_OBSERVATION_STATE, saving: true })).toBe('wait')
    expect(attendanceCloseDecision(0, { ...EMPTY_SESSION_OBSERVATION_STATE, dirty: true })).toBe('confirm')
    expect(attendanceCloseDecision(2, EMPTY_SESSION_OBSERVATION_STATE)).toBe('confirm')
    expect(attendanceCloseDecision(0, EMPTY_SESSION_OBSERVATION_STATE)).toBe('close')
  })
  it('accepts sent attendance once and preserves filtered participants and observation metadata', () => {
    const draft = { visible: { status: 'present' as const, original_status: '' as const, observation_count: 2, observation_preview: [] }, filtered: { status: 'late' as const, original_status: '' as const, observation_count: 0, observation_preview: [] } }
    const records = buildProgramAttendanceBatchRecords(draft)
    expect(records).toHaveLength(2)
    const saved = acceptSavedProgramAttendance(draft, records)
    expect(programAttendanceDirtyParticipantIDs(saved)).toEqual([])
    expect(buildProgramAttendanceBatchRecords(saved)).toEqual([])
    expect(saved.visible.observation_count).toBe(2)
    expect(saved.filtered.status).toBe('late')
    const newer = acceptSavedProgramAttendance({ ...draft, visible: { ...draft.visible, status: 'absent' } }, records)
    expect(newer.visible.status).toBe('absent')
    expect(newer.visible.original_status).toBe('present')
    expect(programAttendanceDirtyParticipantIDs(newer)).toEqual(['visible'])
  })
})
