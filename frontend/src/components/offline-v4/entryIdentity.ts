const key = 'clarin:offline-v4-entry-identity'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export interface EntryIdentityV4 { user_id: string; account_id: string }
export function storeEntryIdentityV4(storage: Storage, identity: EntryIdentityV4, now = Date.now()) {
  if (!uuid.test(identity.user_id) || !uuid.test(identity.account_id)) throw new Error('La identidad actual no permite una transición offline segura.')
  storage.setItem(key, JSON.stringify({ ...identity, issued_at: now }))
}
export function readEntryIdentityV4(storage: Storage, now = Date.now()): EntryIdentityV4 | null {
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw)
    if (!uuid.test(value.user_id) || !uuid.test(value.account_id) || !Number.isSafeInteger(value.issued_at) || value.issued_at > now || now - value.issued_at > 600_000) throw new Error('Invalid expectation')
    return { user_id: value.user_id, account_id: value.account_id }
  } catch { storage.removeItem(key); return null }
}
export function clearEntryIdentityV4(storage: Storage) { storage.removeItem(key) }
