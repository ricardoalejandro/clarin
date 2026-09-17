import type { JWK } from 'jose'
import type { OfflineAction, OfflineActor, OfflineResource, OfflineSession, SyncStatus } from '../offline-v3/types'
export type { OfflineAction, OfflineActor, OfflineResource, OfflineSession, SyncStatus }

export const PROTOCOL = 4 as const
export const WORKER_SCHEMA = 1 as const
export const MAX_RESOURCES = 20
export const MAX_BYTES = 5 * 1024 ** 3
export const IDLE_MS = 30 * 60 * 1000
export const LEASE_MS = 24 * 60 * 60 * 1000
export const WORKER_URL = '/offline-v4/worker.js'

export interface BrowserProfile {
  browser_id: string
  public_jwk: JWK
  private_key: CryptoKey
  created_at: string
}
export interface GrantIdentity {
  origin: string
  browser_id: string
  grant_id: string
  user_id: string
  account_id: string
}
export interface BrowserGrant extends GrantIdentity {
  display_user: string
  username: string
  account_name: string
  state: string
  actions: OfflineAction[]
  effective_actions?: OfflineAction[]
  max_resources: number
  quota_bytes: number
  selection_revision: number
  lease_expires_at?: string
  last_sync_at?: string
}
export interface Ciphertext { version: 1; iv: string; ciphertext: string }
export interface VaultEnvelope {
  identity: GrantIdentity
  lookup_tag: string
  salt: string
  iterations: 600000
  wrapped_key: Ciphertext
  encrypted_metadata: Ciphertext
  lease: string
  signer_keys: JWK[]
  state: 'preparing' | 'available' | 'revoked'
  updated_at: number
}
export interface VaultMetadata {
  grant: BrowserGrant
  actor: OfflineActor
  grant_private_jwk: JWK
  credential_epoch: number
  authority_epoch: number
  selections: OfflineResource[]
  persistent: boolean
  last_sync_at?: string
  highest_time: number
}
export interface LocalGrantSummary {
  grant_id: string
  state: 'preparing' | 'available' | 'revoked' | 'expired'
  /** Names are supplied only after successful password unlock. */
  label: string
}
export interface BrowserCapabilities {
  supported: boolean
  persistent: boolean
  usage: number
  quota: number
  reason?: string
}
export interface BrowserState {
  generation: number
  session: OfflineSession | null
  grant_id?: string
  sync?: SyncStatus
  persistent?: boolean
  preparing?: { completed: number; total: number }
  error?: string
}
export interface StoredRecord {
  id: string
  grant_id: string
  kind: 'snapshot' | 'task' | 'operation' | 'conflict'
  ciphertext: Ciphertext
  byte_size: number
}
export interface Snapshot {
  protocol_version: number
  browser_id?: string
  browser_profile_id: string
  grant_id: string
  user_id: string
  account_id: string
  selection_id: string
  module: string
  resource_type: string
  resource_id: string
  selection_revision: number
  head_version: number
  content_hash: string
  payload: Record<string, unknown>
  payload_json: string
  tombstone: boolean
  generated_at: string
}
export interface Operation {
  protocol_version: 4
  browser_id: string
  grant_id: string
  user_id: string
  account_id: string
  operation_id: string
  action: 'tasks.create' | 'tasks.complete'
  selection_id: string
  resource_id: string
  selection_revision: number
  credential_epoch: number
  authority_epoch: number
  base_version: number
  depends_on_operation_id?: string
  payload: unknown
  occurred_at: string
}
export class BrowserOfflineError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BrowserOfflineError' }
}
