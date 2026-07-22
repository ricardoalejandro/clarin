'use client'

import { createPortal } from 'react-dom'
import { useCallback, useEffect, useRef, useState, type HTMLAttributes } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileText,
  Layers3,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { useContainerWidth } from '@/components/responsive/useContainerWidth'
import { api } from '@/lib/api'
import type {
  Course,
  CourseInput,
  CourseListResponse,
  CourseResponse,
  CourseStatus,
  DeleteCourseResponse,
} from '@/types/course'

const PAGE_SIZE = 10

interface DraftTopic {
  key: string
  id?: string
  title: string
  description: string
  status: CourseStatus
  usageCount: number
}

interface CourseDraft {
  id?: string
  updatedAt?: string
  name: string
  description: string
  status: CourseStatus
  usageCount: number
  topics: DraftTopic[]
}

type CourseDeleteTarget = Pick<Course, 'id' | 'name' | 'usage_count' | 'updated_at'>

interface ConfirmState {
  title: string
  message: string
  confirmLabel: string
  tone?: 'danger' | 'default'
  onConfirm: () => void
  secondaryLabel?: string
  onSecondary?: () => void
}

interface ToastState {
  message: string
  tone: 'success' | 'error'
}

interface SaveConflictState {
  latest: Course
}

function newTopicKey() {
  return `topic-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function emptyDraft(): CourseDraft {
  return {
    name: '',
    description: '',
    status: 'active',
    usageCount: 0,
    topics: [],
  }
}

function draftFromCourse(course: Course): CourseDraft {
  const topics = [...(course.topics || [])]
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === 'active' ? -1 : 1
      return left.position - right.position
    })
    .map(topic => ({
      key: topic.id,
      id: topic.id,
      title: topic.title,
      description: topic.description || '',
      status: topic.status,
      usageCount: topic.usage_count || 0,
    }))

  return {
    id: course.id,
    updatedAt: course.updated_at,
    name: course.name,
    description: course.description || '',
    status: course.status,
    usageCount: course.usage_count || 0,
    topics,
  }
}

function comparableDraft(draft: CourseDraft | null) {
  if (!draft) return ''
  return JSON.stringify({
    id: draft.id || '',
    name: draft.name,
    description: draft.description,
    status: draft.status,
    topics: draft.topics.map(topic => ({
      id: topic.id || '',
      title: topic.title,
      description: topic.description,
      status: topic.status,
    })),
  })
}

function draftToInput(draft: CourseDraft): CourseInput {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    status: draft.status,
    expected_updated_at: draft.id ? draft.updatedAt : undefined,
    topics: draft.topics.map(topic => ({
      id: topic.id,
      title: topic.title.trim(),
      description: topic.description.trim() || null,
      status: topic.status,
    })),
  }
}

function courseToInput(course: Course, status: CourseStatus = course.status): CourseInput {
  return {
    name: course.name,
    description: course.description,
    status,
    expected_updated_at: course.updated_at,
    topics: [...(course.topics || [])]
      .sort((left, right) => left.position - right.position)
      .map(topic => ({
        id: topic.id,
        title: topic.title,
        description: topic.description,
        status: topic.status,
      })),
  }
}

function activeTopics(course: Course) {
  return (course.topics || [])
    .filter(topic => topic.status === 'active')
    .sort((left, right) => left.position - right.position)
}

function formatDate(value: string) {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat('es-PE', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(value))
  } catch {
    return ''
  }
}

function friendlyDeleteError(message?: string) {
  const raw = message || ''
  const normalized = raw.toLocaleLowerCase('es')
  if (
    normalized.includes('409') ||
    normalized.includes('asociad') ||
    normalized.includes('referenc') ||
    normalized.includes('en uso') ||
    normalized.includes('sesión') ||
    normalized.includes('sesion')
  ) {
    return 'Este curso ya está asociado o tiene temas usados en sesiones. Puedes archivarlo para conservar el historial.'
  }
  return raw || 'No se pudo eliminar el curso. Inténtalo nuevamente.'
}

function isCourseConflict(response: { error?: string; status?: number }) {
  if (response.status === 409) return true
  const message = (response.error || '').toLocaleLowerCase('es')
  return message.includes('course was modified by another user') ||
    message.includes('reload it before saving') ||
    message.includes('error 409')
}

function rebaseDraftOntoLatest(draft: CourseDraft, latest: Course): CourseDraft {
  const latestTopics = new Map((latest.topics || []).map(topic => [topic.id, topic]))
  return {
    ...draft,
    updatedAt: latest.updated_at,
    usageCount: latest.usage_count || 0,
    topics: draft.topics.map(topic => {
      if (!topic.id) return topic
      const current = latestTopics.get(topic.id)
      if (!current) return { ...topic, id: undefined, key: newTopicKey(), usageCount: 0 }
      return { ...topic, usageCount: current.usage_count || 0 }
    }),
  }
}

function StatusBadge({ status }: { status: CourseStatus }) {
  return status === 'active' ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      Activo
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">
      <Archive className="h-3 w-3" />
      Archivado
    </span>
  )
}

interface CourseEditorProps {
  draft: CourseDraft
  setDraft: (draft: CourseDraft) => void
  compact: boolean
  dirty: boolean
  saving: boolean
  error: string
  conflict: SaveConflictState | null
  usageCount: number
  onSave: () => void
  onClose: () => void
  onDelete: () => void
  onReviewConflict: () => void
}

function CourseEditor({
  draft,
  setDraft,
  compact,
  dirty,
  saving,
  error,
  conflict,
  usageCount,
  onSave,
  onClose,
  onDelete,
  onReviewConflict,
}: CourseEditorProps) {
  const active = draft.topics.filter(topic => topic.status === 'active')
  const archived = draft.topics.filter(topic => topic.status === 'archived')
  const nameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => nameInputRef.current?.focus(), 80)
    return () => window.clearTimeout(timer)
  }, [draft.id])

  const updateTopic = (key: string, patch: Partial<DraftTopic>) => {
    setDraft({
      ...draft,
      topics: draft.topics.map(topic => topic.key === key ? { ...topic, ...patch } : topic),
    })
  }

  const addTopic = () => {
    const topic: DraftTopic = {
      key: newTopicKey(),
      title: '',
      description: '',
      status: 'active',
      usageCount: 0,
    }
    setDraft({ ...draft, topics: [...active, topic, ...archived] })
    window.requestAnimationFrame(() => document.getElementById(`topic-title-${topic.key}`)?.focus())
  }

  const moveTopic = (key: string, direction: -1 | 1) => {
    const current = active.findIndex(topic => topic.key === key)
    const next = current + direction
    if (current < 0 || next < 0 || next >= active.length) return
    const reordered = [...active]
    const [topic] = reordered.splice(current, 1)
    reordered.splice(next, 0, topic)
    setDraft({ ...draft, topics: [...reordered, ...archived] })
  }

  const removeTopic = (topic: DraftTopic) => {
    if (topic.id && topic.usageCount > 0) {
      const next = draft.topics
        .map(item => item.key === topic.key ? { ...item, status: 'archived' as const } : item)
        .sort((left, right) => {
          if (left.status === right.status) return 0
          return left.status === 'active' ? -1 : 1
        })
      setDraft({ ...draft, topics: next })
      return
    }
    setDraft({ ...draft, topics: draft.topics.filter(item => item.key !== topic.key) })
  }

  const restoreTopic = (key: string) => {
    const restored = draft.topics.find(topic => topic.key === key)
    if (!restored) return
    const remainingActive = active.filter(topic => topic.key !== key)
    const remainingArchived = archived.filter(topic => topic.key !== key)
    setDraft({
      ...draft,
      topics: [...remainingActive, { ...restored, status: 'active' }, ...remainingArchived],
    })
  }

  const surfaceClass = compact
    ? 'app-viewport fixed inset-0 z-[80] flex w-full flex-col overflow-hidden bg-white'
    : 'flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm'

  return (
    <form
      className={surfaceClass}
      onSubmit={event => {
        event.preventDefault()
        onSave()
      }}
      role={compact ? 'dialog' : undefined}
      aria-modal={compact ? true : undefined}
      aria-labelledby="course-editor-title"
    >
      <div className={`flex shrink-0 items-center gap-3 border-b border-slate-200 ${compact ? 'px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]' : 'px-5 py-4'}`}>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={compact ? 'Volver al listado de cursos' : 'Cerrar editor'}
        >
          {compact ? <ArrowLeft className="h-5 w-5" /> : <X className="h-5 w-5" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 id="course-editor-title" className="truncate text-base font-bold text-slate-900 sm:text-lg">
              {draft.id ? 'Editar curso' : 'Nuevo curso'}
            </h2>
            {dirty && (
              <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
                Sin guardar
              </span>
            )}
          </div>
          <p className="truncate text-xs text-slate-500">Plan de clases reutilizable</p>
        </div>
        {!compact && <StatusBadge status={draft.status} />}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className={`mx-auto w-full max-w-3xl ${compact ? 'space-y-6 px-4 py-5 pb-8' : 'space-y-7 p-5 lg:p-6'}`}>
          {error && (
            <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {conflict && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-amber-900" role="alert">
              <div className="flex items-start gap-2.5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">Otra persona actualizó este curso</p>
                  <p className="mt-1 text-xs leading-5 text-amber-800">
                    Conservamos tu borrador. El catálogo ya está actualizado; revisa la versión vigente antes de volver a guardar.
                  </p>
                  <button
                    type="button"
                    onClick={onReviewConflict}
                    className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-xl border border-amber-300 bg-white px-3 text-xs font-semibold text-amber-800 transition hover:bg-amber-100"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Revisar y resolver
                  </button>
                </div>
              </div>
            </div>
          )}

          <section aria-labelledby="course-details-title">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
                <FileText className="h-4 w-4" />
              </div>
              <div>
                <h3 id="course-details-title" className="text-sm font-bold text-slate-900">Información del curso</h3>
                <p className="text-xs text-slate-500">Un nombre claro ayuda a encontrarlo al configurar un programa.</p>
              </div>
            </div>

            <div className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
              <div>
                <label htmlFor="course-name" className="mb-1.5 block text-sm font-semibold text-slate-700">
                  Nombre <span className="text-red-500">*</span>
                </label>
                <input
                  ref={nameInputRef}
                  id="course-name"
                  value={draft.name}
                  onChange={event => setDraft({ ...draft, name: event.target.value })}
                  maxLength={160}
                  placeholder="Ej: Fundamentos de liderazgo"
                  className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3.5 text-base text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 sm:text-sm"
                />
              </div>
              <div>
                <label htmlFor="course-description" className="mb-1.5 block text-sm font-semibold text-slate-700">
                  Descripción <span className="font-normal text-slate-400">(opcional)</span>
                </label>
                <textarea
                  id="course-description"
                  value={draft.description}
                  onChange={event => setDraft({ ...draft, description: event.target.value })}
                  maxLength={1000}
                  rows={3}
                  placeholder="Objetivo o alcance de este plan de clases"
                  className="w-full resize-none rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-base text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 sm:text-sm"
                />
                <p className="mt-1 text-right text-[11px] text-slate-400">{draft.description.length}/1000</p>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[140px_1fr] sm:items-center">
                <label htmlFor="course-status" className="text-sm font-semibold text-slate-700">Estado</label>
                <select
                  id="course-status"
                  value={draft.status}
                  onChange={event => setDraft({ ...draft, status: event.target.value as CourseStatus })}
                  className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 sm:text-sm"
                >
                  <option value="active">Activo</option>
                  <option value="archived">Archivado</option>
                </select>
              </div>
            </div>
          </section>

          <section aria-labelledby="course-topics-title">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
                  <Layers3 className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <h3 id="course-topics-title" className="text-sm font-bold text-slate-900">Temas del plan</h3>
                  <p className="text-xs text-slate-500">El orden se usará para sugerir temas al crear sesiones.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={addTopic}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100"
              >
                <Plus className="h-4 w-4" />
                Agregar tema
              </button>
            </div>

            {active.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-8 text-center">
                <Layers3 className="mx-auto h-8 w-8 text-slate-300" />
                <p className="mt-3 text-sm font-semibold text-slate-700">Este curso aún no tiene temas</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">Puedes guardarlo así y completar el plan después.</p>
                <button
                  type="button"
                  onClick={addTopic}
                  className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white transition hover:bg-emerald-700"
                >
                  <Plus className="h-4 w-4" />
                  Agregar primer tema
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {active.map((topic, index) => (
                  <div key={topic.key} className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-bold text-slate-600">
                        {index + 1}
                      </div>
                      <div className="min-w-0 flex-1 space-y-3">
                        <div>
                          <label htmlFor={`topic-title-${topic.key}`} className="sr-only">Título del tema {index + 1}</label>
                          <input
                            id={`topic-title-${topic.key}`}
                            value={topic.title}
                            onChange={event => updateTopic(topic.key, { title: event.target.value })}
                            maxLength={200}
                            placeholder={`Tema ${index + 1} *`}
                            className="min-h-11 w-full rounded-xl border border-slate-300 px-3 text-base font-medium text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 sm:text-sm"
                          />
                        </div>
                        <div>
                          <label htmlFor={`topic-description-${topic.key}`} className="sr-only">Detalle del tema {index + 1}</label>
                          <textarea
                            id={`topic-description-${topic.key}`}
                            value={topic.description}
                            onChange={event => updateTopic(topic.key, { description: event.target.value })}
                            maxLength={1000}
                            rows={2}
                            placeholder="Detalle o alcance (opcional)"
                            className="w-full resize-none rounded-xl border border-slate-300 px-3 py-2.5 text-base text-slate-700 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 sm:text-sm"
                          />
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
                      <p className="min-w-0 flex-1 text-[11px] leading-4 text-slate-400">
                        {topic.usageCount > 0
                          ? `Usado en ${topic.usageCount} ${topic.usageCount === 1 ? 'sesión o asociación' : 'sesiones o asociaciones'}`
                          : 'Todavía no utilizado'}
                      </p>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => moveTopic(topic.key, -1)}
                          disabled={index === 0}
                          className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
                          aria-label={`Subir tema ${index + 1}`}
                          title="Subir"
                        >
                          <ChevronUp className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveTopic(topic.key, 1)}
                          disabled={index === active.length - 1}
                          className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
                          aria-label={`Bajar tema ${index + 1}`}
                          title="Bajar"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeTopic(topic)}
                          className="flex h-11 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-red-600 transition hover:bg-red-50"
                          aria-label={`${topic.usageCount > 0 ? 'Retirar' : 'Eliminar'} tema ${index + 1}`}
                        >
                          {topic.usageCount > 0 ? <Archive className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                          <span className="hidden sm:inline">{topic.usageCount > 0 ? 'Retirar' : 'Eliminar'}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addTopic}
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-emerald-300 bg-emerald-50/60 px-4 text-sm font-semibold text-emerald-700 transition hover:border-emerald-400 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
                  aria-label="Agregar otro tema al final del plan"
                >
                  <Plus className="h-4 w-4" />
                  Agregar otro tema
                </button>
              </div>
            )}

            {archived.length > 0 && (
              <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
                <div className="flex items-center gap-2">
                  <Archive className="h-4 w-4 text-slate-500" />
                  <h4 className="text-xs font-bold uppercase tracking-wide text-slate-600">
                    Temas retirados ({archived.length})
                  </h4>
                </div>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  Se conservan porque forman parte del historial. Puedes volver a incluirlos en el plan.
                </p>
                <div className="mt-3 space-y-2">
                  {archived.map(topic => (
                    <div key={topic.key} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-700">{topic.title}</p>
                        {topic.description && <p className="mt-0.5 truncate text-xs text-slate-400">{topic.description}</p>}
                      </div>
                      <button
                        type="button"
                        onClick={() => restoreTopic(topic.key)}
                        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50"
                      >
                        <RotateCcw className="h-4 w-4" />
                        Restaurar
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {draft.id && usageCount > 0 && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-3 text-xs leading-5 text-blue-700">
              Este curso tiene {usageCount} {usageCount === 1 ? 'uso' : 'usos'}. Puede archivarse, pero no eliminarse definitivamente, para proteger programas y sesiones históricas.
            </div>
          )}
        </div>
      </div>

      <div className={`shrink-0 border-t border-slate-200 bg-white ${compact ? 'px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3' : 'px-5 py-4'}`}>
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2">
          {draft.id && usageCount === 0 && (
            <button
              type="button"
              onClick={onDelete}
              disabled={saving}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              <span className="hidden sm:inline">Eliminar</span>
            </button>
          )}
          <div className="min-w-0 flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saving || !dirty || Boolean(conflict)}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm shadow-emerald-600/20 transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? 'Guardando…' : conflict ? 'Revisa el conflicto' : 'Guardar curso'}
          </button>
        </div>
      </div>
    </form>
  )
}

interface CourseCardProps {
  course: Course
  selected: boolean
  busy: boolean
  compact: boolean
  expanded: boolean
  onToggle: () => void
  onEdit: () => void
  onStatusChange: () => void
  onDelete: () => void
}

function CourseCard({ course, selected, busy, compact, expanded, onToggle, onEdit, onStatusChange, onDelete }: CourseCardProps) {
  const topicPreview = course.topic_preview || activeTopics(course).slice(0, 3).map(topic => topic.title)
  const activeTopicCount = course.active_topic_count ?? activeTopics(course).length
  const archivedCount = Math.max(0, (course.topic_count ?? course.topics?.length ?? 0) - activeTopicCount)
  const triggerID = `course-${course.id}-trigger`
  const panelID = `course-${course.id}-panel`
  // React 18 treats `inert` as an unknown DOM attribute. An empty string keeps
  // the native boolean attribute in the rendered HTML while the type cast can
  // be removed once the runtime is upgraded to React 19.
  const collapsedInertProps = compact && !expanded
    ? ({ inert: '' } as unknown as HTMLAttributes<HTMLDivElement>)
    : {}

  return (
    <article className={`rounded-2xl border bg-white p-4 transition ${selected ? 'border-emerald-400 ring-2 ring-emerald-500/10' : 'border-slate-200 hover:border-slate-300 hover:shadow-sm'}`}>
      <button
        id={triggerID}
        type="button"
        onClick={compact ? onToggle : onEdit}
        aria-expanded={compact ? expanded : undefined}
        aria-controls={compact ? panelID : undefined}
        aria-label={compact ? `${expanded ? 'Contraer' : 'Ver detalles de'} ${course.name}` : `Editar ${course.name}`}
        className="flex min-h-11 w-full min-w-0 items-start gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
      >
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${course.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
          <BookOpen className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate text-sm font-bold text-slate-900" title={course.name}>{course.name}</h3>
            <StatusBadge status={course.status} />
          </div>
          {!compact && (course.description ? (
            <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-slate-500">{course.description}</p>
          ) : (
            <p className="mt-1.5 text-xs italic text-slate-400">Sin descripción</p>
          ))}
        </div>
        {compact && <ChevronDown className={`mt-2 h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 ease-out motion-reduce:transition-none motion-reduce:transform-none ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />}
      </button>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <Layers3 className="h-3.5 w-3.5" />
          {activeTopicCount} {activeTopicCount === 1 ? 'tema' : 'temas'}
        </span>
        <span>{course.usage_count || 0} {course.usage_count === 1 ? 'uso' : 'usos'}</span>
        {archivedCount > 0 && <span>{archivedCount} retirado{archivedCount === 1 ? '' : 's'}</span>}
        <span className="ml-auto">Actualizado {formatDate(course.updated_at)}</span>
      </div>

      <div
        {...collapsedInertProps}
        id={compact ? panelID : undefined}
        role={compact ? 'region' : undefined}
        aria-labelledby={compact ? triggerID : undefined}
        aria-hidden={compact ? !expanded : undefined}
        className={compact
          ? `grid transition-[grid-template-rows,opacity,transform] duration-200 ease-out motion-reduce:transition-none motion-reduce:transform-none ${expanded ? 'grid-rows-[1fr] translate-y-0 opacity-100' : 'grid-rows-[0fr] -translate-y-1 opacity-0'}`
          : undefined}
      >
        <div className={compact ? 'min-h-0 overflow-hidden' : undefined}>
          {compact && (course.description ? (
            <p className="mt-3 line-clamp-2 border-t border-slate-100 pt-3 text-xs leading-5 text-slate-500">{course.description}</p>
          ) : (
            <p className="mt-3 border-t border-slate-100 pt-3 text-xs italic text-slate-400">Sin descripción</p>
          ))}

          {topicPreview.length > 0 && (
            <ol className={`mt-3 space-y-1.5 ${compact ? '' : 'border-t border-slate-100 pt-3'}`}>
              {topicPreview.map((title, index) => (
                <li key={`${course.id}-preview-${index}`} className="flex min-w-0 items-center gap-2 text-xs text-slate-600">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-slate-100 text-[10px] font-bold text-slate-500">{index + 1}</span>
                  <span className="truncate">{title}</span>
                </li>
              ))}
              {activeTopicCount > topicPreview.length && <li className="pl-7 text-[11px] font-medium text-slate-400">+{activeTopicCount - topicPreview.length} temas más</li>}
            </ol>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={onEdit}
              disabled={busy}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-slate-100 px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Pencil className="h-4 w-4" />
              Editar
            </button>
            <button
              type="button"
              onClick={onStatusChange}
              disabled={busy}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={course.status === 'active' ? `Archivar ${course.name}` : `Restaurar ${course.name}`}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : course.status === 'active' ? <Archive className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
              <span className="hidden sm:inline">{course.status === 'active' ? 'Archivar' : 'Restaurar'}</span>
            </button>
            {course.usage_count === 0 && (
              <button
                type="button"
                onClick={onDelete}
                disabled={busy}
                className="flex h-11 w-11 items-center justify-center rounded-xl text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={`Eliminar permanentemente ${course.name}`}
                title="Eliminar permanentemente"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}

export default function CourseCatalog() {
  const router = useRouter()
  const { ref: workspaceRef, width: workspaceWidth } = useContainerWidth<HTMLDivElement>()
  const compact = workspaceWidth === 0 || workspaceWidth < 900
  const [courses, setCourses] = useState<Course[]>([])
  const [expandedCourseID, setExpandedCourseID] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<CourseStatus>('active')
  const [page, setPage] = useState(1)
  const [totalCourses, setTotalCourses] = useState(0)
  const [draft, setDraft] = useState<CourseDraft | null>(null)
  const [baseline, setBaseline] = useState('')
  const [editorError, setEditorError] = useState('')
  const [saveConflict, setSaveConflict] = useState<SaveConflictState | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyCourseID, setBusyCourseID] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const listRequestRef = useRef<AbortController | null>(null)
  const listSequenceRef = useRef(0)

  const dirty = Boolean(draft && comparableDraft(draft) !== baseline)
  const totalPages = Math.max(1, Math.ceil(totalCourses / PAGE_SIZE))

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, statusFilter])

  useEffect(() => {
    setExpandedCourseID(null)
  }, [compact, debouncedSearch, page, statusFilter])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3500)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!confirm) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirm(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [confirm])

  useEffect(() => {
    if (!dirty) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [dirty])

  useEffect(() => {
    if (!dirty) return
    const handleInternalNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const target = event.target
      const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null
      if (!anchor || anchor.hasAttribute('download')) return
      const anchorTarget = anchor.getAttribute('target')
      if (anchorTarget && anchorTarget !== '_self') return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      if (url.pathname === window.location.pathname && url.search === window.location.search) return

      event.preventDefault()
      event.stopPropagation()
      if (saving || busyCourseID) {
        setToast({ message: 'Espera a que termine la operación antes de salir.', tone: 'error' })
        return
      }
      const destination = `${url.pathname}${url.search}${url.hash}`
      setConfirm({
        title: 'Salir sin guardar',
        message: 'Hay cambios sin guardar. Si navegas a otra sección, se perderán.',
        confirmLabel: 'Salir de todos modos',
        tone: 'danger',
        onConfirm: () => router.push(destination),
      })
    }
    document.addEventListener('click', handleInternalNavigation, true)
    return () => document.removeEventListener('click', handleInternalNavigation, true)
  }, [busyCourseID, dirty, router, saving])

  const loadCourses = useCallback(async () => {
    listRequestRef.current?.abort()
    const controller = new AbortController()
    listRequestRef.current = controller
    const sequence = ++listSequenceRef.current
    setLoading(true)
    setListError('')

    const params = new URLSearchParams({ status: statusFilter, page: String(page), page_size: String(PAGE_SIZE) })
    if (debouncedSearch) params.set('search', debouncedSearch)
    const response = await api<CourseListResponse>(`/api/programs/courses?${params.toString()}`, {
      signal: controller.signal,
    })

    if (controller.signal.aborted || sequence !== listSequenceRef.current) return
    if (!response.success || !Array.isArray(response.data?.courses)) {
      setListError(response.error || 'No se pudo cargar el catálogo de cursos.')
    } else {
      setCourses(response.data.courses)
      setTotalCourses(response.data.total)
    }
    setLoading(false)
  }, [debouncedSearch, page, statusFilter])

  const refreshLatestCourse = useCallback(async (courseID: string) => {
    await loadCourses()
    const response = await api<CourseResponse>(`/api/programs/courses/${courseID}`)
    if (!response.success || !response.data?.course) return null
    return response.data.course
  }, [loadCourses])

  useEffect(() => {
    void loadCourses()
    return () => listRequestRef.current?.abort()
  }, [loadCourses])

  const closeEditorNow = useCallback(() => {
    setDraft(null)
    setBaseline('')
    setEditorError('')
    setSaveConflict(null)
  }, [])

  const requestCloseEditor = useCallback(() => {
    if (!draft) return
    if (saving) return
    if (!dirty) {
      closeEditorNow()
      return
    }
    setConfirm({
      title: 'Descartar cambios',
      message: 'Hay cambios sin guardar en este curso. Si sales ahora, se perderán.',
      confirmLabel: 'Descartar',
      tone: 'danger',
      onConfirm: closeEditorNow,
    })
  }, [closeEditorNow, dirty, draft, saving])

  useEffect(() => {
    if (!compact || !draft || confirm) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestCloseEditor()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [compact, confirm, draft, requestCloseEditor])

  const openDraft = useCallback((next: CourseDraft) => {
    setDraft(next)
    setBaseline(comparableDraft(next))
    setEditorError('')
    setSaveConflict(null)
  }, [])

  const requestOpenDraft = (next: CourseDraft) => {
    if (saving || busyCourseID) return
    if (draft && dirty) {
      setConfirm({
        title: 'Cambios sin guardar',
        message: 'Para abrir otro curso debes descartar los cambios actuales.',
        confirmLabel: 'Descartar y continuar',
        tone: 'danger',
        onConfirm: () => openDraft(next),
      })
      return
    }
    openDraft(next)
  }

  const loadCourseForEditing = async (course: Course) => {
    if (saving || busyCourseID) return
    setBusyCourseID(course.id)
    const response = await api<CourseResponse>(`/api/programs/courses/${course.id}`)
    setBusyCourseID(null)
    if (!response.success || !response.data?.course) {
      setToast({ message: response.error || 'No se pudo cargar el plan completo del curso.', tone: 'error' })
      return
    }
    openDraft(draftFromCourse(response.data.course))
  }

  const requestEditCourse = (course: Course) => {
    if (saving || busyCourseID) return
    if (draft && dirty) {
      setConfirm({
        title: 'Cambios sin guardar',
        message: 'Para abrir otro curso debes descartar los cambios actuales.',
        confirmLabel: 'Descartar y continuar',
        tone: 'danger',
        onConfirm: () => void loadCourseForEditing(course),
      })
      return
    }
    void loadCourseForEditing(course)
  }

  const handleSave = async () => {
    if (!draft || saving) return
    setEditorError('')
    if (!draft.name.trim()) {
      setEditorError('Escribe un nombre para el curso.')
      return
    }
    const invalidTopicIndex = draft.topics.findIndex(topic => topic.status === 'active' && !topic.title.trim())
    if (invalidTopicIndex >= 0) {
      const activeIndex = draft.topics.slice(0, invalidTopicIndex + 1).filter(topic => topic.status === 'active').length
      setEditorError(`El tema ${activeIndex} necesita un título. Puedes completarlo o eliminar esa fila.`)
      return
    }

    setSaving(true)
    const response = await api<CourseResponse>(draft.id ? `/api/programs/courses/${draft.id}` : '/api/programs/courses', {
      method: draft.id ? 'PUT' : 'POST',
      body: JSON.stringify(draftToInput(draft)),
    })

    if (!response.success || !response.data?.course) {
      if (draft.id && isCourseConflict(response)) {
        const latest = await refreshLatestCourse(draft.id)
        setSaving(false)
        if (latest) {
          setSaveConflict({ latest })
          setEditorError('')
        } else {
          setEditorError('El curso cambió y no pudimos recuperar su versión vigente. Conservamos tu borrador; actualiza el catálogo e inténtalo nuevamente.')
        }
        return
      }
      setSaving(false)
      setEditorError(response.error || 'No se pudo guardar el curso. Revisa los datos e inténtalo nuevamente.')
      return
    }

    setSaving(false)
    const saved = response.data.course
    const savedDraft = draftFromCourse(saved)
    setSaveConflict(null)
    setToast({ message: draft.id ? 'Curso actualizado' : 'Curso creado', tone: 'success' })

    if (saved.status !== statusFilter) {
      closeEditorNow()
    } else {
      setCourses(current => {
        const exists = current.some(course => course.id === saved.id)
        if (!exists) return [saved, ...current]
        return current.map(course => course.id === saved.id ? saved : course)
      })
      setDraft(savedDraft)
      setBaseline(comparableDraft(savedDraft))
    }
    void loadCourses()
  }

  const runStatusChange = async (
    course: Course,
    requestedStatus?: CourseStatus,
  ) => {
    const nextStatus: CourseStatus = requestedStatus || (course.status === 'active' ? 'archived' : 'active')
    setBusyCourseID(course.id)
    const currentResponse = await api<CourseResponse>(`/api/programs/courses/${course.id}`)
    if (!currentResponse.success || !currentResponse.data?.course) {
      setBusyCourseID(null)
      setToast({ message: currentResponse.error || 'No se pudo cargar la versión vigente del curso.', tone: 'error' })
      return
    }
    const currentCourse = currentResponse.data.course
    if (currentCourse.status === nextStatus) {
      if (draft?.id === course.id) closeEditorNow()
      setCourses(current => current.filter(item => item.id !== course.id))
      setToast({ message: nextStatus === 'archived' ? 'El curso ya estaba archivado' : 'El curso ya estaba activo', tone: 'success' })
      setBusyCourseID(null)
      void loadCourses()
      return
    }
    const response = await api<CourseResponse>(`/api/programs/courses/${course.id}`, {
      method: 'PUT',
      body: JSON.stringify(courseToInput(currentCourse, nextStatus)),
    })

    if (!response.success || !response.data?.course) {
      if (isCourseConflict(response)) {
        const latest = await refreshLatestCourse(course.id)
        setBusyCourseID(null)
        if (!latest) {
          setToast({ message: 'El curso cambió y no pudimos recuperar su versión vigente. El catálogo fue actualizado.', tone: 'error' })
          return
        }
        const action = nextStatus === 'archived' ? 'archivar' : 'restaurar'
        const alreadyApplied = latest.status === nextStatus
        setConfirm({
          title: `El curso cambió antes de ${action}`,
          message: `No aplicamos la operación sobre datos antiguos. La versión vigente “${latest.name}” está ${latest.status === 'active' ? 'activa' : 'archivada'}, tiene ${activeTopics(latest).length} temas activos y ${latest.usage_count || 0} usos. ${alreadyApplied ? 'El estado solicitado ya fue aplicado por otra persona.' : `Puedes revisar estos datos y ${action} ahora la versión vigente.`}`,
          confirmLabel: alreadyApplied ? 'Aceptar estado vigente' : `${nextStatus === 'archived' ? 'Archivar' : 'Restaurar'} versión vigente`,
          onConfirm: () => void runStatusChange(latest, nextStatus),
        })
        return
      }
      setBusyCourseID(null)
      setToast({ message: response.error || 'No se pudo cambiar el estado del curso.', tone: 'error' })
      return
    }
    setBusyCourseID(null)
    if (draft?.id === course.id) closeEditorNow()
    setCourses(current => current.filter(item => item.id !== course.id))
    setToast({ message: nextStatus === 'archived' ? 'Curso archivado' : 'Curso restaurado', tone: 'success' })
    void loadCourses()
  }

  const requestStatusChange = (course: Course) => {
    if (busyCourseID || saving) return
    const continueAction = () => {
      if (course.status === 'active') {
        setConfirm({
          title: 'Archivar curso',
          message: `“${course.name}” dejará de aparecer entre los cursos activos, pero sus asociaciones e historial se conservarán.`,
          confirmLabel: 'Archivar',
          onConfirm: () => void runStatusChange(course),
        })
      } else {
        void runStatusChange(course)
      }
    }

    if (draft && dirty) {
      setConfirm({
        title: 'Cambios sin guardar',
        message: 'Debes descartar los cambios actuales antes de modificar el estado del curso.',
        confirmLabel: 'Descartar y continuar',
        tone: 'danger',
        onConfirm: () => {
          closeEditorNow()
          continueAction()
        },
      })
      return
    }
    continueAction()
  }

  const runDelete = async (course: CourseDeleteTarget) => {
    setBusyCourseID(course.id)
    const response = await api<DeleteCourseResponse>(`/api/programs/courses/${course.id}?expected_updated_at=${encodeURIComponent(course.updated_at)}`, { method: 'DELETE' })

    if (!response.success) {
      if (isCourseConflict(response)) {
        const latest = await refreshLatestCourse(course.id)
        setBusyCourseID(null)
        if (!latest) {
          setToast({ message: 'El curso cambió o ya no está disponible. No se eliminó nada y el catálogo fue actualizado.', tone: 'error' })
          return
        }
        const willArchive = latest.usage_count > 0
        setConfirm({
          title: 'El curso cambió antes de eliminarlo',
          message: `No aplicamos la eliminación sobre datos antiguos. La versión vigente “${latest.name}” tiene ${activeTopics(latest).length} temas activos y ${latest.usage_count || 0} usos. ${willArchive ? 'Para proteger programas y sesiones, al continuar se archivará en lugar de eliminarse.' : 'Puedes revisar estos datos y confirmar nuevamente la eliminación permanente.'}`,
          confirmLabel: willArchive ? 'Archivar versión vigente' : 'Eliminar versión vigente',
          tone: willArchive ? 'default' : 'danger',
          onConfirm: () => void runDelete(latest),
        })
        return
      }
      setBusyCourseID(null)
      setToast({ message: friendlyDeleteError(response.error), tone: 'error' })
      return
    }
    setBusyCourseID(null)

    if (draft?.id === course.id) closeEditorNow()
    setCourses(current => current.filter(item => item.id !== course.id))
    if (response.data?.archived) {
      setToast({
        message: 'El curso adquirió usos mientras se eliminaba, por lo que fue archivado para proteger el historial.',
        tone: 'success',
      })
    } else {
      setToast({ message: 'Curso eliminado permanentemente', tone: 'success' })
    }
    void loadCourses()
  }

  const requestDelete = (course: CourseDeleteTarget) => {
    if (busyCourseID || saving) return
    const willArchive = course.usage_count > 0
    setConfirm({
      title: willArchive ? 'Archivar curso en uso' : 'Eliminar curso permanentemente',
      message: willArchive
        ? `“${course.name}” ya tiene usos y no puede eliminarse sin afectar el historial. Al continuar se archivará y conservará sus asociaciones.`
        : `Esta acción eliminará “${course.name}” y todos sus temas sin uso. No se puede deshacer.`,
      confirmLabel: willArchive ? 'Archivar curso' : 'Eliminar definitivamente',
      tone: willArchive ? 'default' : 'danger',
      onConfirm: () => void runDelete(course),
    })
  }

  const reviewSaveConflict = () => {
    if (!draft || !saveConflict) return
    const latest = saveConflict.latest
    const latestDraft = draftFromCourse(latest)
    const latestTopicCount = activeTopics(latest).length
    const draftTopicCount = draft.topics.filter(topic => topic.status === 'active').length
    setConfirm({
      title: 'Revisar cambios concurrentes',
      message: `La versión vigente es “${latest.name}”, está ${latest.status === 'active' ? 'activa' : 'archivada'} y tiene ${latestTopicCount} ${latestTopicCount === 1 ? 'tema activo' : 'temas activos'} (actualizada ${formatDate(latest.updated_at)}). Tu borrador “${draft.name}” tiene ${draftTopicCount}. Puedes usar la versión vigente o preparar tu borrador para reaplicarlo de forma explícita.`,
      confirmLabel: 'Reaplicar mi borrador',
      secondaryLabel: 'Usar versión vigente',
      onSecondary: () => {
        setDraft(latestDraft)
        setBaseline(comparableDraft(latestDraft))
        setEditorError('')
        setSaveConflict(null)
        setToast({ message: 'Se cargó la versión vigente del curso', tone: 'success' })
      },
      onConfirm: () => {
        const rebased = rebaseDraftOntoLatest(draft, latest)
        setDraft(rebased)
        setBaseline(comparableDraft(latestDraft))
        setEditorError('')
        setSaveConflict(null)
        setToast({ message: 'Borrador preparado. Revísalo y vuelve a Guardar para reaplicarlo.', tone: 'success' })
      },
    })
  }

  const requestBack = () => {
    if (saving || busyCourseID) return
    if (!dirty) {
      router.push('/dashboard/programs')
      return
    }
    setConfirm({
      title: 'Salir sin guardar',
      message: 'Hay cambios sin guardar. Si vuelves a Programas, se perderán.',
      confirmLabel: 'Salir de todos modos',
      tone: 'danger',
      onConfirm: () => router.push('/dashboard/programs'),
    })
  }

  const editor = draft ? (
    <CourseEditor
      draft={draft}
      setDraft={setDraft}
      compact={compact}
      dirty={dirty}
      saving={saving}
      error={editorError}
      conflict={saveConflict}
      usageCount={draft.usageCount}
      onSave={() => void handleSave()}
      onClose={requestCloseEditor}
      onDelete={() => {
        if (draft.id && draft.updatedAt) requestDelete({ id: draft.id, name: draft.name, usage_count: draft.usageCount, updated_at: draft.updatedAt })
      }}
      onReviewConflict={reviewSaveConflict}
    />
  ) : null

  return (
    <div ref={workspaceRef} className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-slate-200 bg-white px-3 py-3 sm:rounded-t-2xl sm:px-5 sm:py-4">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={requestBack}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
            aria-label="Volver a Programas"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 sm:flex">
              <BookOpen className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-bold tracking-tight text-slate-900 sm:text-xl">Cursos</h1>
              <p className="hidden truncate text-xs text-slate-500 sm:block">Planes de clases reutilizables para tus programas</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => requestOpenDraft(emptyDraft())}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3.5 text-sm font-semibold text-white shadow-sm shadow-emerald-600/20 transition hover:bg-emerald-700 sm:px-4"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden min-[380px]:inline">Nuevo curso</span>
            <span className="min-[380px]:hidden">Nuevo</span>
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden bg-slate-50/70">
        <div className={`grid h-full min-h-0 gap-4 ${compact ? 'grid-cols-1' : 'grid-cols-[minmax(360px,0.9fr)_minmax(480px,1.35fr)] p-4'}`}>
          <section className={`flex min-h-0 min-w-0 flex-col overflow-hidden bg-white ${compact ? '' : 'rounded-2xl border border-slate-200 shadow-sm'}`} aria-labelledby="course-list-title">
            <div className={`shrink-0 border-b border-slate-200 ${compact ? 'px-3 py-3' : 'p-4'}`}>
              <h2 id="course-list-title" className="sr-only">Listado de cursos</h2>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  placeholder="Buscar por nombre o descripción…"
                  aria-label="Buscar cursos"
                  className="min-h-11 w-full rounded-xl border border-slate-300 bg-slate-50 pl-10 pr-10 text-base text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500/20 sm:text-sm"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-slate-400 hover:text-slate-700"
                    aria-label="Limpiar búsqueda"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="mt-3 grid grid-cols-2 rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Estado de cursos">
                {(['active', 'archived'] as CourseStatus[]).map(status => (
                  <button
                    key={status}
                    type="button"
                    role="tab"
                    aria-selected={statusFilter === status}
                    onClick={() => setStatusFilter(status)}
                    className={`min-h-10 rounded-lg px-3 text-xs font-semibold transition ${statusFilter === status ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    {status === 'active' ? 'Activos' : 'Archivados'}
                  </button>
                ))}
              </div>
            </div>

            <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4">
              {loading && courses.length > 0 && (
                <div className="sticky top-0 z-10 mb-3 flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-xs font-medium text-slate-500 shadow-sm backdrop-blur">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-600" />
                  Actualizando catálogo…
                </div>
              )}

              {loading && courses.length === 0 ? (
                <div className="space-y-3" aria-label="Cargando cursos">
                  {[0, 1, 2].map(item => (
                    <div key={item} className="animate-pulse rounded-2xl border border-slate-200 bg-white p-4">
                      <div className="flex gap-3">
                        <div className="h-10 w-10 rounded-xl bg-slate-100" />
                        <div className="flex-1 space-y-2">
                          <div className="h-4 w-2/3 rounded bg-slate-100" />
                          <div className="h-3 w-full rounded bg-slate-100" />
                        </div>
                      </div>
                      <div className="mt-4 h-10 rounded-xl bg-slate-100" />
                    </div>
                  ))}
                </div>
              ) : listError ? (
                <div className="flex min-h-64 flex-col items-center justify-center px-4 text-center">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-red-50 text-red-600">
                    <AlertCircle className="h-5 w-5" />
                  </div>
                  <p className="mt-3 text-sm font-semibold text-slate-800">No pudimos cargar los cursos</p>
                  <p className="mt-1 max-w-sm text-xs leading-5 text-slate-500">{listError}</p>
                  <button
                    type="button"
                    onClick={() => void loadCourses()}
                    className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Reintentar
                  </button>
                </div>
              ) : courses.length === 0 ? (
                <div className="flex min-h-64 flex-col items-center justify-center px-4 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
                    {debouncedSearch ? <Search className="h-5 w-5" /> : statusFilter === 'archived' ? <Archive className="h-5 w-5" /> : <BookOpen className="h-5 w-5" />}
                  </div>
                  <p className="mt-3 text-sm font-semibold text-slate-800">
                    {debouncedSearch ? 'No encontramos coincidencias' : statusFilter === 'archived' ? 'No hay cursos archivados' : 'Crea tu primer curso'}
                  </p>
                  <p className="mt-1 max-w-xs text-xs leading-5 text-slate-500">
                    {debouncedSearch
                      ? 'Prueba con otro nombre o limpia la búsqueda.'
                      : statusFilter === 'archived'
                        ? 'Los cursos que archives aparecerán aquí y podrán restaurarse.'
                        : 'Organiza un plan con temas y úsalo como guía flexible en tus programas.'}
                  </p>
                  {!debouncedSearch && statusFilter === 'active' && (
                    <button
                      type="button"
                      onClick={() => requestOpenDraft(emptyDraft())}
                      className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white transition hover:bg-emerald-700"
                    >
                      <Plus className="h-4 w-4" />
                      Crear curso
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {courses.map(course => (
                    <CourseCard
                      key={course.id}
                      course={course}
                      selected={draft?.id === course.id}
                      busy={busyCourseID === course.id}
                      compact={compact}
                      expanded={expandedCourseID === course.id}
                      onToggle={() => setExpandedCourseID(current => current === course.id ? null : course.id)}
                      onEdit={() => requestEditCourse(course)}
                      onStatusChange={() => requestStatusChange(course)}
                      onDelete={() => requestDelete(course)}
                    />
                  ))}
                </div>
              )}
            </div>

            {!loading && !listError && courses.length > 0 && (
              <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-white px-3 py-2.5 sm:px-4">
                <p className="text-[11px] text-slate-500">
                  {totalCourses} {totalCourses === 1 ? 'curso' : 'cursos'}
                </p>
                {totalPages > 1 && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setPage(current => Math.max(1, current - 1))}
                      disabled={page === 1}
                      className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
                      aria-label="Página anterior"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <span className="min-w-16 text-center text-xs font-medium text-slate-600">{page} de {totalPages}</span>
                    <button
                      type="button"
                      onClick={() => setPage(current => Math.min(totalPages, current + 1))}
                      disabled={page === totalPages}
                      className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
                      aria-label="Página siguiente"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          {!compact && (
            <aside className="min-h-0 min-w-0 overflow-hidden" aria-label="Editor del curso">
              {editor || (
                <div className="flex h-full min-h-0 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/70 px-8 text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
                    <BookOpen className="h-6 w-6" />
                  </div>
                  <h2 className="mt-4 text-base font-bold text-slate-800">Selecciona un curso</h2>
                  <p className="mt-1 max-w-sm text-sm leading-6 text-slate-500">Edita sus datos y ordena los temas sin salir del catálogo.</p>
                  <button
                    type="button"
                    onClick={() => requestOpenDraft(emptyDraft())}
                    className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white transition hover:bg-emerald-700"
                  >
                    <Plus className="h-4 w-4" />
                    Crear un curso
                  </button>
                </div>
              )}
            </aside>
          )}
        </div>
      </div>

      {compact && editor && typeof document !== 'undefined' && createPortal(editor, document.body)}

      {confirm && typeof document !== 'undefined' && createPortal(
        <div
          className="app-viewport fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setConfirm(null)
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl" role="alertdialog" aria-modal="true" aria-labelledby="course-confirm-title" aria-describedby="course-confirm-message">
            <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${confirm.tone === 'danger' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'}`}>
              {confirm.tone === 'danger' ? <Trash2 className="h-5 w-5" /> : <Archive className="h-5 w-5" />}
            </div>
            <h2 id="course-confirm-title" className="mt-4 text-lg font-bold text-slate-900">{confirm.title}</h2>
            <p id="course-confirm-message" className="mt-2 text-sm leading-6 text-slate-600">{confirm.message}</p>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                autoFocus
                className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Cancelar
              </button>
              {confirm.secondaryLabel && confirm.onSecondary && (
                <button
                  type="button"
                  onClick={() => {
                    const action = confirm.onSecondary
                    setConfirm(null)
                    action?.()
                  }}
                  className="min-h-11 rounded-xl border border-emerald-200 bg-emerald-50 px-4 text-sm font-semibold text-emerald-800 transition hover:bg-emerald-100"
                >
                  {confirm.secondaryLabel}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  const action = confirm.onConfirm
                  setConfirm(null)
                  action()
                }}
                className={`min-h-11 rounded-xl px-4 text-sm font-semibold text-white transition ${confirm.tone === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-slate-800 hover:bg-slate-900'}`}
              >
                {confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {toast && typeof document !== 'undefined' && createPortal(
        <div className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[110] flex justify-center px-4" role="status" aria-live="polite">
          <div className={`flex max-w-lg items-start gap-2.5 rounded-xl border bg-white px-4 py-3 text-sm font-medium shadow-xl ${toast.tone === 'success' ? 'border-emerald-200 text-emerald-800' : 'border-red-200 text-red-700'}`}>
            {toast.tone === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />}
            <span>{toast.message}</span>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
