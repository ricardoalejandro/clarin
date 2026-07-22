'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BookOpen,
  ExternalLink,
  Loader2,
  Plus,
  Save,
  Search,
  Trash2,
  UserRoundCheck,
  X,
} from 'lucide-react'
import ContactSelector, { type SelectedPerson } from '@/components/ContactSelector'
import ContactPhotoPreview from '@/components/ContactPhotoPreview'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import { api } from '@/lib/api'
import type { ProgramAcademicConfig, ProgramCourse, ProgramCourseCatalogResponse, ProgramInstructor } from '@/types/program'

interface ProgramAcademicConfigPanelProps {
  programId: string
  config: ProgramAcademicConfig | null
  loading: boolean
  error?: string
  onRetry: () => void
  onChange: (config: ProgramAcademicConfig) => void
  onToast: (message: string, type: 'success' | 'error') => void
  onDirtyChange: (dirty: boolean) => void
  onNavigateToCatalog: () => void
}

const normalizeSearch = (value: string) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('es')
  .trim()

const sameIDs = (left: string[], right: string[]) => left.length === right.length && left.every((id, index) => id === right[index])

export default function ProgramAcademicConfigPanel({
  programId,
  config,
  loading,
  error = '',
  onRetry,
  onChange,
  onToast,
  onDirtyChange,
  onNavigateToCatalog,
}: ProgramAcademicConfigPanelProps) {
  const [courses, setCourses] = useState<ProgramCourse[]>([])
  const [instructors, setInstructors] = useState<ProgramInstructor[]>([])
  const [savedCourseIDs, setSavedCourseIDs] = useState<string[]>([])
  const [savedInstructorIDs, setSavedInstructorIDs] = useState<string[]>([])
  const [configVersion, setConfigVersion] = useState('')
  const [conflictConfig, setConflictConfig] = useState<ProgramAcademicConfig | null>(null)
  const [coursePickerOpen, setCoursePickerOpen] = useState(false)
  const [instructorPickerOpen, setInstructorPickerOpen] = useState(false)
  const [courseSearch, setCourseSearch] = useState('')
  const [debouncedCourseSearch, setDebouncedCourseSearch] = useState('')
  const [courseOptions, setCourseOptions] = useState<ProgramCourse[]>([])
  const [courseOptionsTotal, setCourseOptionsTotal] = useState(0)
  const [courseOptionsLoading, setCourseOptionsLoading] = useState(false)
  const [courseOptionsError, setCourseOptionsError] = useState('')
  const [savingCourses, setSavingCourses] = useState(false)
  const [savingInstructors, setSavingInstructors] = useState(false)
  const courseDialogRef = useRef<HTMLDivElement>(null)
  const courseSearchRef = useRef<HTMLInputElement>(null)
  const courseOptionsRequestRef = useRef<AbortController | null>(null)
  const courseOptionsSequenceRef = useRef(0)
  const closeCoursePicker = useCallback(() => {
    courseOptionsRequestRef.current?.abort()
    setCoursePickerOpen(false)
    setCourseSearch('')
  }, [])

  useAccessibleDialog(coursePickerOpen, courseDialogRef, closeCoursePicker, courseSearchRef)

  useEffect(() => {
    setCourses(config?.courses || [])
    setInstructors(config?.instructors || [])
    setSavedCourseIDs(config?.courses.map(course => course.id) || [])
    setSavedInstructorIDs(config?.instructors.map(instructor => instructor.contact_id) || [])
    setConfigVersion(config?.updated_at || '')
    setConflictConfig(null)
  }, [config])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedCourseSearch(courseSearch.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [courseSearch])

  const loadCourseOptions = useCallback(async () => {
    if (!coursePickerOpen) return
    courseOptionsRequestRef.current?.abort()
    const controller = new AbortController()
    courseOptionsRequestRef.current = controller
    const sequence = ++courseOptionsSequenceRef.current
    setCourseOptionsLoading(true)
    setCourseOptionsError('')
    const params = new URLSearchParams({ status: 'active', page: '1', page_size: '100' })
    if (debouncedCourseSearch) params.set('search', debouncedCourseSearch)
    const response = await api<ProgramCourseCatalogResponse>(`/api/programs/courses?${params.toString()}`, { signal: controller.signal })
    if (controller.signal.aborted || sequence !== courseOptionsSequenceRef.current) return
    if (!response.success || !Array.isArray(response.data?.courses)) {
      setCourseOptionsError(response.error || 'No se pudieron cargar los cursos disponibles.')
    } else {
      setCourseOptions(response.data.courses)
      setCourseOptionsTotal(response.data.total)
    }
    setCourseOptionsLoading(false)
  }, [coursePickerOpen, debouncedCourseSearch])

  useEffect(() => {
    if (!coursePickerOpen) return
    void loadCourseOptions()
    return () => courseOptionsRequestRef.current?.abort()
  }, [coursePickerOpen, loadCourseOptions])

  const associatedCourseIDs = useMemo(() => new Set(courses.map(course => course.id)), [courses])
  const excludedInstructorIDs = useMemo(() => new Set(instructors.map(instructor => instructor.contact_id)), [instructors])
  const normalizedCourseSearch = useMemo(() => normalizeSearch(courseSearch), [courseSearch])
  const availableCourses = useMemo(() => courseOptions
    .filter(course => course.status === 'active' && !associatedCourseIDs.has(course.id))
    .filter(course => !normalizedCourseSearch || normalizeSearch(`${course.name} ${course.description || ''}`).includes(normalizedCourseSearch))
    .sort((left, right) => left.name.localeCompare(right.name, 'es')),
  [associatedCourseIDs, courseOptions, normalizedCourseSearch])

  const courseIDs = courses.map(course => course.id)
  const instructorIDs = instructors.map(instructor => instructor.contact_id)
  const courseChanges = !sameIDs(courseIDs, savedCourseIDs)
  const instructorChanges = !sameIDs(instructorIDs, savedInstructorIDs)
  const dirty = courseChanges || instructorChanges

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  const moveCourse = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= courses.length) return
    setCourses(current => {
      const next = [...current]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      return next.map((course, position) => ({ ...course, position }))
    })
  }

  const addCourse = (course: ProgramCourse) => {
    setCourses(current => [...current, { ...course, position: current.length }])
    closeCoursePicker()
  }

  const addInstructors = (selected: SelectedPerson[]) => {
    if (selected.length === 0) return
    setInstructors(current => {
      const existing = new Set(current.map(instructor => instructor.contact_id))
      const additions = selected
        .filter(person => !existing.has(person.id))
        .map((person, index): ProgramInstructor => ({
          contact_id: person.id,
          contact_name: person.name || 'Sin nombre',
          contact_phone: person.phone || null,
          avatar_url: null,
          avatar_revision: 0,
          position: current.length + index,
        }))
      return [...current, ...additions]
    })
    setInstructorPickerOpen(false)
  }

  const saveConfiguration = async () => {
    if (savingCourses || savingInstructors || (!courseChanges && !instructorChanges)) return
    if (!configVersion) {
      onToast('La configuración cambió o está incompleta. Recárgala antes de guardar.', 'error')
      return
    }
    setSavingCourses(courseChanges)
    setSavingInstructors(instructorChanges)
    try {
      const response = await api<ProgramAcademicConfig>(`/api/programs/${programId}/academic-config`, {
        method: 'PUT',
        body: JSON.stringify({
          course_ids: courseIDs,
          contact_ids: instructorIDs,
          expected_updated_at: configVersion,
        }),
      })
      if (!response.success || !response.data) {
        if (response.status === 409) {
          const latest = await api<ProgramAcademicConfig>(`/api/programs/${programId}/academic-config`)
          if (latest.success && latest.data) {
            setConfigVersion(latest.data.updated_at)
            setSavedCourseIDs(latest.data.courses.map(course => course.id))
            setSavedInstructorIDs(latest.data.instructors.map(instructor => instructor.contact_id))
            setConflictConfig(latest.data)
            onToast('Otra persona actualizó este programa. Conservamos tu borrador para que puedas revisarlo.', 'error')
            return
          }
        }
        throw new Error(response.error || 'No se pudo guardar la configuración académica.')
      }
      setConflictConfig(null)
      onChange(response.data)
      onToast(courseChanges && instructorChanges ? 'Plan e instructores actualizados' : courseChanges ? 'Plan de clases actualizado' : 'Instructores actualizados', 'success')
    } catch (saveError) {
      onToast(saveError instanceof Error ? saveError.message : 'No se pudo guardar la configuración académica.', 'error')
    } finally {
      setSavingCourses(false)
      setSavingInstructors(false)
    }
  }

  if (loading && !config) {
    return <div className="flex h-full items-center justify-center rounded-2xl border border-slate-200 bg-white"><Loader2 className="h-7 w-7 animate-spin text-emerald-600" /><span className="ml-3 text-sm text-slate-500">Cargando plan e instructores…</span></div>
  }

  if (!config) {
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center rounded-2xl border border-red-200 bg-red-50 p-6 text-center">
        <AlertCircle className="h-9 w-9 text-red-400" />
        <p className="mt-3 font-semibold text-red-800">No se pudo cargar la configuración académica</p>
        <p className="mt-1 max-w-md text-sm text-red-600">{error || 'Inténtalo nuevamente.'}</p>
        <button type="button" onClick={onRetry} className="mt-4 min-h-11 rounded-xl border border-red-200 bg-white px-4 text-sm font-semibold text-red-700 hover:bg-red-100">Reintentar</button>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto pb-3">
      {error && <div role="alert" className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 flex-1">{error}</span><button type="button" onClick={onRetry} className="shrink-0 font-semibold underline">Reintentar</button></div>}
      {conflictConfig && (
        <div role="alert" className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">El programa cambió mientras lo editabas</p>
              <p className="mt-1 text-xs leading-5 text-amber-800">Tu borrador se conservó. La versión vigente tiene {conflictConfig.courses.length} cursos y {conflictConfig.instructors.length} instructores. Puedes cargarla o revisar tu borrador y volver a guardarlo sobre esa versión.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setCourses(conflictConfig.courses)
              setInstructors(conflictConfig.instructors)
              onChange(conflictConfig)
              setConflictConfig(null)
            }}
            className="mt-3 min-h-11 rounded-xl border border-amber-300 bg-white px-4 text-xs font-semibold text-amber-900 hover:bg-amber-100"
          >
            Cargar versión vigente
          </button>
        </div>
      )}
      {dirty && <div role="status" className="mb-3 flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs font-medium text-blue-800"><AlertCircle className="h-4 w-4 shrink-0" />Tienes cambios sin guardar. Puedes guardarlos desde cualquiera de las secciones modificadas.</div>}
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white" aria-labelledby="program-courses-heading">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 p-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700"><BookOpen className="h-5 w-5" /></span>
              <div className="min-w-0"><h2 id="program-courses-heading" className="font-bold text-slate-800">Plan de clases</h2><p className="text-xs leading-5 text-slate-500">Asocia cursos y define el orden sugerido de sus temas.</p></div>
            </div>
            <button type="button" onClick={onNavigateToCatalog} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-50">Administrar cursos <ExternalLink className="h-3.5 w-3.5" /></button>
          </div>

          <div className="space-y-3 p-4">
            {courses.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center"><BookOpen className="mx-auto h-8 w-8 text-slate-300" /><p className="mt-2 text-sm font-semibold text-slate-600">Aún no hay cursos asociados</p><p className="mt-1 text-xs text-slate-400">Agrega uno para sugerir temas al crear sesiones.</p></div>
            ) : courses.map((course, index) => (
              <article key={course.id} className={`rounded-xl border p-3 ${course.status === 'archived' ? 'border-amber-200 bg-amber-50/60' : 'border-slate-200 bg-white'}`}>
                <div className="flex items-start gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-bold text-slate-600">{index + 1}</span>
                  <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-sm font-semibold text-slate-800">{course.name}</h3>{course.status === 'archived' && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">Archivado</span>}</div><p className="mt-0.5 text-xs text-slate-500">{course.active_topic_count ?? course.topics.filter(topic => topic.status === 'active').length} temas activos</p>{course.status === 'archived' && <p className="mt-2 flex items-start gap-1 text-xs text-amber-700"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />Conserva el historial, pero no se sugerirá en nuevas sesiones.</p>}</div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button type="button" onClick={() => moveCourse(index, -1)} disabled={index === 0} className="flex h-11 w-10 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-25" aria-label={`Subir ${course.name}`}><ArrowUp className="h-4 w-4" /></button>
                    <button type="button" onClick={() => moveCourse(index, 1)} disabled={index === courses.length - 1} className="flex h-11 w-10 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-25" aria-label={`Bajar ${course.name}`}><ArrowDown className="h-4 w-4" /></button>
                    <button type="button" onClick={() => setCourses(current => current.filter(item => item.id !== course.id).map((item, position) => ({ ...item, position })))} className="flex h-11 w-10 items-center justify-center rounded-xl text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`Desasociar ${course.name}`}><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
              </article>
            ))}
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
              <button type="button" onClick={() => setCoursePickerOpen(true)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 text-sm font-semibold text-emerald-700 hover:bg-emerald-100"><Plus className="h-4 w-4" />Agregar curso</button>
              <button type="button" onClick={saveConfiguration} disabled={!courseChanges || savingCourses || savingInstructors} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40">{savingCourses ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{savingCourses ? 'Guardando…' : 'Guardar plan'}</button>
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white" aria-labelledby="program-instructors-heading">
          <div className="flex items-start gap-3 border-b border-slate-100 p-4"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700"><UserRoundCheck className="h-5 w-5" /></span><div><h2 id="program-instructors-heading" className="font-bold text-slate-800">Instructores</h2><p className="text-xs leading-5 text-slate-500">Todo instructor se selecciona desde Contactos.</p></div></div>
          <div className="space-y-3 p-4">
            {instructors.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center"><UserRoundCheck className="mx-auto h-8 w-8 text-slate-300" /><p className="mt-2 text-sm font-semibold text-slate-600">Sin instructores asignados</p><p className="mt-1 text-xs text-slate-400">Puedes asociar uno o varios contactos.</p></div>
            ) : instructors.map(instructor => (
              <div key={instructor.contact_id} className="flex min-h-16 items-center gap-3 rounded-xl border border-slate-200 p-3">
                <ContactPhotoPreview url={instructor.avatar_url} name={instructor.contact_name || 'Sin nombre'} sizeClassName="h-10 w-10" fallbackClassName="bg-blue-50 text-blue-700 ring-1 ring-blue-100" />
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-800">{instructor.contact_name || 'Sin nombre'}</p><p className="truncate text-xs text-slate-500">{instructor.contact_phone || 'Sin teléfono'}</p></div>
                <button type="button" onClick={() => setInstructors(current => current.filter(item => item.contact_id !== instructor.contact_id).map((item, position) => ({ ...item, position })))} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`Quitar a ${instructor.contact_name}`}><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
              <button type="button" onClick={() => setInstructorPickerOpen(true)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 text-sm font-semibold text-blue-700 hover:bg-blue-100"><Plus className="h-4 w-4" />Agregar instructor</button>
              <button type="button" onClick={saveConfiguration} disabled={!instructorChanges || savingCourses || savingInstructors} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">{savingInstructors ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{savingInstructors ? 'Guardando…' : 'Guardar instructores'}</button>
            </div>
          </div>
        </section>
      </div>

      {coursePickerOpen && typeof document !== 'undefined' && createPortal(
        <div className="app-viewport fixed inset-0 z-[80] flex items-stretch justify-center bg-slate-950/50 p-0 backdrop-blur-sm sm:items-center sm:p-4">
          <div ref={courseDialogRef} role="dialog" aria-modal="true" aria-labelledby="course-picker-title" tabIndex={-1} className="flex h-full w-full max-w-2xl flex-col overflow-hidden bg-white shadow-2xl sm:h-auto sm:max-h-[85vh] sm:rounded-2xl">
            <div className="flex shrink-0 items-center justify-between border-b border-slate-100 p-4"><div><h2 id="course-picker-title" className="font-bold text-slate-800">Agregar curso al programa</h2><p className="text-xs text-slate-500">Solo se muestran cursos activos.</p></div><button type="button" onClick={closeCoursePicker} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100" aria-label="Cerrar"><X className="h-5 w-5" /></button></div>
            <div className="shrink-0 p-4"><div className="relative"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input ref={courseSearchRef} value={courseSearch} onChange={event => setCourseSearch(event.target.value)} maxLength={160} placeholder="Buscar por nombre o descripción" className="h-11 w-full rounded-xl border border-slate-200 pl-10 pr-10 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20" />{courseOptionsLoading && <Loader2 className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-600" />}</div></div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              {courseOptionsLoading && courseOptions.length === 0 ? (
                <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-slate-500" role="status"><Loader2 className="h-5 w-5 animate-spin text-emerald-600" />Buscando cursos…</div>
              ) : courseOptionsError ? (
                <div role="alert" className="py-10 text-center"><AlertCircle className="mx-auto h-9 w-9 text-red-400" /><p className="mt-2 text-sm font-semibold text-slate-700">No pudimos cargar los cursos</p><p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-slate-500">{courseOptionsError}</p><button type="button" onClick={() => { void loadCourseOptions() }} className="mt-3 min-h-11 rounded-xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">Reintentar</button></div>
              ) : availableCourses.length === 0 ? (
                <div className="py-12 text-center"><BookOpen className="mx-auto h-9 w-9 text-slate-300" /><p className="mt-2 text-sm font-semibold text-slate-600">{normalizedCourseSearch ? 'No hay coincidencias' : 'No hay más cursos disponibles'}</p><button type="button" onClick={() => { closeCoursePicker(); onNavigateToCatalog() }} className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-emerald-700">Administrar catálogo</button></div>
              ) : (
                <div className="space-y-2">
                  {availableCourses.map(course => (
                    <button key={course.id} type="button" onClick={() => addCourse(course)} className="flex min-h-16 w-full items-center gap-3 rounded-xl border border-slate-200 p-3 text-left hover:border-emerald-300 hover:bg-emerald-50">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700"><BookOpen className="h-5 w-5" /></span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-800">{course.name}</span><span className="block truncate text-xs text-slate-500">{course.active_topic_count ?? course.topics.filter(topic => topic.status === 'active').length} temas activos{course.description ? ` · ${course.description}` : ''}</span></span>
                      <Plus className="h-5 w-5 shrink-0 text-emerald-600" />
                    </button>
                  ))}
                  {courseOptionsTotal > courseOptions.length && <p className="px-2 py-2 text-center text-xs text-slate-500">Hay más resultados. Escribe parte del nombre para encontrarlos sin cargar todo el catálogo.</p>}
                </div>
              )}
            </div>
            <div className="safe-area-bottom shrink-0 border-t border-slate-100 p-4"><button type="button" onClick={closeCoursePicker} className="min-h-11 w-full rounded-xl border border-slate-200 text-sm font-semibold text-slate-600">Cerrar</button></div>
          </div>
        </div>,
        document.body,
      )}

      {typeof document !== 'undefined' && createPortal(
        <ContactSelector
          open={instructorPickerOpen}
          onClose={() => setInstructorPickerOpen(false)}
          onConfirm={addInstructors}
          title="Asignar instructores"
          subtitle="Busca contactos de esta cuenta"
          confirmLabel="Agregar instructores"
          sourceFilter="contact"
          excludeIds={excludedInstructorIDs}
        />,
        document.body,
      )}
    </div>
  )
}
