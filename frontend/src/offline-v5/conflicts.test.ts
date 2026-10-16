import { describe, expect, it } from 'vitest'
import { offlineV5ConflictCanMerge, offlineV5ConflictRetry } from './conflicts'
import type { OfflineV5Conflict, OfflineV5Operation } from './types'

const operation = { operation_id: 'original', action: 'tasks.update', selection_id: 'list-selection', resource_id: 'task',
  base_version: 2, base: { title: 'Before', description: 'Old' }, payload: { title: 'Mine', description: 'Independent edit' } } as OfflineV5Operation
const conflict: OfflineV5Conflict = { operation_id: 'original', action: 'tasks.update', selection_id: 'list-selection', resource_id: 'task', status: 'conflict',
  fields: ['title'], base: operation.base, local: operation.payload, server: { title: 'Theirs', description: 'Old' }, server_version: 4, created_at: '2026-10-20', operation,
  optimistic_entity: { entity_type: 'task', entity_id: 'task', root_selection_id: 'list-selection', root_resource_id: 'list', version: 2, dependency: false, value: { id: 'task', list_id: 'list', account_id: 'account', title: 'Mine', description: 'Independent edit' } } }

describe('offline explicit conflict decisions', () => {
  it('keeps independent fields, omits server-selected fields and creates a new intent', () => {
    const retry = offlineV5ConflictRetry(conflict, { operation_id: 'original', choice: 'fields', fields: { title: 'server' } })!
    expect(retry).toMatchObject({ base_version: 4, base: conflict.server, payload: { description: 'Independent edit' }, optimistic_value: { title: 'Theirs', description: 'Independent edit' } })
    expect(retry.operation_id).toBeUndefined()
    expect(retry.depends_on_operation_id).toBeUndefined()
    expect(operation.base_version).toBe(2)
    expect(operation.payload).toHaveProperty('title', 'Mine')
  })
  it('requires every conflicting field and preserves a selected local value', () => {
    expect(() => offlineV5ConflictRetry(conflict, { operation_id: 'original', choice: 'fields', fields: {} })).toThrow(/Elige/)
    expect(offlineV5ConflictRetry(conflict, { operation_id: 'original', choice: 'fields', fields: { title: 'local' } })).toMatchObject({ payload: operation.payload })
  })
  it('never retries a permission rejection or a version-only conflict blindly', () => {
    expect(offlineV5ConflictCanMerge({ ...conflict, status: 'rejected' })).toBe(false)
    expect(offlineV5ConflictCanMerge({ ...conflict, server: undefined })).toBe(false)
    expect(offlineV5ConflictCanMerge({ ...conflict, action: 'whiteboards.scene.update' })).toBe(false)
    expect(offlineV5ConflictRetry(conflict, { operation_id: 'original', choice: 'server' })).toBeUndefined()
  })
})
