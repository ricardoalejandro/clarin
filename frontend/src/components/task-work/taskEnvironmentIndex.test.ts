import { describe, expect, it } from 'vitest'
import type { TaskEnvironment } from '@/types/task'
import {
  mergeTaskEnvironmentIndex,
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

  it('falls back to the active default when the preferred environment is unavailable or archived', () => {
    const environments = [
      environment('preferred', { archived_at: '2026-08-01T00:00:00Z' }),
      environment('general', { is_default: true }),
    ]
    expect(selectActiveTaskEnvironment(environments, 'preferred')?.id).toBe('general')
    expect(selectActiveTaskEnvironment(environments, 'missing')?.id).toBe('general')
  })

  it('scopes preferences by account and actor', () => {
    expect(taskEnvironmentPreferenceKey('account-1', 'user-2')).toBe('clarin:tasks:account-1:user-2:active-environment:v1')
  })
})
