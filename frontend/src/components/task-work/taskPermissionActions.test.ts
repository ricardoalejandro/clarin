import { describe, expect, it } from 'vitest'
import type { Task, TaskPermissions } from '@/types/task'
import {
  allTasksCanBeAdministered,
  allTasksCanEdit,
  canAdministerTask,
  canCommentOnTask,
  canEditTask,
} from './taskPermissionActions'

function taskWith(level: TaskPermissions['level'], overrides: Partial<TaskPermissions> = {}) {
  const rank = { none: 0, view: 1, comment: 2, edit: 3, full: 4 }[level]
  return {
    permissions: {
      level,
      can_view: rank >= 1,
      can_comment: rank >= 2,
      can_edit: rank >= 3,
      can_delete: rank >= 4,
      can_manage_access: false,
      ...overrides,
    },
  } as Pick<Task, 'permissions'>
}

describe('task capability gates', () => {
  it('keeps Ver read-only and Comentar limited to conversation actions', () => {
    expect(canEditTask(taskWith('view'))).toBe(false)
    expect(canCommentOnTask(taskWith('view'))).toBe(false)
    expect(canCommentOnTask(taskWith('comment'))).toBe(true)
    expect(canEditTask(taskWith('comment'))).toBe(false)
  })

  it('separates Editar from Administrar and access governance', () => {
    expect(canEditTask(taskWith('edit'))).toBe(true)
    expect(canAdministerTask(taskWith('edit'))).toBe(false)
    expect(canAdministerTask(taskWith('full', { can_manage_access: false }))).toBe(true)
  })

  it('requires every selected task to authorize a bulk action', () => {
    expect(allTasksCanEdit([taskWith('edit'), taskWith('full')])).toBe(true)
    expect(allTasksCanEdit([taskWith('edit'), taskWith('comment')])).toBe(false)
    expect(allTasksCanBeAdministered([taskWith('full'), taskWith('edit')])).toBe(false)
  })

  it('fails closed for stale or partial snapshots and honors explicit denies', () => {
    expect(canEditTask({})).toBe(false)
    expect(canCommentOnTask(null)).toBe(false)
    expect(canAdministerTask(undefined)).toBe(false)
    expect(canEditTask(taskWith('none'))).toBe(false)
  })
})
