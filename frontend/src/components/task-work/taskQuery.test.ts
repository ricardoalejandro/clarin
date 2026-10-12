import { describe, expect, it, vi } from 'vitest'
import { apiGet } from '@/lib/api'
import { appendTaskFilters, loadTaskSummary } from './taskQuery'
import { EMPTY_TASK_FILTERS } from './TaskFilters'

vi.mock('@/lib/api', () => ({ apiGet: vi.fn() }))

describe('shared task query contract', () => {
  it('unwraps the real summary envelope instead of displaying zero for 150 authorized tasks', async () => {
    const summary = { total: 150, done: 25, active: 125, overdue: 6, owners: 2, progress: 40, by_status: [], by_owner: [] }
    vi.mocked(apiGet).mockResolvedValueOnce({ success: true, data: { success: true, summary }, status: 200 })
    const controller = new AbortController()
    const result = await loadTaskSummary(new URLSearchParams({ environment_id: 'env', search: 'pendiente' }), controller.signal)
    expect(result.data).toEqual(summary)
    expect(apiGet).toHaveBeenLastCalledWith('/api/tasks/summary?environment_id=env&search=pendiente', { signal: controller.signal })
  })

  it('keeps a failed summary absent rather than publishing a zero aggregate', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ success: false, error: 'No disponible', status: 503 })
    const result = await loadTaskSummary(new URLSearchParams(), new AbortController().signal)
    expect(result).toMatchObject({ success: false, error: 'No disponible', data: undefined })
  })

  it('preserves all filters across list, agenda and summary without leaking pagination', () => {
    const params = new URLSearchParams({ search: 'acción pendiente', environment_id: 'environment-a' })
    appendTaskFilters(params, { ...EMPTY_TASK_FILTERS, include_closed: true, assigned_to_ids: ['a', 'b'], collaborator_ids: ['c'], priorities: ['urgent'], status_ids: ['done'], types: ['reminder'], creator_ids: ['d'], has_attachments: false, starred: true, due: 'today', created_from: '2026-10-01' })
    expect(Object.fromEntries(params)).toMatchObject({ search: 'acción pendiente', environment_id: 'environment-a', include_closed: 'true', assigned_to_ids: 'a,b', collaborator_ids: 'c', priorities: 'urgent', status_ids: 'done', types: 'reminder', creator_ids: 'd', has_attachments: 'false', starred: 'true', due: 'today', created_from: '2026-10-01' })
    expect(params.has('cursor')).toBe(false)
  })
})
