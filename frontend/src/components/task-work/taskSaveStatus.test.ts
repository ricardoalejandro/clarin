import { describe, expect, it } from 'vitest'
import {
  TASK_SAVE_ABSOLUTE_AFTER_MS,
  deriveTaskSaveStatus,
  formatTaskSaveTime,
  latestTaskPersistenceTimestamp,
  taskHasPendingSave,
  taskSaveStatusText,
} from './taskSaveStatus'

const updatedAt = '2026-09-05T10:00:00.000Z'
const base = {
  canEdit: true,
  updatedAt,
  hasPendingSave: false,
  hasDraftChanges: false,
} as const

describe('task save status', () => {
  it('applies conflict, error, saving, dirty and saved precedence', () => {
    expect(deriveTaskSaveStatus({ ...base, descriptionPhase: 'conflict', failureKind: 'error', hasPendingSave: true, hasDraftChanges: true, commentPhase: 'error' }).phase).toBe('conflict')
    expect(deriveTaskSaveStatus({ ...base, failureKind: 'error', hasPendingSave: true, hasDraftChanges: true, commentPhase: 'error' }).phase).toBe('error')
    expect(deriveTaskSaveStatus({ ...base, hasPendingSave: true, hasDraftChanges: true, commentPhase: 'error' }).phase).toBe('comment-error')
    expect(deriveTaskSaveStatus({ ...base, hasPendingSave: true, hasDraftChanges: true, commentPhase: 'publishing' }).phase).toBe('saving')
    expect(deriveTaskSaveStatus({ ...base, hasDraftChanges: true, commentPhase: 'publishing' }).phase).toBe('comment-publishing')
    expect(deriveTaskSaveStatus({ ...base, hasDraftChanges: true, commentPhase: 'dirty' }).phase).toBe('dirty')
    expect(deriveTaskSaveStatus({ ...base, commentPhase: 'dirty' }).phase).toBe('comment-dirty')
    expect(deriveTaskSaveStatus(base).phase).toBe('saved')
    expect(deriveTaskSaveStatus({ ...base, canEdit: false, descriptionPhase: 'conflict' }).phase).toBe('readonly')
    expect(deriveTaskSaveStatus({ ...base, canEdit: false, commentPhase: 'publishing' }).phase).toBe('comment-publishing')
    expect(deriveTaskSaveStatus({ ...base, canEdit: false, commentPhase: 'error' }).phase).toBe('comment-error')
  })

  it('counts only autosaved task fields for the active task', () => {
    const pending = {
      'task-a:title': 1,
      'task-a:comment-create': 1,
      'task-a:upload:task': 1,
      'task-b:description': 1,
    }
    expect(taskHasPendingSave(pending, 'task-a')).toBe(true)
    expect(taskHasPendingSave({ 'task-a:comment-create': 1, 'task-a:dependency-create': 1 }, 'task-a')).toBe(false)
    expect(taskHasPendingSave(pending, 'task-b')).toBe(true)
    expect(taskHasPendingSave(pending, 'task-c')).toBe(false)
  })

  it('formats now, minute, minutes, hours and absolute dates', () => {
    const now = Date.parse(updatedAt)
    expect(formatTaskSaveTime(updatedAt, now + 59_999).relative).toBe('ahora')
    expect(formatTaskSaveTime(updatedAt, now + 60_000).relative).toBe('hace 1 min')
    expect(formatTaskSaveTime(updatedAt, now + 2 * 60_000).relative).toBe('hace 2 min')
    expect(formatTaskSaveTime(updatedAt, now + 59 * 60_000).relative).toBe('hace 59 min')
    expect(formatTaskSaveTime(updatedAt, now + 60 * 60_000).relative).toBe('hace 1 h')
    expect(formatTaskSaveTime(updatedAt, now + 23 * 60 * 60_000).relative).toBe('hace 23 h')
    expect(formatTaskSaveTime(updatedAt, now + TASK_SAVE_ABSOLUTE_AFTER_MS).relative).not.toContain('hace')
    expect(formatTaskSaveTime('not-a-date', now)).toEqual({ relative: null, absolute: null })
  })

  it('uses the newest valid canonical task, comment or session timestamp', () => {
    expect(latestTaskPersistenceTimestamp(updatedAt, [
      { created_at: '2026-09-05T10:01:00.000Z', updated_at: 'not-a-date' },
      { created_at: '2026-09-05T10:02:00.000Z', updated_at: '2026-09-05T10:03:00.000Z' },
    ], '2026-09-05T10:02:30.000Z')).toBe('2026-09-05T10:03:00.000Z')
    expect(latestTaskPersistenceTimestamp('invalid', [{ created_at: 'also-invalid' }], '2026-09-05T10:04:00.000Z')).toBe('2026-09-05T10:04:00.000Z')
    expect(latestTaskPersistenceTimestamp('invalid', [{ created_at: 'also-invalid' }])).toBeUndefined()
  })

  it('uses compact, editable and read-only copy without inventing a time', () => {
    const now = Date.parse(updatedAt)
    const saved = deriveTaskSaveStatus(base)
    expect(taskSaveStatusText(saved, now, false)).toBe('Guardado automáticamente · ahora')
    expect(taskSaveStatusText(saved, now, true)).toBe('Guardado · ahora')
    expect(taskSaveStatusText({ phase: 'readonly', updatedAt }, now)).toBe('Actualizado · ahora')
    expect(taskSaveStatusText({ phase: 'saved' }, now)).toBe('Guardado automáticamente')
    expect(taskSaveStatusText({ phase: 'comment-dirty', updatedAt }, now)).toBe('Comentario sin publicar')
    expect(taskSaveStatusText({ phase: 'comment-publishing', updatedAt }, now)).toBe('Publicando comentario…')
    expect(taskSaveStatusText({ phase: 'comment-error', updatedAt }, now)).toBe('No se pudo publicar · Reintentar')
  })
})
