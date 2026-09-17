import { BrowserOfflineError, MAX_BYTES, type BrowserProfile, type StoredRecord, type VaultEnvelope } from './types'
import type { JWK } from 'jose'
import { verifyLease } from './crypto'

const DB = 'clarin-offline-v4'
type Store = 'profiles' | 'vaults' | 'records' | 'usage'
export interface StoreMutation { store: Store; key: string; value?: unknown; remove?: boolean; add?: boolean }
export interface OfflineStorage {
  get<T>(store: Store, key: string): Promise<T | undefined>
  all<T>(store: Store, index?: string, key?: IDBValidKey): Promise<T[]>
  totalBytes(grantID?: string): Promise<number>
  commit(mutations: StoreMutation[], expectedAuthEpoch?: string): Promise<void>
}
export class BrowserStorage implements OfflineStorage {
  private async open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        db.createObjectStore('profiles')
        db.createObjectStore('vaults')
        db.createObjectStore('usage')
        const records = db.createObjectStore('records')
        records.createIndex('grant_id', 'grant_id', { unique: false })
        records.createIndex('grant_kind', ['grant_id', 'kind'], { unique: false })
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new BrowserOfflineError('storage_blocked', 'Cierra las otras pestañas de Clarín para actualizar la copia offline.'))
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result) }
    })
  }
  async get<T>(store: Store, key: string): Promise<T | undefined> {
    return (await this.read<T>(store, objectStore => objectStore.get(key)))[0]
  }
  async all<T>(store: Store, index?: string, key?: IDBValidKey): Promise<T[]> {
    const db = await this.open()
    try {
      return await new Promise<T[]>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly'), source = index ? tx.objectStore(store).index(index) : tx.objectStore(store)
        const cursor = source.openCursor(key), results: T[] = []
        cursor.onsuccess = () => {
          if (!cursor.result) return
          if (results.length >= 1000) { tx.abort(); reject(new BrowserOfflineError('collection_limit', 'La colección local supera el límite seguro. Sincroniza los cambios pendientes.')); return }
          results.push(cursor.result.value); cursor.result.continue()
        }
        tx.oncomplete = () => resolve(results)
        tx.onabort = () => reject(tx.error || new BrowserOfflineError('storage_aborted', 'La lectura local fue cancelada.'))
        tx.onerror = () => reject(tx.error)
      })
    } finally { db.close() }
  }
  async totalBytes(grantID?: string): Promise<number> { return await this.get<number>('usage', grantID ? `grant:${grantID}` : 'total') || 0 }
  private async read<T>(store: Store, action: (store: IDBObjectStore) => IDBRequest, many = false): Promise<T[]> {
    const db = await this.open()
    try {
      return await new Promise<T[]>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly'), request = action(tx.objectStore(store))
        let result: T[] = []
        request.onsuccess = () => { result = many ? request.result : [request.result] }
        tx.oncomplete = () => resolve(result)
        tx.onabort = () => reject(tx.error || request.error)
        tx.onerror = () => reject(tx.error || request.error)
      })
    } finally { db.close() }
  }
  async commit(mutations: StoreMutation[], expectedAuthEpoch?: string): Promise<void> {
    if (!mutations.length) return
    const db = await this.open()
    try {
      await new Promise<void>((resolve, reject) => {
        const unique = [...new Map(mutations.map(item => [`${item.store}:${item.key}`, item])).values()]
        const recordMutations = unique.filter(item => item.store === 'records')
        const stores = [...new Set([...unique.map(item => item.store), ...(recordMutations.length ? ['usage' as const] : []), ...(expectedAuthEpoch !== undefined ? ['profiles' as const] : [])])]
        const tx = db.transaction(stores, 'readwrite', { durability: 'strict' })
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error || new BrowserOfflineError('storage_aborted', 'No se guardaron los cambios.'))
        tx.onerror = () => reject(tx.error || new BrowserOfflineError('storage_failed', 'No se pudo guardar la copia offline.'))
        const apply = (item: StoreMutation) => {
          const store = tx.objectStore(item.store)
          if (item.remove) store.delete(item.key)
          else if (item.add) store.add(item.value, item.key)
          else store.put(item.value, item.key)
        }
        const execute = () => {
        for (const item of unique.filter(item => item.store !== 'records')) apply(item)
        if (recordMutations.length) {
          const prior = new Map<string, StoredRecord | undefined>(), counters = new Map<string, number>()
          const finish = () => {
            const deltas = new Map<string, number>([['total', 0]])
            for (const item of recordMutations) {
              const old = prior.get(item.key), next = item.remove ? undefined : item.value as StoredRecord
              for (const [record, factor] of [[old, -1], [next, 1]] as const) if (record) {
                deltas.set('total', (deltas.get('total') || 0) + record.byte_size * factor)
                const grantKey = `grant:${record.grant_id}`
                deltas.set(grantKey, (deltas.get(grantKey) || 0) + record.byte_size * factor)
              }
            }
            let waiting = deltas.size
            for (const key of deltas.keys()) {
              const request = tx.objectStore('usage').get(key)
              request.onsuccess = () => {
                counters.set(key, Number(request.result) || 0)
                if (--waiting) return
                for (const item of recordMutations) apply(item)
                for (const [key, delta] of deltas) tx.objectStore('usage').put(Math.max(0, (counters.get(key) || 0) + delta), key)
              }
            }
          }
          let waiting = recordMutations.length
          for (const item of recordMutations) {
            const request = tx.objectStore('records').get(item.key)
            request.onsuccess = () => { prior.set(item.key, request.result); if (!--waiting) finish() }
          }
        }
        }
        if (expectedAuthEpoch !== undefined) {
          const epoch = tx.objectStore('profiles').get('auth_epoch')
          epoch.onsuccess = () => {
            if ((epoch.result || '') !== expectedAuthEpoch) { tx.abort(); reject(new BrowserOfflineError('identity_changed', 'La sesión online cambió; el cambio anterior fue cancelado.')); return }
            execute()
          }
        } else execute()
      })
    } finally { db.close() }
  }
}
export async function getOrCreateProfile(storage: OfflineStorage): Promise<BrowserProfile> {
  const existing = await storage.get<BrowserProfile>('profiles', 'active')
  if (existing) return existing
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const profile: BrowserProfile = { browser_id: crypto.randomUUID(), public_jwk: await crypto.subtle.exportKey('jwk', keys.publicKey) as JWK, private_key: keys.privateKey, created_at: new Date().toISOString() }
  try { await storage.commit([{ store: 'profiles', key: 'active', value: profile, add: true }]); return profile }
  catch (error) { const winner = await storage.get<BrowserProfile>('profiles', 'active'); if (winner) return winner; throw error }
}
export async function enforceStorageBudget(storage: OfflineStorage, replacements: StoredRecord[], quota: number) {
  let total = await storage.totalBytes()
  const byGrant = new Map<string, number>()
  for (const replacement of new Map(replacements.map(record => [record.id, record])).values()) {
    const delta = replacement.byte_size - ((await storage.get<StoredRecord>('records', replacement.id))?.byte_size || 0)
    total += delta
    byGrant.set(replacement.grant_id, (byGrant.get(replacement.grant_id) ?? await storage.totalBytes(replacement.grant_id)) + delta)
  }
  if (total > MAX_BYTES || [...byGrant.values()].some(value => value > quota)) throw new BrowserOfflineError('storage_quota', 'No queda espacio suficiente para guardar esta copia sin perder cambios pendientes.')
}
export async function listVaults(storage: OfflineStorage) { return storage.all<VaultEnvelope>('vaults') }

/** Read-only capability lookup: never creates a database, profile or worker for ordinary online users. */
export async function hasPreparedCopy(userID: string, accountID: string): Promise<boolean> {
  if (!userID || !accountID || typeof indexedDB === 'undefined' || !indexedDB.databases) return false
  try {
    if (!(await indexedDB.databases()).some(database => database.name === DB && database.version === 1)) return false
    const vaults = await new BrowserStorage().all<VaultEnvelope>('vaults')
    for (const vault of vaults) {
      if (vault.state !== 'available' || vault.identity.user_id !== userID || vault.identity.account_id !== accountID || vault.identity.origin !== location.origin) continue
      try { await verifyLease(vault.lease, vault.signer_keys, vault.identity); return true } catch { /* An expired or invalid copy is not offered as available. */ }
    }
    return false
  } catch { return false }
}

export async function invalidateStoredSessionEpoch(): Promise<void> {
  if (typeof indexedDB === 'undefined' || !indexedDB.databases) return
  if (!(await indexedDB.databases()).some(database => database.name === DB && database.version === 1)) return
  await new BrowserStorage().commit([{ store: 'profiles', key: 'auth_epoch', value: crypto.randomUUID() }])
}
