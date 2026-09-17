import type {
  GrantActivationBundle,
  GrantLeaseActivationBundle,
  GrantLeaseRequest,
  OfflineAction,
  OfflineKeyedJWK,
  OfflineModule,
  OfflineResource,
  OnlineEnrollmentChallenge,
  OnlineEnrollmentRequestInput,
  ServiceDescriptorEnvelope,
} from './types'

export class OfflineV3APIError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly infrastructure = false) {
    super(message)
    this.name = 'OfflineV3APIError'
  }
}

export interface OnlineGrant {
  grant_id: string
  installation_id: string
  windows_principal_id: string
  browser_profile_id: string
  authorization_id: string
  user_id: string
  account_id: string
  display_user: string
  account_name: string
  state: string
  actions: OfflineAction[]
  effective_actions: OfflineAction[]
  max_resources: number
  quota_bytes: number
  keys_ready: boolean
  selection_revision: number
  lease_expires_at?: string
  last_sync_at?: string
}

export interface EnrollmentRequestStatus {
  id: string
  state: 'requested' | 'approved' | 'rejected' | 'revoked'
  installation_id: string
  windows_principal_id: string
  browser_profile_id: string
  authorization_id: string
  user_id: string
  display_name: string
  principal_display_name: string
  user_display_name?: string
  client_version: string
  requested_at: string
  decided_at?: string
}

export interface AdminOfflineGrant extends OnlineGrant {
  installation_name?: string
  principal_name?: string
  browser_name?: string
  installation_state: string
  principal_state: string
  browser_state: string
  authorization_state: string
}

export type AdminOfflineControlScope =
  | 'installation'
  | 'windows_principal'
  | 'browser_profile'
  | 'authorization'
  | 'grant'
  | 'account'
  | 'user'
  | 'installation_account'
  | 'installation_user'

export interface AdminOfflineControlInput {
  scope: AdminOfflineControlScope
  scope_id: string
  installation_id?: string
  action: 'lock' | 'wipe'
}

export interface SelectionCandidate {
  resource_id: string
  resource_type: string
  module: OfflineModule
  label: string
  subtitle?: string
}

export interface GrantKeyRegistrationRequest {
  challenge_id: string
  nonce: string
  counter: number
  signing_jwk: OfflineKeyedJWK
  encryption_jwk: OfflineKeyedJWK
  installation_signature: string
  browser_signature: string
  grant_signature: string
}

export type OnlineGrantActivationBundle = Omit<GrantActivationBundle, 'server_intake_jwk' | 'display_user' | 'display_account'> & {
  lease_expires_at: string
  selection_revision: number
  selection_digest: string
  grant: OnlineGrant
}
export type OnlineGrantLeaseBundle = Omit<GrantLeaseActivationBundle, 'display_user' | 'display_account'> & {
  expires_at: string
  lease_expires_at: string
  selection_revision: number
  selection_digest: string
  grant: OnlineGrant
}

export function localGrantActivationBundle(server: OnlineGrantActivationBundle, serverIntakeJWK: OfflineKeyedJWK): GrantActivationBundle {
  return {
    lease: server.lease,
    service_descriptor: server.service_descriptor,
    signer_public_keys: server.signer_public_keys,
    transport_capability: server.transport_capability,
    server_intake_jwk: serverIntakeJWK,
    display_user: server.grant.display_user,
    display_account: server.grant.account_name,
    selections: server.selections,
    server_time: server.server_time,
  }
}

export function localGrantLeaseActivationBundle(server: OnlineGrantLeaseBundle): GrantLeaseActivationBundle {
  return {
    lease: server.lease,
    service_descriptor: server.service_descriptor,
    signer_public_keys: server.signer_public_keys,
    display_user: server.grant.display_user,
    display_account: server.grant.account_name,
    selections: server.selections,
    server_time: server.server_time,
  }
}

interface SyncIntakeKeySet {
  keys: OfflineKeyedJWK[]
  key_id: string
  key_version: number
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT'
  body?: unknown
  signal?: AbortSignal
}

async function onlineRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!path.startsWith('/api/offline/v3/') && !path.startsWith('/api/admin/offline-v3/')) throw new Error('Ruta offline del servidor no permitida.')
  const token = typeof window === 'undefined' ? '' : localStorage.getItem('token') || ''
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  let response: Response
  try {
    response = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'include',
      cache: 'no-store',
      signal: options.signal,
    })
  } catch {
    throw new OfflineV3APIError(0, 'network_unavailable', 'No se pudo conectar con Clarin.', true)
  }
  if (response.status === 204) return undefined as T
  const contentType = response.headers.get('content-type') || ''
  const trusted = response.headers.get('X-Clarin-Response') === '1' && contentType.includes('application/json')
  const payload = trusted ? await response.json().catch(() => null) as T | { error?: string; message?: string } | null : null
  if (!trusted) throw new OfflineV3APIError(response.status, 'untrusted_server_response', 'La protección de acceso o Clarin no devolvieron una respuesta verificable.', true)
  if (!response.ok) {
    const error = payload as { error?: string; message?: string } | null
    throw new OfflineV3APIError(response.status, error?.error || `http_${response.status}`, error?.message || 'Clarin rechazó la operación offline.')
  }
  return payload as T
}

export function createEnrollmentChallenge(signal?: AbortSignal) {
  return onlineRequest<OnlineEnrollmentChallenge>('/api/offline/v3/enrollment/challenge', { method: 'POST', body: {}, signal })
}

export function submitEnrollmentRequest(input: OnlineEnrollmentRequestInput, signal?: AbortSignal) {
  return onlineRequest<{ request: EnrollmentRequestStatus; idempotent: boolean }>('/api/offline/v3/enrollment/requests', { method: 'POST', body: input, signal })
}

export function enrollmentRequestStatus(requestId: string, signal?: AbortSignal) {
  return onlineRequest<{ request: EnrollmentRequestStatus; grants: OnlineGrant[]; service_descriptor?: string; signer_public_keys?: ServiceDescriptorEnvelope['signer_public_keys'] }>(`/api/offline/v3/enrollment/requests/${encodeURIComponent(requestId)}`, { signal })
}

export function onlineGrants(signal?: AbortSignal) {
  return onlineRequest<{ grants: OnlineGrant[]; signer_public_keys: ServiceDescriptorEnvelope['signer_public_keys'] }>('/api/offline/v3/grants', { signal })
}

export function selectionCandidates(grantId: string, module: OfflineModule, query: string, signal?: AbortSignal) {
  const search = new URLSearchParams({ module, q: query, limit: '50' })
  return onlineRequest<{ items: SelectionCandidate[]; next_cursor?: string }>(`/api/offline/v3/grants/${encodeURIComponent(grantId)}/resources?${search}`, { signal })
}

export function grantSelection(grantId: string, signal?: AbortSignal) {
  return onlineRequest<{ items: OfflineResource[]; selection_revision: number; selection_digest: string }>(`/api/offline/v3/grants/${encodeURIComponent(grantId)}/selection`, { signal })
}

export function replaceGrantSelection(grantId: string, revision: number, items: Array<Pick<SelectionCandidate, 'module' | 'resource_type' | 'resource_id'>>) {
  return onlineRequest<{ items: OfflineResource[]; selection_revision: number; selection_digest: string }>(`/api/offline/v3/grants/${encodeURIComponent(grantId)}/selection`, {
    method: 'PUT', body: { selection_revision: revision, items },
  })
}

export function grantServerChallenge(grantId: string, purpose: 'grant_keys' | 'lease') {
  return onlineRequest<{ challenge_id: string; nonce: string; expires_at: string }>(`/api/offline/v3/grants/${encodeURIComponent(grantId)}/challenge`, { method: 'POST', body: { purpose } })
}

export function grantBootstrap(grantId: string, login: string, password: string, signal?: AbortSignal) {
  return onlineRequest<{ grant_bootstrap: string; expires_at: string; grant: OnlineGrant }>(`/api/offline/v3/grants/${encodeURIComponent(grantId)}/bootstrap`, {
    method: 'POST', body: { login, password }, signal,
  })
}

export async function currentSyncIntakeKey(signal?: AbortSignal) {
  const response = await onlineRequest<SyncIntakeKeySet>('/api/offline/v3/sync-keys', { signal })
  const key = response.keys?.find(item => item.kid === response.key_id)
  if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || key.use !== 'enc' || key.alg !== 'ECDH-ES+A256KW') {
    throw new OfflineV3APIError(502, 'invalid_sync_intake_key', 'Clarin no publicó una clave válida para la sincronización offline.', true)
  }
  return key
}

export function registerGrantKeys(grantId: string, input: GrantKeyRegistrationRequest) {
  return onlineRequest<OnlineGrantActivationBundle>(`/api/offline/v3/grants/${encodeURIComponent(grantId)}/keys`, { method: 'POST', body: input })
}

export function renewGrantLease(grantId: string, input: GrantLeaseRequest) {
  return onlineRequest<OnlineGrantLeaseBundle>(`/api/offline/v3/grants/${encodeURIComponent(grantId)}/lease`, { method: 'POST', body: input })
}

export function listAdminEnrollmentRequests(signal?: AbortSignal) {
  return onlineRequest<{ items: EnrollmentRequestStatus[]; next_cursor?: string }>('/api/admin/offline-v3/enrollment-requests', { signal })
}

export function listAdminGrants(signal?: AbortSignal) {
  return onlineRequest<{ items: AdminOfflineGrant[] }>('/api/admin/offline-v3/grants', { signal })
}

export function approveAdminEnrollment(requestId: string, accounts: Array<{ account_id: string; actions: OfflineAction[]; max_resources: number; quota_bytes: number }>) {
  return onlineRequest<{ grants: OnlineGrant[] }>(`/api/admin/offline-v3/enrollment-requests/${encodeURIComponent(requestId)}/approve`, { method: 'POST', body: { accounts } })
}

export function rejectAdminEnrollment(requestId: string, note = '') {
  return onlineRequest<void>(`/api/admin/offline-v3/enrollment-requests/${encodeURIComponent(requestId)}/reject`, { method: 'POST', body: { note } })
}

export function createAdminOfflineControl(input: AdminOfflineControlInput) {
  return onlineRequest<{ control?: unknown; state: string; control_ids?: string[]; affected_grants?: number }>('/api/admin/offline-v3/controls', { method: 'POST', body: input })
}

export function revokeAdminGrant(grantId: string) {
  return onlineRequest<{ control: unknown; state: string }>(`/api/admin/offline-v3/grants/${encodeURIComponent(grantId)}/revoke`, { method: 'POST', body: {} })
}
