import { describe, expect, it } from 'vitest'
import { appendTaskFilters } from './taskQuery'
import { EMPTY_TASK_FILTERS } from './TaskFilters'

describe('shared task query contract', () => {
  it('preserves all filters across list, agenda and summary without leaking pagination', () => {
    const params = new URLSearchParams({ search: 'acción pendiente', environment_id: 'environment-a' })
    appendTaskFilters(params, { ...EMPTY_TASK_FILTERS, include_closed: true, assigned_to_ids: ['a', 'b'], collaborator_ids: ['c'], priorities: ['urgent'], status_ids: ['done'], types: ['reminder'], creator_ids: ['d'], has_attachments: false, starred: true, due: 'today', created_from: '2026-10-01' })
    expect(Object.fromEntries(params)).toMatchObject({ search: 'acción pendiente', environment_id: 'environment-a', include_closed: 'true', assigned_to_ids: 'a,b', collaborator_ids: 'c', priorities: 'urgent', status_ids: 'done', types: 'reminder', creator_ids: 'd', has_attachments: 'false', starred: 'true', due: 'today', created_from: '2026-10-01' })
    expect(params.has('cursor')).toBe(false)
  })
})
