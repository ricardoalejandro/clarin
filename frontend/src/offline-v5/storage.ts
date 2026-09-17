import { OFFLINE_V5_DB, OFFLINE_V5_MAX_BYTES, OFFLINE_V5_MAX_PAGE, OfflineV5Error, type OfflineV5DataStoreName, type OfflineV5StoreName, type OfflineV5StoredCipher } from './types'

export interface OfflineV5StoreMutation {
  store: OfflineV5StoreName
  key: string
  value?: unknown
  remove?: boolean
  add?: boolean
}

export interface OfflineV5ScanOptions {
  index?: string
  key?: IDBValidKey
  limit?: number
  after?: IDBValidKey
  direction?: IDBCursorDirection
}

export interface OfflineV5CommitOptions {
  namespace?: string
  quotaBytes?: number
  expectedEpoch?: { key: string; value: string }
}

export interface OfflineV5Storage {
  get<T>(store: OfflineV5StoreName, key: string): Promise<T | undefined>
  scan<T>(store: OfflineV5StoreName, options?: OfflineV5ScanOptions): Promise<T[]>
  totalBytes(namespace?: string): Promise<number>
  commit(mutations: OfflineV5StoreMutation[], options?: OfflineV5CommitOptions): Promise<void>
}

const DATA_STORES = new Set<OfflineV5StoreName>(['manifests', 'entities', 'operations', 'conflicts', 'blobs'])

function checkedLimit(value = 50): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new OfflineV5Error('invalid_page_size', `La página local debe contener entre 1 y ${OFFLINE_V5_MAX_PAGE} registros.`)
  return value
}

function usageKey(namespace?: string) { return namespace ? `scope:${namespace}` : 'total' }

function recordBytes(value: unknown): number {
  if (!value || typeof value !== 'object') return 0
  const bytes = Number((value as { byte_size?: number }).byte_size)
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0
}

function recordNamespace(value: unknown): string | undefined {
  return value && typeof value === 'object' && typeof (value as { namespace?: unknown }).namespace === 'string'
    ? (value as { namespace: string }).namespace
    : undefined
}

function uniqueMutations(mutations: OfflineV5StoreMutation[]): OfflineV5StoreMutation[] {
  const result = new Map<string, OfflineV5StoreMutation>()
  for (const mutation of mutations) {
    if (!mutation.key || !mutation.store || mutation.remove && mutation.value !== undefined) throw new OfflineV5Error('invalid_storage_mutation', 'La escritura local solicitada no es válida.')
    result.set(`${mutation.store}\0${mutation.key}`, mutation)
  }
  return [...result.values()]
}

export class BrowserOfflineV5Storage implements OfflineV5Storage {
  private async open(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') throw new OfflineV5Error('storage_unavailable', 'El navegador no ofrece almacenamiento local protegido.')
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(OFFLINE_V5_DB, OFFLINE_V5_SCHEMA_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        for (const name of ['profiles', 'vaults', 'usage', 'schema'] as const) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
        createCipherStore(db, 'manifests', [['namespace', 'namespace']])
        createCipherStore(db, 'entities', [['namespace', 'namespace'], ['namespace_type', ['namespace', 'record_type']], ['namespace_root', ['namespace', 'root_selection_id']]])
        createCipherStore(db, 'operations', [['namespace', 'namespace'], ['namespace_status', ['namespace', 'status']], ['namespace_sequence', ['namespace', 'sequence']]])
        createCipherStore(db, 'conflicts', [['namespace', 'namespace'], ['namespace_status', ['namespace', 'status']], ['namespace_created', ['namespace', 'created_at']]])
        createCipherStore(db, 'blobs', [['namespace', 'namespace'], ['namespace_entity', ['namespace', 'entity_type', 'entity_id']]])
      }
      request.onerror = () => reject(request.error || new OfflineV5Error('storage_open_failed', 'No se pudo abrir la copia offline.'))
      request.onblocked = () => reject(new OfflineV5Error('storage_blocked', 'Cierra las otras pestañas de Clarín para actualizar la copia offline.'))
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close()
        resolve(request.result)
      }
    })
  }

  async get<T>(store: OfflineV5StoreName, key: string): Promise<T | undefined> {
    const db = await this.open()
    try {
      return await new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly'), request = tx.objectStore(store).get(key)
        request.onsuccess = () => resolve(request.result as T | undefined)
        request.onerror = () => reject(request.error || new OfflineV5Error('storage_read_failed', 'No se pudo leer la copia offline.'))
      })
    } finally { db.close() }
  }

  async scan<T>(store: OfflineV5StoreName, options: OfflineV5ScanOptions = {}): Promise<T[]> {
    const limit = checkedLimit(options.limit)
    const db = await this.open()
    try {
      return await new Promise<T[]>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly')
        const objectStore = tx.objectStore(store)
        if (options.index && !objectStore.indexNames.contains(options.index)) {
          reject(new OfflineV5Error('invalid_storage_index', 'El índice local solicitado no existe.'))
          return
        }
        const source: IDBObjectStore | IDBIndex = options.index ? objectStore.index(options.index) : objectStore
        const request = source.openCursor(options.key === undefined ? undefined : IDBKeyRange.only(options.key), options.direction || 'next')
        const result: T[] = []
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor || result.length >= limit) { resolve(result); return }
          if (options.after !== undefined && indexedDB.cmp(cursor.primaryKey, options.after) <= 0) { cursor.continue(); return }
          result.push(cursor.value as T)
          cursor.continue()
        }
        request.onerror = () => reject(request.error || new OfflineV5Error('storage_read_failed', 'No se pudo leer la copia offline.'))
        tx.onabort = () => reject(tx.error || new OfflineV5Error('storage_aborted', 'La lectura local fue cancelada.'))
      })
    } finally { db.close() }
  }

  async totalBytes(namespace?: string): Promise<number> {
    return Number(await this.get<number>('usage', usageKey(namespace))) || 0
  }

  async commit(input: OfflineV5StoreMutation[], options: OfflineV5CommitOptions = {}): Promise<void> {
    const mutations = uniqueMutations(input)
    if (!mutations.length) return
    const dataMutations = mutations.filter(mutation => DATA_STORES.has(mutation.store))
    const stores = new Set<OfflineV5StoreName>(mutations.map(mutation => mutation.store))
    if (dataMutations.length) stores.add('usage')
    if (options.expectedEpoch) stores.add('schema')
    const db = await this.open()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([...stores], 'readwrite', { durability: 'strict' })
        let rejected = false
        const fail = (error: unknown) => {
          if (rejected) return
          rejected = true
          try { tx.abort() } catch { /* already completed */ }
          reject(error)
        }
        tx.oncomplete = () => { if (!rejected) resolve() }
        tx.onerror = () => fail(tx.error || new OfflineV5Error('storage_write_failed', 'No se pudo guardar la copia offline.'))
        tx.onabort = () => fail(tx.error || new OfflineV5Error('storage_aborted', 'No se guardó ningún cambio local.'))

        const apply = (mutation: OfflineV5StoreMutation) => {
          const store = tx.objectStore(mutation.store)
          if (mutation.remove) store.delete(mutation.key)
          else if (mutation.add) store.add(mutation.value, mutation.key)
          else store.put(mutation.value, mutation.key)
        }

        const execute = () => {
          for (const mutation of mutations.filter(item => !DATA_STORES.has(item.store))) apply(mutation)
          if (!dataMutations.length) return
          const prior = new Map<OfflineV5StoreMutation, unknown>()
          let waiting = dataMutations.length
          for (const mutation of dataMutations) {
            const request = tx.objectStore(mutation.store).get(mutation.key)
            request.onerror = () => fail(request.error || new OfflineV5Error('storage_read_failed', 'No se pudo comprobar el espacio local.'))
            request.onsuccess = () => {
              prior.set(mutation, request.result)
              if (--waiting === 0) calculateUsage()
            }
          }

          const calculateUsage = () => {
            const deltas = new Map<string, number>([['total', 0]])
            for (const mutation of dataMutations) {
              const oldValue = prior.get(mutation)
              const nextValue = mutation.remove ? undefined : mutation.value
              for (const [value, direction] of [[oldValue, -1], [nextValue, 1]] as const) {
                const namespace = recordNamespace(value)
                if (!namespace) continue
                const bytes = recordBytes(value) * direction
                deltas.set('total', (deltas.get('total') || 0) + bytes)
                deltas.set(usageKey(namespace), (deltas.get(usageKey(namespace)) || 0) + bytes)
              }
            }
            const current = new Map<string, number>()
            let usageWaiting = deltas.size
            for (const key of deltas.keys()) {
              const request = tx.objectStore('usage').get(key)
              request.onerror = () => fail(request.error || new OfflineV5Error('storage_read_failed', 'No se pudo comprobar el espacio local.'))
              request.onsuccess = () => {
                current.set(key, Number(request.result) || 0)
                if (--usageWaiting === 0) finishUsage(deltas, current)
              }
            }
          }

          const finishUsage = (deltas: Map<string, number>, current: Map<string, number>) => {
            const total = Math.max(0, (current.get('total') || 0) + (deltas.get('total') || 0))
            const scoped = options.namespace ? Math.max(0, (current.get(usageKey(options.namespace)) || 0) + (deltas.get(usageKey(options.namespace)) || 0)) : 0
            const quota = Math.min(OFFLINE_V5_MAX_BYTES, options.quotaBytes ?? OFFLINE_V5_MAX_BYTES)
            if (total > OFFLINE_V5_MAX_BYTES || options.namespace && scoped > quota) {
              fail(new OfflineV5Error('storage_quota', 'No queda espacio suficiente para guardar el cambio sin poner en riesgo la copia offline.'))
              return
            }
            for (const mutation of dataMutations) apply(mutation)
            for (const [key, delta] of deltas) tx.objectStore('usage').put(Math.max(0, (current.get(key) || 0) + delta), key)
          }
        }

        if (options.expectedEpoch) {
          const request = tx.objectStore('schema').get(options.expectedEpoch.key)
          request.onerror = () => fail(request.error || new OfflineV5Error('storage_read_failed', 'No se pudo validar la sesión local.'))
          request.onsuccess = () => {
            if ((request.result || '') !== options.expectedEpoch?.value) {
              fail(new OfflineV5Error('identity_changed', 'La identidad cambió; no se guardó el cambio anterior.'))
              return
            }
            execute()
          }
        } else execute()
      })
    } finally { db.close() }
  }
}

function createCipherStore(db: IDBDatabase, name: OfflineV5DataStoreName, indexes: Array<[string, string | string[]]>) {
  if (db.objectStoreNames.contains(name)) return
  const store = db.createObjectStore(name)
  for (const [index, keyPath] of indexes) store.createIndex(index, keyPath, { unique: false })
}

export const OFFLINE_V5_SCHEMA_VERSION = 1 as const

/** Deterministic transaction model used by unit tests and non-browser adapters. */
export class MemoryOfflineV5Storage implements OfflineV5Storage {
  private stores = new Map<OfflineV5StoreName, Map<string, unknown>>()
  private transaction = Promise.resolve()

  constructor() {
    for (const store of ['profiles', 'vaults', 'manifests', 'entities', 'operations', 'conflicts', 'blobs', 'usage', 'schema'] as OfflineV5StoreName[]) this.stores.set(store, new Map())
  }

  async get<T>(store: OfflineV5StoreName, key: string): Promise<T | undefined> {
    return this.stores.get(store)?.get(key) as T | undefined
  }

  async scan<T>(store: OfflineV5StoreName, options: OfflineV5ScanOptions = {}): Promise<T[]> {
    const limit = checkedLimit(options.limit)
    const values = [...(this.stores.get(store)?.values() || [])] as Array<T & Record<string, unknown>>
    const filtered = options.index && options.key !== undefined
      ? values.filter(value => indexValue(value, options.index!) === JSON.stringify(options.key))
      : values
    return (options.direction?.startsWith('prev') ? filtered.reverse() : filtered).slice(0, limit)
  }

  async totalBytes(namespace?: string): Promise<number> {
    return Number(this.stores.get('usage')?.get(usageKey(namespace))) || 0
  }

  async commit(input: OfflineV5StoreMutation[], options: OfflineV5CommitOptions = {}): Promise<void> {
    const run = async () => {
      const mutations = uniqueMutations(input)
      if (options.expectedEpoch && (this.stores.get('schema')?.get(options.expectedEpoch.key) || '') !== options.expectedEpoch.value) {
        throw new OfflineV5Error('identity_changed', 'La identidad cambió; no se guardó el cambio anterior.')
      }
      const copy = new Map<OfflineV5StoreName, Map<string, unknown>>()
      for (const [name, store] of this.stores) copy.set(name, new Map(store))
      for (const mutation of mutations) {
        const target = copy.get(mutation.store)!
        if (mutation.remove) target.delete(mutation.key)
        else if (mutation.add && target.has(mutation.key)) throw new OfflineV5Error('constraint', 'El registro local ya existe.')
        else target.set(mutation.key, mutation.value)
      }
      let total = 0, scoped = 0
      for (const storeName of DATA_STORES) for (const value of copy.get(storeName)!.values()) {
        total += recordBytes(value)
        if (options.namespace && recordNamespace(value) === options.namespace) scoped += recordBytes(value)
      }
      const quota = Math.min(OFFLINE_V5_MAX_BYTES, options.quotaBytes ?? OFFLINE_V5_MAX_BYTES)
      if (total > OFFLINE_V5_MAX_BYTES || options.namespace && scoped > quota) throw new OfflineV5Error('storage_quota', 'No queda espacio suficiente para guardar el cambio sin poner en riesgo la copia offline.')
      copy.get('usage')!.set('total', total)
      if (options.namespace) copy.get('usage')!.set(usageKey(options.namespace), scoped)
      this.stores = copy
    }
    const result = this.transaction.then(run, run)
    this.transaction = result.then(() => undefined, () => undefined)
    return result
  }
}

function indexValue(value: Record<string, unknown>, index: string): string {
  if (index === 'namespace') return JSON.stringify(value.namespace)
  if (index === 'namespace_type') return JSON.stringify([value.namespace, value.record_type])
  if (index === 'namespace_root') return JSON.stringify([value.namespace, value.root_selection_id])
  if (index === 'namespace_status') return JSON.stringify([value.namespace, value.status])
  if (index === 'namespace_sequence') return JSON.stringify([value.namespace, value.sequence])
  if (index === 'namespace_created') return JSON.stringify([value.namespace, value.created_at])
  if (index === 'namespace_entity') return JSON.stringify([value.namespace, value.entity_type, value.entity_id])
  return JSON.stringify(undefined)
}

export function storedCipherBytes(record: Pick<OfflineV5StoredCipher, 'ciphertext'>): number {
  return new TextEncoder().encode(JSON.stringify(record.ciphertext)).byteLength
}

export async function hasOfflineV5Database(): Promise<boolean> {
  if (typeof indexedDB === 'undefined' || !indexedDB.databases) return false
  try { return (await indexedDB.databases()).some(database => database.name === OFFLINE_V5_DB && database.version === OFFLINE_V5_SCHEMA_VERSION) }
  catch { return false }
}

/**
 * Rotates the durable authorization barrier without creating a v5 database.
 * Call this before broadcasting an online identity change: any in-flight worker
 * transaction holding the prior epoch will then abort atomically.
 */
export async function invalidateOfflineV5StoredSessionEpoch(): Promise<boolean> {
  if (!await hasOfflineV5Database()) return false
  return rotateOfflineV5StoredSessionEpoch(new BrowserOfflineV5Storage())
}

/** Exported for deterministic fail-closed verification without provisioning IDB. */
export async function rotateOfflineV5StoredSessionEpoch(storage: OfflineV5Storage): Promise<boolean> {
  const profile = await storage.get<{ browser_id?: unknown }>('profiles', 'active')
  if (typeof profile?.browser_id !== 'string' || !profile.browser_id) return false
  // A real write failure must propagate. Treating quota/blocked/corrupt storage
  // as “no copy” would let an online identity change proceed while an old
  // worker could still hold write authority.
  await storage.commit([{ store: 'schema', key: `auth:${profile.browser_id}`, value: crypto.randomUUID() }])
  return true
}
