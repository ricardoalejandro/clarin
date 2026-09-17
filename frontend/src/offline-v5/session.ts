import {
  OFFLINE_V5_IDLE_MS,
  OfflineV5Error,
  type OfflineV5Action,
  type OfflineV5Identity,
  type OfflineV5Manifest,
  type OfflineV5Module,
  type OfflineV5SessionSnapshot,
  type OfflineV5VaultEnvelope,
  type OfflineV5VaultMetadata,
} from './types'

export interface OfflineV5SessionKeys {
  content: CryptoKey
  blindIndex: CryptoKey
}

/** This type is worker-internal. Never return or postMessage it to Window. */
export interface OfflineV5ActiveSession {
  identity: OfflineV5Identity
  envelope: OfflineV5VaultEnvelope
  metadata: OfflineV5VaultMetadata
  manifest: OfflineV5Manifest
  keys: OfflineV5SessionKeys
  authEpoch: string
  generation: number
  activityAt: number
  sequence: number
  syncState: 'idle' | 'syncing' | 'conflict' | 'unavailable'
  pendingCount?: number
  conflictCount?: number
  error?: string
}

export type SessionSnapshotListener = (portID: string, snapshot: OfflineV5SessionSnapshot) => void

export class OfflineV5SessionRegistry {
  private sessions = new Map<string, OfflineV5ActiveSession>()
  private generations = new Map<string, number>()
  private listener: SessionSnapshotListener = () => {}

  constructor(private readonly now: () => number = Date.now) {}

  subscribe(listener: SessionSnapshotListener) { this.listener = listener }

  generation(portID: string): number { return this.generations.get(portID) || 0 }

  open(portID: string, input: Omit<OfflineV5ActiveSession, 'generation' | 'activityAt' | 'sequence' | 'syncState'>): OfflineV5SessionSnapshot {
    this.sessions.delete(portID)
    const generation = this.generation(portID) + 1
    this.generations.set(portID, generation)
    this.sessions.set(portID, { ...input, generation, activityAt: this.now(), sequence: this.now() * 100, syncState: 'idle' })
    return this.emit(portID)
  }

  close(portID: string, notify = true): OfflineV5SessionSnapshot {
    this.sessions.delete(portID)
    const generation = this.generation(portID) + 1
    this.generations.set(portID, generation)
    const snapshot = this.lockedSnapshot(generation)
    if (notify) this.listener(portID, snapshot)
    return snapshot
  }

  closeAll() {
    for (const portID of [...this.sessions.keys()]) this.close(portID)
  }

  closeGrants(grantIDs: ReadonlySet<string>) {
    if (!grantIDs.size) return
    for (const [portID, session] of this.sessions) {
      if (grantIDs.has(session.identity.grant_id)) this.close(portID)
    }
  }

  activity(portID: string, generation: number) {
    const session = this.require(portID, generation)
    session.activityAt = this.now()
    this.emit(portID)
  }

  checkIdle() {
    for (const [portID, session] of this.sessions) {
      const expires = Date.parse(session.manifest.expires_at)
      if (this.now() - session.activityAt >= OFFLINE_V5_IDLE_MS || !Number.isFinite(expires) || this.now() >= expires || this.now() < session.metadata.highest_time - 60_000) this.close(portID)
    }
  }

  require(portID: string, generation?: number): OfflineV5ActiveSession {
    this.checkIdle()
    const session = this.sessions.get(portID)
    if (!session) throw new OfflineV5Error('locked', 'Desbloquea esta pestaña para acceder a la copia offline.')
    if (generation !== undefined && generation !== session.generation) throw new OfflineV5Error('identity_changed', 'La pestaña cambió de usuario o cuenta.')
    return session
  }

  nextSequence(portID: string, generation: number): number {
    const session = this.require(portID, generation)
    session.sequence = Math.max(session.sequence + 1, this.now() * 100)
    return session.sequence
  }

  setSyncState(portID: string, generation: number, state: OfflineV5ActiveSession['syncState'], error?: string) {
    const session = this.require(portID, generation)
    session.syncState = state
    session.error = error
    this.emit(portID)
  }

  snapshot(portID: string): OfflineV5SessionSnapshot {
    const session = this.sessions.get(portID)
    return session ? publicSnapshot(session) : this.lockedSnapshot(this.generation(portID))
  }

  emit(portID: string): OfflineV5SessionSnapshot {
    const snapshot = this.snapshot(portID)
    this.listener(portID, snapshot)
    return snapshot
  }

  private lockedSnapshot(generation: number): OfflineV5SessionSnapshot {
    return { generation, active: false, mode: 'locked', authorizedModules: [], selectedRoots: {}, capabilities: [], pendingCount: 0, conflictCount: 0 }
  }
}

function publicSnapshot(session: OfflineV5ActiveSession): OfflineV5SessionSnapshot {
  const modules = [...new Set(session.manifest.roots.map(root => root.module))] as OfflineV5Module[]
  const selectedRoots: Record<string, string[]> = {}
  for (const root of session.manifest.roots) (selectedRoots[root.module] ||= []).push(root.resource_id)
  const actions = [...new Set(session.manifest.capabilities.map(item => item.action))] as OfflineV5Action[]
  return {
    generation: session.generation,
    active: true,
    mode: session.syncState === 'idle' ? 'offline' : session.syncState,
    userId: session.identity.user_id,
    accountId: session.identity.account_id,
    authorizedModules: modules,
    selectedRoots,
    // `navigator.storage.persisted()` protects against browser eviction; it is
    // not a prerequisite for transactional IndexedDB writes. Keep the flag in
    // encrypted metadata for UI warnings, but do not silently make a prepared
    // zero-configuration copy read-only. OPFS blobs stay separately gated.
    capabilities: actions,
    pendingCount: session.pendingCount || 0,
    conflictCount: session.conflictCount || 0,
    lastSyncAt: session.metadata.last_sync_at,
    leaseExpiresAt: session.manifest.expires_at,
    error: session.error,
  }
}
