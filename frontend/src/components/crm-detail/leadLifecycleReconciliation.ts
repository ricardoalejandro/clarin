export type LeadLifecycleFilter = 'active' | 'won' | 'lost' | 'archived' | 'blocked' | 'trash'

export type LeadLifecycleCounts = Record<LeadLifecycleFilter, number>

type LifecycleLead = {
  status: string
  pipeline_id?: string | null
  is_archived?: boolean
  is_blocked?: boolean
  deleted_at?: string | null
}

function countBucket(lead: LifecycleLead): 'active' | 'won' | 'lost' | null {
  if (lead.deleted_at || lead.is_archived) return null
  if (lead.status === 'won' || lead.status === 'lost') return lead.status
  return 'active'
}

function belongsToPipeline(lead: LifecycleLead, pipelineId?: string | null) {
  if (!pipelineId) return true
  if (pipelineId === '__no_pipeline__') return !lead.pipeline_id
  return lead.pipeline_id === pipelineId
}

export function leadMatchesLifecycleFilter(lead: LifecycleLead, filter: LeadLifecycleFilter) {
  switch (filter) {
    case 'trash':
      return Boolean(lead.deleted_at)
    case 'archived':
      return !lead.deleted_at && Boolean(lead.is_archived)
    case 'blocked':
      return !lead.deleted_at && Boolean(lead.is_blocked)
    case 'won':
    case 'lost':
      return !lead.deleted_at && !lead.is_archived && lead.status === filter
    default:
      return !lead.deleted_at && !lead.is_archived && lead.status !== 'won' && lead.status !== 'lost'
  }
}

/**
 * Applies the canonical lifecycle delta immediately. Archived, blocked and
 * trash totals are independent from a stage/status gesture and remain intact.
 */
export function reconcileLeadLifecycleCounts(
  counts: LeadLifecycleCounts,
  previous: LifecycleLead,
  canonical: LifecycleLead,
  pipelineId?: string | null,
): LeadLifecycleCounts {
  if (!belongsToPipeline(previous, pipelineId) && !belongsToPipeline(canonical, pipelineId)) return counts

  const previousBucket = belongsToPipeline(previous, pipelineId) ? countBucket(previous) : null
  const canonicalBucket = belongsToPipeline(canonical, pipelineId) ? countBucket(canonical) : null
  if (previousBucket === canonicalBucket) return counts

  const next = { ...counts }
  if (previousBucket) next[previousBucket] = Math.max(0, next[previousBucket] - 1)
  if (canonicalBucket) next[canonicalBucket] += 1
  return next
}
