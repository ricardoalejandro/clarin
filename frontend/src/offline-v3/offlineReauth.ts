import type { OfflineActor } from './types'

export const OFFLINE_REAUTH_STORAGE_KEY = 'clarin:offline-v3-online-reauth'
export const OFFLINE_REAUTH_MAX_AGE_MS = 10 * 60_000

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface OfflineReauthExpectation {
  version: 3
  user_id: string
  account_id: string
  issued_at: number
}

type EphemeralStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function storeOfflineReauthExpectation(storage: EphemeralStorage, actor: Pick<OfflineActor, 'user_id' | 'account_id'>, now = Date.now()) {
  if (!UUID_PATTERN.test(actor.user_id) || !UUID_PATTERN.test(actor.account_id) || !Number.isSafeInteger(now)) {
    throw new Error('La identidad local no permite una transición online segura.')
  }
  const expectation: OfflineReauthExpectation = { version: 3, user_id: actor.user_id, account_id: actor.account_id, issued_at: now }
  storage.setItem(OFFLINE_REAUTH_STORAGE_KEY, JSON.stringify(expectation))
  return expectation
}

export function readOfflineReauthExpectation(storage: EphemeralStorage, now = Date.now()): OfflineReauthExpectation | null {
  try {
    const raw = storage.getItem(OFFLINE_REAUTH_STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<OfflineReauthExpectation>
    const valid = value.version === 3
      && typeof value.user_id === 'string' && UUID_PATTERN.test(value.user_id)
      && typeof value.account_id === 'string' && UUID_PATTERN.test(value.account_id)
      && Number.isSafeInteger(value.issued_at)
      && (value.issued_at as number) <= now
      && now - (value.issued_at as number) <= OFFLINE_REAUTH_MAX_AGE_MS
    if (!valid) throw new Error('invalid offline reauthentication expectation')
    return value as OfflineReauthExpectation
  } catch {
    storage.removeItem(OFFLINE_REAUTH_STORAGE_KEY)
    return null
  }
}

export function clearOfflineReauthExpectation(storage: EphemeralStorage) {
  storage.removeItem(OFFLINE_REAUTH_STORAGE_KEY)
}
