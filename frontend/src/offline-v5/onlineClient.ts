import type { JWK } from 'jose'
import { createSigningKey, signClaims } from '../offline-v4/crypto'
import type { BrowserProfile } from '../offline-v4/types'
import { offlineV5WhiteboardAssetDescriptors } from './manifest'
import { base64url, sha256HexBytes } from './crypto'
import { OfflineV5Error, type OfflineV5Operation, type OfflineV5PrepareBundle, type OfflineV5PreparedAsset, type OfflineV5Root, type OfflineV5SyncRequest, type OfflineV5SyncResponse, type OfflineV5WhiteboardAssetDescriptor } from './types'

export interface OfflineV5Challenge { challenge_id: string; nonce: string; expires_at: string }
export interface OfflineV5ServerGrant {
  grant_id: string
  browser_profile_id: string
  user_id: string
  account_id: string
  username: string
  account_name: string
  state: string
  selection_revision: number
}

export class OfflineV5APIError extends OfflineV5Error {
  constructor(readonly status: number, code: string, message: string, readonly infrastructure = false) { super(code, message) }
}

export function offlineV5RequestMessage(status: number, code: string, supplied?: string): string {
  if (supplied?.trim()) return supplied.trim()
  switch (code) {
    case 'invalid_offline_selection':
      return 'No se pudo guardar la selección offline. Actualízala y vuelve a intentarlo.'
    case 'offline_state_conflict':
      return 'La operación entró en conflicto con otro cambio. Actualiza e inténtalo nuevamente.'
    case 'offline_retry_required':
      return 'Otra preparación terminó al mismo tiempo. Vuelve a intentarlo; tu autorización y selección se conservan.'
    case 'offline_selection_changed':
      return 'La selección cambió en otra pestaña. Vuelve a cargarla antes de continuar.'
    case 'offline_key_already_registered':
      return 'Esta autorización ya tiene una identidad offline preparada y no puede sustituirse porque existen datos protegidos.'
    case 'offline_resource_too_large':
      return 'Uno de los recursos supera el límite seguro del contenido estructurado. La selección y autorización se conservaron.'
    case 'offline_quota_exceeded':
      return 'Los recursos elegidos, incluidas sus imágenes, superan la cuota offline autorizada.'
    case 'offline_reauthentication_failed':
      return 'La contraseña actual de Clarín no es correcta.'
    case 'offline_reauthentication_throttled':
      return 'Se alcanzó el límite de intentos. Espera 15 minutos antes de volver a intentarlo.'
    case 'offline_reauthentication_unavailable':
      return 'Clarín no pudo verificar la contraseña en este momento. Vuelve a intentarlo.'
    case 'offline_access_denied':
    case 'offline_grant_not_found':
      return 'La autorización offline ya no está disponible. Actualiza esta pantalla.'
    case 'offline_proof_denied':
    case 'offline_key_denied':
    case 'offline_transport_denied':
      return 'La identidad protegida de este navegador ya no es válida. Solicita una nueva autorización.'
    case 'offline_prepare_disabled':
      return 'La preparación offline está temporalmente desactivada.'
    case 'offline_signer_unavailable':
      return 'Clarín no puede preparar el acceso offline en este momento. Vuelve a intentarlo.'
    default:
      return status === 429
        ? 'Se alcanzó el límite de intentos. Espera unos minutos antes de volver a intentarlo.'
        : 'Clarín rechazó la operación.'
  }
}

export function offlineV5SelectionInput(items: ReadonlyArray<Pick<OfflineV5Root, 'module' | 'resource_type' | 'resource_id'>>) {
  return items.map(({ module, resource_type, resource_id }) => ({ module, resource_type, resource_id }))
}

const SYNC_MAX_BYTES = 2 * 1024 * 1024 - 64 * 1024
const SYNC_MAX_OPERATIONS = 50
const encoder = new TextEncoder()

function jsonBytes(value: unknown) { return encoder.encode(JSON.stringify(value)).byteLength }

function publicSigningJWK(jwk: JWK, kid: string): JWK {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new OfflineV5Error('invalid_public_key', 'La clave pública del navegador no es válida.')
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, use: 'sig', alg: 'ES256', kid }
}

function limitedText(value: string, maximumBytes: number): string {
  let result = '', used = 0
  for (const character of value.trim()) {
    const size = encoder.encode(character).byteLength
    if (used + size > maximumBytes) break
    result += character; used += size
  }
  return result
}

export class OfflineV5OnlineClient {
  constructor(readonly origin: string, private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)) {}

  async request<T>(path: string, body?: unknown, options: { method?: string; authenticated?: boolean; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (!path.startsWith('/api/offline/v5/')) throw new OfflineV5Error('invalid_api', 'La ruta no pertenece al protocolo offline v5.')
    const serialized = body === undefined ? undefined : JSON.stringify(body)
    const timeoutMs = Math.max(1_000, Math.min(180_000, Number(options.timeoutMs) || 20_000))
    const timeout = AbortSignal.timeout(timeoutMs), signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers }
    if (serialized !== undefined) headers['Content-Type'] = 'application/json'
    let response: Response
    try {
      response = await this.fetcher(new URL(path, this.origin), { method: options.method || (serialized === undefined ? 'GET' : 'POST'), headers, body: serialized, credentials: options.authenticated ? 'include' : 'omit', cache: 'no-store', redirect: 'error', signal })
    } catch { throw new OfflineV5APIError(0, 'network_unavailable', 'No se pudo conectar con Clarín.', true) }
    if (response.headers.get('X-Clarin-Response') !== '1' || !response.headers.get('Content-Type')?.includes('application/json')) throw new OfflineV5APIError(response.status, 'untrusted_response', 'Clarín o la protección de acceso no están disponibles.', true)
    const payload = await response.json().catch(() => undefined) as { error?: string; message?: string } | undefined
    if (!response.ok) {
      const code = payload?.error || 'request_rejected'
      throw new OfflineV5APIError(response.status, code, offlineV5RequestMessage(response.status, code, payload?.message))
    }
    return payload as T
  }

  async proof(profile: BrowserProfile, grantKey: JWK | undefined, purpose: 'enrollment' | 'keys' | 'prepare' | 'sync' | 'status', path: string, body: unknown, challenge: OfflineV5Challenge, grantID?: string): Promise<Record<string, string>> {
    const bodyHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(body)))), byte => byte.toString(16).padStart(2, '0')).join('')
    const now = Math.floor(Date.now() / 1000)
    const claims = { version: 5, purpose, challenge_id: challenge.challenge_id, nonce: challenge.nonce, method: 'POST', path, body_sha256: bodyHash, aud: this.origin, browser_profile_id: profile.browser_id, ...(grantID ? { grant_id: grantID } : {}), iat: now, exp: now + 120, jti: crypto.randomUUID() }
    const headers: Record<string, string> = { 'X-Clarin-Browser-Proof': await signClaims(profile.private_key, claims, 'clarin-offline-v5-proof+jwt') }
    if (grantKey) headers['X-Clarin-Grant-Proof'] = await signClaims(grantKey, { ...claims, jti: crypto.randomUUID() }, 'clarin-offline-v5-proof+jwt')
    return headers
  }

  enrollmentChallenge() { return this.request<OfflineV5Challenge>('/api/offline/v5/enrollment/challenge', {}, { authenticated: true }) }

  async enroll(profile: BrowserProfile, displayName: string) {
    const challenge = await this.enrollmentChallenge(), path = '/api/offline/v5/enrollment/requests'
    const name = limitedText(displayName, 160) || 'Este navegador en este equipo'
    const body = { challenge_id: challenge.challenge_id, nonce: challenge.nonce, browser_profile_id: profile.browser_id, browser_name: limitedText(name, 80), display_name: name, client_version: '5.0.0', signing_jwk: publicSigningJWK(profile.public_jwk, profile.browser_id) }
    return this.request<{ request: { id: string; state: string; browser_profile_id: string; user_id: string } }>(path, body, { authenticated: true, headers: await this.proof(profile, undefined, 'enrollment', path, body, challenge) })
  }

  grants(profile: BrowserProfile) {
    return this.request<{ items: OfflineV5ServerGrant[] }>(`/api/offline/v5/grants?browser_profile_id=${encodeURIComponent(profile.browser_id)}`, undefined, { authenticated: true })
  }

  async activeLocalGrants(profile: BrowserProfile, grantIDs: readonly string[]): Promise<string[]> {
    if (!grantIDs.length || grantIDs.length > 200 || grantIDs.some(id => typeof id !== 'string' || !id)) {
      throw new OfflineV5Error('invalid_grant_status', 'No se pudo comprobar el estado de las copias offline.')
    }
    const path = '/api/offline/v5/grants/status'
    const challenge: OfflineV5Challenge = {
      challenge_id: crypto.randomUUID(),
      nonce: base64url(crypto.getRandomValues(new Uint8Array(32))),
      expires_at: new Date(Date.now() + 120_000).toISOString(),
    }
    const body = { challenge_id: challenge.challenge_id, nonce: challenge.nonce, browser_profile_id: profile.browser_id, grant_ids: [...new Set(grantIDs)] }
    const result = await this.request<{ active_grant_ids: string[] }>(path, body, {
      timeoutMs: 3_000,
      headers: await this.proof(profile, undefined, 'status', path, body, challenge),
    })
    if (!Array.isArray(result.active_grant_ids) || result.active_grant_ids.some(id => typeof id !== 'string' || !grantIDs.includes(id))) {
      throw new OfflineV5Error('invalid_grant_status', 'Clarín devolvió un estado de autorizaciones no verificable.')
    }
    return [...new Set(result.active_grant_ids)]
  }

  selection(grantID: string) {
    return this.request<{ items: OfflineV5Root[]; selection_revision: number }>(`/api/offline/v5/grants/${encodeURIComponent(grantID)}/selection`, undefined, { authenticated: true })
  }

  replaceSelection(grantID: string, revision: number, items: Array<Pick<OfflineV5Root, 'module' | 'resource_type' | 'resource_id'>>) {
    return this.request<{ items: OfflineV5Root[]; selection_revision: number }>(`/api/offline/v5/grants/${encodeURIComponent(grantID)}/selection`, { selection_revision: revision, items: offlineV5SelectionInput(items) }, { method: 'PUT', authenticated: true })
  }

  async registerKeys(profile: BrowserProfile, grant: OfflineV5ServerGrant, login: string, password: string, privateJWK?: JWK) {
    const keys = privateJWK ? { private_jwk: privateJWK, public_jwk: { ...privateJWK, d: undefined } } : await createSigningKey()
    const challenge = await this.request<OfflineV5Challenge>(`/api/offline/v5/grants/${encodeURIComponent(grant.grant_id)}/challenge`, {}, { authenticated: true })
    const path = `/api/offline/v5/grants/${encodeURIComponent(grant.grant_id)}/keys`
    const body = { challenge_id: challenge.challenge_id, nonce: challenge.nonce, browser_profile_id: profile.browser_id, signing_jwk: publicSigningJWK(keys.public_jwk, grant.grant_id), login, password }
    await this.request(path, body, { authenticated: true, headers: await this.proof(profile, keys.private_jwk, 'keys', path, body, challenge, grant.grant_id) })
    return keys.private_jwk
  }

  async prepare(profile: BrowserProfile, grant: OfflineV5ServerGrant, grantKey: JWK): Promise<OfflineV5PrepareBundle> {
    const challenge = await this.request<OfflineV5Challenge>(`/api/offline/v5/grants/${encodeURIComponent(grant.grant_id)}/prepare/challenge`, {}, { authenticated: true })
    const path = `/api/offline/v5/grants/${encodeURIComponent(grant.grant_id)}/prepare`
    const body = { challenge_id: challenge.challenge_id, nonce: challenge.nonce, browser_profile_id: profile.browser_id }
    return this.request<OfflineV5PrepareBundle>(path, body, { authenticated: true, timeoutMs: 180_000, headers: await this.proof(profile, grantKey, 'prepare', path, body, challenge, grant.grant_id) })
  }

  async downloadPreparedAssets(bundle: OfflineV5PrepareBundle, signal?: AbortSignal): Promise<OfflineV5PreparedAsset[]> {
    const pending = bundle.snapshots.flatMap(snapshot => offlineV5WhiteboardAssetDescriptors(snapshot).map(descriptor => ({
      descriptor,
      root_selection_id: snapshot.root_selection_id,
    })))
    const result = new Array<OfflineV5PreparedAsset>(pending.length)
    let cursor = 0
    const worker = async () => {
      for (;;) {
        const index = cursor++
        if (index >= pending.length) return
        const item = pending[index]
        result[index] = { ...item, bytes: await this.downloadPreparedAsset(item.descriptor, signal) }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, () => worker()))
    return result
  }

  private async downloadPreparedAsset(descriptor: OfflineV5WhiteboardAssetDescriptor, signal?: AbortSignal): Promise<Blob> {
    const path = `/api/whiteboards/${encodeURIComponent(descriptor.root_resource_id)}/assets/${encodeURIComponent(descriptor.id)}`
    let response: Response
    try {
      response = await this.fetcher(new URL(path, this.origin), { method: 'GET', headers: { Accept: descriptor.content_type }, credentials: 'include', cache: 'no-store', redirect: 'error', signal })
    } catch {
      throw new OfflineV5APIError(0, 'offline_asset_download_incomplete', 'No se pudo descargar una imagen completa de la pizarra. Puedes reintentar sin solicitar otra autorización.', true)
    }
    if (!response.ok || response.headers.get('X-Clarin-Response') !== '1') {
      throw new OfflineV5APIError(response.status, 'offline_asset_download_incomplete', 'No se pudo descargar una imagen autorizada de la pizarra. Puedes reintentar sin solicitar otra autorización.')
    }
    const type = (response.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase()
    if (type !== descriptor.content_type) {
      throw new OfflineV5APIError(422, 'offline_asset_integrity_failed', 'Una imagen no coincide con el tipo o tamaño firmado y la copia fue descartada.')
    }
    const buffer = await response.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    const digest = await sha256HexBytes(bytes)
    if (bytes.byteLength !== descriptor.size_bytes || digest !== descriptor.content_hash) {
      bytes.fill(0)
      throw new OfflineV5APIError(422, 'offline_asset_integrity_failed', 'Una imagen llegó incompleta o alterada y la copia fue descartada.')
    }
    const blob = new Blob([bytes], { type })
    bytes.fill(0)
    return blob
  }

  async sync(profile: BrowserProfile, grantKey: JWK, request: Omit<OfflineV5SyncRequest, 'challenge_id' | 'nonce'>, signal?: AbortSignal): Promise<OfflineV5SyncResponse> {
    const challenge = await this.request<OfflineV5Challenge>('/api/offline/v5/sync/challenge', { grant_id: request.grant_id, browser_profile_id: request.browser_profile_id }, { signal })
    const path = '/api/offline/v5/sync'
    const body: OfflineV5SyncRequest = { ...request, challenge_id: challenge.challenge_id, nonce: challenge.nonce }
    if (body.operations.length > SYNC_MAX_OPERATIONS || jsonBytes(body) > SYNC_MAX_BYTES) throw new OfflineV5Error('sync_request_too_large', 'El lote pendiente supera el tamaño seguro de sincronización.')
    return this.request<OfflineV5SyncResponse>(path, body, { signal, timeoutMs: 120_000, headers: await this.proof(profile, grantKey, 'sync', path, body, challenge, request.grant_id) })
  }
}

export function batchOfflineV5Operations(request: Omit<OfflineV5SyncRequest, 'challenge_id' | 'nonce' | 'operations'>, operations: readonly OfflineV5Operation[]): OfflineV5Operation[][] {
  const sample = { ...request, challenge_id: '00000000-0000-4000-8000-000000000000', nonce: 'A'.repeat(43), operations: [] as OfflineV5Operation[] }
  const baseBytes = jsonBytes(sample), result: OfflineV5Operation[][] = [], current: OfflineV5Operation[] = []
  let bytes = baseBytes
  for (const operation of operations) {
    const size = jsonBytes(operation)
    if (baseBytes + size > SYNC_MAX_BYTES) throw new OfflineV5Error('operation_too_large', 'Un cambio pendiente supera el tamaño máximo y permanece guardado localmente.')
    if (current.length && (current.length >= SYNC_MAX_OPERATIONS || bytes + size + 1 > SYNC_MAX_BYTES)) { result.push(current.splice(0)); bytes = baseBytes }
    bytes += size + (current.length ? 1 : 0)
    current.push(operation)
  }
  if (current.length || !result.length) result.push(current)
  return result
}
