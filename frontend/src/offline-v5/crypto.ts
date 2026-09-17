import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose'
import type { JWK } from 'jose'
import {
  PASSWORD_ITERATIONS,
  base64url,
  decryptValue as decryptV4Value,
  encryptValue as encryptV4Value,
  unbase64url,
} from '../offline-v4/crypto'
import type { GrantIdentity as V4GrantIdentity } from '../offline-v4/types'
import { canonicalOfflineLogin, canonicalOfflineV5Identity } from './identity'
import {
  OFFLINE_V5_ACTIONS,
  OFFLINE_V5_LEASE_MS,
  OfflineV5Error,
  type OfflineV5Action,
  type OfflineV5Identity,
  type OfflineV5Manifest,
} from './types'

export { PASSWORD_ITERATIONS, base64url, unbase64url }

const encoder = new TextEncoder()

export async function derivePasswordKey(password: string, salt: string): Promise<CryptoKey> {
  if ([...password].length < 10) throw new OfflineV5Error('password_too_short', 'La contraseña actual de Clarín debe tener al menos 10 caracteres.')
  if (encoder.encode(password).byteLength > 72) throw new OfflineV5Error('password_too_long', 'La contraseña actual de Clarín no puede superar 72 bytes en UTF-8.')
  const saltBytes = unbase64url(salt)
  if (saltBytes.byteLength !== 32) throw new OfflineV5Error('invalid_salt', 'La protección de esta copia no es válida.')
  const material = encoder.encode(password)
  try {
    const input = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveKey'])
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: PASSWORD_ITERATIONS }, input, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  } finally { material.fill(0) }
}

function v4Identity(identity: OfflineV5Identity): V4GrantIdentity {
  return {
    origin: identity.origin,
    browser_id: identity.browser_profile_id,
    grant_id: identity.grant_id,
    user_id: identity.user_id,
    account_id: identity.account_id,
  }
}

function recordAAD(identity: OfflineV5Identity, kind: string, id: string, part?: number): Uint8Array<ArrayBuffer> {
  if (!kind || !id) throw new OfflineV5Error('invalid_record_identity', 'El registro local no tiene una identidad válida.')
  return encoder.encode(JSON.stringify([5, canonicalOfflineV5Identity(identity), kind, id, part ?? null, 1]))
}

export function ciphertextBytes(value: { iv: string; ciphertext: string }): number {
  return unbase64url(value.iv).byteLength + unbase64url(value.ciphertext).byteLength
}

export async function encryptOfflineV5Value(
  key: CryptoKey,
  identity: OfflineV5Identity,
  kind: string,
  id: string,
  value: unknown,
) {
  const plaintext = encoder.encode(JSON.stringify(value))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: recordAAD(identity, kind, id), tagLength: 128 }, key, plaintext)
    return { version: 1 as const, iv: base64url(iv), ciphertext: base64url(new Uint8Array(ciphertext)) }
  } finally { plaintext.fill(0) }
}

export async function decryptOfflineV5Value<T>(
  key: CryptoKey,
  identity: OfflineV5Identity,
  kind: string,
  id: string,
  value: { version: 1; iv: string; ciphertext: string },
): Promise<T> {
  if (value?.version !== 1 || unbase64url(value.iv).byteLength !== 12) throw new OfflineV5Error('invalid_ciphertext', 'La copia local está dañada.')
  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64url(value.iv), additionalData: recordAAD(identity, kind, id), tagLength: 128 }, key, unbase64url(value.ciphertext))
  } catch { throw new OfflineV5Error('unlock_failed', 'La contraseña no corresponde a esta copia o los datos fueron alterados.') }
  try { return JSON.parse(new TextDecoder().decode(plaintext)) as T }
  catch { throw new OfflineV5Error('invalid_plaintext', 'La copia local contiene datos inválidos.') }
  finally { new Uint8Array(plaintext).fill(0) }
}

export async function encryptOfflineV5Bytes(
  key: CryptoKey,
  identity: OfflineV5Identity,
  kind: string,
  id: string,
  part: number,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<{ iv: string; ciphertext: Uint8Array<ArrayBuffer> }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: recordAAD(identity, kind, id, part), tagLength: 128 }, key, plaintext)
  return { iv: base64url(iv), ciphertext: new Uint8Array(ciphertext) }
}

export async function decryptOfflineV5Bytes(
  key: CryptoKey,
  identity: OfflineV5Identity,
  kind: string,
  id: string,
  part: number,
  iv: string,
  ciphertext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64url(iv), additionalData: recordAAD(identity, kind, id, part), tagLength: 128 }, key, ciphertext)
    return new Uint8Array(plaintext)
  } catch { throw new OfflineV5Error('blob_integrity', 'El archivo local fue alterado o pertenece a otra cuenta.') }
}

export async function createOfflineV5VaultKey(password: string, identity: OfflineV5Identity) {
  const salt = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const passwordKey = await derivePasswordKey(password, salt)
  const raw = crypto.getRandomValues(new Uint8Array(32))
  try {
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
    const wrapped_key = await encryptV4Value(passwordKey, v4Identity(identity), 'key', 'dek', base64url(raw))
    return { key, salt, wrapped_key }
  } finally { raw.fill(0) }
}

export async function unlockOfflineV5VaultKey(password: string, identity: OfflineV5Identity, salt: string, wrapped: { version: 1; iv: string; ciphertext: string }) {
  const passwordKey = await derivePasswordKey(password, salt)
  const raw = unbase64url(await decryptV4Value<string>(passwordKey, v4Identity(identity), 'key', 'dek', wrapped))
  try {
    if (raw.byteLength !== 32) throw new OfflineV5Error('invalid_key', 'La clave protegida no es válida.')
    return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
  } finally { raw.fill(0) }
}

export async function encryptOfflineV5EnvelopeValue(key: CryptoKey, identity: OfflineV5Identity, kind: string, id: string, value: unknown) {
  return encryptV4Value(key, v4Identity(identity), kind, id, value)
}

export async function decryptOfflineV5EnvelopeValue<T>(key: CryptoKey, identity: OfflineV5Identity, kind: string, id: string, value: { version: 1; iv: string; ciphertext: string }) {
  return decryptV4Value<T>(key, v4Identity(identity), kind, id, value)
}

export async function createBlindIndexKey(key: CryptoKey, identity: OfflineV5Identity) {
  const raw = crypto.getRandomValues(new Uint8Array(32))
  try {
    const indexKey = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const wrapped = await encryptOfflineV5Value(key, identity, 'vault', 'blind-index', base64url(raw))
    return { indexKey, wrapped }
  } finally { raw.fill(0) }
}

export async function unlockBlindIndexKey(key: CryptoKey, identity: OfflineV5Identity, wrapped: { version: 1; iv: string; ciphertext: string }) {
  const raw = unbase64url(await decryptOfflineV5Value<string>(key, identity, 'vault', 'blind-index', wrapped))
  try {
    if (raw.byteLength !== 32) throw new OfflineV5Error('invalid_index_key', 'La clave del índice local no es válida.')
    return await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  } finally { raw.fill(0) }
}

export async function blindIndex(key: CryptoKey, ...parts: string[]): Promise<string> {
  if (parts.some(part => typeof part !== 'string' || !part)) throw new OfflineV5Error('invalid_index', 'El índice local no es válido.')
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify([5, ...parts])))))
}

/**
 * Opaque username index for the vault catalog. The per-browser HMAC key is
 * non-exportable; unlike SHA-256(browser+username), this value cannot be used
 * for an offline dictionary attack against likely usernames.
 */
export async function offlineV5UsernameLookupTag(key: CryptoKey, username: string): Promise<string> {
  return `h1.${await blindIndex(key, 'vault-username', canonicalOfflineLogin(username))}`
}

export async function sha256HexBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256HexText(value: string): Promise<string> {
  return sha256HexBytes(encoder.encode(value))
}

function equalJSON(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => equalJSON(item, right[index]))
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) return false
  const leftObject = left as Record<string, unknown>, rightObject = right as Record<string, unknown>
  const keys = Object.keys(leftObject)
  return keys.length === Object.keys(rightObject).length && keys.every(key => Object.prototype.hasOwnProperty.call(rightObject, key) && equalJSON(leftObject[key], rightObject[key]))
}

const MANIFEST_SIGNED_FIELDS = [
  'protocol_version', 'id', 'revision', 'browser_profile_id', 'grant_id', 'user_id', 'account_id', 'username', 'account_name',
  'selection_revision', 'selection_digest', 'credential_epoch', 'authority_epoch', 'grant_revision', 'roots', 'dependencies',
  'capabilities', 'entity_versions', 'chunk_hashes', 'issued_at', 'expires_at', 'max_storage_bytes',
] as const

export async function verifyOfflineV5Manifest(manifest: OfflineV5Manifest): Promise<void> {
  let canonicalBytes: Uint8Array<ArrayBuffer>, signed: Record<string, unknown>
  try {
    canonicalBytes = unbase64url(manifest.canonical_json)
    signed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(canonicalBytes)) as Record<string, unknown>
  } catch { throw new OfflineV5Error('invalid_manifest_canonical', 'El manifiesto offline no tiene una representación firmable válida.') }
  if (await sha256HexBytes(canonicalBytes) !== manifest.digest?.toLowerCase()) throw new OfflineV5Error('manifest_integrity', 'El manifiesto offline no superó la verificación de integridad.')
  const view: Record<string, unknown> = {}
  for (const field of MANIFEST_SIGNED_FIELDS) view[field] = manifest[field]
  if (!equalJSON(signed, view)) throw new OfflineV5Error('manifest_mismatch', 'El manifiesto firmado no coincide con los datos recibidos.')
}

export async function verifyOfflineV5LeaseAvailability(token: string, keys: JWK[], identity: OfflineV5Identity, now = Date.now()) {
  const header = decodeProtectedHeader(token)
  if (header.alg !== 'ES256' || header.typ !== 'clarin-offline-v4-lease+jwt') throw new OfflineV5Error('invalid_lease', 'La autorización offline no tiene una firma válida.')
  const jwk = keys.find(key => key.kid === header.kid)
  if (!jwk || jwk.d || jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new OfflineV5Error('invalid_lease_key', 'La clave pública de autorización no es válida.')
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  try {
    payload = (await jwtVerify(token, await importJWK(jwk, 'ES256'), {
      algorithms: ['ES256'], issuer: 'clarin-offline-v4', audience: identity.origin, currentDate: new Date(now),
    })).payload
  } catch { throw new OfflineV5Error('invalid_lease', 'La autorización offline venció o fue alterada.') }
  if (payload.version !== 4 || payload.browser_profile_id !== identity.browser_profile_id || payload.grant_id !== identity.grant_id
      || payload.user_id !== identity.user_id || payload.account_id !== identity.account_id || typeof payload.selection_revision !== 'number' || typeof payload.selection_digest !== 'string'
      || typeof payload.iat !== 'number' || typeof payload.exp !== 'number'
      || payload.exp <= payload.iat || (payload.exp - payload.iat) * 1000 > OFFLINE_V5_LEASE_MS || payload.iat * 1000 > now + 60000) {
    throw new OfflineV5Error('invalid_lease_scope', 'La autorización no corresponde a este navegador, usuario, cuenta y selección.')
  }
  return payload
}

export async function verifyOfflineV5Lease(token: string, keys: JWK[], identity: OfflineV5Identity, manifest: OfflineV5Manifest, now = Date.now()) {
  const payload = await verifyOfflineV5LeaseAvailability(token, keys, identity, now)
  if (payload.selection_revision !== manifest.selection_revision || payload.selection_digest !== manifest.digest) throw new OfflineV5Error('invalid_lease_scope', 'La autorización firmada no corresponde al manifiesto descargado.')
  return payload
}

export function validateOfflineV5Actions(actions: readonly string[]): OfflineV5Action[] {
  const allowed = new Set<string>(OFFLINE_V5_ACTIONS)
  if (!Array.isArray(actions) || actions.some(action => !allowed.has(action))) throw new OfflineV5Error('invalid_capabilities', 'El manifiesto contiene una capacidad offline desconocida.')
  return [...new Set(actions)] as OfflineV5Action[]
}
