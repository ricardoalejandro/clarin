// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { OfflineV5Controller } from './controller'
import { offlineV5ManifestCanBindOperation } from './engine'
import type { OfflineV5Engine } from './engine'
import { OfflineV5APIError, type OfflineV5OnlineClient } from './onlineClient'
import type { OfflineV5Manifest, OfflineV5Operation, OfflineV5Receipt, OfflineV5SyncRequest, OfflineV5SyncResponse } from './types'

function testManifest(id: string, revision: number, write: boolean): OfflineV5Manifest {
  const root = { selection_id: 'selection-1', module: 'tasks' as const, resource_type: 'task_list', resource_id: 'list-1' }
  const capability = (action: 'tasks.read' | 'tasks.update') => ({ action, selection_id: root.selection_id, root_resource_id: root.resource_id, resource_type: root.resource_type, resource_id: root.resource_id })
  return {
    protocol_version: 5, id, revision, browser_profile_id: 'browser-1', grant_id: 'grant-1', user_id: 'user-1', account_id: 'account-1', username: 'ada', account_name: 'Cuenta',
    selection_revision: 1, selection_digest: `digest-${id}`, credential_epoch: revision, authority_epoch: revision, grant_revision: revision,
    roots: [root], dependencies: [{ root_selection_id: root.selection_id, module: 'tasks', resource_type: 'task', resource_id: 'task-1' }],
    capabilities: write ? [capability('tasks.read'), capability('tasks.update')] : [capability('tasks.read')], entity_versions: [], chunk_hashes: [],
    digest: `digest-${id}`, canonical_json: 'e30', issued_at: '2026-09-15T00:00:00.000Z', expires_at: '2026-09-16T00:00:00.000Z', max_storage_bytes: 1024 * 1024,
  }
}

function operationFor(manifest: OfflineV5Manifest): OfflineV5Operation {
  return {
    protocol_version: 5, browser_profile_id: manifest.browser_profile_id, grant_id: manifest.grant_id, user_id: manifest.user_id, account_id: manifest.account_id,
    operation_id: 'operation-1', action: 'tasks.update', selection_id: 'selection-1', resource_id: 'task-1', selection_revision: manifest.selection_revision,
    manifest_id: manifest.id, manifest_revision: manifest.revision, credential_epoch: manifest.credential_epoch, authority_epoch: manifest.authority_epoch,
    base_version: 1, occurred_at: '2026-09-15T00:00:00.000Z', payload: { title: 'Cambio local' },
  }
}

function response(manifest: OfflineV5Manifest, receipts: OfflineV5Receipt[] = []): OfflineV5SyncResponse {
  return { manifest, receipts, lease: 'lease', signer_public_keys: { keys: [] }, snapshots: [], server_time: '2026-09-15T00:01:00.000Z' }
}

function receiptRecovery(receipts: OfflineV5Receipt[]): OfflineV5SyncResponse {
  return { receipts, renewal_available: false, state: 'receipts_recovered', server_time: '2026-09-15T00:01:00.000Z' }
}

function recoveryHarness(initialManifest: OfflineV5Manifest, initialOperation: OfflineV5Operation, responses: OfflineV5SyncResponse[]) {
  let pending = [initialOperation]
  const session = {
    identity: { grant_id: 'grant-1', browser_profile_id: 'browser-1', user_id: 'user-1', account_id: 'account-1' },
    manifest: initialManifest,
    metadata: { grant_private_jwk: { kty: 'EC' } },
    syncState: 'idle',
  }
  const refreshPreparedBundle = vi.fn(async (_port: string, _generation: number, bundle: Extract<OfflineV5SyncResponse, { manifest: OfflineV5Manifest }>) => {
    pending = pending.map(operation => offlineV5ManifestCanBindOperation(bundle.manifest, operation) ? {
      ...operation, manifest_id: bundle.manifest.id, manifest_revision: bundle.manifest.revision,
      selection_revision: bundle.manifest.selection_revision, credential_epoch: bundle.manifest.credential_epoch, authority_epoch: bundle.manifest.authority_epoch,
    } : operation)
    session.manifest = bundle.manifest
    return { active: true }
  })
  const engine = {
    origin: 'https://clarin.test',
    browserProfile: async () => ({ browser_id: 'browser-1' }),
    sessions: {
      require: () => session,
      setSyncState: (_port: string, _generation: number, state: string) => { session.syncState = state },
    },
    outbox: async () => [...pending],
    applyReceipts: async (_port: string, _generation: number, receipts: OfflineV5Receipt[]) => {
      const terminal = new Set(receipts.filter(receipt => receipt.status !== 'pending').map(receipt => receipt.operation_id))
      pending = pending.filter(operation => !terminal.has(operation.operation_id))
    },
    refreshPreparedBundle,
    runtimeSnapshot: async () => ({ generation: 1, active: true, mode: 'offline', authorizedModules: ['tasks'], selectedRoots: { tasks: ['list-1'] }, capabilities: session.manifest.capabilities.map(value => value.action), pendingCount: pending.length, conflictCount: 0 }),
  }
  const online = { sync: vi.fn(async (_profile: unknown, _key: unknown, _request: Omit<OfflineV5SyncRequest, 'challenge_id' | 'nonce'>) => {
    const next = responses.shift()
    if (!next) throw new Error('unexpected sync')
    return next
  }), downloadPreparedAssets: vi.fn(async () => []) }
  const controller = new OfflineV5Controller(engine as unknown as OfflineV5Engine, online as unknown as OfflineV5OnlineClient)
  return { controller, engine, online, refreshPreparedBundle, pending: () => pending }
}

describe('Offline v5 pending receipt recovery', () => {
  it('holds a recovered pending intent on a read-only manifest, then zero-refreshes, rebinds and retries after writes return', async () => {
    const first = testManifest('manifest-1', 1, true)
    const readOnly = testManifest('manifest-2', 2, false)
    const restored = testManifest('manifest-3', 3, true)
    const afterApply = testManifest('manifest-4', 4, true)
    const pendingReceipt: OfflineV5Receipt = { operation_id: 'operation-1', resource_id: 'task-1', status: 'pending', error_code: 'operation_dependency_pending' }
    const appliedReceipt: OfflineV5Receipt = { operation_id: 'operation-1', resource_id: 'task-1', status: 'applied', server_version: 2 }
    const harness = recoveryHarness(first, operationFor(first), [response(readOnly, [pendingReceipt]), response(restored), response(afterApply, [appliedReceipt])])

    await harness.controller.sync('port', 1)
    expect(harness.online.sync).toHaveBeenCalledTimes(1)
    expect(harness.pending()).toMatchObject([{ manifest_id: first.id, action: 'tasks.update' }])

    await harness.controller.sync('port', 1)
    expect(harness.online.sync).toHaveBeenCalledTimes(3)
    const requests = harness.online.sync.mock.calls.map(call => call[2])
    expect(requests.map(request => request.operations.length)).toEqual([1, 0, 1])
    expect(requests[2].operations[0]).toMatchObject({ manifest_id: restored.id, manifest_revision: restored.revision, action: 'tasks.update' })
    expect(harness.pending()).toEqual([])
  })

  it('performs only one zero-operation refresh per attempt when write permission remains revoked', async () => {
    const original = testManifest('manifest-1', 1, true)
    const revoked = testManifest('manifest-2', 2, false)
    const stillRevoked = testManifest('manifest-3', 3, false)
    const harness = recoveryHarness(revoked, operationFor(original), [response(stillRevoked)])

    const snapshot = await harness.controller.sync('port', 1)
    expect(harness.online.sync).toHaveBeenCalledTimes(1)
    expect(harness.online.sync.mock.calls[0][2].operations).toEqual([])
    expect(harness.pending()).toMatchObject([{ operation_id: 'operation-1', manifest_id: original.id }])
    expect(snapshot).toMatchObject({ mode: 'offline', pendingCount: 1 })
  })

  it('accepts committed receipts without inventing a manifest renewal when preparation is globally disabled', async () => {
    const manifest = testManifest('manifest-1', 1, true)
    const applied: OfflineV5Receipt = { operation_id: 'operation-1', resource_id: 'task-1', status: 'applied', server_version: 2 }
    const harness = recoveryHarness(manifest, operationFor(manifest), [receiptRecovery([applied])])

    const snapshot = await harness.controller.sync('port', 1)

    expect(harness.online.sync).toHaveBeenCalledTimes(1)
    expect(harness.refreshPreparedBundle).not.toHaveBeenCalled()
    expect(harness.pending()).toEqual([])
    expect(snapshot).toMatchObject({ mode: 'offline', pendingCount: 0 })
  })
})

describe('Offline v5 preparation recovery', () => {
  function preparationHarness(created = true) {
    const key = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'secret' }
    const grant = { grant_id: 'grant-1', browser_profile_id: 'browser-1', user_id: 'user-1', account_id: 'account-1', username: 'ricardo', account_name: 'Proyectos', state: 'active', selection_revision: 2 }
    const engine = {
      origin: 'https://clarin.test',
      browserProfile: vi.fn(async () => ({ browser_id: 'browser-1' })),
      assertCanPrepareGrant: vi.fn(async () => undefined),
      stagePreparation: vi.fn(async () => ({ privateJWK: key, created })),
      discardPreparingGrant: vi.fn(async () => undefined),
      installPreparedBundle: vi.fn(async () => ({ generation: 1, active: false, mode: 'locked', authorizedModules: [], selectedRoots: {}, capabilities: [], pendingCount: 0, conflictCount: 0 })),
    }
    const online = {
      grants: vi.fn(async () => ({ items: [grant] })),
      registerKeys: vi.fn(async () => key),
      prepare: vi.fn(async () => ({ snapshots: [] })),
      downloadPreparedAssets: vi.fn(async () => []),
    }
    return { controller: new OfflineV5Controller(engine as unknown as OfflineV5Engine, online as unknown as OfflineV5OnlineClient), engine, online, key }
  }

  it('stages the private key before registration and carries it through asset installation', async () => {
    const harness = preparationHarness()
    await harness.controller.prepare('port', 'grant-1', 'Ricardo123@', true)
    expect(harness.engine.stagePreparation).toHaveBeenCalledWith(expect.objectContaining({ grant_id: 'grant-1' }), 'Ricardo123@', true)
    expect(harness.online.registerKeys).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ grant_id: 'grant-1' }), 'ricardo', 'Ricardo123@', harness.key)
    expect(harness.online.downloadPreparedAssets).toHaveBeenCalledTimes(1)
    expect(harness.engine.installPreparedBundle).toHaveBeenCalledWith(expect.objectContaining({ grantPrivateJWK: harness.key, assets: [] }))
    expect(harness.engine.discardPreparingGrant).not.toHaveBeenCalled()
  })

  it('deletes only a newly staged incomplete vault when the server confirms an incorrect password', async () => {
    const harness = preparationHarness(true)
    harness.online.registerKeys.mockRejectedValueOnce(new OfflineV5APIError(403, 'offline_reauthentication_failed', 'Contraseña incorrecta.'))
    await expect(harness.controller.prepare('port', 'grant-1', 'Ricardo123@', true)).rejects.toMatchObject({ code: 'offline_reauthentication_failed' })
    expect(harness.engine.discardPreparingGrant).toHaveBeenCalledWith('grant-1')

    const retained = preparationHarness(false)
    retained.online.registerKeys.mockRejectedValueOnce(new OfflineV5APIError(0, 'network_unavailable', 'Sin red.', true))
    await expect(retained.controller.prepare('port', 'grant-1', 'Ricardo123@', true)).rejects.toMatchObject({ code: 'network_unavailable' })
    expect(retained.engine.discardPreparingGrant).not.toHaveBeenCalled()
  })
})

describe('Offline v5 revocation reconciliation', () => {
  function statusHarness(status: string[] | Error) {
    const engine = {
      origin: 'https://clarin.test',
      browserProfile: vi.fn(async () => ({ browser_id: 'browser-1' })),
      listLocalGrants: vi.fn(async () => [
        { grantId: 'grant-active', state: 'available' },
        { grantId: 'grant-revoked', state: 'available' },
      ]),
      reconcileLocalGrantStatus: vi.fn(async () => ({ removed: ['grant-revoked'] })),
      hasAnyPreparedCopy: vi.fn(async () => true),
    }
    const online = {
      activeLocalGrants: vi.fn(async () => {
        if (status instanceof Error) throw status
        return status
      }),
    }
    return { controller: new OfflineV5Controller(engine as unknown as OfflineV5Engine, online as unknown as OfflineV5OnlineClient), engine, online }
  }

  it('purges revoked grants only after a trusted signed server response', async () => {
    const harness = statusHarness(['grant-active'])
    await expect(harness.controller.refreshPreparedCopyAvailability()).resolves.toBe(true)
    expect(harness.online.activeLocalGrants).toHaveBeenCalledWith(expect.objectContaining({ browser_id: 'browser-1' }), ['grant-active', 'grant-revoked'])
    expect(harness.engine.reconcileLocalGrantStatus).toHaveBeenCalledWith(['grant-active'])
  })

  it('preserves a valid local lease when the status endpoint is genuinely unreachable', async () => {
    const harness = statusHarness(new OfflineV5APIError(0, 'network_unavailable', 'Sin red.', true))
    await expect(harness.controller.refreshPreparedCopyAvailability()).resolves.toBe(true)
    expect(harness.engine.reconcileLocalGrantStatus).not.toHaveBeenCalled()
    expect(harness.engine.hasAnyPreparedCopy).toHaveBeenCalledOnce()
  })
})
