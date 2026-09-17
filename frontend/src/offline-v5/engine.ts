import type { JWK } from 'jose'
import { createSigningKey } from '../offline-v4/crypto'
import { BrowserStorage as BrowserOfflineV4Storage, getOrCreateProfile } from '../offline-v4/storage'
import type { BrowserProfile } from '../offline-v4/types'
import { BrowserOPFSBlobStore, type OfflineV5OpaqueBlobStore } from './blobStore'
import {
  PASSWORD_ITERATIONS,
  base64url,
  blindIndex,
  createBlindIndexKey,
  createOfflineV5VaultKey,
  decryptOfflineV5EnvelopeValue,
  decryptOfflineV5Bytes,
  decryptOfflineV5Value,
  encryptOfflineV5EnvelopeValue,
  encryptOfflineV5Bytes,
  encryptOfflineV5Value,
  offlineV5UsernameLookupTag,
  sha256HexBytes,
  unlockBlindIndexKey,
  unlockOfflineV5VaultKey,
  validateOfflineV5Actions,
  verifyOfflineV5Lease,
  verifyOfflineV5LeaseAvailability,
} from './crypto'
import { canonicalOfflineLogin, canonicalOfflineV5Identity, sameOfflineV5Identity } from './identity'
import { offlineV5WhiteboardAssetDescriptors, validateOfflineV5Bundle } from './manifest'
import { OfflineV5SessionRegistry, type OfflineV5ActiveSession } from './session'
import { BrowserOfflineV5Storage, hasOfflineV5Database, storedCipherBytes, type OfflineV5Storage, type OfflineV5StoreMutation } from './storage'
import {
  OFFLINE_V5_ACTIONS,
  OFFLINE_V5_BLOB_CHUNK_BYTES,
  OFFLINE_V5_MAX_OUTBOX,
  OFFLINE_V5_MAX_PAGE,
  OfflineV5Error,
  type OfflineV5CanonicalEntity,
  type OfflineV5Conflict,
  type OfflineV5Identity,
  type OfflineV5LocalGrantSummary,
  type OfflineV5Manifest,
  type OfflineV5MutationInput,
  type OfflineV5MutationResult,
  type OfflineV5Operation,
  type OfflineV5PrepareBundle,
  type OfflineV5PreparedAsset,
  type OfflineV5Receipt,
  type OfflineV5Root,
  type OfflineV5SessionSnapshot,
  type OfflineV5Snapshot,
  type OfflineV5StoredCipher,
  type OfflineV5StoredBlob,
  type OfflineV5VaultEnvelope,
  type OfflineV5VaultMetadata,
} from './types'

interface Candidate {
  session: Omit<OfflineV5ActiveSession, 'generation' | 'activityAt' | 'sequence' | 'syncState'>
  openedAt: number
}

interface StoredManifestRecord {
  identity: string
  manifest: OfflineV5Manifest
}

interface StoredSnapshotRecord {
  kind: 'snapshot'
  identity: string
  snapshot: OfflineV5Snapshot
}

interface StoredEntityRecord<T = unknown> {
  kind: 'overlay'
  identity: string
  entity: OfflineV5CanonicalEntity<T>
  local_confirmation: 'pending' | 'confirmed' | 'conflict'
}

interface StoredOperationRecord {
  identity: string
  operation: OfflineV5Operation
  optimistic_entity: OfflineV5CanonicalEntity
}

interface StoredConflictRecord {
  identity: string
  conflict: OfflineV5Conflict
}

export interface OfflineV5ProfileProvider {
  get(): Promise<BrowserProfile>
}

class ReusedV4ProfileProvider implements OfflineV5ProfileProvider {
  private readonly storage = new BrowserOfflineV4Storage()
  get() { return getOrCreateProfile(this.storage) }
}

const encoder = new TextEncoder()

export const OFFLINE_V5_CLOCK_ROLLBACK_TOLERANCE_MS = 60_000
export const OFFLINE_V5_HIGH_WATER_INTERVAL_MS = 60_000

/**
 * A small backwards tolerance absorbs ordinary clock corrections. Anything
 * older than the encrypted high-water mark is treated as clock rollback and
 * requires an online revalidation.
 */
export function offlineV5ClockWithinHighWater(highestTime: number, observedAt: number): boolean {
  return Number.isSafeInteger(highestTime) && highestTime >= 0
    && Number.isSafeInteger(observedAt) && observedAt >= 0
    && observedAt >= highestTime - OFFLINE_V5_CLOCK_ROLLBACK_TOLERANCE_MS
}

export class OfflineV5Engine {
  readonly sessions: OfflineV5SessionRegistry
  private readonly candidates = new Map<string, Map<string, Candidate>>()
  private readonly profileProvider: OfflineV5ProfileProvider
  private readonly blobStore: OfflineV5OpaqueBlobStore
  private readonly highWaterWrites = new Map<string, Promise<void>>()
  private readonly highWaterScheduledAt = new Map<string, number>()
  private readonly now: () => number

  constructor(
    readonly origin: string,
    readonly storage: OfflineV5Storage = new BrowserOfflineV5Storage(),
    profileProvider?: OfflineV5ProfileProvider,
    now: () => number = Date.now,
    blobStore: OfflineV5OpaqueBlobStore = new BrowserOPFSBlobStore(),
  ) {
    this.profileProvider = profileProvider || new ReusedV4ProfileProvider()
    this.blobStore = blobStore
    this.now = now
    this.sessions = new OfflineV5SessionRegistry(now)
  }

  async profile(): Promise<{ browser_profile_id: string; public_jwk: JWK; request_ids: string[] }> {
    let profile = await this.storage.get<BrowserProfile>('profiles', 'active')
    if (!profile) {
      profile = await this.profileProvider.get()
      try { await this.storage.commit([{ store: 'profiles', key: 'active', value: profile, add: true }]) }
      catch (error) {
        const winner = await this.storage.get<BrowserProfile>('profiles', 'active')
        if (!winner) throw error
        profile = winner
      }
    }
    await this.ensureEpoch(profile.browser_id)
    const requestIDs = await this.storage.get<string[]>('profiles', 'request_ids') || []
    return { browser_profile_id: profile.browser_id, public_jwk: profile.public_jwk, request_ids: requestIDs.filter(value => typeof value === 'string').slice(0, 30) }
  }

  async rememberEnrollmentRequest(requestID: string): Promise<void> {
    if (!requestID) return
    const prior = await this.storage.get<string[]>('profiles', 'request_ids') || []
    await this.storage.commit([{ store: 'profiles', key: 'request_ids', value: [requestID, ...prior.filter(value => value !== requestID)].slice(0, 30) }])
  }

  async browserProfile(): Promise<BrowserProfile> {
    await this.profile()
    const profile = await this.storage.get<BrowserProfile>('profiles', 'active')
    if (!profile) throw new OfflineV5Error('profile_missing', 'No se pudo abrir la identidad de este navegador.')
    return profile
  }

  async listLocalGrants(): Promise<OfflineV5LocalGrantSummary[]> {
    const profile = await this.browserProfile()
    const envelopes = await this.storage.scan<OfflineV5VaultEnvelope>('vaults', { limit: 1000 })
    return envelopes
      .filter(envelope => envelope.identity.origin === this.origin && envelope.identity.browser_profile_id === profile.browser_id)
      .map((envelope, index) => ({ grantId: envelope.identity.grant_id, state: envelope.state, label: `Copia offline ${index + 1}` }))
  }

  /**
   * The login screen may reveal that an offline entry path exists, but must
   * not reveal account or user metadata. Only a cryptographically valid,
   * prepared copy for this exact browser profile makes that entry path
   * available.
   */
  async hasAnyPreparedCopy(): Promise<boolean> {
    if (!await hasOfflineV5Database()) return false
    try {
      const profile = await this.browserProfile()
      const envelopes = await this.storage.scan<OfflineV5VaultEnvelope>('vaults', { limit: 1000 })
      for (const envelope of envelopes) {
        if (envelope.state !== 'available' || envelope.identity.origin !== this.origin || envelope.identity.browser_profile_id !== profile.browser_id) continue
        try {
          await verifyOfflineV5LeaseAvailability(envelope.lease, envelope.signer_keys, envelope.identity)
          return true
        } catch { /* Expired, altered and revoked local envelopes are never offered. */ }
      }
      return false
    } catch { return false }
  }

  /**
   * Fail closed for the login screen: an outage must not reveal an offline
   * entry point merely because some other user prepared a copy in this shared
   * browser profile. The keyed lookup tag is opaque on disk and lets the
   * worker match only the login the person explicitly typed.
   */
  async hasPreparedCopyForUsername(username: string): Promise<boolean> {
    if (!username.trim() || !await hasOfflineV5Database()) return false
    try {
      const profile = await this.browserProfile()
      const lookupTag = await this.usernameLookupTag(profile.browser_id, username)
      const envelopes = selectPreparedOfflineV5VaultsForUsername(
        await this.storage.scan<OfflineV5VaultEnvelope>('vaults', { limit: 1000 }),
        lookupTag,
        this.origin,
        profile.browser_id,
      )
      for (const envelope of envelopes) {
        try {
          await verifyOfflineV5LeaseAvailability(envelope.lease, envelope.signer_keys, envelope.identity)
          return true
        } catch { /* Expired, altered and revoked local envelopes are never offered. */ }
      }
      return false
    } catch { return false }
  }

  /** Purge one exact grant only when it belongs to this origin and browser profile. */
  async purgeLocalGrant(grantID: string): Promise<{ removed: string[] }> {
    if (!grantID) throw new OfflineV5Error('invalid_grant_reconciliation', 'No se pudo validar la limpieza de la copia offline.')
    const profile = await this.browserProfile()
    const envelope = await this.storage.get<OfflineV5VaultEnvelope>('vaults', grantID)
    if (!envelope || envelope.identity.origin !== this.origin || envelope.identity.browser_profile_id !== profile.browser_id) return { removed: [] }
    return this.purgeLocalGrantEnvelopes([envelope])
  }

  async reconcileLocalGrantStatus(activeGrantIDs: readonly string[]): Promise<{ removed: string[] }> {
    if (activeGrantIDs.length > 1000 || activeGrantIDs.some(value => typeof value !== 'string' || !value)) {
      throw new OfflineV5Error('invalid_grant_reconciliation', 'No se pudo validar el estado de las copias offline.')
    }
    const profile = await this.browserProfile()
    const active = new Set(activeGrantIDs)
    const envelopes = await this.storage.scan<OfflineV5VaultEnvelope>('vaults', { limit: 1000 })
    return this.purgeLocalGrantEnvelopes(envelopes.filter(envelope =>
      envelope.identity.origin === this.origin
      && envelope.identity.browser_profile_id === profile.browser_id
      && !active.has(envelope.identity.grant_id)))
  }

  /**
   * Remove only copies belonging to the authenticated user that the server no
   * longer authorizes for this browser profile. Other users may legitimately
   * share the same browser profile, so their vaults must remain untouched.
   */
  async reconcileLocalGrants(userID: string, authorizedGrantIDs: readonly string[]): Promise<{ removed: string[] }> {
    if (!userID || authorizedGrantIDs.length > 200 || authorizedGrantIDs.some(value => typeof value !== 'string' || !value)) {
      throw new OfflineV5Error('invalid_grant_reconciliation', 'No se pudo validar la limpieza de las copias offline anteriores.')
    }
    const profile = await this.browserProfile()
    const authorized = new Set(authorizedGrantIDs)
    const envelopes = await this.storage.scan<OfflineV5VaultEnvelope>('vaults', { limit: 1000 })
    const targets = envelopes.filter(envelope =>
      envelope.identity.origin === this.origin
      && envelope.identity.browser_profile_id === profile.browser_id
      && envelope.identity.user_id === userID
      && !authorized.has(envelope.identity.grant_id))
    return this.purgeLocalGrantEnvelopes(targets)
  }

  private async purgeLocalGrantEnvelopes(targets: readonly OfflineV5VaultEnvelope[]): Promise<{ removed: string[] }> {
    if (!targets.length) return { removed: [] }
    const grantIDs = new Set(targets.map(envelope => envelope.identity.grant_id))
    this.sessions.closeGrants(grantIDs)
    for (const [portID, candidates] of this.candidates) {
      for (const grantID of grantIDs) candidates.delete(grantID)
      if (!candidates.size) this.candidates.delete(portID)
    }

    // Make every target unusable before removing its data. If cleanup is
    // interrupted, the next verified online refresh retries the same purge.
    await this.storage.commit(targets.map(envelope => ({
      store: 'vaults' as const,
      key: envelope.identity.grant_id,
      value: { ...envelope, state: 'revoked' as const, updated_at: this.now() },
    })))

    for (const envelope of targets) {
      const blobDirectories = new Set<string>()
      for (const store of ['manifests', 'entities', 'operations', 'conflicts', 'blobs'] as const) {
        for (;;) {
          const records = await this.records(envelope.namespace, store)
          if (!records.length) break
          if (store === 'blobs') {
            for (const record of records) {
              const directory = (record as OfflineV5StoredBlob).opfs_directory
              if (typeof directory === 'string') blobDirectories.add(directory)
            }
          }
          await this.storage.commit(records.map(record => ({ store, key: record.storage_key, remove: true })))
        }
      }
      await this.storage.commit([{ store: 'vaults', key: envelope.identity.grant_id, remove: true }])
      for (const directory of blobDirectories) await this.blobStore.remove(directory).catch(() => undefined)
    }
    return { removed: [...grantIDs] }
  }

  async hasPreparedCopy(userID: string, accountID: string): Promise<boolean> {
    if (!userID || !accountID || !await hasOfflineV5Database()) return false
    try {
      const profile = await this.browserProfile()
      const envelopes = await this.storage.scan<OfflineV5VaultEnvelope>('vaults', { limit: 1000 })
      for (const envelope of envelopes) {
        if (envelope.state !== 'available' || envelope.identity.origin !== this.origin || envelope.identity.browser_profile_id !== profile.browser_id || envelope.identity.user_id !== userID || envelope.identity.account_id !== accountID) continue
        try { await verifyOfflineV5LeaseAvailability(envelope.lease, envelope.signer_keys, envelope.identity); return true } catch { /* Expired and altered copies are not offered. */ }
      }
      return false
    } catch { return false }
  }

  /** Worker-only recovery of the existing grant signer for safe re-prepare. */
  async localGrantSigningKey(grantID: string, username: string, password: string): Promise<JWK | undefined> {
    const envelope = await this.storage.get<OfflineV5VaultEnvelope>('vaults', grantID)
    if (!envelope) return undefined
    if (envelope.format !== 5 || envelope.iterations !== PASSWORD_ITERATIONS) throw new OfflineV5Error('invalid_vault', 'La copia offline tiene un formato no compatible.')
    const profile = await this.browserProfile()
    if (envelope.identity.origin !== this.origin || envelope.identity.browser_profile_id !== profile.browser_id) throw new OfflineV5Error('wrong_browser', 'La copia pertenece a otro navegador.')
    const content = await unlockOfflineV5VaultKey(password, envelope.identity, envelope.salt, envelope.wrapped_key)
    const metadata = await decryptOfflineV5EnvelopeValue<OfflineV5VaultMetadata>(content, envelope.identity, 'metadata', 'active', envelope.encrypted_metadata)
    if (canonicalOfflineLogin(username) !== canonicalOfflineLogin(metadata.actor.username) || metadata.actor.user_id !== envelope.identity.user_id || metadata.actor.account_id !== envelope.identity.account_id) {
      throw new OfflineV5Error('unlock_failed', 'El usuario o la contraseña no corresponden a esta copia.')
    }
    validatePrivateSigningKey(metadata.grant_private_jwk)
    return metadata.grant_private_jwk
  }

  async stagePreparation(grant: { grant_id: string; browser_profile_id: string; user_id: string; account_id: string; username: string; account_name: string; selection_revision: number }, password: string, persistent: boolean): Promise<{ privateJWK: JWK; created: boolean }> {
    const existingKey = await this.localGrantSigningKey(grant.grant_id, grant.username, password)
    if (existingKey) return { privateJWK: existingKey, created: false }
    const profile = await this.browserProfile()
    if (grant.browser_profile_id !== profile.browser_id || !grant.grant_id || !grant.user_id || !grant.account_id) {
      throw new OfflineV5Error('wrong_grant_identity', 'La autorización no corresponde a este perfil del navegador.')
    }
    const identity: OfflineV5Identity = {
      origin: this.origin,
      browser_profile_id: profile.browser_id,
      grant_id: grant.grant_id,
      user_id: grant.user_id,
      account_id: grant.account_id,
    }
    const signing = await createSigningKey()
    validatePrivateSigningKey(signing.private_jwk)
    const vault = await createOfflineV5VaultKey(password, identity)
    const blind = await createBlindIndexKey(vault.key, identity)
    const lookupTag = await this.usernameLookupTag(profile.browser_id, grant.username)
    const metadata: OfflineV5VaultMetadata = {
      actor: { user_id: grant.user_id, username: grant.username, display_name: grant.username, account_id: grant.account_id, account_name: grant.account_name },
      manifest_id: '', manifest_revision: 0, manifest_digest: '', selection_revision: grant.selection_revision,
      credential_epoch: 0, authority_epoch: 0, grant_revision: 0,
      grant_private_jwk: signing.private_jwk, persistent, highest_time: this.now(),
    }
    const envelope: OfflineV5VaultEnvelope = {
      format: 5,
      identity,
      namespace: base64url(crypto.getRandomValues(new Uint8Array(24))),
      lookup_tag: lookupTag,
      salt: vault.salt,
      iterations: PASSWORD_ITERATIONS,
      wrapped_key: vault.wrapped_key,
      wrapped_index_key: blind.wrapped,
      encrypted_metadata: await encryptOfflineV5EnvelopeValue(vault.key, identity, 'metadata', 'active', metadata),
      lease: '', signer_keys: [], state: 'preparing', updated_at: this.now(),
    }
    try {
      await this.storage.commit([{ store: 'vaults', key: grant.grant_id, value: envelope, add: true }])
      return { privateJWK: signing.private_jwk, created: true }
    } catch (error) {
      // Another tab may have staged the same grant while this PBKDF2 operation
      // was running. Reopen the winner instead of replacing its signer.
      const winner = await this.localGrantSigningKey(grant.grant_id, grant.username, password)
      if (winner) return { privateJWK: winner, created: false }
      throw error
    }
  }

  async discardPreparingGrant(grantID: string): Promise<void> {
    const envelope = await this.storage.get<OfflineV5VaultEnvelope>('vaults', grantID)
    if (!envelope || envelope.state !== 'preparing') return
    if ((await this.records(envelope.namespace, 'manifests')).length || (await this.records(envelope.namespace, 'operations')).length) return
    await this.storage.commit([{ store: 'vaults', key: grantID, remove: true }])
  }

  async assertCanPrepareGrant(grantID: string): Promise<void> {
    const envelope = await this.storage.get<OfflineV5VaultEnvelope>('vaults', grantID)
    if (!envelope) return
    if ((await this.records(envelope.namespace, 'operations')).length) {
      throw new OfflineV5Error('pending_changes', 'Sincroniza los cambios pendientes antes de actualizar esta copia offline.')
    }
  }

  async installPreparedBundle(input: {
    portID: string
    password: string
    bundle: OfflineV5PrepareBundle
    grantPrivateJWK: JWK
    persistent: boolean
    assets?: OfflineV5PreparedAsset[]
  }): Promise<OfflineV5SessionSnapshot> {
    const profile = await this.browserProfile()
    const identity = await validateOfflineV5Bundle(this.origin, input.bundle, { browser_profile_id: profile.browser_id })
    validatePrivateSigningKey(input.grantPrivateJWK)
    const lookupTag = await this.usernameLookupTag(profile.browser_id, input.bundle.manifest.username)
    const authEpoch = await this.ensureEpoch(profile.browser_id)
    const existing = await this.storage.get<OfflineV5VaultEnvelope>('vaults', identity.grant_id)
    let contentKey: CryptoKey, indexKey: CryptoKey, envelope: OfflineV5VaultEnvelope, metadata: OfflineV5VaultMetadata
    if (existing) {
      if (!sameOfflineV5Identity(existing.identity, identity)) throw new OfflineV5Error('grant_collision', 'La autorización local pertenece a otra identidad.')
      contentKey = await unlockOfflineV5VaultKey(input.password, identity, existing.salt, existing.wrapped_key)
      indexKey = await unlockBlindIndexKey(contentKey, identity, existing.wrapped_index_key)
      const previous = await decryptOfflineV5EnvelopeValue<OfflineV5VaultMetadata>(contentKey, identity, 'metadata', 'active', existing.encrypted_metadata)
      // Every retained operation record is pending until a receipt removes it;
      // do not trust the unauthenticated IndexedDB index metadata to hide one.
      const pending = await this.records(existing.namespace, 'operations')
      if (pending.length) throw new OfflineV5Error('pending_changes', 'Sincroniza los cambios pendientes antes de reemplazar la selección offline.')
      metadata = { ...previous, grant_private_jwk: input.grantPrivateJWK }
      envelope = { ...existing, lookup_tag: lookupTag, state: 'preparing' }
    } else {
      const vault = await createOfflineV5VaultKey(input.password, identity)
      const blind = await createBlindIndexKey(vault.key, identity)
      contentKey = vault.key
      indexKey = blind.indexKey
      envelope = {
        format: 5,
        identity,
        namespace: base64url(crypto.getRandomValues(new Uint8Array(24))),
        // HMAC under a non-exportable per-profile CryptoKey. Local disk access
        // cannot enumerate likely usernames, while unlock derives PBKDF2 only
        // for this user's account copies.
        lookup_tag: lookupTag,
        salt: vault.salt,
        iterations: PASSWORD_ITERATIONS,
        wrapped_key: vault.wrapped_key,
        wrapped_index_key: blind.wrapped,
        encrypted_metadata: { version: 1, iv: '', ciphertext: '' },
        lease: '', signer_keys: [], state: 'preparing', updated_at: Date.now(),
      }
      metadata = {
        actor: {
          user_id: identity.user_id,
          username: input.bundle.manifest.username,
          display_name: input.bundle.manifest.username,
          account_id: identity.account_id,
          account_name: input.bundle.manifest.account_name,
        },
        manifest_id: input.bundle.manifest.id,
        manifest_revision: input.bundle.manifest.revision,
        manifest_digest: input.bundle.manifest.digest,
        selection_revision: input.bundle.manifest.selection_revision,
        credential_epoch: input.bundle.manifest.credential_epoch,
        authority_epoch: input.bundle.manifest.authority_epoch,
        grant_revision: input.bundle.manifest.grant_revision,
        grant_private_jwk: input.grantPrivateJWK,
        persistent: input.persistent,
        highest_time: Math.max(Date.now(), Date.parse(input.bundle.server_time)),
        last_sync_at: input.bundle.server_time,
      }
    }
    metadata = {
      ...metadata,
      actor: { ...metadata.actor, user_id: identity.user_id, account_id: identity.account_id, username: input.bundle.manifest.username, account_name: input.bundle.manifest.account_name },
      manifest_id: input.bundle.manifest.id,
      manifest_revision: input.bundle.manifest.revision,
      manifest_digest: input.bundle.manifest.digest,
      selection_revision: input.bundle.manifest.selection_revision,
      credential_epoch: input.bundle.manifest.credential_epoch,
      authority_epoch: input.bundle.manifest.authority_epoch,
      grant_revision: input.bundle.manifest.grant_revision,
      persistent: input.persistent,
      highest_time: Math.max(metadata.highest_time, Date.now(), Date.parse(input.bundle.server_time)),
      last_sync_at: input.bundle.server_time,
    }
    envelope = {
      ...envelope,
      encrypted_metadata: await encryptOfflineV5EnvelopeValue(contentKey, identity, 'metadata', 'active', metadata),
      lease: input.bundle.lease,
      signer_keys: input.bundle.signer_public_keys.keys,
      state: 'available',
      updated_at: Date.now(),
    }

    const replacement: OfflineV5StoreMutation[] = []
    const replacedBlobDirectories: string[] = []
    const stagedBlobDirectories: string[] = []
    if (existing) {
      for (const store of ['manifests', 'entities', 'conflicts', 'blobs'] as const) {
        for (const record of await this.records(existing.namespace, store)) {
          replacement.push({ store, key: record.storage_key, remove: true })
          if (store === 'blobs' && typeof (record as OfflineV5StoredBlob).opfs_directory === 'string') replacedBlobDirectories.push((record as OfflineV5StoredBlob).opfs_directory)
        }
      }
    }
    replacement.push({ store: 'vaults', key: identity.grant_id, value: envelope })
    replacement.push(await this.encryptManifestRecord(identity, envelope.namespace, contentKey, indexKey, input.bundle.manifest))
    for (const snapshot of input.bundle.snapshots) replacement.push(await this.encryptSnapshotRecord(identity, envelope.namespace, contentKey, indexKey, snapshot))
    try {
      const blobMutations = await this.stagePreparedAssets(identity, envelope.namespace, contentKey, indexKey, input.bundle, input.assets || [], stagedBlobDirectories)
      replacement.push(...blobMutations)
      await this.storage.commit(replacement, { namespace: envelope.namespace, quotaBytes: input.bundle.manifest.max_storage_bytes, expectedEpoch: { key: epochKey(profile.browser_id), value: authEpoch } })
    } catch (error) {
      for (const directory of stagedBlobDirectories) await this.blobStore.remove(directory).catch(() => undefined)
      throw error
    }
    for (const directory of replacedBlobDirectories) await this.blobStore.remove(directory).catch(() => {})
    // Preparation is not login. Releasing these worker-local key references and
    // returning a locked state prevents Configuration from silently becoming an
    // authenticated offline session.
    return this.sessions.close(input.portID)
  }

  async unlockUser(portID: string, username: string, password: string, expected?: { user_id?: string; account_id?: string }) {
    this.lock(portID)
    const profile = await this.browserProfile()
    const envelopes = (await this.storage.scan<OfflineV5VaultEnvelope>('vaults', { limit: 21 })).filter(envelope =>
      envelope.state === 'available' && envelope.identity.origin === this.origin && envelope.identity.browser_profile_id === profile.browser_id)
    if (envelopes.length > 20) throw new OfflineV5Error('too_many_copies', 'Este perfil del navegador supera el máximo seguro de copias offline.')
    const lookupTag = await this.usernameLookupTag(profile.browser_id, username)
    const opened = new Map<string, Candidate>()
    for (const envelope of selectOfflineV5VaultCandidates(envelopes, lookupTag)) {
      let session: Candidate['session']
      try { session = await this.openEnvelope(envelope, username, password) }
      catch { continue }
      if (canonicalOfflineLogin(session.metadata.actor.username) !== canonicalOfflineLogin(username)
          || expected?.user_id && session.identity.user_id !== expected.user_id
          || expected?.account_id && session.identity.account_id !== expected.account_id) continue
      if (envelope.lookup_tag !== lookupTag) {
        const migrated = { ...session.envelope, lookup_tag: lookupTag, updated_at: Date.now() }
        await this.storage.commit([{ store: 'vaults', key: envelope.identity.grant_id, value: migrated }])
        session.envelope = migrated
      }
      opened.set(envelope.identity.grant_id, { session, openedAt: Date.now() })
    }
    if (!opened.size) throw new OfflineV5Error('not_prepared', 'No existe una copia autorizada para estas credenciales en este navegador.')
    if (opened.size === 1) {
      const candidate = [...opened.values()][0]
      const snapshot = this.sessions.open(portID, candidate.session)
      return { accounts: [{ grantId: candidate.session.identity.grant_id, accountId: candidate.session.identity.account_id, accountName: candidate.session.metadata.actor.account_name }], snapshot }
    }
    this.candidates.set(portID, opened)
    return { accounts: [...opened.values()].map(({ session }) => ({ grantId: session.identity.grant_id, accountId: session.identity.account_id, accountName: session.metadata.actor.account_name })) }
  }

  selectAccount(portID: string, grantID: string): OfflineV5SessionSnapshot {
    const candidates = this.candidates.get(portID), candidate = candidates?.get(grantID)
    if (!candidate || Date.now() - candidate.openedAt >= 30 * 60 * 1000) {
      this.candidates.delete(portID)
      throw new OfflineV5Error('unlock_expired', 'Vuelve a escribir tus credenciales para elegir esta cuenta.')
    }
    this.candidates.delete(portID)
    return this.sessions.open(portID, candidate.session)
  }

  lock(portID: string) {
    this.candidates.delete(portID)
    return this.sessions.close(portID)
  }

  lockAll() {
    this.candidates.clear()
    this.sessions.closeAll()
  }

  async invalidateIdentity(): Promise<void> {
    const profile = await this.storage.get<BrowserProfile>('profiles', 'active')
    if (!profile) return
    await this.storage.commit([{ store: 'schema', key: epochKey(profile.browser_id), value: crypto.randomUUID() }])
    this.lockAll()
  }

  async activity(portID: string, generation: number): Promise<OfflineV5SessionSnapshot> {
    const session = await this.checkedSession(portID, generation)
    const observedAt = this.now()
    if (!offlineV5ClockWithinHighWater(session.metadata.highest_time, observedAt)) {
      this.lock(portID)
      throw new OfflineV5Error('clock_rollback', 'El reloj del equipo retrocedió; vuelve a validar la copia con conexión.')
    }
    session.metadata.highest_time = Math.max(session.metadata.highest_time, observedAt)
    this.sessions.activity(portID, generation)
    const key = canonicalOfflineV5Identity(session.identity)
    const lastScheduled = this.highWaterScheduledAt.get(key) || 0
    if (observedAt - lastScheduled < OFFLINE_V5_HIGH_WATER_INTERVAL_MS) return this.sessions.snapshot(portID)
    this.highWaterScheduledAt.set(key, observedAt)
    const previous = this.highWaterWrites.get(key) || Promise.resolve()
    const write = previous.then(async () => {
      await this.persistHighWater(session.identity, session.keys.content, session.authEpoch, session.manifest.id, observedAt)
    })
    this.highWaterWrites.set(key, write.catch(() => undefined))
    try { await write }
    catch (error) {
      this.lock(portID)
      throw error
    }
    return this.sessions.snapshot(portID)
  }

  async aggregates(portID: string, generation: number, module?: string): Promise<OfflineV5Snapshot[]> {
    const session = await this.checkedSession(portID, generation)
    const records = await this.records(session.envelope.namespace, 'entities', 'namespace', session.envelope.namespace)
    const snapshots: OfflineV5Snapshot[] = []
    for (const record of records) {
      const stored = await this.decryptRecord<StoredSnapshotRecord | StoredEntityRecord>(session, 'entities', record)
      if (stored.kind !== 'snapshot') continue
      if (stored.identity !== canonicalOfflineV5Identity(session.identity)) throw new OfflineV5Error('wrong_record_identity', 'Se bloqueó un registro de otra identidad.')
      if (!module || stored.snapshot.module === module) snapshots.push(stored.snapshot)
    }
    return snapshots
  }

  async overlays(portID: string, generation: number, entityType?: string): Promise<OfflineV5CanonicalEntity[]> {
    const session = await this.checkedSession(portID, generation)
    const records = await this.records(session.envelope.namespace, 'entities')
    const entities: OfflineV5CanonicalEntity[] = []
    for (const record of records) {
      const stored = await this.decryptRecord<StoredSnapshotRecord | StoredEntityRecord>(session, 'entities', record)
      if (stored.kind !== 'overlay') continue
      if (stored.identity !== canonicalOfflineV5Identity(session.identity)) throw new OfflineV5Error('wrong_record_identity', 'Se bloqueó un registro de otra identidad.')
      if (entityType && stored.entity.entity_type !== entityType) continue
      if (!session.manifest.roots.some(root => root.selection_id === stored.entity.root_selection_id && root.resource_id === stored.entity.root_resource_id)) throw new OfflineV5Error('wrong_entity_root', 'Se bloqueó una entidad fuera de la selección autorizada.')
      entities.push(stored.entity)
    }
    return entities
  }

  async queueMutation<T>(portID: string, generation: number, input: OfflineV5MutationInput<T>): Promise<OfflineV5MutationResult<T>> {
    const [result] = await this.queueMutations(portID, generation, [input])
    return result as OfflineV5MutationResult<T>
  }

  /**
   * Validate, encrypt and persist a logical batch in one IndexedDB transaction.
   * Canonical batch endpoints (for example attendance) must never expose a
   * half-applied local result when quota, identity epoch or storage fails.
   */
  async queueMutations(portID: string, generation: number, inputs: readonly OfflineV5MutationInput[]): Promise<OfflineV5MutationResult[]> {
    if (!inputs.length || inputs.length > 200) throw new OfflineV5Error('invalid_operation_batch', 'El lote local debe contener entre 1 y 200 cambios.')
    const session = await this.checkedSession(portID, generation)
    const pendingBefore = await this.pendingCount(session)
    const seenOperationIDs = new Set<string>()
    const seenEntityKeys = new Set<string>()
    const results = new Array<OfflineV5MutationResult>(inputs.length)
    const prepared: Array<{
      index: number
      operation: OfflineV5Operation
      operationKey: string
      entity: OfflineV5CanonicalEntity
      entityKey: string
    }> = []

    for (const [index, input] of inputs.entries()) {
      const action = validateOfflineV5Actions([input.action])[0]
      const root = session.manifest.roots.find(item => item.selection_id === input.selection_id)
      const capability = session.manifest.capabilities.find(item => item.action === action && item.selection_id === input.selection_id && item.root_resource_id === root?.resource_id && item.resource_id === root?.resource_id)
      if (!root || !capability) throw new OfflineV5Error('offline_action_denied', 'Este cambio no está autorizado para el recurso seleccionado.')
      if (!Number.isSafeInteger(input.base_version) || input.base_version < 0 || !input.entity_id || !input.entity_type || !input.resource_id) throw new OfflineV5Error('invalid_operation', 'El cambio local no corresponde al recurso seleccionado.')
      validateManifestMembership(session.manifest, root, action, input)
      validateMutationScope({
        value: input.optimistic_value,
        action,
        resourceID: input.resource_id,
        entityID: input.entity_id,
        entityType: input.entity_type,
        accountID: session.identity.account_id,
        module: root.module,
        rootResourceID: root.resource_id,
      })
      const operationID = input.operation_id || crypto.randomUUID()
      if (seenOperationIDs.has(operationID)) throw new OfflineV5Error('duplicate_operation', 'El lote local contiene identificadores de operación repetidos.')
      seenOperationIDs.add(operationID)
      const operation: OfflineV5Operation = {
        protocol_version: 5,
        grant_id: session.identity.grant_id,
        user_id: session.identity.user_id,
        account_id: session.identity.account_id,
        browser_profile_id: session.identity.browser_profile_id,
        operation_id: operationID,
        action,
        selection_id: input.selection_id,
        resource_id: input.resource_id,
        selection_revision: session.manifest.selection_revision,
        manifest_id: session.manifest.id,
        manifest_revision: session.manifest.revision,
        credential_epoch: session.manifest.credential_epoch,
        authority_epoch: session.manifest.authority_epoch,
        base_version: input.base_version,
        ...(input.depends_on_operation_id ? { depends_on_operation_id: input.depends_on_operation_id } : {}),
        occurred_at: new Date().toISOString(),
        payload: input.payload,
      }
      const entity: OfflineV5CanonicalEntity = {
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        root_selection_id: input.selection_id,
        root_resource_id: root.resource_id,
        version: input.base_version,
        dependency: false,
        value: input.optimistic_value,
      }
      const operationKey = await blindIndex(session.keys.blindIndex, 'operation', operationID)
      const existing = await this.storage.get<OfflineV5StoredCipher>('operations', operationKey)
      if (existing) {
        const stored = await this.decryptRecord<StoredOperationRecord>(session, 'operations', existing)
        if (!sameOperationIntent(stored.operation, operation) || !deepEqual(stored.optimistic_entity, entity)) throw new OfflineV5Error('operation_id_reused', 'El identificador de esta operación ya pertenece a otro cambio.')
        results[index] = { operation_id: operationID, state: 'duplicate', entity: stored.optimistic_entity, pending_count: pendingBefore }
        continue
      }
      const entityKey = await blindIndex(session.keys.blindIndex, 'entity', input.entity_type, input.entity_id)
      if (seenEntityKeys.has(entityKey)) throw new OfflineV5Error('duplicate_batch_entity', 'El lote intentó modificar dos veces la misma entidad.')
      seenEntityKeys.add(entityKey)
      prepared.push({ index, operation, operationKey, entity, entityKey })
    }

    if (pendingBefore + prepared.length > OFFLINE_V5_MAX_OUTBOX) throw new OfflineV5Error('outbox_full', 'Hay demasiados cambios pendientes. Conecta y sincroniza antes de guardar más.')
    const mutations: OfflineV5StoreMutation[] = []
    for (const value of prepared) {
      const sequence = this.sessions.nextSequence(portID, generation)
      mutations.push(await this.encryptRecord(session, 'operations', value.operationKey, 'operation', { identity: canonicalOfflineV5Identity(session.identity), operation: value.operation, optimistic_entity: value.entity } satisfies StoredOperationRecord, { status: 'pending', sequence, created_at: Date.parse(value.operation.occurred_at) }))
      mutations.push(await this.encryptRecord(session, 'entities', value.entityKey, `overlay:${value.entity.entity_type}`, { kind: 'overlay', identity: canonicalOfflineV5Identity(session.identity), entity: value.entity, local_confirmation: 'pending' } satisfies StoredEntityRecord, { root_selection_id: value.operation.selection_id, created_at: Date.parse(value.operation.occurred_at) }))
    }
    if (mutations.length) {
      await this.storage.commit(mutations, { namespace: session.envelope.namespace, quotaBytes: session.manifest.max_storage_bytes, expectedEpoch: { key: epochKey(session.identity.browser_profile_id), value: session.authEpoch } })
      this.sessions.activity(portID, generation)
    }
    session.pendingCount = mutations.length ? await this.pendingCount(session) : pendingBefore
    for (const value of prepared) results[value.index] = { operation_id: value.operation.operation_id, state: 'queued', entity: value.entity, pending_count: session.pendingCount }
    for (const result of results) result.pending_count = session.pendingCount
    return results
  }

  async outbox(portID: string, generation: number): Promise<OfflineV5Operation[]> {
    const session = await this.checkedSession(portID, generation)
    const records = await this.records(session.envelope.namespace, 'operations', 'namespace', session.envelope.namespace, 1000)
    const operations: OfflineV5Operation[] = []
    for (const record of records.sort((left, right) => (left.sequence || 0) - (right.sequence || 0))) {
      const stored = await this.decryptRecord<StoredOperationRecord>(session, 'operations', record)
      this.assertOperationIdentity(session, stored.operation)
      operations.push(stored.operation)
    }
    return orderOfflineV5Operations(operations)
  }

  async applyReceipts(portID: string, generation: number, receipts: OfflineV5Receipt[]): Promise<void> {
    const session = await this.checkedSession(portID, generation)
    if (!Array.isArray(receipts) || receipts.length > 1000) throw new OfflineV5Error('invalid_receipts', 'La sincronización devolvió recibos inválidos.')
    const mutations: OfflineV5StoreMutation[] = []
    for (const receipt of receipts) {
      if (!receipt?.operation_id || !['applied', 'merged', 'noop', 'conflict', 'pending', 'rejected'].includes(receipt.status)) throw new OfflineV5Error('invalid_receipt', 'La sincronización devolvió un recibo desconocido.')
      const operationKey = await blindIndex(session.keys.blindIndex, 'operation', receipt.operation_id)
      const record = await this.storage.get<OfflineV5StoredCipher>('operations', operationKey)
      if (!record) continue
      const stored = await this.decryptRecord<StoredOperationRecord>(session, 'operations', record)
      this.assertOperationIdentity(session, stored.operation)
      if (receipt.resource_id && receipt.resource_id !== stored.operation.resource_id) throw new OfflineV5Error('wrong_receipt_identity', 'Se rechazó un recibo de otro recurso.')
      if (receipt.status === 'pending') continue
      mutations.push({ store: 'operations', key: operationKey, remove: true })
      const entityKey = await blindIndex(session.keys.blindIndex, 'entity', stored.optimistic_entity.entity_type, stored.optimistic_entity.entity_id)
      if (receipt.status === 'conflict' || receipt.status === 'rejected') {
        const conflict: OfflineV5Conflict = {
          operation_id: receipt.operation_id,
          action: stored.operation.action,
          selection_id: stored.operation.selection_id,
          resource_id: stored.operation.resource_id,
          status: receipt.status,
          error_code: receipt.error_code,
          fields: receipt.conflict?.fields,
          base: receipt.conflict?.base,
          local: receipt.conflict?.local ?? stored.operation.payload,
          server: receipt.conflict?.server ?? receipt.result,
          server_version: receipt.server_version,
          created_at: new Date().toISOString(),
        }
        const conflictKey = await blindIndex(session.keys.blindIndex, 'conflict', receipt.operation_id)
        mutations.push(await this.encryptRecord(session, 'conflicts', conflictKey, 'conflict', { identity: canonicalOfflineV5Identity(session.identity), conflict } satisfies StoredConflictRecord, { status: receipt.status, root_selection_id: stored.operation.selection_id, created_at: Date.now() }))
        // Pilot conflict policy is server-wins. Keep the encrypted notice for
        // audit/acknowledgement, but never let stale optimistic data obscure the
        // canonical snapshot returned by this sync.
        mutations.push({ store: 'entities', key: entityKey, remove: true })
      } else {
        const resultEntity = receipt.result?.entity as OfflineV5CanonicalEntity | undefined
        const entity = resultEntity && resultEntity.entity_id === stored.optimistic_entity.entity_id ? resultEntity : { ...stored.optimistic_entity, version: receipt.server_version ?? stored.optimistic_entity.version }
        mutations.push(await this.encryptRecord(session, 'entities', entityKey, `overlay:${entity.entity_type}`, { kind: 'overlay', identity: canonicalOfflineV5Identity(session.identity), entity, local_confirmation: 'confirmed' } satisfies StoredEntityRecord, { root_selection_id: stored.operation.selection_id, created_at: Date.now() }))
      }
    }
    await this.storage.commit(mutations, { namespace: session.envelope.namespace, quotaBytes: session.manifest.max_storage_bytes, expectedEpoch: { key: epochKey(session.identity.browser_profile_id), value: session.authEpoch } })
    session.pendingCount = await this.pendingCount(session)
    session.conflictCount = (await this.records(session.envelope.namespace, 'conflicts', 'namespace', session.envelope.namespace, 1000)).length
    session.syncState = session.conflictCount ? 'conflict' : 'idle'
    this.sessions.emit(portID)
  }

  async refreshPreparedBundle(portID: string, generation: number, bundle: OfflineV5PrepareBundle, assets: readonly OfflineV5PreparedAsset[] = []): Promise<OfflineV5SessionSnapshot> {
    const session = await this.checkedSession(portID, generation)
    const identity = await validateOfflineV5Bundle(this.origin, bundle, session.identity)
    if (!sameOfflineV5Identity(identity, session.identity) || bundle.manifest.selection_revision !== session.manifest.selection_revision || bundle.manifest.revision < session.manifest.revision) {
      throw new OfflineV5Error('selection_changed', 'La selección o autorización cambió. Prepara nuevamente la copia antes de seguir trabajando.')
    }
    const metadata: OfflineV5VaultMetadata = {
      ...session.metadata,
      manifest_id: bundle.manifest.id,
      manifest_revision: bundle.manifest.revision,
      manifest_digest: bundle.manifest.digest,
      selection_revision: bundle.manifest.selection_revision,
      credential_epoch: bundle.manifest.credential_epoch,
      authority_epoch: bundle.manifest.authority_epoch,
      grant_revision: bundle.manifest.grant_revision,
      highest_time: Math.max(session.metadata.highest_time, Date.now(), Date.parse(bundle.server_time)),
      last_sync_at: bundle.server_time,
    }
    const envelope: OfflineV5VaultEnvelope = {
      ...session.envelope,
      lease: bundle.lease,
      signer_keys: bundle.signer_public_keys.keys,
      encrypted_metadata: await encryptOfflineV5EnvelopeValue(session.keys.content, session.identity, 'metadata', 'active', metadata),
      state: 'available',
      updated_at: Date.now(),
    }
    const mutations: OfflineV5StoreMutation[] = [{ store: 'vaults', key: session.identity.grant_id, value: envelope }]
    const replacedBlobDirectories: string[] = []
    const stagedBlobDirectories: string[] = []
    // A sync creates a fresh signed manifest. Remove the superseded manifest
    // and root snapshots in the same transaction so no stale encrypted copy
    // accumulates or can be selected after a crash.
    for (const record of await this.records(envelope.namespace, 'manifests')) mutations.push({ store: 'manifests', key: record.storage_key, remove: true })
    for (const record of await this.records(envelope.namespace, 'entities')) {
      const stored = await this.decryptRecord<StoredSnapshotRecord | StoredEntityRecord>(session, 'entities', record)
      if (stored.kind === 'snapshot' || stored.kind === 'overlay' && stored.local_confirmation === 'confirmed') {
        mutations.push({ store: 'entities', key: record.storage_key, remove: true })
      }
    }
    for (const record of await this.records(envelope.namespace, 'blobs')) {
      mutations.push({ store: 'blobs', key: record.storage_key, remove: true })
      const directory = (record as OfflineV5StoredBlob).opfs_directory
      if (typeof directory === 'string') replacedBlobDirectories.push(directory)
    }
    mutations.push(await this.encryptManifestRecord(session.identity, envelope.namespace, session.keys.content, session.keys.blindIndex, bundle.manifest))
    for (const snapshot of bundle.snapshots) mutations.push(await this.encryptSnapshotRecord(session.identity, envelope.namespace, session.keys.content, session.keys.blindIndex, snapshot))
    // Receipts may leave operations pending. Rebind their authority epochs only
    // when the newly signed manifest still contains the exact root capability.
    // A recovery performed while writes are globally disabled deliberately
    // returns a read-only manifest; binding to it would turn a retryable pending
    // command into a terminal action_not_allowed receipt.
    for (const record of await this.records(envelope.namespace, 'operations', 'namespace', envelope.namespace, 1000)) {
      const stored = await this.decryptRecord<StoredOperationRecord>(session, 'operations', record)
      this.assertOperationIdentity(session, stored.operation)
      if (!offlineV5ManifestCanBindOperation(bundle.manifest, stored.operation)) continue
      const operation: OfflineV5Operation = {
        ...stored.operation,
        manifest_id: bundle.manifest.id,
        manifest_revision: bundle.manifest.revision,
        selection_revision: bundle.manifest.selection_revision,
        credential_epoch: bundle.manifest.credential_epoch,
        authority_epoch: bundle.manifest.authority_epoch,
      }
      mutations.push(await this.encryptRecord(session, 'operations', record.storage_key, 'operation', { ...stored, operation } satisfies StoredOperationRecord, {
        status: 'pending', sequence: record.sequence, created_at: record.created_at,
      }))
    }
    try {
      mutations.push(...await this.stagePreparedAssets(session.identity, envelope.namespace, session.keys.content, session.keys.blindIndex, bundle, assets, stagedBlobDirectories))
      await this.storage.commit(mutations, { namespace: envelope.namespace, quotaBytes: bundle.manifest.max_storage_bytes, expectedEpoch: { key: epochKey(session.identity.browser_profile_id), value: session.authEpoch } })
    } catch (error) {
      for (const directory of stagedBlobDirectories) await this.blobStore.remove(directory).catch(() => undefined)
      throw error
    }
    for (const directory of replacedBlobDirectories) await this.blobStore.remove(directory).catch(() => undefined)
    session.envelope = envelope
    session.metadata = metadata
    session.manifest = bundle.manifest
    session.syncState = (await this.conflicts(portID, generation)).length ? 'conflict' : 'idle'
    return this.sessions.emit(portID)
  }

  async conflicts(portID: string, generation: number): Promise<OfflineV5Conflict[]> {
    const session = await this.checkedSession(portID, generation)
    const records = await this.records(session.envelope.namespace, 'conflicts', 'namespace', session.envelope.namespace, 1000)
    const conflicts: OfflineV5Conflict[] = []
    for (const record of records) {
      const stored = await this.decryptRecord<StoredConflictRecord>(session, 'conflicts', record)
      if (stored.identity !== canonicalOfflineV5Identity(session.identity)) throw new OfflineV5Error('wrong_record_identity', 'Se bloqueó un conflicto de otra identidad.')
      conflicts.push(stored.conflict)
    }
    return conflicts.sort((a, b) => a.created_at.localeCompare(b.created_at))
  }

  async acknowledgeServerWinsConflicts(portID: string, generation: number): Promise<OfflineV5SessionSnapshot> {
    const session = await this.checkedSession(portID, generation)
    const records = await this.records(session.envelope.namespace, 'conflicts', 'namespace', session.envelope.namespace, 1000)
    const mutations: OfflineV5StoreMutation[] = []
    for (const record of records) {
      const stored = await this.decryptRecord<StoredConflictRecord>(session, 'conflicts', record)
      if (stored.identity !== canonicalOfflineV5Identity(session.identity)) throw new OfflineV5Error('wrong_record_identity', 'Se bloqueó un conflicto de otra identidad.')
      mutations.push({ store: 'conflicts', key: record.storage_key, remove: true })
    }
    await this.storage.commit(mutations, { namespace: session.envelope.namespace, quotaBytes: session.manifest.max_storage_bytes, expectedEpoch: { key: epochKey(session.identity.browser_profile_id), value: session.authEpoch } })
    session.conflictCount = 0
    session.syncState = 'idle'
    session.error = undefined
    return this.sessions.emit(portID)
  }

  async runtimeSnapshot(portID: string): Promise<OfflineV5SessionSnapshot> {
    const snapshot = this.sessions.snapshot(portID)
    if (!snapshot.active) return snapshot
    const session = await this.checkedSession(portID, snapshot.generation)
    session.pendingCount = await this.pendingCount(session)
    session.conflictCount = (await this.records(session.envelope.namespace, 'conflicts', 'namespace', session.envelope.namespace, 1000)).length
    if (session.syncState !== 'syncing') session.syncState = session.conflictCount ? 'conflict' : 'idle'
    return this.sessions.snapshot(portID)
  }

  async putBlob(portID: string, generation: number, input: { blobId: string; entityType: string; entityId: string; rootSelectionId: string; name: string; type: string; bytes: Blob }): Promise<{ blobId: string; size: number; type: string; name: string }> {
    const session = await this.checkedSession(portID, generation)
    if (!session.metadata.persistent || !this.blobStore.supported()) throw new OfflineV5Error('opfs_unavailable', 'Este navegador no puede guardar archivos offline de forma persistente.')
    const root = session.manifest.roots.find(item => item.selection_id === input.rootSelectionId)
    if (!root || !input.blobId || !input.entityId || !input.entityType || input.bytes.size < 0 || input.bytes.size > session.manifest.max_storage_bytes) throw new OfflineV5Error('invalid_blob', 'El archivo no pertenece a un recurso seleccionado.')
    const projectedBytes = input.bytes.size + Math.ceil(input.bytes.size / (2 * 1024 * 1024)) * 16 + 4096
    if (await this.storage.totalBytes(session.envelope.namespace) + projectedBytes > session.manifest.max_storage_bytes) throw new OfflineV5Error('storage_quota', 'No queda espacio autorizado para guardar este archivo offline.')
    const directory = base64url(crypto.getRandomValues(new Uint8Array(24)))
    const chunks: Array<{ index: number; name: string; iv: string; ciphertext_bytes: number }> = []
    try {
      let index = 0
      for (let offset = 0; offset < input.bytes.size || offset === 0 && input.bytes.size === 0; offset += 2 * 1024 * 1024) {
        const plaintext = new Uint8Array(await input.bytes.slice(offset, Math.min(input.bytes.size, offset + 2 * 1024 * 1024)).arrayBuffer())
        const encrypted = await encryptOfflineV5Bytes(session.keys.content, session.identity, 'blob', input.blobId, index, plaintext)
        plaintext.fill(0)
        const name = `chunk_${String(index).padStart(6, '0')}`
        await this.blobStore.write(directory, name, encrypted.ciphertext)
        chunks.push({ index, name, iv: encrypted.iv, ciphertext_bytes: encrypted.ciphertext.byteLength })
        index++
      }
      const key = await blindIndex(session.keys.blindIndex, 'blob', input.blobId)
      const descriptor = { identity: canonicalOfflineV5Identity(session.identity), blob_id: input.blobId, entity_type: input.entityType, entity_id: input.entityId, root_selection_id: input.rootSelectionId, name: input.name, type: input.type || 'application/octet-stream', plaintext_bytes: input.bytes.size, chunks }
      const ciphertext = await encryptOfflineV5Value(session.keys.content, session.identity, 'blobs', key, descriptor)
      const stored: OfflineV5StoredBlob = {
        storage_key: key, namespace: session.envelope.namespace, record_type: 'blob', root_selection_id: input.rootSelectionId,
        entity_type: input.entityType, entity_id: input.entityId, chunk_count: chunks.length, plaintext_bytes: input.bytes.size,
        opfs_directory: directory, ciphertext, byte_size: chunks.reduce((sum, chunk) => sum + chunk.ciphertext_bytes, 0) + storedCipherBytes({ ciphertext }),
      }
      await this.storage.commit([{ store: 'blobs', key, value: stored }], { namespace: session.envelope.namespace, quotaBytes: session.manifest.max_storage_bytes, expectedEpoch: { key: epochKey(session.identity.browser_profile_id), value: session.authEpoch } })
      return { blobId: input.blobId, size: input.bytes.size, type: descriptor.type, name: input.name }
    } catch (error) {
      await this.blobStore.remove(directory).catch(() => {})
      throw error
    }
  }

  async getBlob(portID: string, generation: number, blobID: string): Promise<Blob> {
    const session = await this.checkedSession(portID, generation)
    const key = await blindIndex(session.keys.blindIndex, 'blob', blobID)
    const stored = await this.storage.get<OfflineV5StoredBlob>('blobs', key)
    if (!stored || stored.namespace !== session.envelope.namespace) throw new OfflineV5Error('blob_missing', 'El archivo no está incluido en esta copia offline.')
    const descriptor = await decryptOfflineV5Value<{ identity: string; blob_id: string; type: string; plaintext_bytes: number; chunks: Array<{ index: number; name: string; iv: string; ciphertext_bytes: number }> }>(session.keys.content, session.identity, 'blobs', key, stored.ciphertext)
    if (descriptor.identity !== canonicalOfflineV5Identity(session.identity) || descriptor.blob_id !== blobID || descriptor.chunks.length !== stored.chunk_count) throw new OfflineV5Error('wrong_blob_identity', 'El archivo pertenece a otra copia offline.')
    const plaintext: Uint8Array<ArrayBuffer>[] = []
    let total = 0
    for (const chunk of [...descriptor.chunks].sort((a, b) => a.index - b.index)) {
      const ciphertext = await this.blobStore.read(stored.opfs_directory, chunk.name)
      if (ciphertext.byteLength !== chunk.ciphertext_bytes) throw new OfflineV5Error('blob_integrity', 'El archivo local está incompleto.')
      const bytes = await decryptOfflineV5Bytes(session.keys.content, session.identity, 'blob', blobID, chunk.index, chunk.iv, ciphertext)
      plaintext.push(bytes); total += bytes.byteLength
    }
    if (total !== descriptor.plaintext_bytes) throw new OfflineV5Error('blob_integrity', 'El tamaño del archivo local no coincide.')
    return new Blob(plaintext, { type: descriptor.type })
  }

  async deleteBlob(portID: string, generation: number, blobID: string): Promise<void> {
    const session = await this.checkedSession(portID, generation)
    const key = await blindIndex(session.keys.blindIndex, 'blob', blobID)
    const stored = await this.storage.get<OfflineV5StoredBlob>('blobs', key)
    if (!stored || stored.namespace !== session.envelope.namespace) return
    await this.storage.commit([{ store: 'blobs', key, remove: true }], { namespace: session.envelope.namespace, quotaBytes: session.manifest.max_storage_bytes, expectedEpoch: { key: epochKey(session.identity.browser_profile_id), value: session.authEpoch } })
    await this.blobStore.remove(stored.opfs_directory).catch(() => {})
  }

  private async stagePreparedAssets(
    identity: OfflineV5Identity,
    namespace: string,
    content: CryptoKey,
    blind: CryptoKey,
    bundle: OfflineV5PrepareBundle,
    supplied: readonly OfflineV5PreparedAsset[],
    stagedDirectories: string[],
  ): Promise<OfflineV5StoreMutation[]> {
    const expected = new Map<string, { descriptor: ReturnType<typeof offlineV5WhiteboardAssetDescriptors>[number]; rootSelectionID: string }>()
    for (const snapshot of bundle.snapshots) for (const descriptor of offlineV5WhiteboardAssetDescriptors(snapshot)) {
      if (expected.has(descriptor.id)) throw new OfflineV5Error('duplicate_asset', 'Una imagen aparece más de una vez en la copia offline.')
      expected.set(descriptor.id, { descriptor, rootSelectionID: snapshot.root_selection_id })
    }
    if (supplied.length !== expected.size || supplied.some(item => !expected.has(item.descriptor.id))) {
      throw new OfflineV5Error('incomplete_asset_set', 'No se descargaron exactamente todas las imágenes firmadas de las pizarras.')
    }
    if (expected.size && !this.blobStore.supported()) throw new OfflineV5Error('opfs_unavailable', 'Este navegador no puede guardar de forma segura las imágenes offline.')

    const mutations: OfflineV5StoreMutation[] = []
    for (const asset of supplied) {
      const signed = expected.get(asset.descriptor.id)
      if (!signed || signed.rootSelectionID !== asset.root_selection_id
          || JSON.stringify(signed.descriptor) !== JSON.stringify(asset.descriptor)
          || asset.bytes.size !== signed.descriptor.size_bytes
          || asset.bytes.type.toLowerCase() !== signed.descriptor.content_type) {
        throw new OfflineV5Error('asset_descriptor_mismatch', 'Una imagen no corresponde al descriptor firmado de su pizarra.')
      }
      const allBytes = new Uint8Array(await asset.bytes.arrayBuffer())
      try {
        if (await sha256HexBytes(allBytes) !== signed.descriptor.content_hash) {
          throw new OfflineV5Error('asset_integrity', 'Una imagen fue alterada antes de guardarse y la copia fue descartada.')
        }
      } finally { allBytes.fill(0) }

      const directory = base64url(crypto.getRandomValues(new Uint8Array(24)))
      stagedDirectories.push(directory)
      const chunks: Array<{ index: number; name: string; iv: string; ciphertext_bytes: number }> = []
      let index = 0
      for (let offset = 0; offset < asset.bytes.size; offset += OFFLINE_V5_BLOB_CHUNK_BYTES) {
        const plaintext = new Uint8Array(await asset.bytes.slice(offset, Math.min(asset.bytes.size, offset + OFFLINE_V5_BLOB_CHUNK_BYTES)).arrayBuffer())
        const encrypted = await encryptOfflineV5Bytes(content, identity, 'blob', signed.descriptor.id, index, plaintext)
        plaintext.fill(0)
        const name = `chunk_${String(index).padStart(6, '0')}`
        await this.blobStore.write(directory, name, encrypted.ciphertext)
        chunks.push({ index, name, iv: encrypted.iv, ciphertext_bytes: encrypted.ciphertext.byteLength })
        index++
      }
      const key = await blindIndex(blind, 'blob', signed.descriptor.id)
      const descriptor = {
        identity: canonicalOfflineV5Identity(identity),
        blob_id: signed.descriptor.id,
        entity_type: 'whiteboard_asset',
        entity_id: signed.descriptor.root_resource_id,
        root_selection_id: signed.rootSelectionID,
        name: signed.descriptor.file_id,
        file_id: signed.descriptor.file_id,
        content_hash: signed.descriptor.content_hash,
        type: signed.descriptor.content_type,
        plaintext_bytes: signed.descriptor.size_bytes,
        chunks,
      }
      const ciphertext = await encryptOfflineV5Value(content, identity, 'blobs', key, descriptor)
      const stored: OfflineV5StoredBlob = {
        storage_key: key, namespace, record_type: 'blob', root_selection_id: signed.rootSelectionID,
        entity_type: 'whiteboard_asset', entity_id: signed.descriptor.root_resource_id,
        chunk_count: chunks.length, plaintext_bytes: signed.descriptor.size_bytes, opfs_directory: directory,
        ciphertext, byte_size: chunks.reduce((sum, chunk) => sum + chunk.ciphertext_bytes, 0) + storedCipherBytes({ ciphertext }),
      }
      mutations.push({ store: 'blobs', key, value: stored })
    }
    return mutations
  }

  private async openEnvelope(envelope: OfflineV5VaultEnvelope, username: string, password: string): Promise<Candidate['session']> {
    if (envelope.format !== 5 || envelope.iterations !== PASSWORD_ITERATIONS) throw new OfflineV5Error('invalid_vault', 'La copia offline tiene un formato no compatible.')
    const profile = await this.browserProfile()
    if (envelope.identity.origin !== this.origin || envelope.identity.browser_profile_id !== profile.browser_id) throw new OfflineV5Error('wrong_browser', 'La copia pertenece a otro navegador.')
    const content = await unlockOfflineV5VaultKey(password, envelope.identity, envelope.salt, envelope.wrapped_key)
    const blind = await unlockBlindIndexKey(content, envelope.identity, envelope.wrapped_index_key)
    const metadata = await decryptOfflineV5EnvelopeValue<OfflineV5VaultMetadata>(content, envelope.identity, 'metadata', 'active', envelope.encrypted_metadata)
    if (canonicalOfflineLogin(username) !== canonicalOfflineLogin(metadata.actor.username) || metadata.actor.user_id !== envelope.identity.user_id || metadata.actor.account_id !== envelope.identity.account_id) throw new OfflineV5Error('unlock_failed', 'El usuario o la contraseña no corresponden a esta copia.')
    const manifestKey = await blindIndex(blind, 'manifest', metadata.manifest_id)
    const manifestRecord = await this.storage.get<OfflineV5StoredCipher>('manifests', manifestKey)
    if (!manifestRecord) throw new OfflineV5Error('manifest_missing', 'La copia offline está incompleta.')
    const stored = await decryptOfflineV5Value<StoredManifestRecord>(content, envelope.identity, 'manifests', manifestKey, manifestRecord.ciphertext)
    if (stored.identity !== canonicalOfflineV5Identity(envelope.identity)) throw new OfflineV5Error('wrong_record_identity', 'El manifiesto pertenece a otra identidad.')
    const observedAt = this.now()
    await verifyOfflineV5Lease(envelope.lease, envelope.signer_keys, envelope.identity, stored.manifest, observedAt)
    if (stored.manifest.digest !== metadata.manifest_digest || stored.manifest.revision !== metadata.manifest_revision || !offlineV5ClockWithinHighWater(metadata.highest_time, observedAt)) throw new OfflineV5Error('vault_mismatch', 'La copia offline fue alterada o el reloj del equipo retrocedió.')
    const authEpoch = await this.ensureEpoch(profile.browser_id)
    const advanced = await this.persistHighWater(envelope.identity, content, authEpoch, stored.manifest.id, observedAt)
    return { identity: envelope.identity, envelope: advanced.envelope, metadata: advanced.metadata, manifest: stored.manifest, keys: { content, blindIndex: blind }, authEpoch }
  }

  private async persistHighWater(identity: OfflineV5Identity, content: CryptoKey, authEpoch: string, manifestID: string, observedAt: number): Promise<{ envelope: OfflineV5VaultEnvelope; metadata: OfflineV5VaultMetadata }> {
    const latest = await this.storage.get<OfflineV5VaultEnvelope>('vaults', identity.grant_id)
    if (!latest || !sameOfflineV5Identity(latest.identity, identity) || latest.state !== 'available') throw new OfflineV5Error('copy_changed', 'La copia offline cambió mientras se protegía la sesión.')
    const metadata = await decryptOfflineV5EnvelopeValue<OfflineV5VaultMetadata>(content, identity, 'metadata', 'active', latest.encrypted_metadata)
    if (metadata.manifest_id !== manifestID || metadata.actor.user_id !== identity.user_id || metadata.actor.account_id !== identity.account_id) throw new OfflineV5Error('copy_changed', 'La copia offline cambió mientras se protegía la sesión.')
    if (!offlineV5ClockWithinHighWater(metadata.highest_time, observedAt)) throw new OfflineV5Error('clock_rollback', 'El reloj del equipo retrocedió; vuelve a validar la copia con conexión.')
    const highestTime = Math.max(metadata.highest_time, observedAt)
    if (highestTime === metadata.highest_time) return { envelope: latest, metadata }
    const nextMetadata = { ...metadata, highest_time: highestTime }
    const nextEnvelope = {
      ...latest,
      encrypted_metadata: await encryptOfflineV5EnvelopeValue(content, identity, 'metadata', 'active', nextMetadata),
      updated_at: Math.max(latest.updated_at, observedAt),
    }
    await this.storage.commit([{ store: 'vaults', key: identity.grant_id, value: nextEnvelope }], { expectedEpoch: { key: epochKey(identity.browser_profile_id), value: authEpoch } })
    return { envelope: nextEnvelope, metadata: nextMetadata }
  }

  /**
   * Worker-internal checked access for canonical route adapters. It validates
   * the durable identity epoch before any actor/manifest metadata is exposed.
   */
  async checkedSession(portID: string, generation: number): Promise<OfflineV5ActiveSession> {
    const session = this.sessions.require(portID, generation)
    const epoch = await this.storage.get<string>('schema', epochKey(session.identity.browser_profile_id)) || ''
    if (epoch !== session.authEpoch) {
      this.lock(portID)
      throw new OfflineV5Error('identity_changed', 'La identidad online cambió; desbloquea nuevamente la copia.')
    }
    return session
  }

  private async ensureEpoch(browserID: string): Promise<string> {
    const key = epochKey(browserID), existing = await this.storage.get<string>('schema', key)
    if (existing) return existing
    const value = crypto.randomUUID()
    try { await this.storage.commit([{ store: 'schema', key, value, add: true }]); return value }
    catch (error) { return await this.storage.get<string>('schema', key) || Promise.reject(error) }
  }

  private async usernameLookupTag(browserID: string, username: string): Promise<string> {
    const storageKey = `vault-username-hmac:${browserID}`
    let key = await this.storage.get<CryptoKey>('profiles', storageKey)
    if (!key) {
      const generated = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
      try {
        await this.storage.commit([{ store: 'profiles', key: storageKey, value: generated, add: true }])
        key = generated
      } catch (error) {
        key = await this.storage.get<CryptoKey>('profiles', storageKey)
        if (!key) throw error
      }
    }
    if (!isNonExportableHMACKey(key)) throw new OfflineV5Error('invalid_profile_key', 'La identidad local de este navegador fue alterada.')
    return offlineV5UsernameLookupTag(key, username)
  }

  private async encryptManifestRecord(identity: OfflineV5Identity, namespace: string, content: CryptoKey, blind: CryptoKey, manifest: OfflineV5Manifest): Promise<OfflineV5StoreMutation> {
    const key = await blindIndex(blind, 'manifest', manifest.id)
    const ciphertext = await encryptOfflineV5Value(content, identity, 'manifests', key, { identity: canonicalOfflineV5Identity(identity), manifest } satisfies StoredManifestRecord)
    return { store: 'manifests', key, value: { storage_key: key, namespace, record_type: 'manifest', byte_size: storedCipherBytes({ ciphertext }), ciphertext } satisfies OfflineV5StoredCipher }
  }

  private async encryptSnapshotRecord(identity: OfflineV5Identity, namespace: string, content: CryptoKey, blind: CryptoKey, snapshot: OfflineV5Snapshot): Promise<OfflineV5StoreMutation> {
    const key = await blindIndex(blind, 'snapshot', snapshot.selection_id)
    const ciphertext = await encryptOfflineV5Value(content, identity, 'entities', key, { kind: 'snapshot', identity: canonicalOfflineV5Identity(identity), snapshot: { ...snapshot, payload_json: '' } } satisfies StoredSnapshotRecord)
    return { store: 'entities', key, value: { storage_key: key, namespace, record_type: `snapshot:${snapshot.module}`, root_selection_id: snapshot.root_selection_id, byte_size: storedCipherBytes({ ciphertext }), ciphertext } satisfies OfflineV5StoredCipher }
  }

  private async encryptRecord(session: OfflineV5ActiveSession, store: 'entities' | 'operations' | 'conflicts', key: string, recordType: string, value: unknown, metadata: Partial<OfflineV5StoredCipher> = {}): Promise<OfflineV5StoreMutation> {
    const ciphertext = await encryptOfflineV5Value(session.keys.content, session.identity, store, key, value)
    return { store, key, value: { storage_key: key, namespace: session.envelope.namespace, record_type: recordType, byte_size: storedCipherBytes({ ciphertext }), ciphertext, ...metadata } satisfies OfflineV5StoredCipher }
  }

  private decryptRecord<T>(session: OfflineV5ActiveSession, store: 'entities' | 'operations' | 'conflicts', record: OfflineV5StoredCipher): Promise<T> {
    if (record.namespace !== session.envelope.namespace) throw new OfflineV5Error('wrong_record_namespace', 'Se bloqueó un registro de otra copia.')
    return decryptOfflineV5Value<T>(session.keys.content, session.identity, store, record.storage_key, record.ciphertext)
  }

  private records(namespace: string, store: 'manifests' | 'entities' | 'operations' | 'conflicts' | 'blobs', index = 'namespace', key: IDBValidKey = namespace, limit = 1000) {
    return this.storage.scan<OfflineV5StoredCipher>(store, { index, key, limit })
  }

  private async pendingCount(session: OfflineV5ActiveSession) {
    return (await this.records(session.envelope.namespace, 'operations', 'namespace', session.envelope.namespace, 1000)).length
  }

  private assertOperationIdentity(session: OfflineV5ActiveSession, operation: OfflineV5Operation) {
    if (operation.protocol_version !== 5 || operation.grant_id !== session.identity.grant_id || operation.user_id !== session.identity.user_id || operation.account_id !== session.identity.account_id
        || operation.browser_profile_id !== session.identity.browser_profile_id || operation.manifest_id !== session.manifest.id || operation.manifest_revision !== session.manifest.revision || operation.selection_revision !== session.manifest.selection_revision) {
      throw new OfflineV5Error('wrong_operation_identity', 'Se bloqueó una operación de otra identidad o selección.')
    }
  }
}

function epochKey(browserID: string) { return `auth:${browserID}` }

function isNonExportableHMACKey(value: unknown): value is CryptoKey {
  if (!value || typeof value !== 'object') return false
  const key = value as Partial<CryptoKey>
  const algorithm = key.algorithm as { name?: unknown; hash?: { name?: unknown } } | undefined
  return key.type === 'secret' && key.extractable === false && Array.isArray(key.usages) && key.usages.length === 1 && key.usages[0] === 'sign'
    && algorithm?.name === 'HMAC' && algorithm.hash?.name === 'SHA-256'
}

/**
 * Indexed copies are cheap candidates; random legacy tags are tried once and
 * migrated after a successful unlock. Other keyed tags are never PBKDF2-tested.
 */
export function selectOfflineV5VaultCandidates(envelopes: readonly OfflineV5VaultEnvelope[], lookupTag: string): OfflineV5VaultEnvelope[] {
  return [
    ...envelopes.filter(envelope => envelope.lookup_tag === lookupTag),
    ...envelopes.filter(envelope => !envelope.lookup_tag.startsWith('h1.')),
  ]
}

export function selectPreparedOfflineV5VaultsForUsername(
  envelopes: readonly OfflineV5VaultEnvelope[],
  lookupTag: string,
  origin: string,
  browserProfileID: string,
): OfflineV5VaultEnvelope[] {
  if (!lookupTag.startsWith('h1.') || !origin || !browserProfileID) return []
  return envelopes.filter(envelope =>
    envelope.lookup_tag === lookupTag
    && envelope.state === 'available'
    && envelope.identity.origin === origin
    && envelope.identity.browser_profile_id === browserProfileID)
}

function validatePrivateSigningKey(key: JWK) {
  if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || !key.d || !key.x || !key.y) throw new OfflineV5Error('invalid_grant_key', 'La clave privada de la autorización no es válida.')
}

function validateMutationScope(input: {
  value: unknown
  action: string
  resourceID: string
  entityID: string
  entityType: string
  accountID: string
  module: string
  rootResourceID: string
}) {
  const { value, action, resourceID, entityID, entityType, accountID, module, rootResourceID } = input
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OfflineV5Error('invalid_optimistic_entity', 'El cambio no contiene una entidad canónica válida.')
  const entity = value as { id?: unknown; account_id?: unknown; contact_id?: unknown; task_id?: unknown; list_id?: unknown; program_id?: unknown; whiteboard_id?: unknown; root_resource_id?: unknown }
  if (entity.id !== undefined && entity.id !== entityID) throw new OfflineV5Error('wrong_entity_id', 'El cambio intentó sustituir otra entidad.')
  if (entity.account_id !== undefined && entity.account_id !== accountID) throw new OfflineV5Error('wrong_entity_account', 'El cambio intentó usar datos de otra cuenta.')
  if (!action.startsWith(`${module}.`)) throw new OfflineV5Error('wrong_action_module', 'La capacidad no corresponde al módulo seleccionado.')
  if (module === 'tasks') {
    if (action === 'tasks.comments.create') {
      if (entityType !== 'task_comment' || resourceID !== entityID || entity.root_resource_id !== rootResourceID || typeof entity.task_id !== 'string') throw new OfflineV5Error('wrong_task_comment', 'El comentario no pertenece a una tarea de la lista seleccionada.')
      return
    }
    if (entityType !== 'task' || resourceID !== entityID) throw new OfflineV5Error('wrong_task_resource', 'La operación no identifica la tarea modificada.')
    if (entity.list_id !== rootResourceID && entity.root_resource_id !== rootResourceID) throw new OfflineV5Error('wrong_task_list', 'La entidad de Tareas no pertenece a la lista seleccionada.')
    return
  }
  if (module === 'contacts') {
    if (resourceID !== rootResourceID) throw new OfflineV5Error('wrong_contact_root', 'La operación no pertenece al contacto seleccionado.')
    if (action === 'contacts.update') {
      if (entityType !== 'contact' || entityID !== rootResourceID) throw new OfflineV5Error('wrong_contact_root', 'Solo puede modificarse el contacto seleccionado.')
      return
    }
    if (action === 'contacts.observations.create') {
      if (entityType !== 'contact_observation' || entity.contact_id !== rootResourceID) throw new OfflineV5Error('wrong_contact_observation', 'La observación no pertenece al contacto seleccionado.')
      return
    }
    throw new OfflineV5Error('wrong_contact_action', 'La acción no está permitida para este contacto.')
  }
  if (module === 'programs') {
    if (action === 'programs.update') {
      if (entityType !== 'program' || entityID !== rootResourceID || resourceID !== rootResourceID) throw new OfflineV5Error('wrong_program_root', 'Solo puede modificarse el programa seleccionado.')
      return
    }
    if (action === 'programs.goals.update') {
      if (entityType !== 'program_goal' || resourceID !== rootResourceID || entity.program_id !== rootResourceID) throw new OfflineV5Error('wrong_program_goal', 'Las metas no pertenecen al programa seleccionado.')
      return
    }
    if (action === 'programs.participants.add' || action === 'programs.participants.lifecycle.update') {
      if (entityType !== 'program_participant' || resourceID !== entityID || entity.program_id !== rootResourceID) throw new OfflineV5Error('wrong_program_participant', 'El participante no pertenece al programa seleccionado.')
      return
    }
    if (action === 'programs.sessions.upsert') {
      if (entityType !== 'program_session' || resourceID !== entityID || entity.program_id !== rootResourceID) throw new OfflineV5Error('wrong_program_session', 'La sesión no pertenece al programa seleccionado.')
      return
    }
    if (action === 'programs.attendance.set') {
      const attendance = entity as typeof entity & { participant_id?: unknown; session_id?: unknown }
      if (entityType !== 'program_attendance' || resourceID !== attendance.participant_id || typeof attendance.session_id !== 'string' || entity.program_id !== rootResourceID) throw new OfflineV5Error('wrong_program_attendance', 'La asistencia no pertenece al programa seleccionado.')
      return
    }
    if (action === 'programs.observations.create') {
      if (entityType !== 'program_observation' || resourceID !== entityID || entity.program_id !== rootResourceID) throw new OfflineV5Error('wrong_program_observation', 'La observación no pertenece al programa seleccionado.')
      return
    }
    throw new OfflineV5Error('wrong_program_action', 'La acción no está permitida para este programa.')
  }
  if (module === 'whiteboards' && (entityType !== 'whiteboard' || entityID !== rootResourceID || resourceID !== rootResourceID)) throw new OfflineV5Error('wrong_whiteboard_root', 'Solo puede modificarse la pizarra seleccionada.')
}

function validateManifestMembership(manifest: OfflineV5Manifest, root: OfflineV5Root, action: string, input: OfflineV5MutationInput) {
  const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload as Record<string, unknown> : {}
  const dependency = (type: string, id: unknown) => typeof id === 'string' && manifest.dependencies.some(item => item.root_selection_id === root.selection_id && item.resource_type === type && item.resource_id === id)
  if (root.module === 'tasks') {
    if (action === 'tasks.create') {
      if (payload.parent_task_id != null && !dependency('task', payload.parent_task_id)) throw new OfflineV5Error('outside_selection', 'La tarea padre no pertenece a la lista seleccionada.')
      return
    }
    const taskID = action === 'tasks.comments.create' ? payload.task_id : input.resource_id
    if (!dependency('task', taskID)) throw new OfflineV5Error('outside_selection', 'La tarea no pertenece a la lista seleccionada.')
    return
  }
  if (root.module === 'contacts') {
    if (input.resource_id !== root.resource_id) throw new OfflineV5Error('outside_selection', 'El cambio no pertenece al contacto seleccionado.')
    return
  }
  if (root.module === 'programs') {
    if (action === 'programs.update' || action === 'programs.goals.update') {
      if (input.resource_id !== root.resource_id) throw new OfflineV5Error('outside_selection', 'El cambio no pertenece al programa seleccionado.')
      return
    }
    if (payload.program_id !== root.resource_id) throw new OfflineV5Error('outside_selection', 'El cambio no pertenece al programa seleccionado.')
    if (action === 'programs.participants.add') {
      const contactID = payload.contact_id
      if (typeof contactID !== 'string' || !manifest.roots.some(item => item.module === 'contacts' && item.resource_id === contactID)) throw new OfflineV5Error('outside_selection', 'Solo puedes añadir un contacto incluido explícitamente en la copia offline.')
      return
    }
    if ((action === 'programs.participants.lifecycle.update' || action === 'programs.attendance.set') && !dependency('program_participant', input.resource_id)) throw new OfflineV5Error('outside_selection', 'El participante no pertenece al programa seleccionado.')
    if (action === 'programs.sessions.upsert' && input.base_version > 0 && !dependency('program_session', input.resource_id)) throw new OfflineV5Error('outside_selection', 'La sesión no pertenece al programa seleccionado.')
    if (action === 'programs.observations.create') {
      if ((payload.scope === 'session' || payload.scope === 'attendance') && !dependency('program_session', payload.session_id)) throw new OfflineV5Error('outside_selection', 'La sesión no pertenece al programa seleccionado.')
      if ((payload.scope === 'attendance' || payload.scope === 'participant') && !dependency('program_participant', payload.participant_id)) throw new OfflineV5Error('outside_selection', 'El participante no pertenece al programa seleccionado.')
      if (payload.scope === 'participant' && payload.session_id != null && !dependency('program_session', payload.session_id)) throw new OfflineV5Error('outside_selection', 'La sesión no pertenece al programa seleccionado.')
      if (!['session', 'attendance', 'participant'].includes(String(payload.scope || ''))) throw new OfflineV5Error('outside_selection', 'El ámbito de la observación no está autorizado.')
    }
    return
  }
  if (root.module === 'whiteboards' && input.resource_id !== root.resource_id) throw new OfflineV5Error('outside_selection', 'El cambio no pertenece a la pizarra seleccionada.')
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) return false
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>, keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
}

function sameOperationIntent(left: OfflineV5Operation, right: OfflineV5Operation): boolean {
  const { occurred_at: _leftTime, ...leftIntent } = left
  const { occurred_at: _rightTime, ...rightIntent } = right
  return deepEqual(leftIntent, rightIntent)
}

export function orderOfflineV5Operations(input: readonly OfflineV5Operation[]): OfflineV5Operation[] {
  const byID = new Map(input.map(operation => [operation.operation_id, operation]))
  if (byID.size !== input.length) throw new OfflineV5Error('duplicate_operation', 'La cola local contiene operaciones repetidas.')
  const result: OfflineV5Operation[] = [], visiting = new Set<string>(), visited = new Set<string>()
  const visit = (operation: OfflineV5Operation) => {
    if (visited.has(operation.operation_id)) return
    if (visiting.has(operation.operation_id)) throw new OfflineV5Error('operation_cycle', 'La cola local contiene una dependencia circular.')
    visiting.add(operation.operation_id)
    if (operation.depends_on_operation_id) {
      const dependency = byID.get(operation.depends_on_operation_id)
      if (dependency) visit(dependency)
    }
    visiting.delete(operation.operation_id); visited.add(operation.operation_id); result.push(operation)
  }
  for (const operation of [...input].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.operation_id.localeCompare(b.operation_id))) visit(operation)
  return result
}

/** Whether a pending immutable intent may be rebound to this signed manifest. */
export function offlineV5ManifestCanBindOperation(manifest: OfflineV5Manifest, operation: OfflineV5Operation): boolean {
  if (manifest.protocol_version !== 5 || operation.protocol_version !== 5
      || operation.browser_profile_id !== manifest.browser_profile_id
      || operation.grant_id !== manifest.grant_id
      || operation.user_id !== manifest.user_id
      || operation.account_id !== manifest.account_id) return false
  const root = manifest.roots.find(item => item.selection_id === operation.selection_id)
  if (!root || !operation.action.startsWith(`${root.module}.`)) return false
  return manifest.capabilities.some(capability => capability.action === operation.action
    && capability.selection_id === root.selection_id
    && capability.root_resource_id === root.resource_id
    && capability.resource_type === root.resource_type
    && capability.resource_id === root.resource_id)
}

/** Exact authority binding required before an operation can leave the browser. */
export function offlineV5OperationReadyForManifest(manifest: OfflineV5Manifest, operation: OfflineV5Operation): boolean {
  return offlineV5ManifestCanBindOperation(manifest, operation)
    && operation.manifest_id === manifest.id
    && operation.manifest_revision === manifest.revision
    && operation.selection_revision === manifest.selection_revision
    && operation.credential_epoch === manifest.credential_epoch
    && operation.authority_epoch === manifest.authority_epoch
}

/**
 * Preserves dependency closure: a ready child is not emitted while its pending
 * predecessor is deferred by a missing capability.
 */
export function sendableOfflineV5Operations(manifest: OfflineV5Manifest, operations: readonly OfflineV5Operation[]): OfflineV5Operation[] {
  const ordered = orderOfflineV5Operations(operations)
  const pendingIDs = new Set(ordered.map(operation => operation.operation_id))
  const sendableIDs = new Set<string>()
  const sendable: OfflineV5Operation[] = []
  for (const operation of ordered) {
    if (!offlineV5OperationReadyForManifest(manifest, operation)) continue
    if (operation.depends_on_operation_id && pendingIDs.has(operation.depends_on_operation_id) && !sendableIDs.has(operation.depends_on_operation_id)) continue
    sendableIDs.add(operation.operation_id)
    sendable.push(operation)
  }
  return sendable
}

export const OFFLINE_V5_ENGINE_ACTIONS = OFFLINE_V5_ACTIONS
