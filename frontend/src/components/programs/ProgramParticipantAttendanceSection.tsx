'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CalendarDays, CheckCircle2, Clock, History, Loader2, MessageSquarePlus, RefreshCw, RotateCcw, Target } from 'lucide-react'
import ObservationHistoryModal, { type HistoryObservation } from '@/components/ObservationHistoryModal'
import type {
  ProgramAttendanceObservation,
  ProgramParticipantAttendanceHistoryResponse,
  ProgramParticipantAttendanceHistorySession,
  ProgramParticipantAttendanceHistorySummary,
} from '@/types/program'

interface ProgramParticipantAttendanceSectionProps {
  programId: string
  participantId: string
  participantName: string
  enrolledAt: string
}

const EMPTY_SUMMARY: ProgramParticipantAttendanceHistorySummary = {
  goal_percent: 0,
  eligible_sessions: 0,
  marked_sessions: 0,
  pending: 0,
  present: 0,
  absent: 0,
  late: 0,
  attendance_rate: null,
  punctuality_rate: null,
  health: 'no_data',
}

const formatDate = (value: string) => {
  const datePart = value?.split('T')[0]
  if (!datePart) return 'Fecha no disponible'
  const date = new Date(`${datePart}T12:00:00`)
  if (Number.isNaN(date.getTime())) return datePart
  return date.toLocaleDateString('es-PE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

const statusPresentation = (status: ProgramParticipantAttendanceHistorySession['status']) => {
  if (status === 'present') return { letter: 'P', label: 'Estuvo presente', badge: 'border-emerald-200 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' }
  if (status === 'absent') return { letter: 'F', label: 'Faltó', badge: 'border-red-200 bg-red-50 text-red-700', dot: 'bg-red-500' }
  if (status === 'late') return { letter: 'T', label: 'Asistió, llegó tarde', badge: 'border-amber-200 bg-amber-50 text-amber-800', dot: 'bg-amber-500' }
  return { letter: '—', label: 'Sin registrar', badge: 'border-slate-200 bg-slate-50 text-slate-500', dot: 'bg-slate-300' }
}

const observationToHistory = (observation: ProgramAttendanceObservation): HistoryObservation => ({
  id: observation.id,
  contact_id: null,
  lead_id: null,
  type: 'attendance',
  direction: null,
  outcome: null,
  notes: observation.notes,
  created_by_name: observation.created_by_name || null,
  created_at: observation.created_at,
  source_label: observation.source_label || null,
})

export default function ProgramParticipantAttendanceSection({
  programId,
  participantId,
  participantName,
  enrolledAt,
}: ProgramParticipantAttendanceSectionProps) {
  const [summary, setSummary] = useState(EMPTY_SUMMARY)
  const [sessions, setSessions] = useState<ProgramParticipantAttendanceHistorySession[]>([])
  const [historicalSessions, setHistoricalSessions] = useState<ProgramParticipantAttendanceHistorySession[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [pageError, setPageError] = useState('')
  const [historicalOpen, setHistoricalOpen] = useState(false)
  const requestRef = useRef<AbortController | null>(null)
  const requestSequence = useRef(0)

  const [selectedSession, setSelectedSession] = useState<ProgramParticipantAttendanceHistorySession | null>(null)
  const [observations, setObservations] = useState<HistoryObservation[]>([])
  const [observationsLoading, setObservationsLoading] = useState(false)
  const [observationsError, setObservationsError] = useState('')
  const [composerInitiallyOpen, setComposerInitiallyOpen] = useState(false)
  const observationRequestRef = useRef<AbortController | null>(null)
  const observationSequence = useRef(0)

  const loadHistory = useCallback(async (reset: boolean, silent = false) => {
    if (!programId || !participantId) return
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    const sequence = ++requestSequence.current
    if (reset) {
      if (silent) setPageError('')
      else {
        setLoading(true)
        setError('')
      }
    } else {
      setLoadingMore(true)
      setPageError('')
    }
    try {
      const cursor = reset ? '' : nextCursor || ''
      const params = new URLSearchParams({ limit: '25' })
      if (cursor) params.set('cursor', cursor)
      const token = localStorage.getItem('token') || ''
      const response = await fetch(`/api/programs/${programId}/participants/${participantId}/attendance-history?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      const raw = await response.json().catch(() => ({}))
      const data = (raw.attendance || raw) as ProgramParticipantAttendanceHistoryResponse
      if (!response.ok || data.success === false) throw new Error(data.error || 'No se pudo cargar la asistencia del participante.')
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      const nextSessions = Array.isArray(data.sessions) ? data.sessions : []
      setSummary(data.summary || EMPTY_SUMMARY)
      setSessions(current => reset ? nextSessions : [...current, ...nextSessions.filter(item => !current.some(existing => existing.session_id === item.session_id))])
      const nextHistorical = Array.isArray(data.historical_sessions) ? data.historical_sessions : []
      setHistoricalSessions(current => reset ? nextHistorical : [...current, ...nextHistorical.filter(item => !current.some(existing => existing.session_id === item.session_id))])
      setNextCursor(data.next_cursor || null)
    } catch (caught) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      const message = caught instanceof Error ? caught.message : 'No se pudo cargar la asistencia del participante.'
      if (reset && !silent) setError(message)
      else setPageError(message)
    } finally {
      if (!controller.signal.aborted && sequence === requestSequence.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [nextCursor, participantId, programId])

  useEffect(() => {
    setSummary(EMPTY_SUMMARY)
    setSessions([])
    setHistoricalSessions([])
    setNextCursor(null)
    setHistoricalOpen(false)
    setSelectedSession(null)
    void loadHistory(true)
    return () => requestRef.current?.abort()
    // `nextCursor` is deliberately excluded: changing pages must not restart the history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrolledAt, participantId, programId])

  const loadObservations = useCallback(async (session: ProgramParticipantAttendanceHistorySession) => {
    observationRequestRef.current?.abort()
    const controller = new AbortController()
    observationRequestRef.current = controller
    const sequence = ++observationSequence.current
    setObservationsLoading(true)
    setObservationsError('')
    try {
      const token = localStorage.getItem('token') || ''
      const response = await fetch(`/api/programs/${programId}/sessions/${session.session_id}/participants/${participantId}/attendance-observations`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.success === false) throw new Error(data.error || 'No se pudieron cargar las observaciones.')
      if (controller.signal.aborted || sequence !== observationSequence.current) return
      setObservations((Array.isArray(data.observations) ? data.observations : []).map(observationToHistory))
    } catch (caught) {
      if (controller.signal.aborted || sequence !== observationSequence.current) return
      setObservations([])
      setObservationsError(caught instanceof Error ? caught.message : 'No se pudieron cargar las observaciones.')
    } finally {
      if (!controller.signal.aborted && sequence === observationSequence.current) setObservationsLoading(false)
    }
  }, [participantId, programId])

  useEffect(() => () => observationRequestRef.current?.abort(), [])

  const openObservations = (session: ProgramParticipantAttendanceHistorySession, openComposer: boolean) => {
    setSelectedSession(session)
    setComposerInitiallyOpen(openComposer)
    const preview = session.observation_preview || session.latest_observation
    setObservations(preview ? [observationToHistory(preview)] : [])
    void loadObservations(session)
  }

  const health = useMemo(() => {
    if (summary.health === 'green') return { label: 'En meta', shell: 'border-emerald-200 bg-emerald-50', text: 'text-emerald-700', bar: 'bg-emerald-500' }
    if (summary.health === 'amber') return { label: 'Por atender', shell: 'border-amber-200 bg-amber-50', text: 'text-amber-800', bar: 'bg-amber-500' }
    if (summary.health === 'red') return { label: 'En riesgo', shell: 'border-red-200 bg-red-50', text: 'text-red-700', bar: 'bg-red-500' }
    if (summary.eligible_sessions > 0) return { label: 'Pendiente', shell: 'border-slate-200 bg-slate-50', text: 'text-slate-500', bar: 'bg-slate-300' }
    if (historicalSessions.length > 0) return { label: 'Solo historial', shell: 'border-slate-200 bg-slate-50', text: 'text-slate-500', bar: 'bg-slate-300' }
    return { label: 'Sin sesiones', shell: 'border-slate-200 bg-slate-50', text: 'text-slate-500', bar: 'bg-slate-300' }
  }, [historicalSessions.length, summary.eligible_sessions, summary.health])

  const renderSession = (session: ProgramParticipantAttendanceHistorySession, historical = false) => {
    const status = statusPresentation(session.status)
    const preview = session.observation_preview || session.latest_observation
    const remainingObservations = Math.max(0, session.observation_count - (preview ? 1 : 0))
    return <article key={`${historical ? 'historical-' : ''}${session.session_id}`} className="relative pl-7">
      <span className={`absolute left-[5px] top-5 h-3 w-3 rounded-full ring-4 ring-white ${status.dot}`} aria-hidden="true" />
      <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-[11px] font-bold text-slate-400">#{session.ordinal}</span>
              <h5 className="min-w-0 break-words text-sm font-bold text-slate-900">{session.title || `Sesión ${session.ordinal}`}</h5>
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
              <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" />{formatDate(session.date)}</span>
              {session.start_time && <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" />{session.start_time.slice(0, 5)}</span>}
              {session.session_type === 'recovery' && <span className="inline-flex items-center gap-1 font-semibold text-blue-600"><RotateCcw className="h-3.5 w-3.5" />Recuperación</span>}
            </p>
          </div>
          <span className={`inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-bold ${status.badge}`} aria-label={`${status.letter}: ${status.label}`}>
            <span className="text-sm">{status.letter}</span><span className="hidden min-[390px]:inline">{status.label}</span>
          </span>
        </div>

        {Array.isArray(session.topics) && session.topics.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">
          {session.topics.slice(0, 2).map((topic, index) => <span key={topic.id || `${topic.title}-${index}`} className="max-w-full truncate rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-medium text-emerald-700">{topic.course_name ? `${topic.course_name} · ` : ''}{topic.title}</span>)}
          {session.topics.length > 2 && <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-500">+{session.topics.length - 2}</span>}
        </div>}

        {preview && <button type="button" onClick={() => openObservations(session, false)} className="mt-3 block min-h-11 w-full rounded-xl bg-slate-50 px-3 py-2 text-left transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
          <span className="line-clamp-2 text-xs leading-relaxed text-slate-700">{preview.notes}</span>
          <span className="mt-1 block text-[10px] text-slate-400">{preview.created_by_name || 'Usuario'} · {new Date(preview.created_at).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })}{remainingObservations > 0 ? ` · +${remainingObservations} más` : ''}</span>
        </button>}

        <div className="mt-2 flex justify-end">
          <button type="button" onClick={() => openObservations(session, !preview)} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
            <MessageSquarePlus className="h-4 w-4" />{session.observation_count > 0 ? `Observaciones (${session.observation_count})` : 'Añadir observación'}
          </button>
        </div>
      </div>
    </article>
  }

  if (loading) return <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4" aria-label="Cargando seguimiento de asistencia">
    <div className="h-5 w-52 animate-pulse rounded bg-slate-200" />
    <div className="mt-4 h-28 animate-pulse rounded-2xl bg-slate-100" />
    <div className="mt-4 space-y-3"><div className="h-28 animate-pulse rounded-2xl bg-slate-100" /><div className="h-28 animate-pulse rounded-2xl bg-slate-100" /></div>
  </section>

  if (error) return <section className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4" role="alert">
    <div className="flex items-start gap-3"><AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" /><div className="min-w-0"><h4 className="text-sm font-bold text-red-800">No se pudo cargar la asistencia</h4><p className="mt-1 text-xs leading-relaxed text-red-700">{error}</p></div></div>
    <button type="button" onClick={() => void loadHistory(true)} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-red-700 hover:bg-red-100"><RefreshCw className="h-4 w-4" />Reintentar</button>
  </section>

  return <>
    <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4" aria-labelledby="participant-attendance-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 id="participant-attendance-title" className="flex items-center gap-2 text-sm font-bold text-slate-900"><CheckCircle2 className="h-4 w-4 text-emerald-600" />Asistencia y progreso</h4>
          <p className="mt-1 text-xs text-slate-500">Desde su incorporación: {formatDate(enrolledAt)}</p>
        </div>
        <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-bold ${health.shell} ${health.text}`}>{health.label}</span>
      </div>

      <div className={`mt-4 rounded-2xl border p-3.5 ${health.shell}`}>
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Asistencia efectiva</p>
            <p className={`mt-1 text-3xl font-black tracking-tight ${health.text}`}>{summary.attendance_rate == null ? '—' : `${Math.round(summary.attendance_rate)}%`}</p>
          </div>
          <div className="text-right text-[11px] text-slate-500">
            <p className="inline-flex items-center gap-1 font-semibold"><Target className="h-3.5 w-3.5" />Meta {summary.goal_percent}%</p>
            <p className="mt-1">{summary.marked_sessions} de {summary.eligible_sessions} registradas en el periodo</p>
          </div>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/80" aria-hidden="true"><div className={`h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${health.bar}`} style={{ width: `${Math.max(0, Math.min(100, summary.attendance_rate || 0))}%` }} /></div>
        {summary.punctuality_rate != null && <p className="mt-2 text-[11px] text-slate-500">Puntualidad: <span className="font-semibold text-slate-700">{Math.round(summary.punctuality_rate)}%</span></p>}
      </div>

      <div className="mt-3 grid grid-cols-4 gap-1.5 text-center">
        {[['P', summary.present, 'text-emerald-700 bg-emerald-50'], ['F', summary.absent, 'text-red-700 bg-red-50'], ['T', summary.late, 'text-amber-800 bg-amber-50'], ['Pend.', summary.pending, 'text-slate-600 bg-slate-100']].map(([label, value, style]) => <div key={String(label)} className={`min-w-0 rounded-xl px-1 py-2 ${style}`}><p className="text-base font-black">{value}</p><p className="truncate text-[10px] font-bold">{label}</p></div>)}
      </div>

      {sessions.length === 0 ? <div className="mt-5 rounded-2xl bg-slate-50 px-4 py-8 text-center"><History className="mx-auto h-7 w-7 text-slate-300" /><p className="mt-2 text-sm font-medium text-slate-600">No hay sesiones dentro de su periodo</p><p className="mt-1 text-xs leading-relaxed text-slate-400">{historicalSessions.length > 0 ? `${historicalSessions.length} registro${historicalSessions.length === 1 ? '' : 's'} de asistencia anterior${historicalSessions.length === 1 ? '' : 'es'} a la incorporación se conserva${historicalSessions.length === 1 ? '' : 'n'} abajo.` : 'Las sesiones se contabilizarán desde la fecha de incorporación.'}</p></div>
      : <div className="relative mt-5 space-y-3 before:absolute before:bottom-5 before:left-[10px] before:top-5 before:w-px before:bg-slate-200">{sessions.map(session => renderSession(session))}</div>}

      {pageError && <div className="mt-3 rounded-xl border border-red-100 bg-red-50 p-3 text-xs text-red-700"><p>{pageError}</p><button type="button" onClick={() => void loadHistory(false)} className="mt-2 min-h-10 rounded-lg px-2 font-semibold hover:bg-red-100">Reintentar</button></div>}
      {nextCursor && !pageError && <button type="button" onClick={() => void loadHistory(false)} disabled={loadingMore} className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60">{loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />}Ver sesiones anteriores</button>}

      {historicalSessions.length > 0 && <div className="mt-5 border-t border-slate-100 pt-4">
        <button type="button" onClick={() => setHistoricalOpen(value => !value)} className="flex min-h-11 w-full items-center justify-between rounded-xl px-2 text-left text-xs font-semibold text-slate-600 hover:bg-slate-50" aria-expanded={historicalOpen}><span>Registros fuera del periodo de participación ({historicalSessions.length})</span><span className="text-slate-400">{historicalOpen ? 'Ocultar' : 'Mostrar'}</span></button>
        {historicalOpen && <><p className="px-2 pb-3 text-[11px] leading-relaxed text-slate-400">Son registros reales y permanecen disponibles, pero no modifican el porcentaje calculado desde la incorporación.</p><div className="relative space-y-3 before:absolute before:bottom-5 before:left-[10px] before:top-5 before:w-px before:bg-slate-200">{historicalSessions.map(session => renderSession(session, true))}</div></>}
      </div>}
    </section>

    <ObservationHistoryModal
      isOpen={Boolean(selectedSession)}
      onClose={() => { setSelectedSession(null); setComposerInitiallyOpen(false); observationRequestRef.current?.abort() }}
      attendanceContext={selectedSession ? { programId, sessionId: selectedSession.session_id, participantId } : null}
      name={participantName}
      observations={observations}
      loading={observationsLoading}
      errorMessage={observationsError}
      onRetry={() => { if (selectedSession) void loadObservations(selectedSession) }}
      onObservationChange={() => { if (selectedSession) void loadObservations(selectedSession); void loadHistory(true, true) }}
      mutationMode="manage"
      initialComposerOpen={composerInitiallyOpen}
    />
  </>
}
