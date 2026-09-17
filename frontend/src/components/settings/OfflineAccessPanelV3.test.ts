import { describe, expect, it } from 'vitest'
import { indexLocalGrantSummaries, localGrantBlocksSelectionChange, localGrantNeedsSelectionRenewal, toggleV3Selection } from './OfflineAccessPanelV3'
import type { GrantSummary } from '@/offline-v3/types'

const candidate = (id: string) => ({ module: 'tasks' as const, resource_type: 'task_list', resource_id: id, label: `Lista ${id}` })

describe('offline v3 user selection', () => {
  it('adds and removes only the exact module/resource tuple', () => {
    const first = toggleV3Selection([], candidate('one'), 2)
    expect(first).toEqual([candidate('one')])
    expect(toggleV3Selection(first, candidate('one'), 2)).toEqual([])
  })

  it('never exceeds the grant resource limit', () => {
    const full = [candidate('one'), candidate('two')]
    expect(toggleV3Selection(full, candidate('three'), 2)).toBe(full)
  })

  it('keeps readiness isolated by exact grant instead of account position', () => {
    const grants = [
      { grant_id: 'grant-a', state: 'available', ready: true, selection_revision: 3 },
      { grant_id: 'grant-b', state: 'available', ready: false, selection_revision: 7 },
    ] as GrantSummary[]

    const indexed = indexLocalGrantSummaries(grants)

    expect(indexed['grant-a']).toMatchObject({ ready: true, selection_revision: 3 })
    expect(indexed['grant-b']).toMatchObject({ ready: false, selection_revision: 7 })
  })

  it('keeps a suspended or revision-stale local grant sealed until lease renewal', () => {
    const available = { grant_id: 'grant-a', state: 'available', ready: true, selection_revision: 3 } as GrantSummary
    const suspended = { ...available, state: 'expired', ready: false } as GrantSummary

    expect(localGrantNeedsSelectionRenewal(available, 3)).toBe(false)
    expect(localGrantNeedsSelectionRenewal(available, 4)).toBe(true)
    expect(localGrantNeedsSelectionRenewal(suspended, 3)).toBe(true)
    expect(localGrantNeedsSelectionRenewal(undefined, 3)).toBe(false)
  })

  it('blocks durable pending writes without creating a permanent dead-end for historical conflicts', () => {
    const local = { grant_id: 'grant-a', state: 'available', ready: true, selection_revision: 3, pending_count: 0, conflict_count: 0 } as GrantSummary
    expect(localGrantBlocksSelectionChange(local)).toBe('')
    expect(localGrantBlocksSelectionChange({ ...local, pending_count: 1 })).toContain('pendientes')
    expect(localGrantBlocksSelectionChange({ ...local, conflict_count: 1 })).toBe('')
  })
})
