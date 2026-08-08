import { describe, expect, it } from 'vitest'
import {
  leadMatchesLifecycleFilter,
  reconcileLeadLifecycleCounts,
  type LeadLifecycleCounts,
} from './leadLifecycleReconciliation'

const counts: LeadLifecycleCounts = {
  active: 8,
  won: 3,
  lost: 2,
  archived: 4,
  blocked: 1,
  trash: 5,
}

describe('lead lifecycle reconciliation', () => {
  it('moves the visible badge exactly once from active to won', () => {
    expect(reconcileLeadLifecycleCounts(
      counts,
      { status: 'open', pipeline_id: 'pipeline-a' },
      { status: 'won', pipeline_id: 'pipeline-a' },
      'pipeline-a',
    )).toEqual({ ...counts, active: 7, won: 4 })
  })

  it('does not alter lifecycle badges for archived leads or another pipeline', () => {
    expect(reconcileLeadLifecycleCounts(
      counts,
      { status: 'open', pipeline_id: 'pipeline-a', is_archived: true },
      { status: 'lost', pipeline_id: 'pipeline-a', is_archived: true },
      'pipeline-a',
    )).toBe(counts)

    expect(reconcileLeadLifecycleCounts(
      counts,
      { status: 'open', pipeline_id: 'pipeline-b' },
      { status: 'won', pipeline_id: 'pipeline-b' },
      'pipeline-a',
    )).toBe(counts)
  })

  it('keeps transversal views honest while lifecycle views follow status', () => {
    const blockedWon = { status: 'won', is_blocked: true }
    expect(leadMatchesLifecycleFilter(blockedWon, 'blocked')).toBe(true)
    expect(leadMatchesLifecycleFilter(blockedWon, 'active')).toBe(false)
    expect(leadMatchesLifecycleFilter(blockedWon, 'won')).toBe(true)
    expect(leadMatchesLifecycleFilter({ status: 'lost', is_archived: true }, 'archived')).toBe(true)
    expect(leadMatchesLifecycleFilter({ status: 'lost', deleted_at: '2026-08-07' }, 'trash')).toBe(true)
  })
})
