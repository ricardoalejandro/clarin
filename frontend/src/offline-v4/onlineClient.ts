import type { JWK } from 'jose'
import { signClaims } from './crypto'
import { BrowserOfflineError, type BrowserGrant, type BrowserProfile, type GrantIdentity, type Operation, type Snapshot } from './types'
import type { OfflineAction, OfflineResource } from '../offline-v3/types'

export interface ServerGrant {
  grant_id: string; browser_profile_id: string; user_id: string; account_id: string; account_name: string
  display_user: string; username: string; state: string; actions: OfflineAction[]; effective_actions?: OfflineAction[]
  max_resources: number; quota_bytes: number; max_offline_seconds: number; selection_revision: number; credential_epoch: number; authority_epoch: number
}
export interface LeaseResponse {
  grant: ServerGrant
  lease: string
  signer_public_keys: { keys: JWK[] }
  snapshots: Snapshot[]
  receipts: Array<{ operation_id: string; status: string; error_code?: string; resource_id?: string; server_version?: number; result?: { task?: Record<string, unknown> } }>
  state: string
  server_time: string
}
export interface Challenge { challenge_id: string; nonce: string; expires_at: string }
export class BrowserAPIError extends BrowserOfflineError {
  constructor(readonly status: number, code: string, message: string, readonly infrastructure = false) { super(code, message) }
}
// The API caps the raw sync JSON at 2 MiB. Leave a conservative 64 KiB
// transport/proof reserve; proofs are headers and never enter the signed body.
export const SYNC_BODY_BUDGET_BYTES = 2 * 1024 * 1024 - 64 * 1024
export const SYNC_BATCH_OPERATIONS = 50
const sizingChallenge = { challenge_id: '00000000-0000-4000-8000-000000000000', nonce: 'A'.repeat(43) }
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
function wireOperation({ browser_id, ...operation }: Operation) { return { ...operation, browser_profile_id: browser_id } }
export function syncRequestBody(browserID: string, grantID: string, selectionRevision: number, operations: readonly Operation[], wantSnapshots: readonly string[], challenge: Pick<Challenge, 'challenge_id' | 'nonce'>) {
  return { grant_id: grantID, browser_profile_id: browserID, challenge_id: challenge.challenge_id, nonce: challenge.nonce, selection_revision: selectionRevision, operations: operations.map(wireOperation), want_snapshots: wantSnapshots }
}
/** Preserve operation objects/IDs and caller-provided dependency order, including across batches. */
export function batchSyncOperations(browserID: string, grantID: string, selectionRevision: number, operations: readonly Operation[]): Operation[][] {
  // Server challenges use a UUID and a 32-byte base64url nonce. Count the whole
  // envelope, then add each exact wire JSON plus its array comma, in linear time.
  const emptyBytes = jsonBytes(syncRequestBody(browserID, grantID, selectionRevision, [], [], sizingChallenge))
  const batches: Operation[][] = [], current: Operation[] = []
  let bytes = emptyBytes
  for (const operation of operations) {
    const operationBytes = jsonBytes(wireOperation(operation))
    if (emptyBytes + operationBytes > SYNC_BODY_BUDGET_BYTES) throw new BrowserOfflineError('operation_too_large', 'Un cambio pendiente supera el tamaño permitido para sincronizar. Se conserva completo en este navegador; solicita ayuda antes de borrar la copia.')
    if (current.length && (current.length >= SYNC_BATCH_OPERATIONS || bytes + operationBytes + 1 > SYNC_BODY_BUDGET_BYTES)) {
      batches.push(current.splice(0)); bytes = emptyBytes
    }
    bytes += operationBytes + (current.length ? 1 : 0)
    current.push(operation)
  }
  // Preflight the entire queue before sending any batch, so an oversized item
  // cannot silently skip itself, lose its dependencies or cause partial upload.
  if (current.length || !batches.length) batches.push(current)
  return batches
}
export function wireSigningKey(jwk: JWK, kid: string): JWK {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y || jwk.d) throw new BrowserOfflineError('invalid_public_key', 'La clave pública del navegador no es válida.')
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, use: 'sig', alg: 'ES256', kid }
}
export function limitUTF8(value: string, maximumBytes: number): string {
  let result = '', bytes = 0
  for (const character of value.trim()) {
    const size = new TextEncoder().encode(character).length
    if (bytes + size > maximumBytes) break
    result += character; bytes += size
  }
  return result
}
export function normalizeSelection(item: Partial<OfflineResource> & { id?: string; grant_id?: string }, grantID: string): OfflineResource {
  const selectionID = item.selection_id || item.id
  if (!selectionID || !item.resource_id || !item.module || !['tasks', 'contacts', 'programs', 'whiteboards'].includes(item.module) || !item.resource_type
      || item.grant_id && item.grant_id !== grantID || item.id && item.selection_id && item.id !== item.selection_id) throw new BrowserOfflineError('invalid_selection', 'La selección recibida no corresponde a esta autorización.')
  return { selection_id: selectionID, resource_id: item.resource_id, module: item.module, resource_type: item.resource_type, label: item.label || 'Recurso seleccionado', readiness: 'preparing', head_version: item.head_version || 0, content_hash: item.content_hash || '', item_count: 0, byte_size: 0 }
}
export function normalizeGrant(grant: ServerGrant, origin: string): BrowserGrant {
  return { ...grant, origin, browser_id: grant.browser_profile_id, username: grant.username || '', display_user: grant.display_user || grant.username || '' }
}
export class BrowserOnlineClient {
  // WebIDL fetch requires the Window/WorkerGlobalScope receiver. Keeping the
  // native method as a class property and calling this.fetcher() breaks Chromium.
  constructor(readonly origin: string, private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)) {}
  async request<T>(path: string, body?: unknown, options: { token?: string; headers?: Record<string, string>; signal?: AbortSignal; method?: string } = {}): Promise<T> {
    if (!path.startsWith('/api/offline/v4/')) throw new BrowserOfflineError('invalid_api', 'Ruta offline no permitida.')
    const serialized = body === undefined ? undefined : JSON.stringify(body)
    const timeout = AbortSignal.timeout(20000)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let response: Response
    try { response = await this.fetcher(new URL(path, this.origin), { method: options.method || (serialized === undefined ? 'GET' : 'POST'), headers, body: serialized, credentials: options.token ? 'include' : 'omit', cache: 'no-store', redirect: 'error', signal }) }
    catch { throw new BrowserAPIError(0, 'network_unavailable', 'No se pudo conectar con Clarín.', true) }
    if (response.headers.get('X-Clarin-Response') !== '1' || !response.headers.get('Content-Type')?.includes('application/json')) throw new BrowserAPIError(response.status, 'untrusted_response', 'Clarín o la protección de acceso no están disponibles.', true)
    const payload = await response.json()
    if (!response.ok) throw new BrowserAPIError(response.status, payload.error || 'request_rejected', payload.message || 'Clarín rechazó la operación.')
    return payload as T
  }
  async proof(profile: BrowserProfile, key: JWK | undefined, purpose: string, path: string, body: unknown, challenge: Challenge, grantID?: string): Promise<Record<string, string>> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body))))
    const now = Math.floor(Date.now() / 1000)
    const claims = { version: 4, purpose, challenge_id: challenge.challenge_id, nonce: challenge.nonce, method: 'POST', path, body_sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join(''), aud: this.origin, browser_profile_id: profile.browser_id, ...(grantID ? { grant_id: grantID } : {}), iat: now, exp: now + 120, jti: crypto.randomUUID() }
    const headers: Record<string, string> = { 'X-Clarin-Browser-Proof': await signClaims(profile.private_key, claims, 'clarin-offline-v4-proof+jwt') }
    if (key) headers['X-Clarin-Grant-Proof'] = await signClaims(key, { ...claims, jti: crypto.randomUUID() }, 'clarin-offline-v4-proof+jwt')
    return headers
  }
  async enroll(profile: BrowserProfile, token: string, browserName: string) {
    const challenge = await this.request<Challenge>('/api/offline/v4/enrollment/challenge', {}, { token })
    const path = '/api/offline/v4/enrollment/requests'
    const name = browserName.trim() || 'Este navegador en este equipo'
    const body = { challenge_id: challenge.challenge_id, nonce: challenge.nonce, browser_profile_id: profile.browser_id, browser_name: limitUTF8(name, 80), display_name: limitUTF8(name, 160), client_version: '4.0.0', signing_jwk: wireSigningKey(profile.public_jwk, profile.browser_id) }
    return this.request<{ request: { id: string; state: string; browser_profile_id: string; user_id: string } }>(path, body, { token, headers: await this.proof(profile, undefined, 'enrollment', path, body, challenge) })
  }
  grants(profile: BrowserProfile, token: string) { return this.request<{ items: ServerGrant[] }>(`/api/offline/v4/grants?browser_profile_id=${encodeURIComponent(profile.browser_id)}`, undefined, { token }) }
  async selection(grantID: string, token: string) {
    const response = await this.request<{ items: Array<Partial<OfflineResource> & { id?: string; grant_id?: string }>; selection_revision: number }>(`/api/offline/v4/grants/${encodeURIComponent(grantID)}/selection`, undefined, { token })
    if (!Array.isArray(response.items) || response.items.length > 20 || !Number.isSafeInteger(response.selection_revision) || response.selection_revision < 0) throw new BrowserOfflineError('invalid_selection', 'La selección recibida no es válida.')
    return { items: response.items.map(item => normalizeSelection(item, grantID)), selection_revision: response.selection_revision }
  }
  async registerKeys(profile: BrowserProfile, grantID: string, publicJWK: JWK, privateJWK: JWK, login: string, password: string, token: string) {
    const challenge = await this.request<Challenge>(`/api/offline/v4/grants/${encodeURIComponent(grantID)}/challenge`, {}, { token })
    const path = `/api/offline/v4/grants/${encodeURIComponent(grantID)}/keys`
    const body = { challenge_id: challenge.challenge_id, nonce: challenge.nonce, browser_profile_id: profile.browser_id, signing_jwk: wireSigningKey(publicJWK, grantID), login, password }
    return this.request(path, body, { token, headers: await this.proof(profile, privateJWK, 'keys', path, body, challenge, grantID) })
  }
  async sync(profile: BrowserProfile, identity: GrantIdentity, grantKey: JWK, selectionRevision: number, operations: Operation[], wantSnapshots: string[], signal?: AbortSignal): Promise<LeaseResponse> {
    const challenge = await this.request<Challenge>('/api/offline/v4/sync/challenge', { grant_id: identity.grant_id, browser_profile_id: profile.browser_id }, { signal })
    const path = '/api/offline/v4/sync'
    const body = syncRequestBody(profile.browser_id, identity.grant_id, selectionRevision, operations, wantSnapshots, challenge)
    if (operations.length > SYNC_BATCH_OPERATIONS || jsonBytes(body) > SYNC_BODY_BUDGET_BYTES) throw new BrowserOfflineError('sync_request_too_large', 'El lote supera el tamaño seguro para sincronizar. Los cambios pendientes se conservan en este navegador.')
    return this.request<LeaseResponse>(path, body, { signal, headers: await this.proof(profile, grantKey, 'sync', path, body, challenge, identity.grant_id) })
  }
}
