import { describe, expect, it } from 'vitest'
import { beginQuickTagMutation, reconcileQuickTagMutation, rollbackQuickTagMutation } from './quickTagMutation'

const priority = { id: 'tag-priority', account_id: 'account-1', name: 'Prioridad', color: '#F59E0B' }
const community = { id: 'tag-community', account_id: 'account-1', name: 'Comunidad', color: '#10B981' }

describe('quick Contact tag mutation', () => {
  it('identifies the exact tag being added or removed', () => {
    expect(beginQuickTagMutation([community], [community, priority]).pendingId).toBe('tag-priority')
    expect(beginQuickTagMutation([community, priority], [community]).pendingId).toBe('tag-priority')
  })

  it('restores the exact previous tags while retaining a deterministic retry', () => {
    const snapshot = beginQuickTagMutation([community], [community, priority])
    expect(rollbackQuickTagMutation(snapshot)).toEqual({ tags: [community], retry: [community, priority] })
  })

  it('reconciles the canonical response instead of preserving stale optimistic tags', () => {
    const snapshot = beginQuickTagMutation([community], [community, priority])
    const canonical = [{ ...priority, name: 'Prioridad alta' }]
    expect(reconcileQuickTagMutation(snapshot, canonical)).toEqual(canonical)
    expect(reconcileQuickTagMutation(snapshot)).toEqual([community, priority])
  })
})
