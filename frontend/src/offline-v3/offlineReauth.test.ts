import { describe, expect, it } from 'vitest'
import {
  OFFLINE_REAUTH_MAX_AGE_MS,
  OFFLINE_REAUTH_STORAGE_KEY,
  clearOfflineReauthExpectation,
  readOfflineReauthExpectation,
  storeOfflineReauthExpectation,
} from './offlineReauth'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

const actor = {
  user_id: '11111111-1111-4111-8111-111111111111',
  account_id: '22222222-2222-4222-8222-222222222222',
}

describe('offline to online reauthentication binding', () => {
  it('keeps only the exact local user/account tuple in ephemeral session storage', () => {
    const storage = memoryStorage()
    storeOfflineReauthExpectation(storage, actor, 1_000)

    expect(readOfflineReauthExpectation(storage, 1_001)).toEqual({ version: 3, ...actor, issued_at: 1_000 })
    expect(storage.getItem(OFFLINE_REAUTH_STORAGE_KEY)).not.toContain('password')

    clearOfflineReauthExpectation(storage)
    expect(readOfflineReauthExpectation(storage, 1_002)).toBeNull()
  })

  it('fails closed and removes stale or malformed bindings', () => {
    const storage = memoryStorage()
    storeOfflineReauthExpectation(storage, actor, 5_000)
    expect(readOfflineReauthExpectation(storage, 5_000 + OFFLINE_REAUTH_MAX_AGE_MS + 1)).toBeNull()
    expect(storage.getItem(OFFLINE_REAUTH_STORAGE_KEY)).toBeNull()

    storage.setItem(OFFLINE_REAUTH_STORAGE_KEY, JSON.stringify({ version: 3, user_id: actor.user_id, account_id: 'other', issued_at: 8_000 }))
    expect(readOfflineReauthExpectation(storage, 8_001)).toBeNull()
  })
})
