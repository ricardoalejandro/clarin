// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { offlineProgramAttendanceHistory, offlineProgramAttendanceStats, offlineProgramDashboard, offlineProgramDerivedState } from './programDerivedState'
import type { OfflineV5Snapshot } from './types'

function snapshot(id = 'program'): OfflineV5Snapshot {
  return { protocol_version: 5, manifest_id: 'manifest', manifest_revision: 1, selection_id: id, root_selection_id: id, root_resource_id: id, module: 'programs', resource_type: 'program', resource_id: id, dependency: false, head_version: 1, content_hash: 'hash', payload_json: '{}', tombstone: false, generated_at: '2026-10-10T00:00:00Z', payload: {
    program: { id, name: id, status: 'active', type: 'course', created_at: '2026-10-01' },
    active_roster: [{ id: `${id}-active`, program_id: id, contact_id: 'same-contact', contact_name: 'Ada', status: 'active', enrolled_at: '2026-10-02' }],
    historical_participations: [{ id: `${id}-retired`, program_id: id, contact_id: 'other-contact', contact_name: 'Retired', status: 'dropped', enrolled_at: '2026-10-01', dropped_at: '2026-10-03' }],
    sessions: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-11'].map((date, i) => ({ id: `${id}-s${i}`, program_id: id, date, title: `Clase ${i}`, created_at: '2026-10-01T00:00:00Z' })),
    eligible_attendance: [
      { id: 'a1', session_id: `${id}-s1`, participant_id: `${id}-active`, status: 'present' },
      { id: 'a2', session_id: `${id}-s2`, participant_id: `${id}-active`, status: 'absent' },
      { id: 'r1', session_id: `${id}-s1`, participant_id: `${id}-retired`, status: 'present' },
    ], out_of_window_history: [{ id: 'outside', session_id: `${id}-s0`, participant_id: `${id}-active`, status: 'late' }, { id: 'closed', session_id: `${id}-s2`, participant_id: `${id}-retired`, status: 'absent' }],
    attendance_observations: [{ id: 'note', session_id: `${id}-s3`, participant_id: `${id}-retired`, created_at: '2026-10-04T10:00:00Z', notes: 'Historical note' }],
    goals: { attendance_goal_percent: 80, transfer_goal_percent: 70 }, global_goals: { attendance_goal_percent: 90, transfer_goal_percent: 75 },
    health: { participants: [{ participant_id: `${id}-active`, notes_count: 0 }] },
  } }
}
const url = (query = '') => new URL(`https://clarin.test/?${query}`)
const derive = (value = snapshot()) => offlineProgramDerivedState(value, [], '2026-10-10')

describe('Program offline derived state follows canonical attendance semantics', () => {
  it('normalizes the real Go snapshot DTO using its authenticated root without accepting contradictory roots', () => {
    const value = snapshot()
    value.payload.active_roster = [{ id: 'program-active', contact_id: 'same-contact', name: 'Ada', phone: '00001', status: 'active', enrolled_at: '2026-10-02' }, { id: 'foreign', program_id: 'other', contact_id: 'outside' }]
    value.payload.sessions = [{ id: 'program-s1', date: '2026-10-02', title: 'From snapshot' }, { id: 'foreign-session', program_id: 'other', date: '2026-10-02' }]
    const state = derive(value)
    expect(state.participants[0]).toMatchObject({ program_id: 'program', contact_name: 'Ada', contact_phone: '00001' })
    expect(state.participants.some(value => value.id === 'foreign')).toBe(false)
    expect(state.sessions).toMatchObject([{ id: 'program-s1', program_id: 'program' }])
    expect(state.health).toMatchObject({ attendance_rate: 100, session_count: 1 })
  })
  it('excludes future and outside-window attendance, counts only active roster in current health', () => {
    const state = derive()
    expect(state.health).toMatchObject({ participant_count: 1, active_count: 1, dropped_count: 1, session_count: 4, attendance_rate: 50, health: 'watch', participants: [{ participant_id: 'program-active', present: 1, absent: 1, late: 0, eligible_sessions: 3, marked_sessions: 2, pending: 1, notes_count: 0, reasons: ['una falta pendiente', 'sin seguimiento registrado'] }] })
    const stats = offlineProgramAttendanceStats(state, url())
    expect(stats.participant_stats).toHaveLength(1)
    expect(stats.session_stats.find(value => value.session_id === 'program-s1')).toMatchObject({ present: 2 })
    expect(stats.session_stats.find(value => value.session_id === 'program-s2')).toMatchObject({ absent: 1 })
    expect(stats.session_stats.some(value => value.session_id === 'program-s4')).toBe(false)
  })

  it('updates enrollment, lifecycle, goals and notes from only the selected root overlays', () => {
    const value = snapshot()
    const state = offlineProgramDerivedState(value, [
      { root_selection_id: 'program', entity_type: 'program_participant', entity_id: 'program-active', value: { ...(value.payload.active_roster as object[])[0], enrolled_at: '2026-10-03' } },
      { root_selection_id: 'program', entity_type: 'program_observation', entity_id: 'new-note', value: { id: 'new-note', scope: 'participant', participant_id: 'program-active', notes: 'Follow-up', created_at: '2026-10-10T00:00:00Z' } },
      { root_selection_id: 'foreign', entity_type: 'program_attendance', entity_id: 'foreign', value: { session_id: 'program-s2', participant_id: 'program-active', status: 'present' } },
    ], '2026-10-10')
    expect(state.health).toMatchObject({ attendance_rate: 0, participants: [{ notes_count: 1, eligible_sessions: 2, pending: 1, reasons: ['una falta pendiente'] }] })
    expect(state.sessionObservations).toHaveLength(0)
    expect(state.attendanceObservations).toHaveLength(1)
    expect(state.participantNotes).toHaveLength(1)
    const retired = offlineProgramDerivedState(value, [{ root_selection_id: 'program', entity_type: 'program_participant', entity_id: 'program-active', value: { ...(value.payload.active_roster as object[])[0], status: 'completed', completed_at: '2026-10-03' } }], '2026-10-10')
    expect(retired.health).toMatchObject({ active_count: 0, completed_count: 1, attendance_rate: null, participants: [], health: 'no_data' })
    expect(offlineProgramAttendanceStats(retired, url()).session_stats.find(value => value.session_id === 'program-s1')).toMatchObject({ present: 2 })
  })

  it('preserves both sides of the lifecycle as real history without counting them in rates', () => {
    const state = derive()
    const retired = state.participants.find(value => value.id === 'program-retired')!
    const history = offlineProgramAttendanceHistory(state, retired, url())
    expect(history.summary).toMatchObject({ eligible_sessions: 2, marked_sessions: 1, present: 1, absent: 0, attendance_rate: 100, punctuality_rate: 100, pending: 1 })
    expect(history.historical_sessions.map(value => value.session_id)).toEqual(['program-s3', 'program-s2'])
    expect(history.historical_sessions[0]).toMatchObject({ outside_enrollment_period: true, observation_count: 1, status: null })
    const activeHistory = offlineProgramAttendanceHistory(state, state.participants[0], url())
    expect(activeHistory.summary).toMatchObject({ punctuality_rate: 50 })
    expect(activeHistory.historical_sessions).toMatchObject([{ session_id: 'program-s0', status: 'late' }])
  })

  it('pages combined history with participant-bound cursors and preserves global ordinals', () => {
    const state = derive()
    const first = offlineProgramAttendanceHistory(state, state.participants[0], url('limit=2'))
    expect(first.sessions.map(value => value.ordinal)).toEqual([4, 3])
    const second = offlineProgramAttendanceHistory(state, state.participants[0], url(`limit=2&cursor=${first.next_cursor}`))
    expect(second.sessions).toMatchObject([{ ordinal: 2 }])
    expect(second.historical_sessions).toMatchObject([{ ordinal: 1 }])
    expect(second.next_cursor).toBeNull()
    expect(() => offlineProgramAttendanceHistory(state, state.participants[1], url(`cursor=${first.next_cursor}`))).toThrowError(/no pertenece/)
  })

  it('weights dashboard by actual marked attendance and keeps the same Contact separate per Program', () => {
    const first = derive(), secondSnapshot = snapshot('second')
    secondSnapshot.payload.eligible_attendance = [{ session_id: 'second-s1', participant_id: 'second-active', status: 'present' }]
    const second = derive(secondSnapshot)
    const dashboard = offlineProgramDashboard([first, second], url())
    expect(dashboard).toMatchObject({ program_count: 2, participant_count: 2, attendance_goal_percent: 90, transfer_goal_percent: 75, dropped_count: 2 })
    expect(dashboard.attendance_rate).toBeCloseTo(200 / 3)
    expect(dashboard.groups.map(value => value.attendance_rate)).toEqual([50, 100])
  })

  it('filters held stats by month without converting pending attendance into absence', () => {
    const state = derive()
    expect(offlineProgramAttendanceStats(state, url('months=2026-09')).participant_stats[0]).toMatchObject({ rate: null, total_sessions: 0, marked_sessions: 0, absent: 0 })
    expect(() => offlineProgramAttendanceStats(state, url('months=2026-99'))).toThrowError(/mes solicitado/)
  })

  it('keeps exact rates for a large prepared roster, sparse attendance and a superseding local mark', () => {
    const value = snapshot()
    value.payload.active_roster = Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}`, program_id: 'program', contact_id: `c${i}`, status: 'active', enrolled_at: '2026-10-01' }))
    value.payload.historical_participations = []
    value.payload.out_of_window_history = []
    value.payload.sessions = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, program_id: 'program', date: '2026-10-02' }))
    value.payload.eligible_attendance = Array.from({ length: 5000 }, (_, i) => ({ id: `a${i}`, participant_id: `p${Math.floor(i / 5)}`, session_id: `s${i % 5}`, status: i % 5 === 4 ? 'absent' : 'present' }))
    const state = offlineProgramDerivedState(value, [{ root_selection_id: 'program', entity_type: 'program_attendance', entity_id: 'local', value: { id: 'local', participant_id: 'p0', session_id: 's4', status: 'present' } }], '2026-10-10')
    expect(state.health).toMatchObject({ active_count: 1000 })
    expect(state.health.attendance_rate).toBeCloseTo(80.02)
    expect((state.health.participants as Record<string, unknown>[]).find(participant => participant.participant_id === 'p0')).toMatchObject({ present: 5, absent: 0, marked_sessions: 5, pending: 195 })
    expect(offlineProgramDashboard([state], url()).attendance_rate).toBeCloseTo(80.02)
  })
})
