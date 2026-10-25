import { describe, expect, it } from 'vitest'
import type { TaskEnvironment } from '@/types/task'
import {
  mergeTaskEnvironmentIndex, taskEnvironmentCanRemove, taskEnvironmentInventoryChanged, taskEnvironmentStructureEvent,
  preferredTaskEnvironmentNeedsFetch,
  selectActiveTaskEnvironment,
  taskEnvironmentPreferenceKey,
} from './taskEnvironmentIndex'

function environment(id: string, options: Partial<TaskEnvironment> = {}): TaskEnvironment {
  return {
    id,
    account_id: 'account-1',
    name: id,
    color: '#6366F1',
    icon: 'layers',
    sort_order: 1,
    visibility: 'restricted',
    default_access_level: 'none',
    is_default: false,
    version: 1,
    access_revision: 1,
    created_at: '',
    updated_at: '',
    folder_count: 0,
    list_count: 0,
    task_count: 0,
    open_task_count: 0,
    completed_task_count: 0,
    cancelled_task_count: 0,
    permissions: { level: 'full', can_view: true, can_comment: true, can_edit: true, can_delete: true, can_manage_access: true },
    ...options,
  }
}

describe('task environment index', () => {
  it('restores a preferred environment fetched outside the first page', () => {
    const firstPage = [environment('general', { is_default: true }), environment('page-50')]
    expect(preferredTaskEnvironmentNeedsFetch(firstPage, 'page-51')).toBe(true)

    const merged = mergeTaskEnvironmentIndex(firstPage, [environment('page-51', { sort_order: 51 })])
    expect(selectActiveTaskEnvironment(merged, 'page-51')?.id).toBe('page-51')
  })

  it('opens a preferred historical environment and falls back when it is unavailable', () => {
    const environments = [
      environment('preferred', { archived_at: '2026-08-01T00:00:00Z' }),
      environment('general', { is_default: true }),
    ]
    expect(selectActiveTaskEnvironment(environments, 'preferred')?.id).toBe('preferred')
    expect(selectActiveTaskEnvironment(environments, 'missing')?.id).toBe('general')
  })

  it('scopes preferences by account and actor', () => {
    expect(taskEnvironmentPreferenceKey('account-1', 'user-2')).toBe('clarin:tasks:account-1:user-2:active-environment:v1')
  })
})

it('allows Administrar to prepare a populated environment removal while protecting General and missing capabilities', () => {
  expect(taskEnvironmentCanRemove(environment('populated', { task_count: 500, open_task_count: 400 }))).toBe(true)
  expect(taskEnvironmentCanRemove(environment('general', { is_default: true }))).toBe(false)
  expect(taskEnvironmentCanRemove(environment('deleted', { deleted_at: '2026-10-24' }))).toBe(false)
  expect(taskEnvironmentCanRemove(environment('view', { permissions: undefined } as unknown as Partial<TaskEnvironment>))).toBe(false)
})
it('refreshes environment inventory after count-changing work and structure, without treating comments or a title edit as structural', () => {
  const before = { id: 'task', environment_id: 'env', list_id: 'a', status: 'pending', status_id: 'active' } as import('@/types/task').Task
  expect(taskEnvironmentInventoryChanged(before, { ...before, title: 'New title' })).toBe(false)
  expect(taskEnvironmentInventoryChanged(before, { ...before, status_id: 'done' })).toBe(true)
  expect(taskEnvironmentInventoryChanged(before, { ...before, list_id: 'b' })).toBe(true)
  expect(taskEnvironmentInventoryChanged(null, before)).toBe(true)
  expect(taskEnvironmentInventoryChanged(before, null)).toBe(true)
  expect(taskEnvironmentStructureEvent('container_removed')).toBe(true)
  expect(taskEnvironmentStructureEvent('environment_restored')).toBe(true)
  expect(taskEnvironmentStructureEvent('comment_created')).toBe(false)
})
it('falls back to General, then another authorized active environment, then an honest empty index', () => {
  const other = environment('other')
  const general = environment('general', { is_default: true })
  expect(selectActiveTaskEnvironment([other, general], 'removed')?.id).toBe('general')
  expect(selectActiveTaskEnvironment([other], 'removed')?.id).toBe('other')
  expect(selectActiveTaskEnvironment([], 'removed')).toBeUndefined()
})
