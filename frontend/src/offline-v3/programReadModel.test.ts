import { describe, expect, it } from 'vitest'
import { offlineAttendanceLabel, offlineCalendarDay, offlineDateLabel, offlineProgramParticipantEligible, offlineProgramRosters } from './programReadModel'
import type { OfflineProgramParticipant } from './types'

const participant: OfflineProgramParticipant = { id: 'a', contact_id: 'contact', name: 'Uno', status: 'dropped', enrolled_at: '2026-09-02T00:00:00Z', dropped_at: '2026-09-05T00:00:00Z' }
describe('offline program history and attendance', () => {
  it('keeps calendar dates stable and rejects malformed values', () => {
    expect(offlineCalendarDay('2026-09-02T00:00:00Z')).toBe('2026-09-02')
    expect(offlineCalendarDay('2026-02-30')).toBe(null)
    expect(offlineDateLabel('2026-09-02')).not.toContain('Invalid')
  })
  it('includes enrollment, excludes withdrawal/completion and does not infer absence', () => {
    expect(offlineProgramParticipantEligible(participant, '2026-09-01')).toBe(false)
    expect(offlineProgramParticipantEligible(participant, '2026-09-02')).toBe(true)
    expect(offlineProgramParticipantEligible(participant, '2026-09-04')).toBe(true)
    expect(offlineProgramParticipantEligible(participant, '2026-09-05')).toBe(false)
    expect(offlineProgramParticipantEligible({ ...participant, completed_at: '2026-09-03' }, '2026-09-03')).toBe(false)
    expect(offlineAttendanceLabel()).toBe('Pendiente')
  })
  it('keeps enrollment identities and retired history separate even for the same contact', () => {
    const active = { ...participant, id: 'b', status: 'active', dropped_at: undefined }
    const rosters = offlineProgramRosters({ id: 'p', version: 1, name: 'P', participants: [participant, active] })
    expect(rosters.active.map(item => item.id)).toEqual(['b'])
    expect(rosters.history.map(item => item.id)).toEqual(['a'])
    expect(rosters.all).toHaveLength(2)
  })
})
