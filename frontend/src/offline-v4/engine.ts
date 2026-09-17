import type { OfflineDataGateway } from '../offline-v3/gateway'
import type { OfflineContact, OfflineConflict, OfflineModule, OfflinePage, OfflineProgram, OfflineResource, OfflineSession, OfflineTask, OfflineTaskList, OfflineWhiteboard, QueuedTaskResult, SyncStatus, TaskCompleteInput, TaskCreateInput } from '../offline-v3/types'
import { createSigningKey, createVaultKey, decryptValue, encryptValue, unlockVaultKey, verifyLease, canonicalIdentity, PASSWORD_ITERATIONS, sha256, sha256Hex } from './crypto'
import { BrowserOnlineClient, BrowserAPIError, batchSyncOperations, normalizeGrant, type LeaseResponse } from './onlineClient'
import { BrowserStorage, enforceStorageBudget, getOrCreateProfile, type OfflineStorage, type StoreMutation } from './storage'
import { BrowserOfflineError, IDLE_MS, MAX_BYTES, MAX_RESOURCES, type BrowserCapabilities, type BrowserState, type GrantIdentity, type LocalGrantSummary, type Operation, type Snapshot, type StoredRecord, type VaultEnvelope, type VaultMetadata } from './types'

interface ActiveVault { envelope: VaultEnvelope; metadata: VaultMetadata; key: CryptoKey; generation: number; activity_at: number; auth_epoch: string }
const recordID = (grant: string, kind: string, id: string) => `${grant}:${kind}:${id}`
const canonicalLogin = (login: string) => login.trim().toLowerCase()
const timestamp = () => new Date().toISOString()

/** All public mutations are serialized by the SharedWorker. lock() deliberately preempts I/O. */
export class BrowserOfflineEngine {
  private active: ActiveVault | null = null
  private candidates = new Map<string, ActiveVault>()
  private generation = 0
  private abort = new AbortController()
  private sync: SyncStatus | undefined
  private progress: BrowserState['preparing']
  private listener: (state: BrowserState) => void = () => {}
  constructor(private readonly origin: string, private readonly storage: OfflineStorage = new BrowserStorage(), private readonly api = new BrowserOnlineClient(origin), private readonly storageManager: StorageManager | undefined = globalThis.navigator?.storage) {}
  subscribe(listener: (state: BrowserState) => void) { this.listener = listener }
  state(): BrowserState {
    const active = this.active
    return { generation: this.generation, session: active ? this.session(active) : null, grant_id: active?.envelope.identity.grant_id, sync: this.sync, persistent: active?.metadata.persistent, preparing: this.progress }
  }
  private emit() { this.listener(this.state()) }
  lock() {
    this.abort.abort(); this.abort = new AbortController(); this.generation++
    this.active = null; this.candidates.clear(); this.sync = undefined; this.progress = undefined; this.emit()
  }
  activity() { if (this.active) this.active.activity_at = Date.now() }
  hasUnlockContext() { return !!this.active || this.candidates.size > 0 }
  checkIdle() { if ((this.active && (Date.now() - this.active.activity_at >= IDLE_MS || Date.now() >= Date.parse(this.active.metadata.grant.lease_expires_at || ''))) || [...this.candidates.values()].some(item => Date.now() - item.activity_at >= IDLE_MS || Date.now() >= Date.parse(item.metadata.grant.lease_expires_at || ''))) this.lock() }
  private guard(generation: number) {
    if (this.generation !== generation) throw new BrowserOfflineError('identity_changed', 'La sesión cambió. No se aplicó la operación anterior.')
  }
  private async checkEpoch(active: ActiveVault) {
    this.guard(active.generation)
    if ((await this.storage.get<string>('profiles', 'auth_epoch') || '') !== active.auth_epoch) { this.lock(); throw new BrowserOfflineError('identity_changed', 'La sesión online cambió. Desbloquea nuevamente tu copia.') }
    this.guard(active.generation)
  }
  private async currentPersistence(): Promise<boolean> {
    return await this.storageManager?.persisted?.().catch(() => false) || false
  }
  private async revalidatePersistence(active: ActiveVault): Promise<boolean> {
    const persistent = await this.currentPersistence()
    await this.checkEpoch(active)
    if (active.metadata.persistent && !persistent) {
      // The browser may withdraw persistence after preparation. Degrade the
      // current UI even if writing this metadata fails; never discard its outbox.
      active.metadata = { ...active.metadata, persistent: false }
      try { await this.saveMetadata(active) }
      finally { this.guard(active.generation); this.emit() }
    }
    return active.metadata.persistent && persistent
  }
  private requireActive(): ActiveVault {
    this.checkIdle()
    if (!this.active) throw new BrowserOfflineError('locked', 'Desbloquea primero tu copia offline.')
    if (Date.now() < this.active.metadata.highest_time - 60000) { this.lock(); throw new BrowserOfflineError('clock_rollback', 'Conecta con Clarín para comprobar la hora de esta copia.') }
    if (Date.now() >= Date.parse(this.session(this.active).lease_expires_at)) throw new BrowserOfflineError('lease_expired', 'La autorización offline venció. Conecta con Clarín para renovarla.')
    return this.active
  }
  private session(active: ActiveVault): OfflineSession {
    return { session_id: `${active.envelope.identity.grant_id}:${active.generation}`, capability: '', profile_epoch: active.generation, idle_expires_at: new Date(active.activity_at + IDLE_MS).toISOString(), lease_expires_at: active.metadata.grant.lease_expires_at || '', actor: active.metadata.actor, actions: active.metadata.grant.actions.filter(action => active.metadata.persistent || action.endsWith('.read')) }
  }
  async capabilities(requestPersistence = false): Promise<BrowserCapabilities> {
    const supported = !!(globalThis.crypto?.subtle && globalThis.indexedDB && this.storageManager?.estimate)
    if (!supported) return { supported: false, persistent: false, usage: 0, quota: 0, reason: 'Este navegador no dispone del almacenamiento protegido necesario. Clarín online sigue disponible.' }
    let persistent = await this.storageManager?.persisted?.().catch(() => false) || false
    if (requestPersistence && !persistent) persistent = await this.storageManager?.persist?.().catch(() => false) || false
    const estimate = await this.storageManager?.estimate().catch(() => ({ usage: 0, quota: 0 }))
    return { supported: true, persistent, usage: estimate?.usage || 0, quota: estimate?.quota || 0 }
  }
  async profile() {
    const profile = await getOrCreateProfile(this.storage)
    return { browser_profile_id: profile.browser_id, public_jwk: profile.public_jwk, request_ids: await this.storage.get<string[]>('profiles', 'request_ids') || [] }
  }
  async enroll(token: string, displayName: string) {
    if (!token) throw new BrowserOfflineError('online_required', 'Inicia sesión online para solicitar acceso.')
    const profile = await getOrCreateProfile(this.storage)
    const result = await this.api.enroll(profile, token, displayName)
    const requests = await this.storage.get<string[]>('profiles', 'request_ids') || []
    await this.storage.commit([{ store: 'profiles', key: 'request_ids', value: [result.request.id, ...requests.filter(id => id !== result.request.id)].slice(0, 30) }])
    return result.request
  }
  async listLocalGrants(): Promise<LocalGrantSummary[]> {
    const profile = await getOrCreateProfile(this.storage)
    const vaults = await this.storage.all<VaultEnvelope>('vaults')
    return Promise.all(vaults.filter(vault => vault.identity.origin === this.origin && vault.identity.browser_id === profile.browser_id)
      .map(async (vault, index): Promise<LocalGrantSummary> => {
        let state: LocalGrantSummary['state'] = vault.state
        if (state === 'available') { try { await verifyLease(vault.lease, vault.signer_keys, vault.identity) } catch { state = 'expired' } }
        return { grant_id: vault.identity.grant_id, state, label: `Copia offline ${index + 1}` }
      }))
  }
  async replaceSelection(grantID: string, revision: number, items: Array<{ module: string; resource_type: string; resource_id: string }>, token: string) {
    const existing = await this.storage.get<VaultEnvelope>('vaults', grantID)
    let previousSelections: OfflineResource[] = []
    if (existing) {
      const active = this.requireActive()
      if (active.envelope.identity.grant_id !== grantID) throw new BrowserOfflineError('wrong_grant', 'Desbloquea la copia que deseas cambiar.')
      if ((await this.records(active, 'operation')).length) throw new BrowserOfflineError('pending_changes', 'Sincroniza los cambios pendientes antes de cambiar la selección.')
      previousSelections = active.metadata.selections
    }
    if (items.length > MAX_RESOURCES) throw new BrowserOfflineError('too_many_resources', 'Selecciona como máximo 20 recursos.')
    // UI catalog items also carry labels/subtitles and local state. Only the
    // three authority selectors belong to the strict backend write contract.
    const selections = items.map(({ module, resource_type, resource_id }) => ({ module, resource_type, resource_id }))
    this.lock()
    const generation = this.generation
    const result = await this.api.request(`/api/offline/v4/grants/${encodeURIComponent(grantID)}/selection`, { selection_revision: revision, items: selections }, { token, method: 'PUT' })
    this.guard(generation)
    if (existing) {
      const retained = new Set(items.map(item => `${item.module}:${item.resource_type}:${item.resource_id}`))
      const removed = previousSelections.filter(item => !retained.has(`${item.module}:${item.resource_type}:${item.resource_id}`))
      const overlays = await this.storage.all<StoredRecord>('records', 'grant_kind', [grantID, 'task'])
      await this.storage.commit([
        { store: 'vaults', key: grantID, value: { ...existing, state: 'preparing' } },
        ...removed.map(item => ({ store: 'records' as const, key: recordID(grantID, 'snapshot', item.selection_id), remove: true })),
        ...overlays.map(item => ({ store: 'records' as const, key: item.id, remove: true })),
      ])
    }
    return result
  }
  async prepare(grantID: string, password: string, token: string): Promise<OfflineSession> {
    if (!token) throw new BrowserOfflineError('online_required', 'Inicia sesión online para preparar tu copia.')
    this.lock()
    const generation = this.generation
    const authEpoch = await this.storage.get<string>('profiles', 'auth_epoch') || ''
    const profile = await getOrCreateProfile(this.storage)
    const grant = (await this.api.grants(profile, token)).items.find(item => item.grant_id === grantID && item.browser_profile_id === profile.browser_id)
    if (!grant || grant.state !== 'active') throw new BrowserOfflineError('not_authorized', 'El superadmin todavía no autorizó esta cuenta en este navegador.')
    const selection = await this.api.selection(grantID, token)
    if (!selection.items.length) throw new BrowserOfflineError('empty_selection', 'Selecciona al menos un recurso para preparar la copia.')
    if (selection.items.length > Math.min(MAX_RESOURCES, grant.max_resources)) throw new BrowserOfflineError('too_many_resources', 'La selección supera el límite autorizado.')
    const capability = await this.capabilities(true)
    if (!capability.supported) throw new BrowserOfflineError('unsupported_browser', capability.reason || 'Navegador no compatible.')
    const identity: GrantIdentity = { origin: this.origin, browser_id: profile.browser_id, grant_id: grant.grant_id, user_id: grant.user_id, account_id: grant.account_id }
    const previous = await this.storage.get<VaultEnvelope>('vaults', grantID)
    let key: CryptoKey, envelope: VaultEnvelope, metadata: VaultMetadata
    if (previous) {
      if (canonicalIdentity(previous.identity) !== canonicalIdentity(identity) || previous.state === 'revoked') throw new BrowserOfflineError('wrong_identity', 'La copia existente no pertenece a esta autorización.')
      key = await unlockVaultKey(password, identity, previous.salt, previous.wrapped_key)
      metadata = await decryptValue<VaultMetadata>(key, identity, 'metadata', 'active', previous.encrypted_metadata)
      const pending = await this.storage.all<StoredRecord>('records', 'grant_kind', [grantID, 'operation'])
      if (pending.length && metadata.grant.selection_revision !== selection.selection_revision) throw new BrowserOfflineError('pending_changes', 'La selección cambió mientras había pendientes. No se sobrescribirá tu copia.')
      envelope = { ...previous, state: 'preparing' }
      metadata = { ...metadata, grant: normalizeGrant(grant, this.origin), selections: selection.items, persistent: capability.persistent }
    } else {
      const vault = await createVaultKey(password, identity)
      key = vault.key
      const signing = await createSigningKey()
      metadata = { grant: normalizeGrant(grant, this.origin), actor: { user_id: grant.user_id, account_id: grant.account_id, username: grant.username, display_name: grant.display_user || grant.username, account_name: grant.account_name }, grant_private_jwk: signing.private_jwk, credential_epoch: grant.credential_epoch, authority_epoch: grant.authority_epoch, selections: selection.items, persistent: capability.persistent, highest_time: Date.now() }
      envelope = { identity, lookup_tag: await sha256(`${profile.browser_id}\0${canonicalLogin(grant.username)}`), salt: vault.salt, iterations: PASSWORD_ITERATIONS, wrapped_key: vault.wrapped_key, encrypted_metadata: await encryptValue(key, identity, 'metadata', 'active', metadata), lease: '', signer_keys: [], state: 'preparing', updated_at: Date.now() }
      this.guard(generation)
      // Durable key material precedes server registration: a lost response must not orphan an accepted key.
      await this.storage.commit([{ store: 'vaults', key: grantID, value: envelope, add: true }])
    }
    const publicJWK = { ...metadata.grant_private_jwk }; delete publicJWK.d; publicJWK.key_ops = ['verify']
    try { await this.api.registerKeys(profile, grantID, publicJWK, metadata.grant_private_jwk, grant.username, password, token) }
    catch (error) {
      if (!previous && error instanceof BrowserAPIError && !error.infrastructure && [400, 401, 403, 422].includes(error.status)) {
        this.guard(generation)
        await this.storage.commit([{ store: 'vaults', key: grantID, remove: true }])
      }
      throw error
    }
    this.guard(generation)
    const active: ActiveVault = { envelope, metadata, key, generation, activity_at: Date.now(), auth_epoch: authEpoch }
    this.progress = { completed: 0, total: selection.items.length }; this.emit()
    await this.saveMetadata(active)
    for (let index = 0; index < selection.items.length; index++) {
      this.guard(generation)
      const response = await this.api.sync(profile, identity, metadata.grant_private_jwk, selection.selection_revision, [], [selection.items[index].selection_id], this.abort.signal)
      await this.applyResponse(active, response)
      this.progress = { completed: index + 1, total: selection.items.length }; this.emit()
    }
    this.guard(generation)
    for (const item of active.metadata.selections) {
      if (item.readiness !== 'available') throw new BrowserOfflineError('incomplete_snapshot', 'La copia aún está incompleta. Vuelve a preparar los recursos.')
    }
    active.envelope.state = 'available'
    active.metadata.persistent = await this.currentPersistence()
    await this.saveMetadata(active)
    this.guard(generation)
    this.active = active; this.progress = undefined; this.sync = await this.statusFor(active); this.emit()
    return this.session(active)
  }
  async unlock(grantID: string, password: string, login: string): Promise<OfflineSession> {
    this.lock()
    return this.activate(await this.openVault(grantID, password, login, this.generation))
  }
  async unlockUser(login: string, password: string, expected?: { user_id: string; account_id: string }): Promise<{ accounts: Array<{ grant_id: string; account_name: string }>; session?: OfflineSession }> {
    this.lock()
    const generation = this.generation, profile = await getOrCreateProfile(this.storage)
    const tag = await sha256(`${profile.browser_id}\0${canonicalLogin(login)}`)
    const vaults = (await this.storage.all<VaultEnvelope>('vaults')).filter(vault => vault.lookup_tag === tag && vault.identity.browser_id === profile.browser_id && vault.identity.origin === this.origin && vault.state === 'available' && (!expected || vault.identity.user_id === expected.user_id && vault.identity.account_id === expected.account_id))
    if (vaults.length > 20) throw new BrowserOfflineError('too_many_accounts', 'Esta identidad supera el límite de cuentas preparadas.')
    const unlocked: ActiveVault[] = []
    let lastError: unknown
    for (const vault of vaults) {
      try { unlocked.push(await this.openVault(vault.identity.grant_id, password, login, generation)) }
      catch (error) { this.guard(generation); lastError = error }
    }
    this.guard(generation)
    if (!unlocked.length) throw lastError || new BrowserOfflineError('unlock_failed', 'Usuario o contraseña incorrectos, o no hay una copia autorizada preparada para este usuario.')
    const accounts = unlocked.map(item => ({ grant_id: item.envelope.identity.grant_id, account_name: item.metadata.actor.account_name }))
    if (unlocked.length === 1) return { accounts, session: await this.activate(unlocked[0]) }
    this.candidates = new Map(unlocked.map(item => [item.envelope.identity.grant_id, item]))
    return { accounts }
  }
  async selectAccount(grantID: string): Promise<OfflineSession> {
    this.checkIdle()
    const candidate = this.candidates.get(grantID)
    if (!candidate || candidate.generation !== this.generation) throw new BrowserOfflineError('locked', 'Vuelve a identificarte para elegir una cuenta.')
    return this.activate(candidate)
  }
  private async openVault(grantID: string, password: string, login: string, generation: number): Promise<ActiveVault> {
    const authEpoch = await this.storage.get<string>('profiles', 'auth_epoch') || ''
    const profile = await getOrCreateProfile(this.storage)
    const envelope = await this.storage.get<VaultEnvelope>('vaults', grantID)
    if (!envelope || envelope.state !== 'available' || envelope.identity.origin !== this.origin || envelope.identity.browser_id !== profile.browser_id) throw new BrowserOfflineError('not_prepared', 'Esta copia no está preparada en este navegador.')
    if (envelope.iterations !== PASSWORD_ITERATIONS) throw new BrowserOfflineError('invalid_kdf', 'La protección de esta copia no es válida.')
    const key = await unlockVaultKey(password, envelope.identity, envelope.salt, envelope.wrapped_key)
    const metadata = await decryptValue<VaultMetadata>(key, envelope.identity, 'metadata', 'active', envelope.encrypted_metadata)
    if (!login || canonicalLogin(login) !== canonicalLogin(metadata.actor.username)) throw new BrowserOfflineError('unlock_failed', 'El usuario o la contraseña no corresponden a esta copia.')
    const claims = await verifyLease(envelope.lease, envelope.signer_keys, envelope.identity)
    if (Date.now() < metadata.highest_time - 60000) throw new BrowserOfflineError('clock_rollback', 'Conecta con Clarín para comprobar la hora de esta copia.')
    if (metadata.actor.user_id !== envelope.identity.user_id || metadata.actor.account_id !== envelope.identity.account_id) throw new BrowserOfflineError('wrong_identity', 'La identidad de la copia no coincide.')
    metadata.grant.actions = claims.actions as typeof metadata.grant.actions
    metadata.grant.lease_expires_at = new Date(Number(claims.exp) * 1000).toISOString()
    metadata.highest_time = Math.max(Date.now(), metadata.highest_time)
    metadata.persistent = await this.currentPersistence()
    this.guard(generation)
    return { envelope, key, metadata, generation, activity_at: Date.now(), auth_epoch: authEpoch }
  }
  private async activate(active: ActiveVault): Promise<OfflineSession> {
    active.metadata.persistent = await this.currentPersistence()
    this.guard(active.generation); await this.saveMetadata(active); this.guard(active.generation)
    this.candidates.clear(); this.active = active; this.sync = await this.statusFor(active); this.emit()
    return this.session(active)
  }
  private async saveMetadata(active: ActiveVault, other: StoreMutation[] = []) {
    await this.checkEpoch(active)
    const envelope = { ...active.envelope, encrypted_metadata: await encryptValue(active.key, active.envelope.identity, 'metadata', 'active', active.metadata), updated_at: Date.now() }
    this.guard(active.generation)
    await this.storage.commit([...other, { store: 'vaults', key: active.envelope.identity.grant_id, value: envelope }], active.auth_epoch)
    this.guard(active.generation); active.envelope = envelope
  }
  private async encryptRecord(active: ActiveVault, kind: StoredRecord['kind'], id: string, value: unknown): Promise<StoredRecord> {
    const ciphertext = await encryptValue(active.key, active.envelope.identity, kind, id, value)
    return { id: recordID(active.envelope.identity.grant_id, kind, id), grant_id: active.envelope.identity.grant_id, kind, ciphertext, byte_size: new TextEncoder().encode(JSON.stringify(ciphertext)).length }
  }
  private async readRecord<T>(active: ActiveVault, kind: StoredRecord['kind'], id: string): Promise<T | undefined> {
    await this.checkEpoch(active)
    const record = await this.storage.get<StoredRecord>('records', recordID(active.envelope.identity.grant_id, kind, id))
    if (!record) return undefined
    const value = await decryptValue<T>(active.key, active.envelope.identity, kind, id, record.ciphertext)
    await this.checkEpoch(active); return value
  }
  private async records(active: ActiveVault, kind: StoredRecord['kind']) { await this.checkEpoch(active); const records = await this.storage.all<StoredRecord>('records', 'grant_kind', [active.envelope.identity.grant_id, kind]); await this.checkEpoch(active); return records }
  private async values<T>(active: ActiveVault, kind: StoredRecord['kind']): Promise<T[]> {
    const records = await this.records(active, kind), prefix = `${active.envelope.identity.grant_id}:${kind}:`
    const values: T[] = []
    for (const record of records) { values.push(await decryptValue<T>(active.key, active.envelope.identity, kind, record.id.slice(prefix.length), record.ciphertext)); this.guard(active.generation) }
    return values
  }
  private async statusFor(active: ActiveVault): Promise<SyncStatus> {
    return { state: 'idle', server_reachability: 'unknown', pending_count: (await this.records(active, 'operation')).length, conflict_count: (await this.records(active, 'conflict')).length, outcome_unknown_count: 0, last_success_at: active.metadata.last_sync_at, lease_expires_at: active.metadata.grant.lease_expires_at || '', selection_revision: active.metadata.grant.selection_revision }
  }
  private async applyResponse(original: ActiveVault, response: LeaseResponse) {
    // A rejected download, quota failure or aborted IDB transaction must not renew RAM authority.
    const active: ActiveVault = { ...original, envelope: { ...original.envelope }, metadata: structuredClone(original.metadata) }
    this.guard(active.generation)
    const identity = active.envelope.identity, grant = normalizeGrant(response.grant, this.origin)
    if (canonicalIdentity(grant) !== canonicalIdentity(identity)) throw new BrowserOfflineError('wrong_sync_identity', 'La sincronización devolvió otra cuenta o usuario y fue rechazada.')
    const claims = await verifyLease(response.lease, response.signer_public_keys.keys, identity)
    if (!Array.isArray(claims.actions) || claims.actions.some(action => typeof action !== 'string' || !['tasks.read', 'tasks.create', 'tasks.complete', 'contacts.read', 'programs.read', 'whiteboards.read'].includes(action))
        || claims.credential_epoch !== response.grant.credential_epoch || claims.authority_epoch !== response.grant.authority_epoch || claims.selection_revision !== response.grant.selection_revision) throw new BrowserOfflineError('invalid_lease_authority', 'La autorización firmada no coincide con los permisos recibidos.')
    const mutations: StoreMutation[] = [], replacements: StoredRecord[] = []
    if (grant.selection_revision !== active.metadata.grant.selection_revision) throw new BrowserOfflineError('selection_changed', 'La selección cambió. Conecta y prepara nuevamente esta copia.')
    active.envelope = { ...active.envelope, lease: response.lease, signer_keys: response.signer_public_keys.keys }
    active.metadata = { ...active.metadata, grant: { ...grant, actions: claims.actions as typeof grant.actions, lease_expires_at: new Date(Number(claims.exp) * 1000).toISOString() }, credential_epoch: response.grant.credential_epoch, authority_epoch: response.grant.authority_epoch, last_sync_at: response.server_time, highest_time: Math.max(active.metadata.highest_time, Date.parse(response.server_time), Date.now()), selections: active.metadata.selections.map(item => ({ ...item })) }
    for (const snapshot of response.snapshots || []) {
      const selection = active.metadata.selections.find(item => item.selection_id === snapshot.selection_id)
      if (snapshot.protocol_version !== 4 || snapshot.browser_profile_id !== identity.browser_id || snapshot.grant_id !== identity.grant_id || snapshot.user_id !== identity.user_id || snapshot.account_id !== identity.account_id || snapshot.selection_revision !== grant.selection_revision || !selection || selection.resource_id !== snapshot.resource_id || selection.module !== snapshot.module || selection.resource_type !== snapshot.resource_type) throw new BrowserOfflineError('wrong_snapshot', 'Se rechazó un recurso ajeno a la selección autorizada.')
      if (snapshot.tombstone) {
        mutations.push({ store: 'records', key: recordID(identity.grant_id, 'snapshot', snapshot.selection_id), remove: true })
        active.metadata.selections = active.metadata.selections.filter(item => item.selection_id !== snapshot.selection_id)
      } else {
        if (typeof snapshot.payload_json !== 'string' || new TextEncoder().encode(snapshot.payload_json).length > 8 * 1024 * 1024 || await sha256Hex(snapshot.payload_json) !== snapshot.content_hash) throw new BrowserOfflineError('snapshot_integrity', 'La descarga del recurso no superó la verificación de integridad.')
        const payload = JSON.parse(snapshot.payload_json) as Record<string, unknown>
        const entity = payload[{ tasks: 'list', contacts: 'contact', programs: 'program', whiteboards: 'whiteboard' }[snapshot.module] || ''] as { id?: string } | undefined
        if (!entity || entity.id !== snapshot.resource_id) throw new BrowserOfflineError('wrong_snapshot_entity', 'El contenido recibido no corresponde al recurso seleccionado.')
        if (snapshot.module === 'tasks' && (!Array.isArray(payload.tasks) || payload.tasks.length > 5000 || payload.tasks.some(task => task.list_id !== snapshot.resource_id))) throw new BrowserOfflineError('wrong_snapshot_tasks', 'La lista recibida contiene tareas fuera de su selección.')
        // Only the exact hashed bytes are authoritative; never reserialize Go JSON to calculate its hash.
        const record = await this.encryptRecord(active, 'snapshot', snapshot.selection_id, { ...snapshot, payload, payload_json: '' })
        replacements.push(record)
        Object.assign(selection, { readiness: 'available', head_version: snapshot.head_version, content_hash: snapshot.content_hash, byte_size: record.byte_size, last_synced_at: response.server_time })
      }
    }
    for (const receipt of response.receipts || []) {
      const operation = await this.readRecord<Operation>(active, 'operation', receipt.operation_id)
      if (!operation) continue
      const receivedTask = receipt.result?.task
      if ((receipt.resource_id && receipt.resource_id !== operation.resource_id) || (receivedTask?.id && receivedTask.id !== operation.resource_id) || (receivedTask?.account_id && receivedTask.account_id !== identity.account_id) || (receivedTask?.user_id && receivedTask.user_id !== identity.user_id)) throw new BrowserOfflineError('wrong_receipt', 'Se rechazó un recibo de otra tarea, cuenta o usuario.')
      if (receipt.status === 'pending' || receipt.status === 'retry') continue
      if (!['applied', 'accepted', 'confirmed', 'conflict', 'rejected', 'noop', 'duplicate'].includes(receipt.status)) throw new BrowserOfflineError('invalid_receipt', 'El servidor devolvió un recibo no reconocido.')
      mutations.push({ store: 'records', key: recordID(identity.grant_id, 'operation', operation.operation_id), remove: true })
      const rejected = receipt.status === 'conflict' || receipt.status === 'rejected'
      if (rejected) {
        replacements.push(await this.encryptRecord(active, 'conflict', receipt.operation_id, { operation_id: receipt.operation_id, selection_id: operation.selection_id, resource_id: operation.resource_id, status: receipt.status as 'conflict' | 'rejected', error_code: receipt.error_code, client_change: operation.payload as Partial<OfflineTask>, server_result: receipt.result, created_at: operation.occurred_at } satisfies OfflineConflict))
      }
      const task = receipt.result?.task
      if (task) replacements.push(await this.encryptRecord(active, 'task', operation.resource_id, { ...task, version: receipt.server_version || task.version, local_confirmation: rejected ? receipt.status : 'confirmed' }))
      else if (rejected) mutations.push({ store: 'records', key: recordID(identity.grant_id, 'task', operation.resource_id), remove: true })
      else {
        const local = await this.readRecord<OfflineTask>(active, 'task', operation.resource_id)
        if (local) replacements.push(await this.encryptRecord(active, 'task', operation.resource_id, { ...local, version: receipt.server_version || local.version, local_confirmation: 'confirmed' }))
      }
    }
    await enforceStorageBudget(this.storage, replacements, Math.min(MAX_BYTES, active.metadata.grant.quota_bytes))
    mutations.push(...replacements.map(record => ({ store: 'records' as const, key: record.id, value: record })))
    await this.saveMetadata(active, mutations)
    this.guard(active.generation)
    original.envelope = active.envelope; original.metadata = active.metadata
  }
  async triggerSync(): Promise<SyncStatus> {
    const active = this.requireActive(), profile = await getOrCreateProfile(this.storage)
    await this.revalidatePersistence(active)
    this.sync = { ...await this.statusFor(active), state: 'syncing', phase: 'upload', last_attempt_at: timestamp() }; this.emit()
    try {
      const operations = (await this.values<Operation>(active, 'operation')).sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.operation_id.localeCompare(b.operation_id))
      // Dependencies are stable and retain their original grant and actor on every retry.
      const ordered = orderOperations(operations)
      const batches = batchSyncOperations(profile.browser_id, active.envelope.identity.grant_id, active.metadata.grant.selection_revision, ordered)
      for (const batch of batches) {
        const response = await this.api.sync(profile, active.envelope.identity, active.metadata.grant_private_jwk, active.metadata.grant.selection_revision, batch, [], this.abort.signal)
        await this.applyResponse(active, response)
      }
      for (const selection of [...active.metadata.selections]) {
        const response = await this.api.sync(profile, active.envelope.identity, active.metadata.grant_private_jwk, active.metadata.grant.selection_revision, [], [selection.selection_id], this.abort.signal)
        await this.applyResponse(active, response)
      }
      this.guard(active.generation); this.sync = { ...await this.statusFor(active), server_reachability: 'reachable' }; this.emit(); return this.sync
    } catch (error) {
      this.guard(active.generation)
      const authenticatedDenial = error instanceof BrowserAPIError && !error.infrastructure && [401, 403, 404, 410].includes(error.status)
      // A failed proof/clock check does not revoke the server's signed offline
      // authorization. Only explicit authority outcomes may discard downloaded data.
      const authorityRevoked = error instanceof BrowserAPIError && !error.infrastructure
        && (error.status === 403 && error.code === 'offline_access_denied' || error.status === 404 && error.code === 'offline_grant_not_found')
      if (authorityRevoked) {
        active.envelope.state = 'revoked'
        try {
          const removable = [...await this.records(active, 'snapshot'), ...await this.records(active, 'task'), ...await this.records(active, 'conflict')]
          await this.saveMetadata(active, removable.map(record => ({ store: 'records', key: record.id, remove: true })))
        } finally { this.lock() }
        throw new BrowserOfflineError('access_blocked', 'Clarín bloqueó esta autorización. Los cambios pendientes permanecen cifrados y no se enviarán.')
      }
      const oversized = error instanceof BrowserOfflineError && ['operation_too_large', 'sync_request_too_large'].includes(error.code)
      this.sync = { ...await this.statusFor(active), state: authenticatedDenial || oversized ? 'blocked' : error instanceof BrowserAPIError && error.infrastructure ? 'waiting_network' : 'error', server_reachability: error instanceof BrowserAPIError && !error.infrastructure ? 'reachable' : 'unreachable', last_error: { code: error instanceof BrowserOfflineError ? error.code : 'sync_failed', message: error instanceof Error ? error.message : 'No se pudo sincronizar.', retryable: !oversized } }
      this.emit(); return this.sync
    }
  }
  private async snapshot(active: ActiveVault, selectionID: string): Promise<Snapshot> {
    const selection = active.metadata.selections.find(item => item.selection_id === selectionID)
    if (!selection || selection.readiness !== 'available') throw new BrowserOfflineError('resource_not_prepared', 'Este recurso no está preparado para trabajar offline.')
    const snapshot = await this.readRecord<Snapshot>(active, 'snapshot', selectionID)
    if (!snapshot) throw new BrowserOfflineError('copy_missing', 'Faltan datos de esta copia. Conecta para prepararla nuevamente.')
    return snapshot
  }
  private page<T>(active: ActiveVault, items: T[], cursor?: string): OfflinePage<T> {
    const offset = cursor ? Number(cursor) : 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new BrowserOfflineError('invalid_cursor', 'La página solicitada no es válida.')
    return { items: items.slice(offset, offset + 50), ...(offset + 50 < items.length ? { next_cursor: String(offset + 50) } : {}), snapshot: { selection_revision: active.metadata.grant.selection_revision, head_version: 0, last_synced_at: active.metadata.last_sync_at || '' } }
  }
  private async readModule<T>(module: OfflineModule, property: string, cursor?: string): Promise<OfflinePage<T>> {
    const active = this.requireActive(), items: T[] = []
    for (const selection of active.metadata.selections.filter(item => item.module === module)) {
      const snapshot = await this.snapshot(active, selection.selection_id)
      const item = snapshot.payload[property] as Record<string, unknown>
      if (!item) continue
      if (module === 'programs') items.push({ ...item, sessions: snapshot.payload.sessions, active_roster: snapshot.payload.active_roster, historical_participations: snapshot.payload.historical_participations, eligible_attendance: snapshot.payload.eligible_attendance, out_of_window_history: snapshot.payload.out_of_window_history } as T)
      else if (module === 'whiteboards') items.push({ ...item, assets: snapshot.payload.referenced_assets } as T)
      else items.push({ ...item, ...snapshot.payload, [property]: undefined } as T)
    }
    return this.page(active, items, cursor)
  }
  async taskLists(cursor?: string): Promise<OfflinePage<OfflineTaskList>> {
    const active = this.requireActive(), items: OfflineTaskList[] = []
    for (const selection of active.metadata.selections.filter(item => item.module === 'tasks')) {
      const snapshot = await this.snapshot(active, selection.selection_id)
      items.push({ ...snapshot.payload.list as OfflineTaskList, statuses: snapshot.payload.statuses as OfflineTaskList['statuses'], selection_id: selection.selection_id })
    }
    return this.page(active, items, cursor)
  }
  private async allTasks(active: ActiveVault, selectionID: string): Promise<OfflineTask[]> {
    const snapshot = await this.snapshot(active, selectionID)
    const canonical = snapshot.payload.tasks as OfflineTask[] || [], list = snapshot.payload.list as OfflineTaskList
    const overlays = await this.values<OfflineTask>(active, 'task')
    const map = new Map(canonical.map(task => [task.id, task]))
    for (const task of overlays.filter(item => item.list_id === list.id)) {
      const remote = map.get(task.id)
      if (task.local_confirmation === 'pending' || !remote || task.version > remote.version) map.set(task.id, task)
    }
    return [...map.values()]
  }
  async tasks(selectionID: string, cursor?: string) { const active = this.requireActive(); return this.page(active, await this.allTasks(active, selectionID), cursor) }
  private async queue(active: ActiveVault, operation: Operation, task: OfflineTask): Promise<QueuedTaskResult> {
    const existing = await this.readRecord<Operation>(active, 'operation', operation.operation_id)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(operation)) throw new BrowserOfflineError('operation_id_reused', 'El identificador ya pertenece a otra operación.')
      return { operation_id: operation.operation_id, state: 'noop', local_task: task, pending_count: (await this.records(active, 'operation')).length, sync: await this.statusFor(active) }
    }
    if (!await this.revalidatePersistence(active)) throw new BrowserOfflineError('persistent_storage_required', 'La copia permite consultar. El navegador no concedió almacenamiento persistente para guardar cambios offline.')
    if ((await this.records(active, 'operation')).length >= 1000) throw new BrowserOfflineError('outbox_full', 'Hay 1.000 cambios pendientes. Sincronízalos antes de guardar más cambios offline.')
    const records = await Promise.all([this.encryptRecord(active, 'operation', operation.operation_id, operation), this.encryptRecord(active, 'task', task.id, task)])
    await enforceStorageBudget(this.storage, records, active.metadata.grant.quota_bytes)
    const estimate = await this.storageManager?.estimate()
    if (estimate?.quota && estimate.quota - (estimate.usage || 0) < records.reduce((total, item) => total + item.byte_size, 0) + 1024 * 1024) throw new BrowserOfflineError('storage_quota', 'No queda espacio suficiente para guardar el cambio con seguridad.')
    active.metadata.highest_time = Math.max(active.metadata.highest_time, Date.now())
    await this.saveMetadata(active, records.map(record => ({ store: 'records', key: record.id, value: record })))
    this.sync = await this.statusFor(active); this.emit()
    return { operation_id: operation.operation_id, state: 'queued', local_task: task, pending_count: this.sync.pending_count, sync: this.sync }
  }
  private operation(active: ActiveVault, action: Operation['action'], id: string, selectionID: string, resourceID: string, occurred: string, payload: unknown, baseVersion = 0): Operation {
    const identity = active.envelope.identity
    if (!active.metadata.grant.actions.includes(action)) throw new BrowserOfflineError('action_denied', 'Esta autorización no permite esa operación.')
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(resourceID) || !Number.isFinite(Date.parse(occurred))) throw new BrowserOfflineError('invalid_operation', 'El cambio no tiene un identificador o fecha válidos.')
    return { protocol_version: 4, browser_id: identity.browser_id, grant_id: identity.grant_id, user_id: identity.user_id, account_id: identity.account_id, operation_id: id, action, selection_id: selectionID, resource_id: resourceID, selection_revision: active.metadata.grant.selection_revision, credential_epoch: active.metadata.credential_epoch, authority_epoch: active.metadata.authority_epoch, base_version: baseVersion, payload, occurred_at: occurred }
  }
  async createTask(input: TaskCreateInput): Promise<QueuedTaskResult> {
    const active = this.requireActive(), snapshot = await this.snapshot(active, input.selection_id), list = snapshot.payload.list as OfflineTaskList
    if (!list?.can_create || !input.patch.title.trim() || input.patch.title.length > 500) throw new BrowserOfflineError('task_invalid', 'No puedes crear esta tarea en la lista seleccionada.')
    const task: OfflineTask = { id: input.task_id, version: 0, ...input.patch, start_at: input.patch.start_at || undefined, due_at: input.patch.due_at || undefined, due_end_at: input.patch.due_end_at || undefined, title: input.patch.title.trim(), list_id: list.id, list_name: list.name, status_category: 'not_started', can_complete: active.metadata.grant.actions.includes('tasks.complete'), created_at: input.client_occurred_at, local_confirmation: 'pending' }
    const operation = this.operation(active, 'tasks.create', input.operation_id, input.selection_id, input.task_id, input.client_occurred_at, { ...input.patch, title: task.title })
    return this.queue(active, operation, task)
  }
  async completeTask(taskID: string, input: TaskCompleteInput): Promise<QueuedTaskResult> {
    const active = this.requireActive(), task = (await this.allTasks(active, input.selection_id)).find(item => item.id === taskID)
    if (!task || !task.can_complete || task.status_category === 'cancelled') throw new BrowserOfflineError('task_denied', 'No puedes completar esta tarea.')
    if (task.status_category === 'done') return { operation_id: input.operation_id, state: 'noop', local_task: task, pending_count: (await this.records(active, 'operation')).length, sync: await this.statusFor(active) }
    if (task.version !== input.base_version) throw new BrowserOfflineError('task_version_changed', 'La tarea cambió. Revisa su estado antes de completarla.')
    const operation = this.operation(active, 'tasks.complete', input.operation_id, input.selection_id, taskID, input.client_occurred_at, {}, input.base_version)
    if (task.version === 0) {
      const created = (await this.values<Operation>(active, 'operation')).find(item => item.action === 'tasks.create' && item.resource_id === taskID)
      if (!created) throw new BrowserOfflineError('missing_dependency', 'No se encontró la creación pendiente de esta tarea.')
      operation.depends_on_operation_id = created.operation_id
    }
    return this.queue(active, operation, { ...task, status_category: 'done', completed_at: input.client_occurred_at, local_confirmation: 'pending' })
  }
  gateway(): OfflineDataGateway {
    return {
      resources: async (module, cursor) => { const active = this.requireActive(), page = this.page(active, active.metadata.selections.filter(item => item.module === module), cursor); return { items: page.items, next_cursor: page.next_cursor, selection_revision: page.snapshot.selection_revision } },
      taskLists: cursor => this.taskLists(cursor), tasks: (selection, cursor) => this.tasks(selection, cursor),
      contacts: cursor => this.readModule<OfflineContact>('contacts', 'contact', cursor),
      contact: async id => { const page = await this.readModule<OfflineContact>('contacts', 'contact'); const item = page.items.find(row => row.id === id); if (!item) throw new BrowserOfflineError('not_found', 'Este contacto no está preparado.'); return { item, snapshot: page.snapshot } },
      programs: cursor => this.readModule<OfflineProgram>('programs', 'program', cursor),
      program: async id => { const page = await this.readModule<OfflineProgram>('programs', 'program'); const item = page.items.find(row => row.id === id); if (!item) throw new BrowserOfflineError('not_found', 'Este programa no está preparado.'); return { item, snapshot: page.snapshot } },
      whiteboards: cursor => this.readModule<OfflineWhiteboard>('whiteboards', 'whiteboard', cursor),
      whiteboardScene: async id => { const page = await this.readModule<OfflineWhiteboard>('whiteboards', 'whiteboard'); const item = page.items.find(row => row.id === id); if (!item) throw new BrowserOfflineError('not_found', 'Esta pizarra no está preparada.'); return { item, snapshot: page.snapshot } },
      conflicts: async cursor => { const active = this.requireActive(), page = this.page(active, await this.values<OfflineConflict>(active, 'conflict'), cursor); return { items: page.items, next_cursor: page.next_cursor } },
      createTask: input => this.createTask(input), completeTask: (id, input) => this.completeTask(id, input),
      syncStatus: async () => { const active = this.requireActive(); await this.revalidatePersistence(active); const fresh = await this.statusFor(active); return this.sync ? { ...this.sync, pending_count: fresh.pending_count, conflict_count: fresh.conflict_count, lease_expires_at: fresh.lease_expires_at, selection_revision: fresh.selection_revision } : fresh },
      triggerSync: () => this.triggerSync(),
    }
  }
}

export function orderOperations(operations: Operation[]): Operation[] {
  const pending = new Map(operations.map(operation => [operation.operation_id, operation])), ordered: Operation[] = [], visiting = new Set<string>()
  function visit(operation: Operation) {
    if (!pending.has(operation.operation_id)) return
    if (visiting.has(operation.operation_id)) throw new BrowserOfflineError('operation_cycle', 'La cola de cambios contiene una dependencia no válida.')
    visiting.add(operation.operation_id)
    const parent = operation.depends_on_operation_id && pending.get(operation.depends_on_operation_id)
    if (parent) {
      if (parent.grant_id !== operation.grant_id || parent.user_id !== operation.user_id || parent.account_id !== operation.account_id || parent.resource_id !== operation.resource_id || parent.action !== 'tasks.create') throw new BrowserOfflineError('wrong_dependency', 'La dependencia del cambio pertenece a otra identidad o recurso.')
      visit(parent)
    }
    visiting.delete(operation.operation_id); pending.delete(operation.operation_id); ordered.push(operation)
  }
  for (const operation of operations) visit(operation)
  return ordered
}
