'use client'

import { useMemo, useState } from 'react'
import { AlertTriangle, BookOpen, Check, Search, Sparkles, X } from 'lucide-react'
import type { CourseTopic, ProgramCourse, ProgramSession, ProgramSessionTopic } from '@/types/program'

interface SessionTopicFieldProps {
  courses: ProgramCourse[]
  sessions: ProgramSession[]
  currentSessionId?: string
  selectedTopics: ProgramSessionTopic[]
  targetDate: string
  targetStartTime?: string
  onChange: (topics: ProgramSessionTopic[]) => void
}

interface TopicOption {
  course: ProgramCourse
  topic: CourseTopic
}

const normalizeSearch = (value: string) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('es')
  .trim()

export function normalizedSessionTopics(session: ProgramSession): ProgramSessionTopic[] {
  if (Array.isArray(session.topics) && session.topics.length > 0) return session.topics
  if (session.course_topic_id) {
    return [{
      kind: 'course',
      course_id: session.course_id,
      course_topic_id: session.course_topic_id,
      course_name: session.course_name,
      title: session.course_topic_title || session.topic || 'Tema histórico',
    }]
  }
  return session.topic ? [{ kind: 'free', title: session.topic }] : []
}

export function pendingActiveCourseTopics(courses: ProgramCourse[], sessions: ProgramSession[], currentSessionId?: string): TopicOption[] {
  const used = new Set(sessions
    .filter(session => session.id !== currentSessionId)
    .flatMap(normalizedSessionTopics)
    .map(topic => topic.course_topic_id)
    .filter((id): id is string => Boolean(id)))
  return [...courses]
    .sort((left, right) => left.position - right.position)
    .flatMap(course => [...course.topics]
      .sort((left, right) => left.position - right.position)
      .map(topic => ({ course, topic })))
    .filter(({ course, topic }) => course.status === 'active' && topic.status === 'active' && !used.has(topic.id))
}

function compareSessions(left: ProgramSession, right: ProgramSession) {
  const leftDate = left.date.slice(0, 10)
  const rightDate = right.date.slice(0, 10)
  if (leftDate !== rightDate) return leftDate.localeCompare(rightDate)
  const leftTime = left.start_time || '99:99'
  const rightTime = right.start_time || '99:99'
  if (leftTime !== rightTime) return leftTime.localeCompare(rightTime)
  const creationOrder = (left.created_at || '').localeCompare(right.created_at || '')
  if (creationOrder !== 0) return creationOrder
  return left.id.localeCompare(right.id)
}

export function suggestedSessionTopics(
  courses: ProgramCourse[],
  sessions: ProgramSession[],
  targetDate: string,
  targetStartTime?: string,
  currentSessionId?: string,
): { suggestions: TopicOption[]; message: string } {
  const orderedCourses = [...courses].sort((left, right) => left.position - right.position)
  const editedSession = currentSessionId ? sessions.find(session => session.id === currentSessionId) : undefined
  // A new session is created after every existing session with the same date
  // and time. During editing, retain the session's real creation order while
  // applying the date/time currently shown in the form.
  const chronologicalTarget: ProgramSession = {
    ...(editedSession || ({} as ProgramSession)),
    id: editedSession?.id || '\uffff',
    program_id: editedSession?.program_id || '',
    date: targetDate,
    start_time: targetStartTime || undefined,
    created_at: editedSession?.created_at || '9999-12-31T23:59:59.999Z',
    topics: editedSession?.topics || [],
  }
  const previous = sessions
    .filter(session => session.id !== currentSessionId && compareSessions(session, chronologicalTarget) < 0)
    .sort(compareSessions)
    .at(-1)

  if (!previous) {
    return {
      suggestions: orderedCourses.flatMap(course => {
        const topic = [...course.topics].sort((left, right) => left.position - right.position).find(item => item.status === 'active')
        return course.status === 'active' && topic ? [{ course, topic }] : []
      }),
      message: 'Primera sesión: puedes comenzar por el primer tema de cada plan.',
    }
  }

  const previousTopics = normalizedSessionTopics(previous)
  if (previousTopics.length === 0 || previousTopics.some(topic => topic.kind === 'free')) {
    return { suggestions: [], message: 'La sesión anterior usó un tema libre. Elige el siguiente tema manualmente.' }
  }

  const suggestions: TopicOption[] = []
  const completedCourses: string[] = []
  for (const previousTopic of previousTopics) {
    const course = orderedCourses.find(item => item.id === previousTopic.course_id)
    if (!course || course.status !== 'active' || !previousTopic.course_topic_id) continue
    const orderedTopics = [...course.topics].sort((left, right) => left.position - right.position)
    const currentIndex = orderedTopics.findIndex(topic => topic.id === previousTopic.course_topic_id)
    const next = currentIndex >= 0 ? orderedTopics.slice(currentIndex + 1).find(topic => topic.status === 'active') : undefined
    if (next) suggestions.push({ course, topic: next })
    else completedCourses.push(course.name)
  }

  if (suggestions.length > 0) {
    return { suggestions, message: completedCourses.length > 0 ? `${completedCourses.join(', ')} ya llegó al final del plan.` : '' }
  }
  return { suggestions: [], message: completedCourses.length > 0 ? 'La sesión anterior completó los temas disponibles de sus planes.' : 'No hay una continuación automática para la sesión anterior.' }
}

export default function SessionTopicField({
  courses,
  sessions,
  currentSessionId,
  selectedTopics,
  targetDate,
  targetStartTime,
  onChange,
}: SessionTopicFieldProps) {
  const [manualMode, setManualMode] = useState<'plan' | 'free' | null>(null)
  const [search, setSearch] = useState('')
  const orderedCourses = useMemo(() => [...courses].sort((left, right) => left.position - right.position), [courses])
  const allTopics = useMemo(() => orderedCourses.flatMap(course => [...course.topics]
    .sort((left, right) => left.position - right.position)
    .map(topic => ({ course, topic }))), [orderedCourses])
  const mode = manualMode || (selectedTopics.some(topic => topic.kind === 'free') ? 'free' : allTopics.length > 0 ? 'plan' : 'free')
  const normalizedSearch = useMemo(() => normalizeSearch(search), [search])
  const groupedTopics = useMemo(() => orderedCourses.map(course => ({
    course,
    topics: [...course.topics]
      .sort((left, right) => left.position - right.position)
      .filter(topic => !normalizedSearch || normalizeSearch(`${course.name} ${topic.title} ${topic.description || ''}`).includes(normalizedSearch)),
  })).filter(group => group.topics.length > 0), [normalizedSearch, orderedCourses])
  const usedTopicIDs = useMemo(() => new Set(sessions
    .filter(session => session.id !== currentSessionId)
    .flatMap(normalizedSessionTopics)
    .map(topic => topic.course_topic_id)
    .filter((id): id is string => Boolean(id))), [currentSessionId, sessions])
  const recommendation = useMemo(
    () => suggestedSessionTopics(courses, sessions, targetDate, targetStartTime, currentSessionId),
    [courses, currentSessionId, sessions, targetDate, targetStartTime],
  )
  const selectedCourseTopics = selectedTopics.filter(topic => topic.kind === 'course')
  const freeTopic = selectedTopics.find(topic => topic.kind === 'free')

  const chooseTopic = (option: TopicOption) => {
    setManualMode('plan')
    const next = selectedCourseTopics.filter(topic => topic.course_id !== option.course.id)
    next.push({
      kind: 'course',
      course_id: option.course.id,
      course_topic_id: option.topic.id,
      course_name: option.course.name,
      title: option.topic.title,
    })
    onChange(next)
  }

  const switchMode = (nextMode: 'plan' | 'free') => {
    setManualMode(nextMode)
    onChange(nextMode === 'free' ? [{ kind: 'free', title: '' }] : [])
  }

  return (
    <div className="sm:col-span-2">
      <label className="mb-1.5 block text-sm font-medium text-slate-700">Tema de la sesión</label>
      <div className="grid grid-cols-2 rounded-xl border border-slate-200 bg-slate-50 p-1">
        <button type="button" aria-pressed={mode === 'plan'} onClick={() => switchMode('plan')} disabled={allTopics.length === 0} className={`min-h-11 rounded-lg px-3 text-sm font-semibold transition ${mode === 'plan' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'} disabled:cursor-not-allowed disabled:opacity-40`}><span className="inline-flex items-center gap-1.5"><BookOpen className="h-4 w-4" />Plan de clases</span></button>
        <button type="button" aria-pressed={mode === 'free'} onClick={() => switchMode('free')} className={`min-h-11 rounded-lg px-3 text-sm font-semibold transition ${mode === 'free' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>Tema libre</button>
      </div>

      {mode === 'free' ? (
        <div className="mt-3">
          <input type="text" required maxLength={255} value={freeTopic?.title || ''} onChange={event => onChange([{ kind: 'free', title: event.target.value }])} className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-sm outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20" placeholder="Ej: Repaso y práctica guiada" />
          <p className="mt-1.5 text-xs text-slate-400">El tema libre reemplaza cualquier selección de los planes de clase.</p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {selectedCourseTopics.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="Temas seleccionados">
              {selectedCourseTopics.map(topic => <span key={topic.course_topic_id || `${topic.course_id}-${topic.title}`} className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-xl bg-emerald-50 px-3 text-xs font-semibold text-emerald-800 ring-1 ring-inset ring-emerald-200"><span className="truncate">{topic.course_name || 'Curso histórico'} · {topic.title}</span><button type="button" onClick={() => onChange(selectedCourseTopics.filter(item => item !== topic))} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg hover:bg-emerald-100" aria-label={`Quitar ${topic.title}`}><X className="h-3.5 w-3.5" /></button></span>)}
            </div>
          )}

          {!normalizedSearch && recommendation.suggestions.length > 0 && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
              <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-emerald-700"><Sparkles className="h-4 w-4" />Continuación sugerida</div>
              <div className="space-y-2">{recommendation.suggestions.map(option => <button key={option.topic.id} type="button" onClick={() => chooseTopic(option)} className="flex min-h-11 w-full items-center gap-3 rounded-xl bg-white px-3 text-left text-sm shadow-sm ring-1 ring-inset ring-emerald-200 transition hover:bg-emerald-100"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white"><Check className="h-4 w-4" /></span><span className="min-w-0"><span className="block truncate font-semibold text-emerald-900">{option.topic.title}</span><span className="block truncate text-xs text-emerald-700">{option.course.name}</span></span></button>)}</div>
              {recommendation.message && <p className="mt-2 text-xs text-emerald-700">{recommendation.message}</p>}
            </div>
          )}
          {!normalizedSearch && recommendation.suggestions.length === 0 && recommendation.message && <p className="flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2.5 text-xs text-amber-800"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{recommendation.message}</p>}

          <div className="relative"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={search} onChange={event => setSearch(event.target.value)} className="h-11 w-full rounded-xl border border-slate-200 pl-10 pr-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20" placeholder="Buscar tema o curso" aria-label="Buscar tema del plan" /></div>

          <div className="max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-white">
            {groupedTopics.length === 0 ? <div className="px-4 py-8 text-center text-sm text-slate-400">No hay temas que coincidan con la búsqueda.</div> : groupedTopics.map(group => (
              <div key={group.course.id} className="border-b border-slate-100 last:border-b-0">
                <div className="sticky top-0 z-[1] flex items-center gap-2 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600"><BookOpen className="h-3.5 w-3.5" /><span className="truncate">{group.course.name}</span>{selectedCourseTopics.some(topic => topic.course_id === group.course.id) && <span className="ml-auto rounded-full bg-emerald-100 px-2 py-0.5 text-[9px] text-emerald-800">1 seleccionado</span>}</div>
                {group.topics.map(courseTopic => {
                  const selected = selectedCourseTopics.some(topic => topic.course_topic_id === courseTopic.id)
                  const archived = group.course.status === 'archived' || courseTopic.status === 'archived'
                  return <button key={courseTopic.id} type="button" aria-pressed={selected} disabled={archived && !selected} onClick={() => chooseTopic({ course: group.course, topic: courseTopic })} className={`flex min-h-12 w-full items-center gap-3 border-t border-slate-50 px-3 py-2 text-left transition ${selected ? 'bg-emerald-50' : ''} ${archived && !selected ? 'cursor-not-allowed opacity-50' : 'hover:bg-slate-50'}`}><span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${selected ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{selected ? <Check className="h-4 w-4" /> : courseTopic.position + 1}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-slate-800">{courseTopic.title}</span>{courseTopic.description && <span className="block truncate text-xs text-slate-400">{courseTopic.description}</span>}</span>{usedTopicIDs.has(courseTopic.id) && <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[9px] font-bold text-blue-700">Ya usado</span>}</button>
                })}
              </div>
            ))}
          </div>
          <p className="flex items-start gap-1.5 text-xs text-slate-500"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />Puedes elegir un tema por curso. Elegir otro del mismo curso reemplaza el anterior.</p>
        </div>
      )}
    </div>
  )
}
