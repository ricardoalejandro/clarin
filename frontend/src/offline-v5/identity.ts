import { OfflineV5Error, type OfflineV5Identity } from './types'

const MAX_ID_BYTES = 256
const encoder = new TextEncoder()

function checkedID(value: unknown, field: keyof Omit<OfflineV5Identity, 'origin'>): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || encoder.encode(value).byteLength > MAX_ID_BYTES || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new OfflineV5Error('invalid_identity', `La identidad offline contiene un ${field} inválido.`)
  }
  return value
}

export function normalizeOfflineV5Origin(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new OfflineV5Error('invalid_origin', 'El origen de la copia offline no es válido.')
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new OfflineV5Error('invalid_origin', 'El origen de la copia offline no es válido.') }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== value) {
    throw new OfflineV5Error('invalid_origin', 'La copia offline pertenece a otro origen.')
  }
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new OfflineV5Error('insecure_origin', 'El modo offline requiere HTTPS.')
  }
  return parsed.origin
}

export function assertOfflineV5Identity(value: OfflineV5Identity, expectedOrigin?: string): OfflineV5Identity {
  const identity: OfflineV5Identity = {
    origin: normalizeOfflineV5Origin(value?.origin),
    browser_profile_id: checkedID(value?.browser_profile_id, 'browser_profile_id'),
    grant_id: checkedID(value?.grant_id, 'grant_id'),
    user_id: checkedID(value?.user_id, 'user_id'),
    account_id: checkedID(value?.account_id, 'account_id'),
  }
  if (expectedOrigin && identity.origin !== normalizeOfflineV5Origin(expectedOrigin)) {
    throw new OfflineV5Error('wrong_origin', 'La copia offline pertenece a otro sitio de Clarín.')
  }
  return identity
}

export function canonicalOfflineV5Identity(identity: OfflineV5Identity): string {
  const checked = assertOfflineV5Identity(identity)
  return JSON.stringify([
    OFFLINE_IDENTITY_VERSION,
    checked.origin,
    checked.browser_profile_id,
    checked.grant_id,
    checked.user_id,
    checked.account_id,
  ])
}

export const OFFLINE_IDENTITY_VERSION = 5 as const

export function sameOfflineV5Identity(left: OfflineV5Identity, right: OfflineV5Identity): boolean {
  try { return canonicalOfflineV5Identity(left) === canonicalOfflineV5Identity(right) } catch { return false }
}

export function manifestIdentity(origin: string, manifest: {
  browser_profile_id: string
  grant_id: string
  user_id: string
  account_id: string
}): OfflineV5Identity {
  return assertOfflineV5Identity({ origin, ...manifest }, origin)
}

export function canonicalOfflineLogin(value: string): string {
  const login = value.trim().normalize('NFKC').toLocaleLowerCase('en-US')
  if (!login || encoder.encode(login).byteLength > 320 || /[\u0000-\u001f\u007f]/.test(login)) {
    throw new OfflineV5Error('invalid_login', 'El usuario no es válido.')
  }
  return login
}
