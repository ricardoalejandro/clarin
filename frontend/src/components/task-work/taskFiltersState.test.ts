import { describe, expect, it } from 'vitest'
import { EMPTY_TASK_FILTERS, normalizeTaskFilters, taskFilterCount } from './TaskFilters'

describe('task filter draft state', () => {
  it('normalizes legacy saved filters with closed tasks hidden', () => {
    expect(normalizeTaskFilters({ status_ids: ['status'], priorities: ['urgent'] })).toMatchObject({
      include_closed: false,
      status_ids: ['status'],
      priorities: ['urgent'],
    })
  })

  it('preserves an explicit closed-task choice and counts it once', () => {
    const filters = normalizeTaskFilters({ ...EMPTY_TASK_FILTERS, include_closed: true, assigned_to_ids: ['user'] })
    expect(filters.include_closed).toBe(true)
    expect(taskFilterCount(filters)).toBe(2)
  })

  it('discards malformed catalog values without breaking old views', () => {
    const filters = normalizeTaskFilters({ priorities: ['urgent', 'not-a-priority'] as never, types: ['meeting', 'bad'] as never, due: 'unknown' as never })
    expect(filters.priorities).toEqual(['urgent'])
    expect(filters.types).toEqual(['meeting'])
    expect(filters.due).toBe('')
  })
})
