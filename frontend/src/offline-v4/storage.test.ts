// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserStorage, enforceStorageBudget, hasPreparedCopy, invalidateStoredSessionEpoch, type OfflineStorage } from './storage'
import type { StoredRecord } from './types'

function transactionHarness() {
  const objectStore = { put: vi.fn(), add: vi.fn(), delete: vi.fn() }
  const transaction = { objectStore: vi.fn(() => objectStore), oncomplete: null as (() => void) | null, onabort: null as (() => void) | null, onerror: null as (() => void) | null, error: null as Error | null }
  const db = { transaction: vi.fn(() => transaction), close: vi.fn(), onversionchange: null }
  const request = { result: db, onsuccess: null as (() => void) | null, onerror: null, onblocked: null, onupgradeneeded: null }
  const open = vi.fn(() => { queueMicrotask(() => request.onsuccess?.()); return request })
  vi.stubGlobal('indexedDB', { open })
  return { transaction, db, objectStore }
}
afterEach(() => vi.unstubAllGlobals())
describe('IndexedDB durability boundary', () => {
  it('does not report success when a put is merely queued; waits for transaction completion', async () => {
    const harness = transactionHarness(), storage = new BrowserStorage()
    let completed = false
    const writing = storage.commit([{ store: 'profiles', key: 'active', value: {} }]).then(() => { completed = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.objectStore.put).toHaveBeenCalled(); expect(completed).toBe(false)
    expect(harness.db.transaction).toHaveBeenCalledWith(['profiles'], 'readwrite', { durability: 'strict' })
    harness.transaction.oncomplete?.(); await writing
    expect(completed).toBe(true); expect(harness.db.close).toHaveBeenCalled()
  })
  it('rejects a transaction aborted after a write was queued', async () => {
    const harness = transactionHarness(), storage = new BrowserStorage()
    const writing = storage.commit([{ store: 'profiles', key: 'active', value: {} }])
    const failure = expect(writing).rejects.toThrow('Quota exceeded')
    await new Promise(resolve => setTimeout(resolve, 0))
    harness.transaction.error = new Error('Quota exceeded'); harness.transaction.onabort?.()
    await failure; expect(harness.db.close).toHaveBeenCalled()
  })
  it('never creates offline storage or profiles for ordinary online users', async () => {
    const open = vi.fn()
    vi.stubGlobal('indexedDB', { databases: vi.fn(async () => []), open })
    expect(await hasPreparedCopy('user', 'account')).toBe(false)
    await invalidateStoredSessionEpoch()
    expect(open).not.toHaveBeenCalled()
  })
  it('applies a per-grant budget independently of the global 5 GiB ceiling', async () => {
    const storage = { totalBytes: vi.fn(async (grant?: string) => grant ? 100 : 1000), get: vi.fn(async () => undefined) } as unknown as OfflineStorage
    const record = { id: 'g:task:a', grant_id: 'g', kind: 'task', byte_size: 100, ciphertext: {} } as StoredRecord
    await expect(enforceStorageBudget(storage, [record], 250)).resolves.toBeUndefined()
    await expect(enforceStorageBudget(storage, [record], 150)).rejects.toMatchObject({ code: 'storage_quota' })
    vi.mocked(storage.totalBytes).mockImplementation(async grant => grant ? 100 : 5 * 1024 ** 3)
    await expect(enforceStorageBudget(storage, [record], 250)).rejects.toMatchObject({ code: 'storage_quota' })
  })
})
