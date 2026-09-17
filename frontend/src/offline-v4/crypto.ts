import { decodeProtectedHeader, importJWK, jwtVerify, SignJWT } from 'jose'
import type { JWK } from 'jose'
import { BrowserOfflineError, LEASE_MS, type Ciphertext, type GrantIdentity } from './types'

const encoder = new TextEncoder()
export const PASSWORD_ITERATIONS = 600000 as const
export function base64url(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new BrowserOfflineError('invalid_ciphertext', 'La copia protegida no es válida.')
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
}
export function canonicalIdentity(identity: GrantIdentity): string {
  const values = [identity.origin, identity.browser_id, identity.user_id, identity.account_id, identity.grant_id]
  if (values.some(value => !value || typeof value !== 'string')) throw new BrowserOfflineError('invalid_identity', 'La identidad offline no es válida.')
  return JSON.stringify(values)
}
function aad(identity: GrantIdentity, kind: string, id: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify([4, canonicalIdentity(identity), kind, id, 1]))
}
export async function derivePasswordKey(password: string, salt: string): Promise<CryptoKey> {
  if ([...password].length < 12) throw new BrowserOfflineError('password_too_short', 'El acceso offline requiere una contraseña de al menos 12 caracteres.')
  if (encoder.encode(password).length > 1024) throw new BrowserOfflineError('password_too_long', 'La contraseña supera el tamaño permitido.')
  const saltBytes = unbase64url(salt)
  if (saltBytes.length !== 32) throw new BrowserOfflineError('invalid_salt', 'La protección de esta copia no es válida.')
  const input = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: PASSWORD_ITERATIONS }, input, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
export async function encryptValue(key: CryptoKey, identity: GrantIdentity, kind: string, id: string, value: unknown): Promise<Ciphertext> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = encoder.encode(JSON.stringify(value))
  try {
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(identity, kind, id), tagLength: 128 }, key, plaintext)
    return { version: 1, iv: base64url(iv), ciphertext: base64url(new Uint8Array(encrypted)) }
  } finally { plaintext.fill(0) }
}
export async function decryptValue<T>(key: CryptoKey, identity: GrantIdentity, kind: string, id: string, value: Ciphertext): Promise<T> {
  if (value.version !== 1 || unbase64url(value.iv).length !== 12) throw new BrowserOfflineError('invalid_ciphertext', 'La copia protegida no es válida.')
  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64url(value.iv), additionalData: aad(identity, kind, id), tagLength: 128 }, key, unbase64url(value.ciphertext))
  } catch { throw new BrowserOfflineError('unlock_failed', 'Contraseña incorrecta o copia protegida dañada.') }
  try { return JSON.parse(new TextDecoder().decode(plaintext)) as T } finally { new Uint8Array(plaintext).fill(0) }
}
export async function createVaultKey(password: string, identity: GrantIdentity) {
  const salt = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const passwordKey = await derivePasswordKey(password, salt)
  const raw = crypto.getRandomValues(new Uint8Array(32))
  try {
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
    const wrapped_key = await encryptValue(passwordKey, identity, 'key', 'dek', base64url(raw))
    return { key, salt, wrapped_key }
  } finally { raw.fill(0) }
}
export async function unlockVaultKey(password: string, identity: GrantIdentity, salt: string, wrapped: Ciphertext) {
  const passwordKey = await derivePasswordKey(password, salt)
  const raw = unbase64url(await decryptValue<string>(passwordKey, identity, 'key', 'dek', wrapped))
  try {
    if (raw.length !== 32) throw new BrowserOfflineError('invalid_key', 'La clave protegida no es válida.')
    return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
  } finally { raw.fill(0) }
}
export async function sha256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
}
export async function sha256Hex(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
}
export async function createSigningKey() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return { public_jwk: await crypto.subtle.exportKey('jwk', keys.publicKey) as JWK, private_jwk: await crypto.subtle.exportKey('jwk', keys.privateKey) as JWK }
}
export async function signClaims(key: CryptoKey | JWK, claims: Record<string, unknown>, typ: string): Promise<string> {
  const signing = 'kty' in key ? await importJWK(key, 'ES256') : key
  return new SignJWT(claims).setProtectedHeader({ alg: 'ES256', typ }).sign(signing)
}
export async function verifyLease(token: string, keys: JWK[], identity: GrantIdentity, now = Date.now()) {
  const header = decodeProtectedHeader(token)
  if (header.alg !== 'ES256') throw new BrowserOfflineError('invalid_lease', 'La autorización offline no tiene una firma válida.')
  const jwk = keys.find(key => key.kid === header.kid)
  if (!jwk || jwk.d || jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new BrowserOfflineError('invalid_lease_key', 'La clave de autorización offline no es válida.')
  if (header.typ !== 'clarin-offline-v4-lease+jwt') throw new BrowserOfflineError('invalid_lease_type', 'La autorización offline no es válida.')
  const { payload } = await jwtVerify(token, await importJWK(jwk, 'ES256'), { algorithms: ['ES256'], issuer: 'clarin-offline-v4', audience: identity.origin, currentDate: new Date(now) })
  if (payload.version !== 4 || payload.browser_profile_id !== identity.browser_id || payload.grant_id !== identity.grant_id || payload.user_id !== identity.user_id || payload.account_id !== identity.account_id
      || typeof payload.iat !== 'number' || typeof payload.exp !== 'number' || payload.exp <= payload.iat || (payload.exp - payload.iat) * 1000 > LEASE_MS || payload.iat * 1000 > now + 60000) {
    throw new BrowserOfflineError('invalid_lease_scope', 'La autorización no corresponde a esta cuenta, usuario o navegador.')
  }
  return payload
}
