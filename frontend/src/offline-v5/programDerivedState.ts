import { OfflineV5Error, type OfflineV5Snapshot } from './types'

type Row = Record<string, unknown>
type Overlay = { root_selection_id: string; entity_type: string; entity_id: string; value: unknown }
type State = { snapshot: OfflineV5Snapshot; program: Row; participants: Row[]; sessions: Row[]; attendances: Row[]; attendanceByPair: ReadonlyMap<string, Row>; goals: Row; sessionObservations: Row[]; attendanceObservations: Row[]; participantNotes: Row[]; asOfDate: string; localNotes: Row[] }
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : []
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const day = (value: unknown) => typeof value === 'string' ? value.slice(0, 10) : ''
const percent = (n: number, d: number) => d ? n / d * 100 : null
const rounded = (n: number, d: number) => d ? Math.round(n / d * 1000) / 10 : null
const sum = (items: Row[], key: string) => items.reduce((total, item) => total + (Number(item[key]) || 0), 0)
const sessionKey = (session: Row) => [day(session.date), session.start_time || '00:00', session.created_at || '', session.id].join('|')
const attendanceKey = (sessionID: unknown, participantID: unknown) => `${String(sessionID)}:${String(participantID)}`
function merge(canonical: Row[], local: Row[], key: (row: Row) => string = row => String(row.id)) {
  return [...new Map([...canonical, ...local].map(row => [key(row), row])).values()]
}
export function offlineProgramEligible(participant: Row, session: Row) {
  const date = day(session.date), enrolled = day(participant.enrolled_at), dropped = day(participant.dropped_at), completed = day(participant.completed_at)
  return !!date && !!enrolled && date >= enrolled && (!dropped || date < dropped) && (!completed || date < completed)
}
export function offlineProgramParticipant(participant: Row, programID: string): Row {
  return { ...participant, program_id: participant.program_id ?? programID, contact_name: participant.contact_name ?? participant.name, contact_phone: participant.contact_phone ?? participant.phone ?? null }
}

/** One derived dataset feeds the ordinary Program API routes after every local write. */
export function offlineProgramDerivedState(snapshot: OfflineV5Snapshot, overlays: readonly Overlay[], asOfDate: string) {
  const local = overlays.filter(value => value.root_selection_id === snapshot.root_selection_id)
  const values = (type: string) => local.filter(value => value.entity_type === type).map(value => object(value.value))
  const program = { ...object(snapshot.payload.program), ...values('program').at(-1) }
  const participants = merge([...rows(snapshot.payload.active_roster), ...rows(snapshot.payload.historical_participations)].map(value => offlineProgramParticipant(value, snapshot.root_resource_id)), values('program_participant')).filter(value => value.program_id === program.id)
  const topics = rows(snapshot.payload.session_topics)
  const sessions = merge(rows(snapshot.payload.sessions).map(value => ({ ...value, program_id: value.program_id ?? snapshot.root_resource_id, topics: Array.isArray(value.topics) ? value.topics : topics.filter(topic => topic.session_id === value.id) })), values('program_session')).filter(value => value.program_id === program.id)
  const attendances = merge([...rows(snapshot.payload.eligible_attendance), ...rows(snapshot.payload.out_of_window_history)], values('program_attendance'), value => attendanceKey(value.session_id, value.participant_id))
  const attendanceByPair = new Map(attendances.map(value => [attendanceKey(value.session_id, value.participant_id), value]))
  const goals = values('program_goal').at(-1) || object(snapshot.payload.goals)
  const notes = values('program_observation')
  const sessionObservations = merge(rows(snapshot.payload.session_observations), notes.filter(note => note.scope === 'session'))
  const attendanceObservations = merge(rows(snapshot.payload.attendance_observations), notes.filter(note => note.scope === 'attendance'))
  const participantNotes = merge(rows(snapshot.payload.participant_notes), notes.filter(note => note.scope === 'participant'))
  const state = { snapshot, program, participants, sessions, attendances, attendanceByPair, goals, sessionObservations, attendanceObservations, participantNotes, asOfDate, localNotes: notes }
  const health = offlineProgramHealth(state)
  return { ...state, health }
}

function held(state: State, from = '', to = '') {
  return state.sessions.filter(session => day(session.date) <= state.asOfDate && (!from || day(session.date) >= from) && (!to || day(session.date) <= to))
}
function counts(state: State, participant: Row, sessions = held(state)) {
  const eligible = sessions.filter(session => offlineProgramEligible(participant, session))
  const statuses = eligible.map(session => ({ session, status: state.attendanceByPair.get(attendanceKey(session.id, participant.id))?.status }))
  const count = (status: string) => statuses.filter(value => value.status === status).length
  const present = count('present'), absent = count('absent'), late = count('late'), marked = present + absent + late
  return { present, absent, late, excused: 0, eligible_sessions: eligible.length, marked_sessions: marked, pending: eligible.length - marked,
    attendance_rate: percent(present + late, marked), recovery_sessions: statuses.filter(value => value.session.session_type === 'recovery' && ['present', 'late'].includes(String(value.status))).length }
}

/** Mirrors GetProgramHealth: current health includes only active participation. */
function offlineProgramHealth(state: State): Row {
  const attendanceGoal = Number(state.goals.attendance_goal_percent) || 80, transferGoal = Number(state.goals.transfer_goal_percent) || 70
  const preparedHealth = object(state.snapshot.payload.health)
  const preparedParticipants = rows(preparedHealth.participants)
  const participants = state.participants.filter(value => value.status === 'active').map(participant => {
    const stats = counts(state, participant), prepared = preparedParticipants.find(value => value.participant_id === participant.id)
    const localNotes = state.localNotes.filter(note => note.participant_id === participant.id)
    const notesCount = (Number(prepared?.notes_count) || 0) + localNotes.length
    const unresolved = Math.max(0, stats.absent - stats.recovery_sessions), reasons: string[] = []
    let health = stats.marked_sessions ? 'healthy' : 'no_data'
    if (unresolved >= 2) { health = 'critical'; reasons.push(`${unresolved} faltas no regularizadas`) }
    else if (unresolved === 1 && health === 'healthy') { health = 'watch'; reasons.push('una falta pendiente') }
    if (stats.attendance_rate != null && stats.attendance_rate < attendanceGoal && health === 'healthy') { health = 'watch'; reasons.push('asistencia bajo la meta') }
    if (unresolved > 0 && notesCount === 0) reasons.push('sin seguimiento registrado')
    if (!reasons.length) reasons.push(stats.pending ? `${stats.pending} sesiones pendientes de registrar` : stats.marked_sessions ? 'sin alertas' : 'sin asistencia registrada')
    const lastNoteAt = [...localNotes.map(note => String(note.created_at || '')), String(prepared?.last_note_at || '')].sort().at(-1) || null
    return { participant_id: participant.id, contact_id: participant.contact_id, name: participant.contact_name || 'Contacto', phone: participant.contact_phone || null,
      avatar_url: participant.avatar_url || null, avatar_revision: participant.avatar_revision || 0, status: participant.status, enrolled_at: participant.enrolled_at,
      transferred_to_level: participant.transferred_to_level || '', ...stats, health, reasons, notes_count: notesCount, last_note_at: lastNoteAt }
  }).sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'))
  const completedCount = state.participants.filter(value => value.status === 'completed').length, transferredCount = state.participants.filter(value => !!value.transferred_to_level).length
  const marked = sum(participants, 'marked_sessions'), attendanceRate = percent(sum(participants, 'present') + sum(participants, 'late'), marked), transferRate = completedCount ? transferredCount / completedCount * 100 : 0
  let health = marked ? 'healthy' : 'no_data'
  if (participants.some(value => value.health === 'critical')) health = 'critical'
  else if (participants.some(value => value.health === 'watch') && health === 'healthy') health = 'watch'
  const reasons: string[] = []
  if (attendanceRate != null && attendanceRate < attendanceGoal) { reasons.push('asistencia grupal bajo la meta'); if (health === 'healthy') health = 'watch' }
  if (completedCount && transferRate < transferGoal) reasons.push('traspaso bajo la meta')
  if (!reasons.length) reasons.push(marked ? 'grupo estable' : 'sin asistencia registrada')
  return { program_id: state.program.id, as_of_date: state.asOfDate, attendance_goal_percent: attendanceGoal, transfer_goal_percent: transferGoal,
    participant_count: participants.length, active_count: participants.length, completed_count: completedCount, dropped_count: state.participants.filter(value => value.status === 'dropped').length,
    transferred_count: transferredCount, session_count: held(state).length, recovery_session_count: held(state).filter(value => value.session_type === 'recovery').length,
    attendance_rate: attendanceRate, transfer_rate: transferRate, health, reasons, participants }
}

export function offlineProgramAttendanceStats(state: State, url: URL) {
  const months = (url.searchParams.get('months') || '').split(',').filter(Boolean)
  if (months.some(value => !/^\d{4}-(0[1-9]|1[0-2])$/.test(value))) throw new OfflineV5Error('invalid_request_body', 'El mes solicitado no es válido.')
  const sessions = held(state).filter(session => !months.length || months.includes(day(session.date).slice(0, 7)))
  const sessionStats = sessions.map(session => {
    const eligible = new Set(state.participants.filter(participant => offlineProgramEligible(participant, session)).map(value => value.id))
    const attendance = state.attendances.filter(value => value.session_id === session.id && eligible.has(value.participant_id))
    const count = (status: string) => attendance.filter(value => value.status === status).length
    return { session_id: session.id, title: session.title || 'Sesión', topic: session.topic || '', date: session.date, confirmed: count('confirmed'), present: count('present'), absent: count('absent'), late: count('late'), excused: 0 }
  }).sort((a, b) => day(a.date).localeCompare(day(b.date)))
  const participantStats = state.participants.filter(value => value.status === 'active').map(participant => {
    const stats = counts(state, participant, sessions)
    return { participant_id: participant.id, name: participant.contact_name || 'Contacto', ...stats, total_sessions: stats.eligible_sessions, rate: stats.attendance_rate }
  }).sort((a, b) => b.present - a.present || String(a.name).localeCompare(String(b.name), 'es'))
  return { success: true, session_stats: sessionStats, participant_stats: participantStats }
}

/** Held sessions outside either lifecycle boundary remain history when real activity exists. */
export function offlineProgramAttendanceHistory(state: State, participant: Row, url: URL) {
  const stats = counts(state, participant), goal = Number(state.goals.attendance_goal_percent) || 80
  const eligible = (session: Row) => offlineProgramEligible(participant, session)
  const ordinal = new Map([...state.sessions].sort((a, b) => sessionKey(a).localeCompare(sessionKey(b))).map((session, i) => [session.id, i + 1]))
  const history = held(state).flatMap(session => {
    const attendance = state.attendanceByPair.get(attendanceKey(session.id, participant.id))
    const observations = state.attendanceObservations.filter(value => value.session_id === session.id && value.participant_id === participant.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    if (!eligible(session) && !attendance && !observations.length) return []
    return [{ session_id: session.id, ordinal: ordinal.get(session.id), title: session.title || `Sesión ${ordinal.get(session.id)}`, date: session.date, start_time: session.start_time || null, end_time: session.end_time || null,
      session_type: session.session_type || 'regular', topics: session.topics || [], status: attendance?.status || null, observation_count: observations.length, observation_preview: observations[0] || null,
      outside_enrollment_period: !eligible(session), sort_key: sessionKey(session) }]
  }).sort((a, b) => b.sort_key.localeCompare(a.sort_key))
  const rawLimit = Number(url.searchParams.get('limit') || 25), cursor = url.searchParams.get('cursor') || ''
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) throw new OfflineV5Error('invalid_request_body', 'El límite del historial no es válido.')
  const index = cursor ? history.findIndex(value => `${state.program.id}:${participant.id}:${value.session_id}` === cursor) : -1
  if (cursor && index < 0) throw new OfflineV5Error('invalid_cursor', 'La página del historial no pertenece a esta participación.')
  const page = history.slice(index + 1, index + 1 + rawLimit).map(({ sort_key: _key, ...value }) => value)
  return { summary: { goal_percent: goal, eligible_sessions: stats.eligible_sessions, marked_sessions: stats.marked_sessions, pending: stats.pending, present: stats.present, absent: stats.absent, late: stats.late,
    attendance_rate: rounded(stats.present + stats.late, stats.marked_sessions), punctuality_rate: rounded(stats.present, stats.marked_sessions),
    health: stats.attendance_rate == null ? 'no_data' : stats.attendance_rate >= goal ? 'green' : stats.attendance_rate >= Math.max(0, goal - 10) ? 'amber' : 'red' },
    sessions: page.filter(value => !value.outside_enrollment_period), historical_sessions: page.filter(value => value.outside_enrollment_period),
    next_cursor: index + 1 + page.length < history.length ? `${state.program.id}:${participant.id}:${page.at(-1)?.session_id}` : null }
}

export function offlineProgramDashboard(states: State[], url: URL) {
  const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || ''
  const groups = states.filter(state => state.program.status === 'active' && state.program.type !== 'event'
    && (!from || day(state.program.created_at) >= from || state.sessions.some(value => day(value.date) >= from))
    && (!to || day(state.program.created_at) <= to || state.sessions.some(value => day(value.date) <= to))).map(state => {
    const participants = state.participants.filter(value => value.status === 'active'), sessions = held(state, from, to)
    const measurements = participants.map(participant => counts(state, participant, sessions))
    const marked = sum(measurements, 'marked_sessions'), attended = sum(measurements, 'present') + sum(measurements, 'late'), rate = percent(attended, marked)
    const completed = state.participants.filter(value => value.status === 'completed').length, transferred = state.participants.filter(value => !!value.transferred_to_level).length
    const goal = Number(state.goals.attendance_goal_percent) || 80, atRisk = measurements.filter(value => value.absent > 0).length
    let health = marked ? 'healthy' : 'no_data'
    if (atRisk || rate != null && rate < goal) health = 'watch'
    if (measurements.some(value => value.absent >= 2) || rate != null && rate < goal - 10) health = 'critical'
    return { program_id: state.program.id, name: state.program.name, status: state.program.status, color: state.program.color, participant_count: participants.length, active_count: participants.length,
      completed_count: completed, dropped_count: state.participants.filter(value => value.status === 'dropped').length, transferred_count: transferred, session_count: sessions.length,
      attendance_rate: rate, transfer_rate: completed ? transferred / completed * 100 : 0, attendance_goal_percent: goal, transfer_goal_percent: Number(state.goals.transfer_goal_percent) || 70, at_risk_count: atRisk, health,
      marked, attended }
  })
  const globalGoal = object(states[0]?.snapshot.payload.global_goals)
  const completed = sum(groups, 'completed_count'), transferred = sum(groups, 'transferred_count')
  return { ...(from ? { from } : {}), ...(to ? { to } : {}), attendance_goal_percent: Number(globalGoal.attendance_goal_percent) || 80, transfer_goal_percent: Number(globalGoal.transfer_goal_percent) || 70,
    program_count: groups.length, active_program_count: groups.length, participant_count: sum(groups, 'participant_count'), completed_count: completed, dropped_count: sum(groups, 'dropped_count'), transferred_count: transferred,
    attendance_rate: percent(sum(groups, 'attended'), sum(groups, 'marked')), transfer_rate: completed ? transferred / completed * 100 : 0,
    groups_below_goal: groups.filter(group => group.attendance_rate != null && group.attendance_rate < group.attendance_goal_percent).length,
    critical_participants: sum(groups, 'at_risk_count'), groups: groups.map(({ attended: _attended, marked: _marked, ...group }) => group) }
}
