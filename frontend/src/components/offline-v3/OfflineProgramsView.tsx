import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, BookOpenCheck, CalendarDays, ChevronRight, Loader2, RefreshCw, Users } from 'lucide-react'
import type { OfflineDataGateway } from '@/offline-v3/gateway'
import type { OfflineProgram, OfflineProgramParticipant } from '@/offline-v3/types'
import { offlineAttendanceLabel, offlineDateLabel, offlineProgramParticipantEligible, offlineProgramRosters } from '@/offline-v3/programReadModel'

function participantName(item: OfflineProgramParticipant) { return item.display_name || item.name || 'Contacto' }
function More({ count, visible, show }: { count: number; visible: number; show: () => void }) { return count > visible ? <button className="offline-button offline-button--secondary" onClick={show}>Mostrar más ({visible} de {count})</button> : null }

function ProgramDetail({ program }: { program: OfflineProgram }) {
  const rosters = useMemo(() => offlineProgramRosters(program), [program])
  const sessions = program.sessions || []
  const [sessionID, setSessionID] = useState(sessions[0]?.id || '')
  useEffect(() => { setSessionID(current => sessions.some(item => item.id === current) ? current : sessions[0]?.id || '') }, [program.sessions])
  const [sessionLimit, setSessionLimit] = useState(50), [rosterLimit, setRosterLimit] = useState(50), [historyLimit, setHistoryLimit] = useState(50), [attendanceLimit, setAttendanceLimit] = useState(50), [outsideLimit, setOutsideLimit] = useState(50)
  const session = sessions.find(item => item.id === sessionID)
  const eligible = session ? rosters.all.filter(item => offlineProgramParticipantEligible(item, session.date)) : []
  const attendance = new Map((program.eligible_attendance || []).filter(item => item.session_id === sessionID).map(item => [item.participant_id, item]))
  const participants = new Map(rosters.all.map(item => [item.id, item]))
  return <>
    <header className="offline-module__header"><div><p className="offline-eyebrow">Programa · solo lectura</p><h1>{program.name}</h1><p>{program.description || 'Sin descripción'}</p></div><span className="offline-pill">{program.status || 'Activo'}</span></header>
    <div className="offline-stat-grid"><div><Users /><strong>{rosters.active.length}</strong><span>Participantes activos</span></div><div><CalendarDays /><strong>{sessions.length}</strong><span>Sesiones incluidas</span></div></div>
    <div className="offline-two-columns">
      <section className="offline-panel"><h2>Sesiones incluidas</h2><p className="offline-muted">Elige una sesión para consultar su asistencia.</p>{sessions.slice(0, sessionLimit).map(item => <button className="offline-row offline-session-choice" key={item.id} aria-pressed={sessionID === item.id} onClick={() => { setSessionID(item.id); setAttendanceLimit(50) }}><CalendarDays /><span><strong>{item.title || item.topic || 'Sesión'}</strong><small>{offlineDateLabel(item.date)}</small></span></button>)}{!sessions.length && <p>La copia no contiene sesiones.</p>}<More count={sessions.length} visible={sessionLimit} show={() => setSessionLimit(current => current + 50)} /></section>
      <section className="offline-panel"><h2>Participantes activos</h2>{rosters.active.slice(0, rosterLimit).map(item => <article className="offline-row" key={item.id}><span className="offline-avatar">{participantName(item).slice(0, 2).toUpperCase()}</span><span><strong>{participantName(item)}</strong><small>Inicio: {offlineDateLabel(item.enrolled_at)}</small></span></article>)}{!rosters.active.length && <p>No hay participantes activos en esta copia.</p>}<More count={rosters.active.length} visible={rosterLimit} show={() => setRosterLimit(current => current + 50)} /></section>
    </div>
    {session && <section className="offline-panel"><h2>Asistencia · {session.title || session.topic || offlineDateLabel(session.date)}</h2><p className="offline-muted">Solo participaciones elegibles en la fecha de esta sesión. Pendiente no significa ausencia.</p>{eligible.slice(0, attendanceLimit).map(item => { const row = attendance.get(item.id); return <article className="offline-row" key={item.id}><span><strong>{participantName(item)}</strong><small>{row?.notes || offlineDateLabel(session.date)}</small></span><span className="offline-pill">{offlineAttendanceLabel(row?.status)}</span></article> })}{!eligible.length && <p>No hay participaciones elegibles en la fecha seleccionada.</p>}<More count={eligible.length} visible={attendanceLimit} show={() => setAttendanceLimit(current => current + 50)} /></section>}
    <details className="offline-panel"><summary>Participaciones retiradas o completadas ({rosters.history.length})</summary>{rosters.history.slice(0, historyLimit).map(item => <article className="offline-row" key={item.id}><span><strong>{participantName(item)}</strong><small>Inicio: {offlineDateLabel(item.enrolled_at)} · {item.dropped_at ? `Retiro: ${offlineDateLabel(item.dropped_at)}` : `Completado: ${offlineDateLabel(item.completed_at)}`}</small></span></article>)}<More count={rosters.history.length} visible={historyLimit} show={() => setHistoryLimit(current => current + 50)} /></details>
    <details className="offline-panel"><summary>Historial de asistencia fuera de matrícula ({program.out_of_window_history?.length || 0})</summary><p className="offline-muted">Estos registros históricos no cuentan como asistencia elegible ni se eliminan.</p>{(program.out_of_window_history || []).slice(0, outsideLimit).map(item => <article className="offline-row" key={item.id}><span><strong>{participants.has(item.participant_id) ? participantName(participants.get(item.participant_id)!) : 'Participación histórica'}</strong><small>{offlineDateLabel(item.session_date)} · {item.notes}</small></span><span className="offline-pill">{offlineAttendanceLabel(item.status)}</span></article>)}<More count={program.out_of_window_history?.length || 0} visible={outsideLimit} show={() => setOutsideLimit(current => current + 50)} /></details>
  </>
}

export default function OfflineProgramsView({ gateway, programId, navigate, refreshToken }: { gateway: OfflineDataGateway; programId?: string; navigate: (path: string) => void; refreshToken?: string }) {
  const [programs, setPrograms] = useState<OfflineProgram[]>([]), [program, setProgram] = useState<OfflineProgram | null>(null)
  const [nextCursor, setNextCursor] = useState<string>(), [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false), [error, setError] = useState(''), [attempt, setAttempt] = useState(0)
  const generation = useRef(0)
  const scope = useRef({ gateway, programId })
  useEffect(() => {
    const changed = generation.current === 0 || scope.current.gateway !== gateway || scope.current.programId !== programId
    scope.current = { gateway, programId }
    const expected = ++generation.current
    if (changed) { setLoading(true); setProgram(null); setPrograms([]); setNextCursor(undefined) }
    setError(''); setLoadingMore(false)
    const request = programId ? gateway.program(programId).then(result => result.item) : gateway.programs()
    void request.then(result => { if (expected !== generation.current) return; if (programId) setProgram(result as OfflineProgram); else { const page = result as Awaited<ReturnType<typeof gateway.programs>>; setPrograms(page.items); setNextCursor(page.next_cursor) } })
      .catch(cause => { if (expected === generation.current) { setProgram(null); setPrograms([]); setError(cause instanceof Error ? cause.message : 'No se pudo cargar el programa.') } }).finally(() => { if (expected === generation.current) setLoading(false) })
    return () => { generation.current++ }
  }, [gateway, programId, attempt, refreshToken])
  async function loadMore() {
    if (!nextCursor || loadingMore) return
    const expected = generation.current; setLoadingMore(true)
    try { const page = await gateway.programs(nextCursor); if (expected !== generation.current) return; setPrograms(current => [...current, ...page.items.filter(item => !current.some(existing => existing.id === item.id))]); setNextCursor(page.next_cursor) }
    catch (cause) { if (expected === generation.current) setError(cause instanceof Error ? cause.message : 'No se pudieron cargar más programas.') }
    finally { if (expected === generation.current) setLoadingMore(false) }
  }
  return <section className="offline-module">
    {programId && <button className="offline-back" onClick={() => navigate('/dashboard/programs')}>← Programas</button>}
    {!programId && <header className="offline-module__header"><div><p className="offline-eyebrow">Programas · solo lectura</p><h1>Programas disponibles</h1><p>Participantes, sesiones y asistencia en la copia autorizada.</p></div></header>}
    {error && <div className="offline-alert offline-alert--error" role="alert"><AlertCircle /><span>{error}</span><button className="offline-button offline-button--secondary" onClick={() => setAttempt(current => current + 1)}>Reintentar</button></div>}
    {loading ? <div className="offline-loading"><Loader2 className="spin" />Cargando copia protegida…</div> : programId ? program && <ProgramDetail key={program.id} program={program} /> : programs.length === 0 && !error ? <div className="offline-empty"><BookOpenCheck /><h2>No hay programas preparados</h2><p>Selecciona programas online y espera a que la preparación termine.</p></div> : <div className="offline-card-grid">{programs.map(item => <button className="offline-program-card" key={item.id} onClick={() => navigate(`/dashboard/programs/${item.id}`)}><span className="offline-program-card__icon"><BookOpenCheck /></span><span><strong>{item.name}</strong><small>{item.participant_count ?? offlineProgramRosters(item).active.length} participantes activos · {item.session_count ?? item.sessions?.length ?? 0} sesiones</small></span><ChevronRight /></button>)}</div>}
    {nextCursor && <button className="offline-button offline-button--secondary offline-load-more" disabled={loadingMore} onClick={() => void loadMore()}><RefreshCw className={loadingMore ? 'spin' : ''} />Cargar más</button>}
  </section>
}
