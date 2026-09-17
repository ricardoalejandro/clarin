import type { JWK } from 'jose'

export const OFFLINE_V3_PROTOCOL = 3 as const
export const OFFLINE_V3_LOCAL_ORIGIN = 'http://127.0.0.1:17373' as const

export type OfflineJWK = JWK & { kid?: string }
export type OfflineKeyedJWK = JWK & { kid: string }

export type OfflineModule = 'tasks' | 'contacts' | 'programs' | 'whiteboards'
export type OfflineAction =
  | 'tasks.read'
  | 'tasks.create'
  | 'tasks.complete'
  | 'contacts.read'
  | 'programs.read'
  | 'whiteboards.read'

export interface OfflineHealth {
  protocol: 3
  service: 'clarin-offline'
  service_version: string
  engine_state: 'starting' | 'ready' | 'blocked'
  configured_origin: string
  server_reachability: 'unknown' | 'reachable' | 'unreachable'
  now: string
}

export interface BrowserIdentityRecord {
  version: 1
  privateKey: CryptoKey
  publicKey: CryptoKey
  publicJwk: OfflineJWK
  browserProfileId?: string
  trust?: BrowserTransportTrust
  pendingEnrollmentRequestIds?: string[]
  createdAt: string
}

export interface BrowserTransportTrust {
  serverOrigin: string
  descriptorJws: string
  signerKeys: OfflineKeyedJWK[]
  signerKeyVersion: number
  pinnedAt: string
}

export interface ServiceDescriptorEnvelope {
  service_descriptor: string
  signer_public_keys: {
    keys: OfflineKeyedJWK[]
    key_version: number
  }
}

export interface LocalServiceDescriptor extends ServiceDescriptorEnvelope {
  possession: string
}

export interface PrincipalChallenge {
  challenge_id: string
  launch_uri: string
  expires_at: string
  state: 'waiting'
}

export interface OnlineEnrollmentChallenge {
  challenge_id: string
  nonce: string
  authorization_id: string
  expires_at: string
  server_time?: string
}

export interface LocalEnrollmentMaterial {
  challenge_id: string
  nonce: string
  installation_id: string
  windows_principal_id: string
  browser_profile_id: string
  authorization_id: string
  display_name: string
  principal_display_name: string
  browser_name: string
  client_version: string
  sid_hash: string
  installation_signing_jwk: OfflineKeyedJWK
  service_encryption_jwk: OfflineKeyedJWK
  browser_dpop_jwk: OfflineKeyedJWK
  installation_signature: string
  principal_signature: string
  browser_proof_claims: Record<string, unknown>
}

export interface OnlineEnrollmentRequestInput {
  challenge_id: string
  nonce: string
  installation_id: string
  windows_principal_id: string
  browser_profile_id: string
  authorization_id: string
  display_name: string
  principal_display_name: string
  browser_name: string
  client_version: string
  sid_hash: string
  installation_signing_jwk: OfflineKeyedJWK
  service_encryption_jwk: OfflineKeyedJWK
  browser_dpop_jwk: OfflineKeyedJWK
  installation_signature: string
  principal_signature: string
  browser_signature: string
}

export interface BrowserChallenge {
  challenge_id: string
  challenge: string
  nonce: string
  expires_at: string
  unlock_encryption_jwk: OfflineJWK
}

export interface BrowserProfileProof {
  browser_profile_id: string
  state: 'pending' | 'active' | 'revoked'
  profile_epoch: number
}

export interface GrantSummary {
  grant_id: string
  state: 'pending' | 'preparing' | 'available' | 'expired' | 'revoked' | 'error'
  display_user: string
  display_account: string
  actions: OfflineAction[]
  ready: boolean
  needs_online_provision?: boolean
  lease_expires_at?: string
  last_sync_at?: string
  pending_count: number
  conflict_count: number
  selection_revision: number
  selection_total?: number
  selection_ready?: number
  selection_errors?: number
}

export interface OfflineActor {
  user_id: string
  username: string
  display_name: string
  account_id: string
  account_name: string
}

export interface OfflineSession {
  session_id: string
  capability: string
  profile_epoch: number
  idle_expires_at: string
  lease_expires_at: string
  actor: OfflineActor
  actions: OfflineAction[]
}

export interface SyncStatus {
  state: 'idle' | 'waiting_network' | 'syncing' | 'blocked' | 'error'
  server_reachability: 'unknown' | 'reachable' | 'unreachable'
  phase?: 'controls' | 'lease' | 'upload' | 'download' | 'commit'
  completed?: number
  total?: number
  pending_count: number
  conflict_count: number
  outcome_unknown_count: number
  last_attempt_at?: string
  last_success_at?: string
  next_attempt_at?: string
  lease_expires_at: string
  selection_revision: number
  last_error?: { code: string; message: string; retryable: boolean }
}

export interface OfflineResource {
  selection_id: string
  resource_id: string
  module: OfflineModule
  resource_type: string
  label: string
  readiness: 'preparing' | 'available' | 'error'
  head_version: number
  content_hash: string
  item_count: number
  byte_size: number
  last_synced_at?: string
  error_code?: string
}

export interface SnapshotMeta {
  selection_revision: number
  head_version: number
  last_synced_at: string
}

export interface OfflinePage<T> {
  items: T[]
  next_cursor?: string
  snapshot: SnapshotMeta
}

export interface OfflineTaskList {
  selection_id: string
  id: string
  name: string
  environment_id: string
  environment_name: string
  can_create?: boolean
  statuses: Array<{ id: string; name: string; color: string; category: 'not_started' | 'active' | 'done' | 'cancelled' }>
}

export interface OfflineTask {
  id: string
  version: number
  title: string
  description: string
  priority: 'low' | 'medium' | 'high' | 'urgent'
  status?: 'pending' | 'completed' | 'cancelled'
  status_category?: 'not_started' | 'active' | 'done' | 'cancelled'
  can_complete?: boolean
  status_id?: string
  status_name?: string
  status_color?: string
  list_id: string
  list_name?: string
  assigned_to_name?: string
  start_at?: string
  due_at?: string
  due_end_at?: string
  is_all_day: boolean
  completed_at?: string
  created_at?: string
  updated_at?: string
  local_confirmation?: 'pending' | 'confirmed' | 'conflict' | 'rejected'
}

export interface OfflineContact {
  id: string
  version: number
  display_name: string
  name?: string
  last_name?: string
  phone?: string
  email?: string
  observations?: Array<{ id: string; notes: string; type: string; created_at: string; created_by_name?: string }>
  direct_observations?: Array<{ id: string; notes: string; type: string; created_at: string; author?: string }>
  phones?: Array<{ id: string; phone: string; label: string }>
  tags?: Array<{ id: string; name: string; color: string }>
  notes?: string
  do_not_contact?: boolean
  address?: string
  district?: string
  occupation?: string
  custom_fields?: Array<{ id: string; name: string; type: string; text?: string; number?: string; date?: string; bool?: boolean; json?: unknown }>
}

export interface OfflineConflict {
  operation_id: string
  selection_id: string
  resource_id: string
  status: 'conflict' | 'rejected'
  error_code?: string
  client_change: Partial<OfflineTask>
  server_result?: { task?: Partial<OfflineTask> }
  created_at: string
}

export interface OfflineProgramParticipant {
  id: string
  contact_id: string
  name?: string
  display_name?: string
  status: string
  enrolled_at: string
  dropped_at?: string
  completed_at?: string
}

export interface OfflineProgramAttendance {
  id: string
  session_id: string
  participant_id: string
  status: string
  notes: string
  session_date: string
}

export interface OfflineProgram {
  id: string
  version: number
  name: string
  description?: string
  status?: string
  participant_count?: number
  session_count?: number
  sessions?: Array<{ id: string; date: string; title?: string; topic?: string }>
  participants?: OfflineProgramParticipant[]
  active_roster?: OfflineProgramParticipant[]
  historical_participations?: OfflineProgramParticipant[]
  eligible_attendance?: OfflineProgramAttendance[]
  out_of_window_history?: OfflineProgramAttendance[]
}

export interface OfflineWhiteboard {
  id: string
  version: number
  name: string
  description?: string
  updated_at: string
  scene_sequence?: number
  sequence?: number
  editor_version?: string
  scene?: { elements: unknown[]; appState?: Record<string, unknown>; app_state?: Record<string, unknown>; files?: Record<string, unknown> }
  assets?: Array<{ file_id: string; content_hash: string; content_type: string; data_base64: string; size_bytes: number }>
}

export interface UnlockChallenge {
  challenge_id: string
  nonce: string
  expires_at: string
  credential_encryption_jwk: OfflineJWK
  service_descriptor: string
  password_kdf: { name: 'argon2id'; memory_kib: 65536; iterations: 3; parallelism: 1 }
}

export interface UnlockResult {
  session: OfflineSession
  sync: SyncStatus
}

export interface ProvisionChallenge extends UnlockChallenge {}

export interface GrantKeyChallenge {
  challenge_id: string
  nonce: string
  expires_at?: string
}

export interface GrantProvisionResult {
  state: 'registering'
  key_registration: {
    challenge_id: string
    nonce: string
    counter: number
    signing_jwk: OfflineKeyedJWK
    encryption_jwk: OfflineKeyedJWK
    installation_signature: string
    grant_signature: string
    browser_proof_claims: Record<string, unknown>
  }
}

export interface GrantLeaseProofResult {
  state: 'authorizing'
  lease_proof: {
    challenge_id: string
    nonce: string
    counter: number
    installation_signature: string
    grant_signature: string
    browser_proof_claims: Record<string, unknown>
  }
}

export interface GrantLeaseRequest {
  challenge_id: string
  nonce: string
  counter: number
  installation_signature: string
  browser_signature: string
  grant_signature: string
}

export interface GrantActivationBundle extends ServiceDescriptorEnvelope {
  lease: string
  transport_capability: string
  server_intake_jwk: OfflineKeyedJWK
  display_user: string
  display_account: string
  selections: OfflineResource[]
  server_time?: string
}

export interface GrantLeaseActivationBundle extends ServiceDescriptorEnvelope {
  lease: string
  display_user: string
  display_account: string
  selections: OfflineResource[]
  server_time?: string
}

export interface GrantLeaseActivationResult {
  state: 'updated'
  profile_epoch: number
}

export interface TaskCreateInput {
  operation_id: string
  selection_id: string
  task_id: string
  client_occurred_at: string
  patch: {
    title: string
    description: string
    start_at: string | null
    due_at: string | null
    due_end_at: string | null
    is_all_day: boolean
    priority: 'low' | 'medium' | 'high'
  }
}

export interface TaskCompleteInput {
  operation_id: string
  selection_id: string
  base_version: number
  client_occurred_at: string
}

export interface QueuedTaskResult {
  operation_id: string
  state: 'queued' | 'noop'
  local_task: OfflineTask
  pending_count: number
  sync: SyncStatus
}

export interface LocalServiceErrorBody {
  error: string
  message?: string
  request_id?: string
  profile_epoch?: number
}

export class LocalServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly profileEpoch?: number,
  ) {
    super(message)
    this.name = 'LocalServiceError'
  }
}
