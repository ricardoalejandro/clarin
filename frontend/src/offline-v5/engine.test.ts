// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { MemoryOfflineV5BlobStore } from '@/offline-v5/blobStore'
import { decryptOfflineV5EnvelopeValue, decryptOfflineV5Value, encryptOfflineV5EnvelopeValue, encryptOfflineV5Value, offlineV5UsernameLookupTag } from '@/offline-v5/crypto'
import { OfflineV5Engine, offlineV5ClockWithinHighWater, offlineV5ManifestCanBindOperation, offlineV5OperationReadyForManifest, selectOfflineV5VaultCandidates, selectPreparedOfflineV5VaultsForUsername, sendableOfflineV5Operations } from '@/offline-v5/engine'
import { offlineV5ManifestScopeWithinBounds, offlineV5PayloadAccountIsolated } from '@/offline-v5/manifest'
import { OfflineV5SessionRegistry, type OfflineV5ActiveSession } from '@/offline-v5/session'
import { MemoryOfflineV5Storage, rotateOfflineV5StoredSessionEpoch } from '@/offline-v5/storage'
import { clearOfflineV5BootMarker, markOfflineV5Boot, readOfflineV5BootMarker, type OfflineV5BootStorage } from '@/lib/offlineV5Boot'
import { beginOfflineV5OnlineTransition, bootstrapOfflineV5Runtime, cancelOfflineV5OnlineTransition, getOfflineV5RuntimeSnapshot, offlineV5RuntimeAtBoot, offlineV5ShouldBlockEgress, refreshOfflineV5FallbackOffer, refreshOfflineV5FallbackState, replaceStaleOfflineLoginWithOnline, runtimeAfterOfflineV5Bootstrap, setOfflineV5RuntimeClientForTests, shouldCloseOfflineV5OnlineTransition, shouldOfferOfflineV5, type RuntimeSnapshot } from '@/lib/offlineV5Runtime'
import { OfflineV5Error, type OfflineV5Identity, type OfflineV5Manifest, type OfflineV5Operation, type OfflineV5VaultEnvelope, type OfflineV5VaultMetadata } from '@/offline-v5/types'

const origin = 'https://clarin.test'

async function keys() {
  return {
    content: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    blindIndex: await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
  }
}

function identity(user: string, account: string): OfflineV5Identity {
  return { origin, browser_profile_id: 'browser-1', grant_id: `grant-${user}-${account}`, user_id: user, account_id: account }
}

function manifest(value: OfflineV5Identity): OfflineV5Manifest {
  return {
    protocol_version: 5, id: `manifest-${value.grant_id}`, revision: 1, browser_profile_id: value.browser_profile_id, grant_id: value.grant_id,
    user_id: value.user_id, account_id: value.account_id, username: value.user_id, account_name: value.account_id, selection_revision: 1,
    selection_digest: 'digest', credential_epoch: 1, authority_epoch: 1, grant_revision: 1,
    roots: [{ selection_id: `selection-${value.grant_id}`, module: 'tasks', resource_type: 'task_list', resource_id: `list-${value.account_id}` }],
    dependencies: [
      { root_selection_id: `selection-${value.grant_id}`, module: 'tasks', resource_type: 'task', resource_id: 'task-1' },
      { root_selection_id: `selection-${value.grant_id}`, module: 'tasks', resource_type: 'task', resource_id: 'same-task' },
    ],
    capabilities: [
      { action: 'tasks.read', selection_id: `selection-${value.grant_id}`, root_resource_id: `list-${value.account_id}`, resource_type: 'task_list', resource_id: `list-${value.account_id}` },
      { action: 'tasks.update', selection_id: `selection-${value.grant_id}`, root_resource_id: `list-${value.account_id}`, resource_type: 'task_list', resource_id: `list-${value.account_id}` },
    ],
    entity_versions: [], chunk_hashes: [], digest: 'digest', canonical_json: 'e30', issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(), max_storage_bytes: 1024 * 1024,
  }
}

async function active(value: OfflineV5Identity, namespace = value.grant_id): Promise<Omit<OfflineV5ActiveSession, 'generation' | 'activityAt' | 'sequence' | 'syncState'>> {
  const selectedManifest = manifest(value)
  const metadata: OfflineV5VaultMetadata = {
    actor: { user_id: value.user_id, username: value.user_id, account_id: value.account_id, account_name: value.account_id },
    manifest_id: selectedManifest.id, manifest_revision: 1, manifest_digest: 'digest', selection_revision: 1, credential_epoch: 1, authority_epoch: 1, grant_revision: 1,
    grant_private_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' }, persistent: true, highest_time: Date.now(),
  }
  const envelope: OfflineV5VaultEnvelope = {
    format: 5, identity: value, namespace, lookup_tag: 'lookup', salt: 'salt', iterations: 600000,
    wrapped_key: { version: 1, iv: 'iv', ciphertext: 'cipher' }, wrapped_index_key: { version: 1, iv: 'iv', ciphertext: 'cipher' },
    encrypted_metadata: { version: 1, iv: 'iv', ciphertext: 'cipher' }, lease: 'lease', signer_keys: [], state: 'available', updated_at: Date.now(),
  }
  return { identity: value, envelope, metadata, manifest: selectedManifest, keys: await keys(), authEpoch: 'epoch' }
}

describe('Offline v5 encrypted browser engine', () => {
  it('accepts the backend dependency boundary and rejects one item above it', () => {
    const value = manifest(identity('user', 'account'))
    const dependency = value.dependencies[0]
    expect(offlineV5ManifestScopeWithinBounds({ ...value, dependencies: Array.from({ length: 20_000 }, () => dependency) })).toBe(true)
    expect(offlineV5ManifestScopeWithinBounds({ ...value, dependencies: Array.from({ length: 20_001 }, () => dependency) })).toBe(false)
  })

  it('rebinds pending intent only to a manifest carrying its exact root capability', () => {
    const writable = manifest(identity('user', 'account'))
    const operation: OfflineV5Operation = {
      protocol_version: 5, browser_profile_id: writable.browser_profile_id, grant_id: writable.grant_id, user_id: writable.user_id, account_id: writable.account_id,
      operation_id: 'operation-rebind', action: 'tasks.update', selection_id: writable.roots[0].selection_id, resource_id: 'task-1',
      selection_revision: writable.selection_revision, manifest_id: writable.id, manifest_revision: writable.revision,
      credential_epoch: writable.credential_epoch, authority_epoch: writable.authority_epoch, base_version: 1,
      occurred_at: new Date().toISOString(), payload: { title: 'Pendiente' },
    }
    expect(offlineV5ManifestCanBindOperation(writable, operation)).toBe(true)
    expect(offlineV5OperationReadyForManifest(writable, operation)).toBe(true)
    const readOnly = { ...writable, id: 'manifest-read-only', revision: 2, capabilities: writable.capabilities.filter(value => value.action === 'tasks.read') }
    expect(offlineV5ManifestCanBindOperation(readOnly, operation)).toBe(false)
    expect(offlineV5OperationReadyForManifest(readOnly, operation)).toBe(false)
    const restored = { ...writable, id: 'manifest-restored', revision: 3, credential_epoch: 2, authority_epoch: 2 }
    expect(offlineV5ManifestCanBindOperation(restored, operation)).toBe(true)
    expect(offlineV5OperationReadyForManifest(restored, operation)).toBe(false)
    const rebound = { ...operation, manifest_id: restored.id, manifest_revision: restored.revision, credential_epoch: restored.credential_epoch, authority_epoch: restored.authority_epoch }
    expect(offlineV5OperationReadyForManifest(restored, rebound)).toBe(true)
  })

  it('does not emit a ready dependent operation while its predecessor is capability-deferred', () => {
    const current = manifest(identity('user', 'account'))
    const base = {
      protocol_version: 5 as const, browser_profile_id: current.browser_profile_id, grant_id: current.grant_id, user_id: current.user_id, account_id: current.account_id,
      selection_id: current.roots[0].selection_id, selection_revision: current.selection_revision, manifest_id: current.id, manifest_revision: current.revision,
      credential_epoch: current.credential_epoch, authority_epoch: current.authority_epoch, base_version: 1, occurred_at: new Date().toISOString(),
    }
    const predecessor: OfflineV5Operation = { ...base, operation_id: 'a-comment', action: 'tasks.comments.create', resource_id: 'comment-1', payload: { task_id: 'task-1', body: 'Primero' } }
    const dependent: OfflineV5Operation = { ...base, operation_id: 'b-update', depends_on_operation_id: predecessor.operation_id, action: 'tasks.update', resource_id: 'task-1', payload: { title: 'Después' } }
    expect(sendableOfflineV5Operations(current, [dependent, predecessor])).toEqual([])
  })

  it('uses a non-exportable keyed username index and skips unrelated indexed vaults', async () => {
    const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
    const ada = await offlineV5UsernameLookupTag(key, ' Ada ')
    expect(await offlineV5UsernameLookupTag(key, 'ada')).toBe(ada)
    expect(await offlineV5UsernameLookupTag(key, 'grace')).not.toBe(ada)
    expect(ada).not.toContain('ada')
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
    const template = await active(identity('user', 'account'))
    const envelope = template.envelope
    const candidates = selectOfflineV5VaultCandidates([
      { ...envelope, identity: identity('ada', 'one'), lookup_tag: ada },
      { ...envelope, identity: identity('other', 'two'), lookup_tag: 'h1.unrelated' },
      { ...envelope, identity: identity('legacy', 'three'), lookup_tag: 'legacy-random' },
    ], ada)
    expect(candidates.map(item => item.identity.user_id)).toEqual(['ada', 'legacy'])

    const prepared = selectPreparedOfflineV5VaultsForUsername([
      { ...envelope, identity: identity('ada', 'one'), lookup_tag: ada, state: 'available' },
      { ...envelope, identity: identity('grace', 'two'), lookup_tag: 'h1.unrelated', state: 'available' },
      { ...envelope, identity: { ...identity('ada', 'foreign'), browser_profile_id: 'browser-2' }, lookup_tag: ada, state: 'available' },
      { ...envelope, identity: identity('ada', 'revoked'), lookup_tag: ada, state: 'revoked' },
    ], ada, origin, 'browser-1')
    expect(prepared.map(item => item.identity.account_id)).toEqual(['one'])
  })

  it('restores a closed offline browser as locked even when the OS reports connectivity', () => {
    const prior: RuntimeSnapshot = { mode: 'online', active: false, canEnterOffline: false, authorizedModules: [], selectedRoots: {}, capabilities: [], pendingCount: 0, conflictCount: 0 }
    const restored = runtimeAfterOfflineV5Bootstrap({ enabled: true, mode: 'offline', fallback_offer: false }, prior)
    expect(restored).toMatchObject({ mode: 'locked', active: false, canEnterOffline: true })
    expect(shouldOfferOfflineV5({ mode: 'offline', fallback_offer: false })).toBe(true)
  })

  it('offers the offline login only when both the shell and a prepared local copy are present', async () => {
    await expect(refreshOfflineV5FallbackOffer(
      async () => ({ enabled: true, mode: 'online', fallback_offer: true }),
      async () => false,
    )).resolves.toBe(false)
    await expect(refreshOfflineV5FallbackOffer(
      async () => ({ enabled: true, mode: 'offline', fallback_offer: false }),
      async () => true,
    )).resolves.toBe(true)
    const availability = vi.fn(async () => true)
    await expect(refreshOfflineV5FallbackOffer(async () => ({ enabled: true, mode: 'online', fallback_offer: false }), availability)).resolves.toBe(false)
    expect(availability).not.toHaveBeenCalled()
  })

  it('reloads the ordinary login only after a stale offline shell was authoritatively disabled', async () => {
    const statuses = vi.fn()
      .mockResolvedValueOnce({ enabled: true, mode: 'offline' })
      .mockResolvedValueOnce({ enabled: false, mode: 'online' })
    await expect(refreshOfflineV5FallbackState(statuses, async () => false)).resolves.toEqual({
      offer: false,
      reloadOnlineLogin: true,
    })

    const unavailable = vi.fn(async () => ({ enabled: true, mode: 'offline' as const }))
    await expect(refreshOfflineV5FallbackState(unavailable, async () => false)).resolves.toEqual({
      offer: false,
      reloadOnlineLogin: false,
    })

    const replace = vi.fn()
    replaceStaleOfflineLoginWithOnline(replace)
    expect(replace).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledWith('/login')
  })

  it('starts fail-closed synchronously from a non-sensitive durable boot marker', () => {
    const values = new Map<string, string>()
    const storage: OfflineV5BootStorage = {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
      removeItem: key => { values.delete(key) },
    }
    expect(readOfflineV5BootMarker(storage)).toBe(false)
    expect(markOfflineV5Boot(storage)).toBe(true)
    expect(readOfflineV5BootMarker(storage)).toBe(true)
    expect(offlineV5RuntimeAtBoot(true)).toMatchObject({ mode: 'locked', active: false, canEnterOffline: true })
    expect(clearOfflineV5BootMarker(storage)).toBe(true)
    expect(readOfflineV5BootMarker(storage)).toBe(false)
  })

  it('clears only a stale boot marker confirmed online and stays locked when status is unavailable', async () => {
    const locked = offlineV5RuntimeAtBoot(true)
    setOfflineV5RuntimeClientForTests(locked)
    let cleared = 0
    await bootstrapOfflineV5Runtime(async () => undefined, { mark: () => undefined, clear: () => { cleared++ } })
    expect(getOfflineV5RuntimeSnapshot()).toMatchObject({ mode: 'locked', canEnterOffline: true })
    expect(cleared).toBe(0)
    await bootstrapOfflineV5Runtime(async () => ({ enabled: true, mode: 'online' }), { mark: () => undefined, clear: () => { cleared++ } })
    expect(getOfflineV5RuntimeSnapshot()).toMatchObject({ mode: 'online', active: false, canEnterOffline: false })
    expect(cleared).toBe(1)
  })

  it('blocks cross-origin egress in active or locked offline runtime without blocking same-origin assets', () => {
    expect(offlineV5ShouldBlockEgress(origin, 'https://tracker.example/pixel')).toBe(true)
    expect(offlineV5ShouldBlockEgress(origin, `${origin}/_next/static/app.js`)).toBe(false)
    expect(offlineV5ShouldBlockEgress(origin, '/api/tasks')).toBe(false)
    expect(offlineV5ShouldBlockEgress(origin, 'http://[')).toBe(true)
  })

  it('rejects any nested account-labelled snapshot value from another account', () => {
    expect(offlineV5PayloadAccountIsolated({ account_id: 'account-a', nested: [{ account_id: 'account-a' }, { no_account: true }] }, 'account-a')).toBe(true)
    expect(offlineV5PayloadAccountIsolated({ nested: { rows: [{ account_id: 'account-b' }] } }, 'account-a')).toBe(false)
    expect(offlineV5PayloadAccountIsolated({ nested: { account_id: null } }, 'account-a')).toBe(false)
  })

  it('opens and cancels the narrow online-login transition latch in order', async () => {
    const calls: string[] = []
    await beginOfflineV5OnlineTransition(async () => { calls.push('begin') })
    await cancelOfflineV5OnlineTransition(async () => { calls.push('offline') })
    expect(calls).toEqual(['begin', 'offline'])
    await expect(beginOfflineV5OnlineTransition(async () => { throw new Error('no latch') })).rejects.toThrow('no latch')
  })

  it('consumes a failed online login latch while preserving offline mode', async () => {
    expect(shouldCloseOfflineV5OnlineTransition('/api/auth/login', false)).toBe(true)
    expect(shouldCloseOfflineV5OnlineTransition('/api/auth/login', true)).toBe(false)
    expect(shouldCloseOfflineV5OnlineTransition('/api/public/security-config', false)).toBe(false)
    const modes: string[] = []
    await beginOfflineV5OnlineTransition(async () => { modes.push('latch') })
    if (shouldCloseOfflineV5OnlineTransition('/api/auth/login', false)) {
      await cancelOfflineV5OnlineTransition(async () => { modes.push('offline') })
    }
    expect(modes).toEqual(['latch', 'offline'])
  })

  it('binds every ciphertext to origin/browser/grant/user/account plus kind and id', async () => {
    const owner = identity('user-a', 'account-a'), key = (await keys()).content
    const encrypted = await encryptOfflineV5Value(key, owner, 'entities', 'entity-a', { secret: 'only-a' })
    await expect(decryptOfflineV5Value(key, owner, 'entities', 'entity-a', encrypted)).resolves.toEqual({ secret: 'only-a' })
    for (const changed of [
      { ...owner, origin: 'https://other.test' },
      { ...owner, browser_profile_id: 'browser-2' },
      { ...owner, grant_id: 'grant-2' },
      { ...owner, user_id: 'user-b' },
      { ...owner, account_id: 'account-b' },
    ]) await expect(decryptOfflineV5Value(key, changed, 'entities', 'entity-a', encrypted)).rejects.toMatchObject({ code: 'unlock_failed' })
    await expect(decryptOfflineV5Value(key, owner, 'operations', 'entity-a', encrypted)).rejects.toMatchObject({ code: 'unlock_failed' })
    await expect(decryptOfflineV5Value(key, owner, 'entities', 'entity-b', encrypted)).rejects.toMatchObject({ code: 'unlock_failed' })
  })

  it('keeps 10 users and two accounts per user isolated by MessagePort session', async () => {
    const registry = new OfflineV5SessionRegistry()
    const expected = new Map<string, string>()
    for (let user = 0; user < 10; user++) for (let account = 0; account < 2; account++) {
      const port = `port-${user}-${account}`, value = identity(`user-${user}`, `account-${account}`)
      registry.open(port, await active(value))
      expected.set(port, `${value.user_id}:${value.account_id}`)
    }
    for (const [port, tuple] of expected) {
      const snapshot = registry.snapshot(port)
      expect(`${snapshot.userId}:${snapshot.accountId}`).toBe(tuple)
      expect(JSON.stringify(snapshot)).not.toContain('CryptoKey')
    }
    const before = registry.snapshot('port-0-1')
    registry.close('port-0-0')
    expect(registry.snapshot('port-0-0').active).toBe(false)
    expect(registry.snapshot('port-0-1')).toEqual(before)
  })

  it('drops the only key reference on close and locks after 30 minutes idle', async () => {
    let now = 1_000_000
    const registry = new OfflineV5SessionRegistry(() => now), port = 'port'
    const value = identity('user', 'account'), input = await active(value)
    input.metadata.highest_time = now
    input.manifest.expires_at = new Date(now + 86_400_000).toISOString()
    const opened = registry.open(port, input)
    expect(registry.require(port, opened.generation).keys.content).toBe(input.keys.content)
    registry.close(port)
    expect(() => registry.require(port)).toThrowError(expect.objectContaining({ code: 'locked' }))
    const reopened = registry.open(port, input)
    now += 30 * 60 * 1000
    expect(() => registry.require(port, reopened.generation)).toThrowError(expect.objectContaining({ code: 'locked' }))
  })

  it('enforces quota atomically without deleting the prior record', async () => {
    const storage = new MemoryOfflineV5Storage()
    const first = { storage_key: 'one', namespace: 'scope', record_type: 'snapshot:tasks', byte_size: 90, ciphertext: { version: 1 as const, iv: 'a', ciphertext: 'b' } }
    await storage.commit([{ store: 'entities', key: 'one', value: first }], { namespace: 'scope', quotaBytes: 100 })
    await expect(storage.commit([{ store: 'entities', key: 'two', value: { ...first, storage_key: 'two', byte_size: 20 } }], { namespace: 'scope', quotaBytes: 100 })).rejects.toMatchObject({ code: 'storage_quota' })
    expect(await storage.get('entities', 'one')).toEqual(first)
    expect(await storage.get('entities', 'two')).toBeUndefined()
    expect(await storage.totalBytes('scope')).toBe(90)
  })

  it('keeps encrypted IndexedDB mutations available when eviction protection was not granted', async () => {
    const storage = new MemoryOfflineV5Storage(), engine = new OfflineV5Engine(origin, storage)
    await storage.commit([{ store: 'schema', key: 'auth:browser-1', value: 'epoch' }])
    const candidate = await active(identity('user', 'account'))
    candidate.metadata.persistent = false
    const session = engine.sessions.open('port', candidate)
    expect(engine.sessions.snapshot('port').capabilities).toContain('tasks.update')
    await expect(engine.queueMutation('port', session.generation, {
      operation_id: 'operation-non-persistent', action: 'tasks.update', selection_id: 'selection-grant-user-account', resource_id: 'task-1', entity_type: 'task', entity_id: 'task-1', base_version: 2,
      payload: { title: 'Guardado local' }, optimistic_value: { id: 'task-1', account_id: 'account', list_id: 'list-account', title: 'Guardado local' },
    })).resolves.toMatchObject({ state: 'queued' })
    expect(await engine.outbox('port', session.generation)).toHaveLength(1)
  })

  it('persists a preparing grant signer across engine restarts and removes only an incomplete vault on confirmed rejection', async () => {
    const storage = new MemoryOfflineV5Storage()
    await storage.commit([{ store: 'profiles', key: 'active', value: { browser_id: 'browser-1' } }])
    const grant = { grant_id: 'grant-preparing', browser_profile_id: 'browser-1', user_id: 'user-a', account_id: 'account-a', username: 'ricardo', account_name: 'Proyectos', selection_revision: 2 }
    const firstEngine = new OfflineV5Engine(origin, storage)
    const first = await firstEngine.stagePreparation(grant, 'Ricardo123@', true)
    expect(first.created).toBe(true)
    expect(await storage.get<OfflineV5VaultEnvelope>('vaults', grant.grant_id)).toMatchObject({ state: 'preparing', identity: { user_id: 'user-a', account_id: 'account-a' } })

    const reopenedEngine = new OfflineV5Engine(origin, storage)
    const reopened = await reopenedEngine.stagePreparation(grant, 'Ricardo123@', true)
    expect(reopened.created).toBe(false)
    expect(reopened.privateJWK.d).toBe(first.privateJWK.d)

    await reopenedEngine.discardPreparingGrant(grant.grant_id)
    expect(await storage.get('vaults', grant.grant_id)).toBeUndefined()
  })

  it('purges only revoked local grants for the authenticated user and preserves another browser user', async () => {
    const storage = new MemoryOfflineV5Storage()
    const blobs = new MemoryOfflineV5BlobStore()
    const engine = new OfflineV5Engine(origin, storage, undefined, Date.now, blobs)
    await storage.commit([{ store: 'profiles', key: 'active', value: { browser_id: 'browser-1' } }])
    const removed = await active(identity('user', 'removed'), 'namespace-removed')
    const retained = await active(identity('user', 'retained'), 'namespace-retained')
    const otherUser = await active(identity('other-user', 'shared-browser'), 'namespace-other')
    await storage.commit([
      { store: 'vaults', key: removed.identity.grant_id, value: removed.envelope },
      { store: 'vaults', key: retained.identity.grant_id, value: retained.envelope },
      { store: 'vaults', key: otherUser.identity.grant_id, value: otherUser.envelope },
      { store: 'entities', key: 'removed-entity', value: { storage_key: 'removed-entity', namespace: removed.envelope.namespace, record_type: 'snapshot:tasks', byte_size: 10, ciphertext: { version: 1, iv: 'iv', ciphertext: 'cipher' } } },
      { store: 'entities', key: 'retained-entity', value: { storage_key: 'retained-entity', namespace: retained.envelope.namespace, record_type: 'snapshot:tasks', byte_size: 10, ciphertext: { version: 1, iv: 'iv', ciphertext: 'cipher' } } },
    ])
    engine.sessions.open('removed-port', removed)
    engine.sessions.open('other-port', otherUser)

    await expect(engine.reconcileLocalGrants('user', [retained.identity.grant_id])).resolves.toEqual({ removed: [removed.identity.grant_id] })
    expect(await storage.get('vaults', removed.identity.grant_id)).toBeUndefined()
    expect(await storage.get('entities', 'removed-entity')).toBeUndefined()
    expect(await storage.get('vaults', retained.identity.grant_id)).toEqual(retained.envelope)
    expect(await storage.get('entities', 'retained-entity')).toBeDefined()
    expect(await storage.get('vaults', otherUser.identity.grant_id)).toEqual(otherUser.envelope)
    expect(engine.sessions.snapshot('removed-port').active).toBe(false)
    expect(engine.sessions.snapshot('other-port').active).toBe(true)
  })

  it('purges one exact local grant after revocation without touching other users or accounts', async () => {
    const storage = new MemoryOfflineV5Storage()
    const blobs = new MemoryOfflineV5BlobStore()
    const engine = new OfflineV5Engine(origin, storage, undefined, Date.now, blobs)
    await storage.commit([{ store: 'profiles', key: 'active', value: { browser_id: 'browser-1' } }])
    const revoked = await active(identity('user-a', 'account-a'), 'namespace-revoked')
    const retained = await active(identity('user-b', 'account-b'), 'namespace-retained')
    await storage.commit([
      { store: 'vaults', key: revoked.identity.grant_id, value: revoked.envelope },
      { store: 'vaults', key: retained.identity.grant_id, value: retained.envelope },
      { store: 'entities', key: 'revoked-entity', value: { storage_key: 'revoked-entity', namespace: revoked.envelope.namespace, record_type: 'snapshot:tasks', byte_size: 10, ciphertext: { version: 1, iv: 'iv', ciphertext: 'cipher' } } },
      { store: 'entities', key: 'retained-entity', value: { storage_key: 'retained-entity', namespace: retained.envelope.namespace, record_type: 'snapshot:tasks', byte_size: 10, ciphertext: { version: 1, iv: 'iv', ciphertext: 'cipher' } } },
    ])
    engine.sessions.open('revoked-port', revoked)
    engine.sessions.open('retained-port', retained)

    await expect(engine.purgeLocalGrant(revoked.identity.grant_id)).resolves.toEqual({ removed: [revoked.identity.grant_id] })
    expect(await storage.get('vaults', revoked.identity.grant_id)).toBeUndefined()
    expect(await storage.get('entities', 'revoked-entity')).toBeUndefined()
    expect(await storage.get('vaults', retained.identity.grant_id)).toEqual(retained.envelope)
    expect(await storage.get('entities', 'retained-entity')).toBeDefined()
    expect(engine.sessions.snapshot('revoked-port').active).toBe(false)
    expect(engine.sessions.snapshot('retained-port').active).toBe(true)
  })

  it('advances the encrypted durable clock high-water and rejects a later rollback', async () => {
    let now = 1_700_000_000_000
    const storage = new MemoryOfflineV5Storage(), engine = new OfflineV5Engine(origin, storage, undefined, () => now)
    await storage.commit([{ store: 'schema', key: 'auth:browser-1', value: 'epoch' }])
    const candidate = await active(identity('user', 'account'))
    candidate.metadata.highest_time = now
    candidate.manifest.expires_at = new Date(now + 86_400_000).toISOString()
    candidate.envelope = {
      ...candidate.envelope,
      encrypted_metadata: await encryptOfflineV5EnvelopeValue(candidate.keys.content, candidate.identity, 'metadata', 'active', candidate.metadata),
      updated_at: now,
    }
    await storage.commit([{ store: 'vaults', key: candidate.identity.grant_id, value: candidate.envelope }])
    const opened = engine.sessions.open('port', candidate)
    now += 120_000
    await engine.activity('port', opened.generation)
    const stored = await storage.get<OfflineV5VaultEnvelope>('vaults', candidate.identity.grant_id)
    expect(stored).toBeDefined()
    const persisted = await decryptOfflineV5EnvelopeValue<OfflineV5VaultMetadata>(candidate.keys.content, candidate.identity, 'metadata', 'active', stored!.encrypted_metadata)
    expect(persisted.highest_time).toBe(now)
    engine.lock('port')
    expect(offlineV5ClockWithinHighWater(persisted.highest_time, now - 120_000)).toBe(false)
  })

  it('commits a canonical mutation batch atomically when quota rejects it', async () => {
    const storage = new MemoryOfflineV5Storage(), engine = new OfflineV5Engine(origin, storage)
    await storage.commit([{ store: 'schema', key: 'auth:browser-1', value: 'epoch' }])
    const candidate = await active(identity('user', 'account'))
    candidate.manifest.max_storage_bytes = 1
    const session = engine.sessions.open('port', candidate)
    await expect(engine.queueMutations('port', session.generation, [
      { operation_id: 'batch-1', action: 'tasks.update', selection_id: 'selection-grant-user-account', resource_id: 'task-1', entity_type: 'task', entity_id: 'task-1', base_version: 2, payload: { title: 'Uno' }, optimistic_value: { id: 'task-1', account_id: 'account', list_id: 'list-account', title: 'Uno' } },
      { operation_id: 'batch-2', action: 'tasks.update', selection_id: 'selection-grant-user-account', resource_id: 'same-task', entity_type: 'task', entity_id: 'same-task', base_version: 2, payload: { title: 'Dos' }, optimistic_value: { id: 'same-task', account_id: 'account', list_id: 'list-account', title: 'Dos' } },
    ])).rejects.toMatchObject({ code: 'storage_quota' })
    expect(await engine.outbox('port', session.generation)).toHaveLength(0)
    expect(await engine.overlays('port', session.generation, 'task')).toHaveLength(0)
  })

  it('fails an identity switch when the durable revocation barrier cannot be written', async () => {
    const storage = new MemoryOfflineV5Storage()
    await storage.commit([{ store: 'profiles', key: 'active', value: { browser_id: 'browser-1' } }])
    const failure = new OfflineV5Error('storage_blocked', 'blocked')
    const original = storage.commit.bind(storage)
    storage.commit = async (mutations, options) => {
      if (mutations.some(mutation => mutation.store === 'schema')) throw failure
      return original(mutations, options)
    }
    await expect(rotateOfflineV5StoredSessionEpoch(storage)).rejects.toBe(failure)
  })

  it('queues one idempotent operation, rejects ID reuse, and materializes a conflict', async () => {
    const storage = new MemoryOfflineV5Storage(), engine = new OfflineV5Engine(origin, storage)
    await storage.commit([{ store: 'schema', key: 'auth:browser-1', value: 'epoch' }])
    const session = engine.sessions.open('port', await active(identity('user', 'account')))
    const input = {
      operation_id: 'operation-1', action: 'tasks.update' as const, selection_id: 'selection-grant-user-account', resource_id: 'task-1', entity_type: 'task', entity_id: 'task-1', base_version: 2,
      payload: { title: 'Nuevo' }, optimistic_value: { id: 'task-1', account_id: 'account', list_id: 'list-account', title: 'Nuevo' },
    }
    const first = await engine.queueMutation('port', session.generation, input)
    const duplicate = await engine.queueMutation('port', session.generation, input)
    expect(first.state).toBe('queued')
    expect(duplicate.state).toBe('duplicate')
    expect(await engine.outbox('port', session.generation)).toHaveLength(1)
    await expect(engine.queueMutation('port', session.generation, { ...input, payload: { title: 'Distinto' } })).rejects.toMatchObject({ code: 'operation_id_reused' })
    await engine.applyReceipts('port', session.generation, [{ operation_id: 'operation-1', status: 'conflict', resource_id: 'task-1', conflict: { fields: ['title'], base: { title: 'Antes' }, local: { title: 'Nuevo' }, server: { title: 'Servidor' } } }])
    expect(await engine.outbox('port', session.generation)).toHaveLength(0)
    expect(await engine.conflicts('port', session.generation)).toMatchObject([{ operation_id: 'operation-1', fields: ['title'], status: 'conflict' }])
    expect(await engine.overlays('port', session.generation, 'task')).toHaveLength(0)
    const acknowledged = await engine.acknowledgeServerWinsConflicts('port', session.generation)
    expect(acknowledged).toMatchObject({ mode: 'offline', conflictCount: 0 })
    expect(await engine.conflicts('port', session.generation)).toHaveLength(0)
  })

  it('treats a canonical noop receipt as confirmed and removes it from the outbox', async () => {
    const storage = new MemoryOfflineV5Storage(), engine = new OfflineV5Engine(origin, storage)
    await storage.commit([{ store: 'schema', key: 'auth:browser-1', value: 'epoch' }])
    const session = engine.sessions.open('port', await active(identity('user', 'account')))
    await engine.queueMutation('port', session.generation, {
      operation_id: 'operation-noop', action: 'tasks.update', selection_id: 'selection-grant-user-account', resource_id: 'task-1', entity_type: 'task', entity_id: 'task-1', base_version: 2,
      payload: { title: 'Sin cambio' }, optimistic_value: { id: 'task-1', account_id: 'account', list_id: 'list-account', title: 'Sin cambio' },
    })
    await engine.applyReceipts('port', session.generation, [{ operation_id: 'operation-noop', status: 'noop', resource_id: 'task-1', server_version: 2 }])
    expect(await engine.outbox('port', session.generation)).toHaveLength(0)
    expect(await engine.conflicts('port', session.generation)).toHaveLength(0)
  })

  it('never returns the same entity id from another account namespace', async () => {
    const storage = new MemoryOfflineV5Storage(), engine = new OfflineV5Engine(origin, storage)
    await storage.commit([{ store: 'schema', key: 'auth:browser-1', value: 'epoch' }])
    const a = engine.sessions.open('port-a', await active(identity('user', 'account-a'), 'namespace-a'))
    const b = engine.sessions.open('port-b', await active(identity('user', 'account-b'), 'namespace-b'))
    const mutation = (account: string) => ({ operation_id: `op-${account}`, action: 'tasks.update' as const, selection_id: `selection-grant-user-${account}`, resource_id: 'same-task', entity_type: 'task', entity_id: 'same-task', base_version: 1, payload: { title: account }, optimistic_value: { id: 'same-task', account_id: account, list_id: `list-${account}`, title: account } })
    await engine.queueMutation('port-a', a.generation, mutation('account-a'))
    await engine.queueMutation('port-b', b.generation, mutation('account-b'))
    expect((await engine.overlays('port-a', a.generation, 'task'))[0].value).toMatchObject({ title: 'account-a' })
    expect((await engine.overlays('port-b', b.generation, 'task'))[0].value).toMatchObject({ title: 'account-b' })
    engine.lock('port-a')
    await expect(engine.overlays('port-a', a.generation, 'task')).rejects.toMatchObject({ code: 'locked' })
    expect((await engine.overlays('port-b', b.generation, 'task'))[0].value).toMatchObject({ title: 'account-b' })
  })

  it('encrypts OPFS-style chunks and refuses another account even with the same blob id', async () => {
    const storage = new MemoryOfflineV5Storage(), blobs = new MemoryOfflineV5BlobStore(), engine = new OfflineV5Engine(origin, storage, undefined, Date.now, blobs)
    await storage.commit([{ store: 'schema', key: 'auth:browser-1', value: 'epoch' }])
    const a = engine.sessions.open('port-a', await active(identity('user', 'account-a'), 'namespace-a'))
    const b = engine.sessions.open('port-b', await active(identity('user', 'account-b'), 'namespace-b'))
    await engine.putBlob('port-a', a.generation, { blobId: 'blob-same', entityType: 'task', entityId: 'task-a', rootSelectionId: 'selection-grant-user-account-a', name: 'evidence.txt', type: 'text/plain', bytes: new Blob(['secreto-a']) })
    expect(await (await engine.getBlob('port-a', a.generation, 'blob-same')).text()).toBe('secreto-a')
    await expect(engine.getBlob('port-b', b.generation, 'blob-same')).rejects.toMatchObject({ code: 'blob_missing' })
    await engine.deleteBlob('port-a', a.generation, 'blob-same')
    expect(blobs.count()).toBe(0)
  })
})
