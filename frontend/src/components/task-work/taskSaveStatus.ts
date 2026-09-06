import type { TaskDescriptionSavePhase } from './taskDescriptionAutosave'

export const TASK_SAVE_RELATIVE_REFRESH_MS = 30_000
export const TASK_SAVE_ABSOLUTE_AFTER_MS = 24 * 60 * 60 * 1_000

export type TaskSaveStatusPhase =
  | 'saved'
  | 'dirty'
  | 'saving'
  | 'error'
  | 'conflict'
  | 'comment-dirty'
  | 'comment-publishing'
  | 'comment-error'
  | 'readonly'
export type TaskSaveFailureKind = 'error' | 'conflict'
export type TaskCommentPersistencePhase = 'dirty' | 'publishing' | 'error'

export type TaskSaveStatusModel = {
  phase: TaskSaveStatusPhase
  updatedAt?: string
}

export type TaskSaveStatusInput = {
  canEdit: boolean
  updatedAt?: string
  descriptionPhase?: TaskDescriptionSavePhase
  hasPendingSave: boolean
  hasDraftChanges: boolean
  failureKind?: TaskSaveFailureKind
  commentPhase?: TaskCommentPersistencePhase
}

export type TaskSaveTime = {
  relative: string | null
  absolute: string | null
}

export type TaskCommentPersistenceSource = {
  created_at?: string
  updated_at?: string
}

const taskSaveOperationKeys = new Set([
  'title',
  'description',
  'status',
  'owner',
  'dates',
  'priority',
  'progress',
  'list',
  'color',
  'collaborators',
])

const exactDateFormatter = new Intl.DateTimeFormat('es-PE', {
  dateStyle: 'long',
  timeStyle: 'short',
})

const shortDateFormatter = new Intl.DateTimeFormat('es-PE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

export function taskHasPendingSave(
  pending: Record<string, number>,
  taskId: string | null | undefined,
) {
  if (!taskId) return false
  const prefix = `${taskId}:`
  return Object.entries(pending).some(([scopedKey, count]) => {
    if (count <= 0 || !scopedKey.startsWith(prefix)) return false
    return taskSaveOperationKeys.has(scopedKey.slice(prefix.length))
  })
}

export function deriveTaskSaveStatus(input: TaskSaveStatusInput): TaskSaveStatusModel {
  if (input.canEdit && (input.descriptionPhase === 'conflict' || input.failureKind === 'conflict')) {
    return { phase: 'conflict', updatedAt: input.updatedAt }
  }
  if (input.canEdit && (input.descriptionPhase === 'error' || input.failureKind === 'error')) {
    return { phase: 'error', updatedAt: input.updatedAt }
  }
  if (input.commentPhase === 'error') return { phase: 'comment-error', updatedAt: input.updatedAt }
  if (input.canEdit && (input.hasPendingSave || input.descriptionPhase === 'saving')) {
    return { phase: 'saving', updatedAt: input.updatedAt }
  }
  if (input.commentPhase === 'publishing') return { phase: 'comment-publishing', updatedAt: input.updatedAt }
  if (input.canEdit && (input.hasDraftChanges || input.descriptionPhase === 'dirty')) {
    return { phase: 'dirty', updatedAt: input.updatedAt }
  }
  if (input.commentPhase === 'dirty') return { phase: 'comment-dirty', updatedAt: input.updatedAt }
  return { phase: input.canEdit ? 'saved' : 'readonly', updatedAt: input.updatedAt }
}

export function latestTaskPersistenceTimestamp(
  taskUpdatedAt?: string,
  comments: readonly TaskCommentPersistenceSource[] = [],
  lastConfirmedAt?: string,
) {
  const candidates = [
    taskUpdatedAt,
    lastConfirmedAt,
    ...comments.flatMap(comment => [comment.created_at, comment.updated_at]),
  ]
  let latest: { value: string; time: number } | undefined
  for (const value of candidates) {
    if (!value) continue
    const time = new Date(value).getTime()
    if (!Number.isFinite(time) || (latest && time <= latest.time)) continue
    latest = { value, time }
  }
  return latest?.value
}

export function formatTaskSaveTime(updatedAt?: string, now = Date.now()): TaskSaveTime {
  if (!updatedAt) return { relative: null, absolute: null }
  const savedAt = new Date(updatedAt)
  const savedAtMs = savedAt.getTime()
  if (!Number.isFinite(savedAtMs)) return { relative: null, absolute: null }

  const elapsed = Math.max(0, now - savedAtMs)
  const absolute = exactDateFormatter.format(savedAt)
  if (elapsed < 60_000) return { relative: 'ahora', absolute }
  if (elapsed < 60 * 60_000) {
    return { relative: `hace ${Math.floor(elapsed / 60_000)} min`, absolute }
  }
  if (elapsed < TASK_SAVE_ABSOLUTE_AFTER_MS) {
    return { relative: `hace ${Math.floor(elapsed / (60 * 60_000))} h`, absolute }
  }
  return { relative: shortDateFormatter.format(savedAt), absolute }
}

export function taskSaveStatusText(
  model: TaskSaveStatusModel,
  now = Date.now(),
  compact = false,
) {
  if (model.phase === 'dirty') return 'Cambios pendientes'
  if (model.phase === 'saving') return 'Guardando cambios…'
  if (model.phase === 'error') return 'No se pudo guardar · Reintentar'
  if (model.phase === 'conflict') return 'Conflicto de cambios · Revisar'
  if (model.phase === 'comment-dirty') return 'Comentario sin publicar'
  if (model.phase === 'comment-publishing') return 'Publicando comentario…'
  if (model.phase === 'comment-error') return 'No se pudo publicar · Reintentar'

  const time = formatTaskSaveTime(model.updatedAt, now)
  const prefix = model.phase === 'readonly'
    ? 'Actualizado'
    : compact
      ? 'Guardado'
      : 'Guardado automáticamente'
  return time.relative ? `${prefix} · ${time.relative}` : prefix
}

export function taskSaveStatusAnnouncement(model: TaskSaveStatusModel) {
  if (model.phase === 'dirty') return 'Hay cambios pendientes de guardado.'
  if (model.phase === 'saving') return 'Guardando cambios en Clarin.'
  if (model.phase === 'error') return 'No se pudieron guardar los cambios.'
  if (model.phase === 'conflict') return 'Hay un conflicto de cambios que requiere revisión.'
  if (model.phase === 'comment-dirty') return 'Hay un comentario sin publicar.'
  if (model.phase === 'comment-publishing') return 'Publicando comentario en Clarin.'
  if (model.phase === 'comment-error') return 'No se pudo publicar el comentario.'
  if (model.phase === 'readonly') return 'Tarea actualizada.'
  return 'Todos los cambios están guardados.'
}
