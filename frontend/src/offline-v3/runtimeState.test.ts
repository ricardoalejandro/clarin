import { describe, expect, it } from 'vitest'
import { captureRuntimeRequestIdentity, initialOfflineRuntimeState, isRuntimeRequestCurrent, offlineRuntimeReducer } from './runtimeState'
import type { OfflineSession, SyncStatus } from './types'

const sync: SyncStatus = {
  state: 'idle',
  server_reachability: 'unreachable',
  pending_count: 0,
  conflict_count: 0,
  outcome_unknown_count: 0,
  lease_expires_at: '2026-09-15T00:00:00Z',
  selection_revision: 1,
}

function session(user = '11111111-1111-4111-8111-111111111111', account = '22222222-2222-4222-8222-222222222222'): OfflineSession {
  return {
    session_id: '33333333-3333-4333-8333-333333333333',
    capability: 'RAM-only-capability',
    profile_epoch: 8,
    idle_expires_at: '2026-09-14T22:00:00Z',
    lease_expires_at: sync.lease_expires_at,
    actor: { user_id: user, username: 'ana', display_name: 'Ana', account_id: account, account_name: 'Cuenta A' },
    actions: ['tasks.read'],
  }
}

describe('offline runtime identity isolation', () => {
  it('invalidates every stale completion after a profile switch', () => {
    const active = offlineRuntimeReducer(initialOfflineRuntimeState, { type: 'UNLOCKED', session: session(), sync })
    const request = captureRuntimeRequestIdentity(active)
    expect(isRuntimeRequestCurrent(active, request)).toBe(true)

    const switched = offlineRuntimeReducer(active, { type: 'IDENTITY_CHANGED', profileEpoch: 9 })
    expect(switched.session).toBeNull()
    expect(switched.generation).toBe(active.generation + 1)
    expect(isRuntimeRequestCurrent(switched, request)).toBe(false)
  })

  it('does not apply sync results after lock and does not preserve another actor', () => {
    const active = offlineRuntimeReducer(initialOfflineRuntimeState, { type: 'UNLOCKED', session: session(), sync })
    const locked = offlineRuntimeReducer(active, { type: 'IDENTITY_CHANGED', profileEpoch: 10 })
    expect(offlineRuntimeReducer(locked, { type: 'SYNC', sync: { ...sync, pending_count: 9 } })).toBe(locked)
    expect(locked.grants).toEqual([])
  })

  it('keeps the latest unlock failure visible after the grant list refreshes', () => {
    const unlocking = offlineRuntimeReducer(initialOfflineRuntimeState, { type: 'UNLOCKING' })
    const refreshed = offlineRuntimeReducer(unlocking, { type: 'LOCKED', grants: [], profileEpoch: 8 })
    const failed = offlineRuntimeReducer(refreshed, { type: 'ERROR', message: 'Credenciales no válidas.' })

    expect(failed.phase).toBe('locked')
    expect(failed.error).toBe('Credenciales no válidas.')
  })
})
