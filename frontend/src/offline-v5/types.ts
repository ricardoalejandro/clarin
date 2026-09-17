import type { JWK } from 'jose'
import type { Ciphertext } from '../offline-v4/types'

export const OFFLINE_V5_PROTOCOL = 5 as const
export const OFFLINE_V5_SCHEMA = 1 as const
export const OFFLINE_V5_DB = 'clarin-offline-v5' as const
export const OFFLINE_V5_WORKER_URL = '/offline-v5/worker.js' as const
export const OFFLINE_V5_MAX_ROOTS = 20 as const
/** Must match the backend's signed-manifest admission limit. */
export const OFFLINE_V5_MAX_DEPENDENCIES = 20_000 as const
export const OFFLINE_V5_MAX_BYTES = 5 * 1024 ** 3
export const OFFLINE_V5_IDLE_MS = 30 * 60 * 1000
export const OFFLINE_V5_LEASE_MS = 24 * 60 * 60 * 1000
export const OFFLINE_V5_MAX_PAGE = 200 as const
export const OFFLINE_V5_MAX_OUTBOX = 1000 as const
export const OFFLINE_V5_BLOB_CHUNK_BYTES = 2 * 1024 * 1024

export type OfflineV5Module = 'tasks' | 'contacts' | 'programs' | 'whiteboards'
export type OfflineV5Action =
  | 'tasks.read'
  | 'tasks.create'
  | 'tasks.update'
  | 'tasks.complete'
  | 'tasks.reopen'
  | 'tasks.comments.create'
  | 'contacts.read'
  | 'contacts.update'
  | 'contacts.observations.create'
  | 'programs.read'
  | 'programs.update'
  | 'programs.participants.add'
  | 'programs.participants.lifecycle.update'
  | 'programs.sessions.upsert'
  | 'programs.attendance.set'
  | 'programs.observations.create'
  | 'programs.goals.update'
  | 'whiteboards.read'
  | 'whiteboards.scene.update'

export const OFFLINE_V5_ACTIONS: readonly OfflineV5Action[] = [
  'tasks.read',
  'tasks.create',
  'tasks.update',
  'tasks.complete',
  'tasks.reopen',
  'tasks.comments.create',
  'contacts.read',
  'contacts.update',
  'contacts.observations.create',
  'programs.read',
  'programs.update',
  'programs.participants.add',
  'programs.participants.lifecycle.update',
  'programs.sessions.upsert',
  'programs.attendance.set',
  'programs.observations.create',
  'programs.goals.update',
  'whiteboards.read',
  'whiteboards.scene.update',
] as const

export interface OfflineV5Identity {
  origin: string
  browser_profile_id: string
  grant_id: string
  user_id: string
  account_id: string
}

export interface OfflineV5Actor {
  user_id: string
  username: string
  display_name?: string
  account_id: string
  account_name: string
}

export interface OfflineV5Root {
  selection_id: string
  module: OfflineV5Module
  resource_type: string
  resource_id: string
  label?: string
}

export interface OfflineV5Dependency {
  selection_id?: string
  root_selection_id: string
  module: OfflineV5Module
  resource_type: string
  resource_id: string
  relationship?: string
  mutable?: boolean
}

export interface OfflineV5Capability {
  action: OfflineV5Action
  selection_id: string
  root_resource_id: string
  resource_type: string
  resource_id: string
}

export interface OfflineV5Manifest {
  protocol_version: 5
  id: string
  revision: number
  browser_profile_id: string
  grant_id: string
  user_id: string
  account_id: string
  username: string
  account_name: string
  selection_revision: number
  selection_digest: string
  credential_epoch: number
  authority_epoch: number
  grant_revision: number
  roots: OfflineV5Root[]
  dependencies: OfflineV5Dependency[]
  capabilities: OfflineV5Capability[]
  effective_actions?: OfflineV5Action[]
  entity_versions: Array<{ entity_type: string; entity_id: string; version: number }>
  chunk_hashes: Array<{ selection_id: string; head_version: number; content_hash: string }>
  digest: string
  canonical_json: string
  issued_at: string
  expires_at: string
  max_storage_bytes: number
}

export interface OfflineV5Snapshot {
  protocol_version: 5
  manifest_id: string
  manifest_revision: number
  selection_id: string
  root_selection_id: string
  root_resource_id: string
  module: OfflineV5Module
  resource_type: string
  resource_id: string
  dependency: boolean
  head_version: number
  content_hash: string
  payload: Record<string, unknown>
  /** Exact server bytes used for content_hash. Never hash a JS reserialization. */
  payload_json: string
  tombstone: boolean
  generated_at: string
}

export interface OfflineV5WhiteboardAssetDescriptor {
  id: string
  root_resource_id: string
  file_id: string
  content_hash: string
  content_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  size_bytes: number
}

export interface OfflineV5PreparedAsset {
  descriptor: OfflineV5WhiteboardAssetDescriptor
  root_selection_id: string
  bytes: Blob
}

export interface OfflineV5PrepareBundle {
  manifest: OfflineV5Manifest
  lease: string
  signer_public_keys: { keys: JWK[] }
  snapshots: OfflineV5Snapshot[]
  server_time: string
}

export interface OfflineV5VaultMetadata {
  actor: OfflineV5Actor
  manifest_id: string
  manifest_revision: number
  manifest_digest: string
  selection_revision: number
  credential_epoch: number
  authority_epoch: number
  grant_revision: number
  grant_private_jwk: JWK
  persistent: boolean
  highest_time: number
  last_sync_at?: string
}

export interface OfflineV5VaultEnvelope {
  format: 5
  identity: OfflineV5Identity
  namespace: string
  lookup_tag: string
  salt: string
  iterations: 600000
  wrapped_key: Ciphertext
  wrapped_index_key: Ciphertext
  encrypted_metadata: Ciphertext
  lease: string
  signer_keys: JWK[]
  state: 'preparing' | 'available' | 'revoked'
  updated_at: number
}

export type OfflineV5StoreName =
  | 'profiles'
  | 'vaults'
  | 'manifests'
  | 'entities'
  | 'operations'
  | 'conflicts'
  | 'blobs'
  | 'usage'
  | 'schema'

export type OfflineV5DataStoreName = Exclude<OfflineV5StoreName, 'profiles' | 'vaults' | 'usage' | 'schema'>

export interface OfflineV5StoredCipher {
  storage_key: string
  namespace: string
  record_type: string
  root_selection_id?: string
  status?: string
  sequence?: number
  created_at?: number
  byte_size: number
  ciphertext: Ciphertext
}

export interface OfflineV5StoredBlob extends OfflineV5StoredCipher {
  record_type: 'blob'
  entity_type: string
  entity_id: string
  chunk_count: number
  plaintext_bytes: number
  opfs_directory: string
}

export interface OfflineV5Operation {
  protocol_version: 5
  grant_id: string
  user_id: string
  account_id: string
  browser_profile_id: string
  operation_id: string
  action: OfflineV5Action
  selection_id: string
  resource_id: string
  selection_revision: number
  manifest_id: string
  manifest_revision: number
  credential_epoch: number
  authority_epoch: number
  base_version: number
  depends_on_operation_id?: string
  occurred_at: string
  payload: unknown
}

export interface OfflineV5Conflict {
  operation_id: string
  action: OfflineV5Action
  selection_id: string
  resource_id: string
  status: 'conflict' | 'rejected'
  error_code?: string
  fields?: string[]
  base?: unknown
  local?: unknown
  server?: unknown
  server_version?: number
  created_at: string
}

export interface OfflineV5Receipt {
  operation_id: string
  status: 'applied' | 'merged' | 'noop' | 'conflict' | 'pending' | 'rejected'
  error_code?: string
  resource_id?: string
  server_version?: number
  result?: Record<string, unknown>
  conflict?: { fields?: string[]; base?: unknown; local?: unknown; server?: unknown }
}

export interface OfflineV5RenewedSyncResponse extends OfflineV5PrepareBundle {
  receipts: OfflineV5Receipt[]
  renewal_available?: true
}

export interface OfflineV5ReceiptRecoveryResponse {
  receipts: OfflineV5Receipt[]
  renewal_available: false
  state: 'receipts_recovered'
  server_time: string
}

export type OfflineV5SyncResponse = OfflineV5RenewedSyncResponse | OfflineV5ReceiptRecoveryResponse

export interface OfflineV5SyncRequest {
  grant_id: string
  browser_profile_id: string
  challenge_id: string
  nonce: string
  manifest_id: string
  manifest_revision: number
  selection_revision: number
  operations: OfflineV5Operation[]
  want_snapshots: string[]
}

export interface OfflineV5CanonicalEntity<T = unknown> {
  entity_type: string
  entity_id: string
  root_selection_id: string
  root_resource_id: string
  version: number
  dependency: boolean
  value: T
}

export interface OfflineV5EntityPage<T = unknown> {
  items: Array<OfflineV5CanonicalEntity<T>>
  next_cursor?: string
}

export interface OfflineV5MutationInput<T = unknown> {
  operation_id?: string
  action: OfflineV5Action
  selection_id: string
  resource_id: string
  entity_type: string
  entity_id: string
  base_version: number
  depends_on_operation_id?: string
  payload: unknown
  /** Canonical optimistic value returned by the existing online component. */
  optimistic_value: T
}

export interface OfflineV5MutationResult<T = unknown> {
  operation_id: string
  state: 'queued' | 'duplicate'
  entity: OfflineV5CanonicalEntity<T>
  pending_count: number
}

export interface OfflineV5RouteRequest {
  url: string
  method: string
  headers: Array<[string, string]>
  body?: string
}

export interface OfflineV5RouteResponse {
  status: number
  headers?: Array<[string, string]>
  body?: string
  binary?: Blob
}

export interface OfflineV5LocalGrantSummary {
  grantId: string
  state: 'preparing' | 'available' | 'expired' | 'revoked'
  /** Account/user names remain encrypted; this label is intentionally generic. */
  label: string
}

export interface OfflineV5SessionSnapshot {
  generation: number
  active: boolean
  mode: 'offline' | 'syncing' | 'conflict' | 'locked' | 'unavailable'
  userId?: string
  accountId?: string
  authorizedModules: OfflineV5Module[]
  selectedRoots: Record<string, string[]>
  capabilities: OfflineV5Action[]
  pendingCount: number
  conflictCount: number
  lastSyncAt?: string
  leaseExpiresAt?: string
  error?: string
  /** A waiting v5 service worker becomes the controller after every Clarin tab closes and is reopened. */
  shellActivation?: 'current' | 'next-reopen'
}

export interface OfflineV5WorkerRequest {
  id: string
  protocol: 5
  schema: 1
  generation: number
  method: string
  args: unknown[]
}

export interface OfflineV5WorkerResult {
  type: 'result'
  id: string
  protocol: 5
  schema: 1
  generation: number
  result?: unknown
  error?: { code: string; message: string }
}

export class OfflineV5Error extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'OfflineV5Error'
  }
}
