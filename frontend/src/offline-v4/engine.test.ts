// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SignJWT, importJWK } from 'jose'
import { BrowserOfflineEngine, orderOperations } from './engine'
import { createSigningKey, sha256Hex } from './crypto'
import { BrowserAPIError, BrowserOnlineClient, syncRequestBody, SYNC_BODY_BUDGET_BYTES, type LeaseResponse, type ServerGrant } from './onlineClient'
import { getOrCreateProfile, type OfflineStorage, type StoreMutation } from './storage'
import type { BrowserProfile, GrantIdentity, Operation, Snapshot, StoredRecord, VaultEnvelope } from './types'
import type { OfflineResource, OfflineTask, TaskCreateInput } from '../offline-v3/types'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const password = 'Contraseña segura de prueba 2026', origin = 'https://clarin.test'
class MemoryStorage implements OfflineStorage {
  values = new Map<string, unknown>()
  failNext = false
  async get<T>(store: string, key: string) { return structuredClone(this.values.get(`${store}:${key}`)) as T | undefined }
  async all<T>(store: string, index?: string, key?: IDBValidKey): Promise<T[]> {
    return [...this.values].filter(([stored, value]) => stored.startsWith(`${store}:`) && (!index || index === 'grant_id' ? !index || (value as StoredRecord).grant_id === key : JSON.stringify([(value as StoredRecord).grant_id, (value as StoredRecord).kind]) === JSON.stringify(key))).map(([, value]) => structuredClone(value) as T)
  }
  async totalBytes(grantID?: string) { return (await this.all<StoredRecord>('records')).filter(record => !grantID || record.grant_id === grantID).reduce((sum, record) => sum + record.byte_size, 0) }
  async commit(mutations: StoreMutation[], epoch?: string) {
    if (epoch !== undefined && (await this.get('profiles', 'auth_epoch') || '') !== epoch) throw new Error('identity_changed')
    if (this.failNext) { this.failNext = false; throw new Error('transaction aborted') }
    const next = new Map(this.values)
    for (const mutation of mutations) {
      const key = `${mutation.store}:${mutation.key}`
      if (mutation.add && next.has(key)) throw new DOMException('exists', 'ConstraintError')
      if (mutation.remove) next.delete(key); else next.set(key, structuredClone(mutation.value))
    }
    this.values = next
  }
}
async function fixture(count = 1, sameUser = false) {
  vi.stubGlobal('indexedDB', {})
  const storage = new MemoryStorage(), profile = await getOrCreateProfile(storage), signing = await createSigningKey()
  const publicKey = { ...signing.public_jwk, kid: 'server-key' }, signingKey = await importJWK(signing.private_jwk, 'ES256')
  const grants: ServerGrant[] = Array.from({ length: count }, (_, index) => ({ grant_id: id(index + 1), browser_profile_id: profile.browser_id, user_id: id(sameUser ? 100 : index + 100), account_id: id(index + 200), account_name: `Cuenta ${index}`, username: sameUser ? 'usuario0' : `usuario${index}`, display_user: `Usuario ${index}`, state: 'active', actions: ['tasks.read', 'tasks.create', 'tasks.complete'], max_resources: 20, quota_bytes: 1024 ** 3, max_offline_seconds: 86400, selection_revision: 1, credential_epoch: 1, authority_epoch: 1 }))
  const selections = new Map(grants.map((grant, index) => [grant.grant_id, { selection_id: id(index + 300), resource_id: id(index + 400), module: 'tasks', resource_type: 'task_list', label: `Lista privada ${index}`, readiness: 'preparing', head_version: 1, content_hash: 'hash', item_count: 0, byte_size: 0 } satisfies OfflineResource]))
  const tasks = new Map<string, OfflineTask>()
  const api = new BrowserOnlineClient(origin)
  vi.spyOn(api, 'grants').mockResolvedValue({ items: grants })
  vi.spyOn(api, 'selection').mockImplementation(async grant => ({ items: [selections.get(grant)!], selection_revision: 1 }))
  vi.spyOn(api, 'registerKeys').mockResolvedValue({})
  let responseTransform: (response: LeaseResponse) => LeaseResponse = value => value
  const sync = vi.spyOn(api, 'sync').mockImplementation(async (_profile: BrowserProfile, identity: GrantIdentity, _key, revision, operations, wanted) => {
    const grant = grants.find(item => item.grant_id === identity.grant_id)!, selection = selections.get(grant.grant_id)!, now = Math.floor(Date.now() / 1000)
    const receipts: LeaseResponse['receipts'] = []
    for (const operation of operations) {
      const task = operation.action === 'tasks.create' ? { id: operation.resource_id, version: 1, ...(operation.payload as TaskCreateInput['patch']), list_id: selection.resource_id, status_category: 'not_started', can_complete: true } as OfflineTask : { ...tasks.get(operation.resource_id)!, version: 2, status_category: 'done' } as OfflineTask
      tasks.set(task.id, task)
      receipts.push({ operation_id: operation.operation_id, resource_id: operation.resource_id, status: 'applied', server_version: task.version, result: { task: { ...task } } })
    }
    const payload = { list: { id: selection.resource_id, name: selection.label, can_create: true, environment_id: id(999), environment_name: 'General' }, statuses: [], tasks: [...tasks.values()].filter(task => task.list_id === selection.resource_id) }
    const payloadJSON = JSON.stringify(payload)
    const snapshots: Snapshot[] = wanted.length ? [{ protocol_version: 4, browser_profile_id: identity.browser_id, grant_id: grant.grant_id, user_id: grant.user_id, account_id: grant.account_id, selection_id: selection.selection_id, module: selection.module, resource_type: selection.resource_type, resource_id: selection.resource_id, selection_revision: revision, head_version: 1, content_hash: await sha256Hex(payloadJSON), payload, payload_json: payloadJSON, tombstone: false, generated_at: new Date().toISOString() }] : []
    const lease = await new SignJWT({ version: 4, browser_profile_id: identity.browser_id, grant_id: grant.grant_id, user_id: grant.user_id, account_id: grant.account_id, iat: now, exp: now + 86400, actions: grant.actions, credential_epoch: grant.credential_epoch, authority_epoch: grant.authority_epoch, selection_revision: revision }).setIssuer('clarin-offline-v4').setAudience(origin).setProtectedHeader({ alg: 'ES256', typ: 'clarin-offline-v4-lease+jwt', kid: publicKey.kid }).sign(signingKey)
    return responseTransform({ grant, lease, signer_public_keys: { keys: [publicKey] }, snapshots, receipts, state: 'synchronized', server_time: new Date().toISOString() })
  })
  const manager = { estimate: vi.fn(async () => ({ quota: 10 * 1024 ** 3, usage: 0 })), persisted: vi.fn(async () => true), persist: vi.fn(async () => true) } as unknown as StorageManager
  const engine = new BrowserOfflineEngine(origin, storage, api, manager)
  const createInput = (grantIndex = 0): TaskCreateInput => ({ operation_id: crypto.randomUUID(), selection_id: selections.get(grants[grantIndex].grant_id)!.selection_id, task_id: crypto.randomUUID(), client_occurred_at: new Date().toISOString(), patch: { title: 'Tarea absolutamente privada', description: 'Contenido privado', priority: 'medium', start_at: null, due_at: null, due_end_at: null, is_all_day: false } })
  return { storage, profile, api, engine, grants, selections, manager, sync, createInput, transform: (fn: typeof responseTransform) => { responseTransform = fn } }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
describe('browser-only durable engine', () => {
  it('writes only selection authority selectors and excludes UI labels, subtitles and local state', async () => {
    const f = await fixture(), request = vi.spyOn(f.api, 'request').mockResolvedValue({ items: [], selection_revision: 2 })
    const choice = { module: 'tasks', resource_type: 'task_list', resource_id: id(400), label: 'Lista privada', subtitle: 'Entorno privado', readiness: 'available', account_id: 'not-a-write-selector', selection_id: 'client-metadata' }
    await f.engine.replaceSelection(f.grants[0].grant_id, 1, [choice], 'cookie-session')
    expect(request).toHaveBeenCalledExactlyOnceWith(`/api/offline/v4/grants/${f.grants[0].grant_id}/selection`, {
      selection_revision: 1, items: [{ module: 'tasks', resource_type: 'task_list', resource_id: id(400) }],
    }, { token: 'cookie-session', method: 'PUT' })
  })
  it('prepares encrypted data and reopens without any native service', async () => {
    const f = await fixture()
    await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session')
    expect(f.engine.state().session?.actor.user_id).toBe(f.grants[0].user_id)
    expect(JSON.stringify([...f.storage.values])).not.toContain('Lista privada')
    expect(JSON.stringify([...f.storage.values])).not.toContain(password)
    f.engine.lock()
    const reopened = new BrowserOfflineEngine(origin, f.storage, f.api, f.manager)
    const result = await reopened.unlockUser(' USUARIO0 ', password)
    expect(result.session?.actor.account_id).toBe(f.grants[0].account_id)
    expect((await reopened.gateway().taskLists()).items).toHaveLength(1)
  })
  it('protects ten users in the same profile and rejects cross-account expectations', async () => {
    const f = await fixture(10)
    for (const grant of f.grants) await f.engine.prepare(grant.grant_id, password, 'cookie-session')
    const user = await f.engine.unlockUser('usuario0', password)
    expect(user.accounts).toEqual([{ grant_id: f.grants[0].grant_id, account_name: 'Cuenta 0' }])
    await expect(f.engine.unlockUser('usuario0', password, { user_id: f.grants[1].user_id, account_id: f.grants[1].account_id })).rejects.toThrow()
    expect(f.engine.state().session).toBeNull()
  }, 15000)
  it('requires explicit account selection after correct credentials for multiple accounts', async () => {
    const f = await fixture(2, true)
    for (const grant of f.grants) await f.engine.prepare(grant.grant_id, password, 'cookie-session')
    const result = await f.engine.unlockUser('usuario0', password)
    expect(result.session).toBeUndefined(); expect(result.accounts).toHaveLength(2); expect(f.engine.state().session).toBeNull()
    expect((await f.engine.selectAccount(f.grants[1].grant_id)).actor.account_id).toBe(f.grants[1].account_id)
    await expect(f.engine.selectAccount(f.grants[0].grant_id)).rejects.toThrow()
  }, 15000)
  it('does not disclose names or open a session with a wrong username even when passwords match', async () => {
    const f = await fixture()
    await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session'); f.engine.lock()
    const listener = vi.fn(); f.engine.subscribe(listener)
    await expect(f.engine.unlock(f.grants[0].grant_id, password, 'another-user')).rejects.toThrow()
    expect(f.engine.state().session).toBeNull()
    expect(listener.mock.calls.every(([state]) => !state.session)).toBe(true)
  })
  it('commits task and outbox atomically and preserves the operation identity through create-complete sync', async () => {
    const f = await fixture(); await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session')
    const input = f.createInput(), created = await f.engine.createTask(input)
    expect(created.pending_count).toBe(1)
    await f.engine.completeTask(input.task_id, { operation_id: crypto.randomUUID(), selection_id: input.selection_id, base_version: 0, client_occurred_at: new Date().toISOString() })
    expect((await f.engine.gateway().syncStatus()).pending_count).toBe(2)
    const status = await f.engine.triggerSync(); expect(status.pending_count).toBe(0)
    expect((await f.engine.tasks(input.selection_id)).items[0]).toMatchObject({ id: input.task_id, status_category: 'done', version: 2 })
    const operations = f.sync.mock.calls.flatMap(call => call[4])
    expect(operations.map(operation => operation.action)).toEqual(['tasks.create', 'tasks.complete'])
    expect(operations.every(operation => operation.user_id === f.grants[0].user_id && operation.account_id === f.grants[0].account_id && operation.grant_id === f.grants[0].grant_id)).toBe(true)
  })
  it('reports a failed transaction without optimistic success or an orphan task', async () => {
    const f = await fixture(); await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session')
    f.storage.failNext = true
    const input = f.createInput()
    await expect(f.engine.createTask(input)).rejects.toThrow('transaction aborted')
    expect((await f.engine.gateway().syncStatus()).pending_count).toBe(0)
    expect((await f.engine.tasks(input.selection_id)).items).toHaveLength(0)
  })
  it('syncs large ASCII/Unicode tasks in bounded batches while keeping create-complete dependencies and IDs', async () => {
    const f = await fixture(); await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session')
    f.sync.mockClear()
    const inputs: TaskCreateInput[] = []
    for (let index = 0; index < 12; index++) {
      const input = f.createInput(); input.client_occurred_at = new Date(Date.now() + index).toISOString()
      input.patch.description = index % 2 ? '😀'.repeat(50000) : 'A'.repeat(200000)
      inputs.push(input); await f.engine.createTask(input)
    }
    const completeID = crypto.randomUUID(), last = inputs.at(-1)!
    await f.engine.completeTask(last.task_id, { operation_id: completeID, selection_id: last.selection_id, base_version: 0, client_occurred_at: new Date(Date.now() + 1000).toISOString() })
    expect((await f.engine.triggerSync()).pending_count).toBe(0)
    const uploads = f.sync.mock.calls.filter(call => call[4].length)
    expect(uploads.map(call => call[4].length)).toEqual([10, 3])
    expect(uploads.flatMap(call => call[4].map(item => item.operation_id))).toEqual([...inputs.map(input => input.operation_id), completeID])
    expect(uploads[1][4].at(-1)?.depends_on_operation_id).toBe(last.operation_id)
    for (const [profile, identity, , revision, operations, wanted] of uploads) {
      const wire = syncRequestBody(profile.browser_id, identity.grant_id, revision, operations, wanted, { challenge_id: id(999), nonce: 'A'.repeat(43) })
      expect(new TextEncoder().encode(JSON.stringify(wire)).byteLength).toBeLessThanOrEqual(SYNC_BODY_BUDGET_BYTES)
    }
    const tasks = (await f.engine.tasks(last.selection_id)).items
    expect(tasks).toHaveLength(12)
    expect(tasks.find(task => task.id === last.task_id)?.status_category).toBe('done')
    for (const input of inputs) expect(tasks.find(task => task.id === input.task_id)?.description).toBe(input.patch.description)
  }, 15000)
  it('retains the whole unacknowledged batch and replays identical operations after an ACK is lost', async () => {
    const f = await fixture(); await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session'); f.sync.mockClear()
    for (let index = 0; index < 12; index++) {
      const input = f.createInput(); input.patch.description = 'A'.repeat(200000); await f.engine.createTask(input)
    }
    const implementation = f.sync.getMockImplementation()!
    f.sync.mockImplementationOnce(async (...args) => { await implementation(...args); throw new BrowserAPIError(0, 'network_unavailable', 'ACK lost', true) })
    expect(await f.engine.triggerSync()).toMatchObject({ pending_count: 12, state: 'waiting_network' })
    const lostBatch = structuredClone(f.sync.mock.calls[0][4])
    expect(lostBatch).toHaveLength(10)
    expect((await f.engine.triggerSync()).pending_count).toBe(0)
    expect(f.sync.mock.calls[1][4]).toEqual(lostBatch)
    expect(f.sync.mock.calls.filter(call => call[4].length).map(call => call[4].length)).toEqual([10, 10, 2])
    expect((await f.engine.tasks(f.selections.get(f.grants[0].grant_id)!.selection_id)).items).toHaveLength(12)
  }, 15000)
  it('retains all ciphertext and returns a stable non-retryable error when one pending operation cannot fit', async () => {
    const f = await fixture(); await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session')
    await f.engine.createTask(f.createInput())
    const input = f.createInput(); input.patch.description = 'X'.repeat(SYNC_BODY_BUDGET_BYTES); await f.engine.createTask(input)
    const records = await f.storage.all('records'), envelope = await f.storage.get('vaults', f.grants[0].grant_id)
    f.sync.mockClear()
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await f.engine.triggerSync()).toMatchObject({ pending_count: 2, state: 'blocked', last_error: { code: 'operation_too_large', retryable: false } })
      expect(await f.storage.all('records')).toEqual(records)
      expect(await f.storage.get('vaults', f.grants[0].grant_id)).toEqual(envelope)
    }
    expect(f.sync).not.toHaveBeenCalled()
    expect((await f.engine.tasks(input.selection_id)).items.find(task => task.id === input.task_id)?.description).toBe(input.patch.description)
  }, 15000)
  it('allows reads but prohibits offline writes when persistence is denied', async () => {
    const f = await fixture(); vi.mocked(f.manager.persisted).mockResolvedValue(false); vi.mocked(f.manager.persist).mockResolvedValue(false)
    await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session')
    expect((await f.engine.gateway().taskLists()).items).toHaveLength(1)
    await expect(f.engine.createTask(f.createInput())).rejects.toMatchObject({ code: 'persistent_storage_required' })
  })
  it('rechecks real browser persistence on reopening and exposes only read actions while retaining pending changes', async () => {
    const f = await fixture(); await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session')
    await f.engine.createTask(f.createInput()); f.engine.lock()
    vi.mocked(f.manager.persisted).mockResolvedValue(false)
    const reopened = new BrowserOfflineEngine(origin, f.storage, f.api, f.manager)
    const result = await reopened.unlockUser('usuario0', password)
    expect(result.session?.actions).toEqual(['tasks.read'])
    expect(reopened.state().persistent).toBe(false)
    expect((await reopened.gateway().syncStatus()).pending_count).toBe(1)
    expect((await reopened.gateway().taskLists()).items).toHaveLength(1)
    await expect(reopened.createTask(f.createInput())).rejects.toMatchObject({ code: 'persistent_storage_required' })
    expect(await f.storage.all('records', 'grant_kind', [f.grants[0].grant_id, 'operation'])).toHaveLength(1)
  })
  it('downgrades the active UI immediately when a new write detects lost persistence without changing identity or outbox', async () => {
    const f = await fixture(); await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session')
    await f.engine.createTask(f.createInput())
    const previous = f.engine.state(), listener = vi.fn(); f.engine.subscribe(listener)
    vi.mocked(f.manager.persisted).mockResolvedValue(false)
    await expect(f.engine.createTask(f.createInput())).rejects.toMatchObject({ code: 'persistent_storage_required' })
    expect(f.engine.state()).toMatchObject({ generation: previous.generation, persistent: false, session: { actor: previous.session!.actor, actions: ['tasks.read'] } })
    expect(listener.mock.lastCall?.[0].persistent).toBe(false)
    expect((await f.engine.gateway().syncStatus()).pending_count).toBe(1)
    expect(await f.storage.all('records', 'grant_kind', [f.grants[0].grant_id, 'task'])).toHaveLength(1)
  })
  it('removes obsolete write controls on normal status polling after persistence disappears', async () => {
    const f = await fixture(); await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session')
    vi.mocked(f.manager.persisted).mockResolvedValue(false)
    await f.engine.gateway().syncStatus()
    expect(f.engine.state().persistent).toBe(false)
    expect(f.engine.state().session?.actions).toEqual(['tasks.read'])
  })
  it('rejects a foreign snapshot and never marks the preparation available', async () => {
    const f = await fixture(); f.transform(response => ({ ...response, snapshots: response.snapshots.map(snapshot => ({ ...snapshot, account_id: id(9999) })) }))
    await expect(f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session')).rejects.toMatchObject({ code: 'wrong_snapshot' })
    expect((await f.storage.get<VaultEnvelope>('vaults', f.grants[0].grant_id))?.state).toBe('preparing')
    expect(f.engine.state().session).toBeNull()
  })
  it('keeps pending records and RAM authority unchanged on a foreign receipt or failed commit', async () => {
    const f = await fixture(); await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session')
    const created = f.createInput(); await f.engine.createTask(created)
    const before = f.engine.state().session?.lease_expires_at
    f.transform(response => ({ ...response, receipts: response.receipts.map(receipt => ({ ...receipt, resource_id: id(888) })) }))
    const result = await f.engine.triggerSync()
    expect(result.last_error?.code).toBe('wrong_receipt'); expect(result.pending_count).toBe(1)
    expect(f.engine.state().session?.lease_expires_at).toBe(before)
  })
  it('preserves pending ciphertext after server revocation while blocking private reads', async () => {
    const f = await fixture(); await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session'); await f.engine.createTask(f.createInput())
    f.sync.mockRejectedValue(new BrowserAPIError(403, 'offline_access_denied', 'Revoked'))
    await expect(f.engine.triggerSync()).rejects.toMatchObject({ code: 'access_blocked' })
    expect(f.engine.state().session).toBeNull()
    expect(await f.storage.all('records', 'grant_kind', [f.grants[0].grant_id, 'operation'])).toHaveLength(1)
    expect(await f.storage.all('records', 'grant_kind', [f.grants[0].grant_id, 'snapshot'])).toHaveLength(0)
  })
  it('preserves vault, signed lease and outbox when authentication, transport or proof checks fail without revocation', async () => {
    const f = await fixture(); await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session'); await f.engine.createTask(f.createInput())
    const previous = await f.storage.get<VaultEnvelope>('vaults', f.grants[0].grant_id), session = f.engine.state().session
    for (const [status, code] of [[403, 'offline_proof_denied'], [403, 'offline_transport_denied'], [401, 'session_expired'], [404, 'offline_unavailable'], [410, 'unknown_temporary_error']] as const) {
      f.sync.mockRejectedValueOnce(new BrowserAPIError(status, code, 'Temporary proof failure'))
      const result = await f.engine.triggerSync()
      expect(result).toMatchObject({ state: 'blocked', pending_count: 1, server_reachability: 'reachable', last_error: { code, retryable: true } })
      expect(await f.storage.get<VaultEnvelope>('vaults', f.grants[0].grant_id)).toEqual(previous)
      expect(f.engine.state().session).toEqual(session)
      expect(await f.storage.all('records', 'grant_kind', [f.grants[0].grant_id, 'snapshot'])).toHaveLength(1)
    }
  })
  it('treats an explicit missing grant as an authority outcome while retaining encrypted pending operations', async () => {
    const f = await fixture(); await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session'); await f.engine.createTask(f.createInput())
    f.sync.mockRejectedValue(new BrowserAPIError(404, 'offline_grant_not_found', 'No longer authorized'))
    await expect(f.engine.triggerSync()).rejects.toMatchObject({ code: 'access_blocked' })
    expect(f.engine.state().session).toBeNull()
    expect((await f.storage.get<VaultEnvelope>('vaults', f.grants[0].grant_id))?.state).toBe('revoked')
    expect(await f.storage.all('records', 'grant_kind', [f.grants[0].grant_id, 'operation'])).toHaveLength(1)
  })
  it('durably invalidates private reads and writes after an online identity transition without relying on broadcast delivery', async () => {
    const f = await fixture(); await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session')
    await f.storage.commit([{ store: 'profiles', key: 'auth_epoch', value: 'new-online-identity' }])
    await expect(f.engine.gateway().taskLists()).rejects.toMatchObject({ code: 'identity_changed' })
    expect(f.engine.state().session).toBeNull()
  })
  it('refuses operation 1001 before writing and keeps the existing queue readable', async () => {
    const f = await fixture(); await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session')
    const mutations = Array.from({ length: 1000 }, (_, index) => ({ store: 'records' as const, key: `${f.grants[0].grant_id}:operation:${id(5000 + index)}`, value: { id: `${f.grants[0].grant_id}:operation:${id(5000 + index)}`, kind: 'operation', grant_id: f.grants[0].grant_id, byte_size: 1, ciphertext: {} } }))
    await f.storage.commit(mutations)
    await expect(f.engine.createTask(f.createInput())).rejects.toMatchObject({ code: 'outbox_full' })
    expect((await f.engine.gateway().syncStatus()).pending_count).toBe(1000)
    expect(await f.storage.all('records', 'grant_kind', [f.grants[0].grant_id, 'task'])).toHaveLength(0)
  })
  it('rejects altered exact snapshot bytes even when the parsed object looks valid', async () => {
    const f = await fixture(); f.transform(response => ({ ...response, snapshots: response.snapshots.map(snapshot => ({ ...snapshot, payload_json: `${snapshot.payload_json} ` })) }))
    await expect(f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session')).rejects.toMatchObject({ code: 'snapshot_integrity' })
    expect(f.engine.state().session).toBeNull()
  })
  it('rejects late preparation completion after lock and locks on 30 minutes inactivity', async () => {
    const f = await fixture(); await f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session')
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 30 * 60 * 1000 + 1)
    f.engine.checkIdle(); expect(f.engine.state().session).toBeNull()
    vi.useRealTimers()
    let release!: () => void
    f.sync.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); throw new Error('late') })
    const request = f.engine.prepare(f.grants[0].grant_id, password, 'cookie-session')
    while (!release) await new Promise(resolve => setTimeout(resolve, 5))
    f.engine.lock(); release()
    await expect(request).rejects.toThrow(); expect(f.engine.state().session).toBeNull()
  })
})
describe('outbox ordering', () => {
  it('orders create before completion and rejects cross-account dependencies', () => {
    const create = { operation_id: id(1), action: 'tasks.create', grant_id: id(10), user_id: id(11), account_id: id(12), resource_id: id(13) } as Operation
    const complete = { ...create, operation_id: id(2), action: 'tasks.complete', depends_on_operation_id: create.operation_id } as Operation
    expect(orderOperations([complete, create])).toEqual([create, complete])
    expect(() => orderOperations([{ ...complete, account_id: id(99) }, create])).toThrow()
  })
})
