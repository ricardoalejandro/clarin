import { apiBlob } from '@/lib/api'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'

export const PROGRAM_AVATAR_CACHE_TTL_MS = 60_000
export const PROGRAM_AVATAR_CACHE_MAX_ENTRIES = 32
export const PROGRAM_AVATAR_CACHE_MAX_BYTES = 8 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 15_000

type Result = { success: boolean; blob?: Blob }
type Entry = {
  scope: string
  programId: string
  revision: number
  controller: AbortController
  promise: Promise<Result>
  finish: (result: Result) => void
  users: number
  blob?: Blob
  expiresAt: number
  expiry?: ReturnType<typeof setTimeout>
}
const entries = new Map<string, Entry>()
let observingScope = false

function remove(key: string, entry: Entry) {
  if (entries.get(key) !== entry) return
  entries.delete(key)
  clearTimeout(entry.expiry)
  entry.controller.abort()
  entry.finish({ success: false })
}

function trim() {
  let bytes = [...entries.values()].reduce((total, entry) => total + (entry.blob?.size || 0), 0)
  let completed = [...entries.values()].filter(entry => entry.blob).length
  for (const [key, entry] of entries) {
    if (!entry.blob) continue
    if (entry.expiresAt <= Date.now() || completed > PROGRAM_AVATAR_CACHE_MAX_ENTRIES || bytes > PROGRAM_AVATAR_CACHE_MAX_BYTES) {
      bytes -= entry.blob.size
      completed--
      remove(key, entry)
    }
  }
}

/** Only bytes are shared; every mounted avatar owns and revokes its own object URL. */
export function acquireProgramAvatarBlob(scope: string, programId: string, revision: number) {
  if (!observingScope) {
    observingScope = true
    subscribeAuthScope(() => { for (const [key, entry] of entries) remove(key, entry) })
  }
  if (scope !== getAuthScope() || isAuthIdentityChanging(scope)) {
    return { promise: Promise.resolve<Result>({ success: false }), release: () => {} }
  }
  const key = JSON.stringify([scope, programId, revision])
  // A canonical revision change or removal makes old cached bytes obsolete.
  for (const [previousKey, entry] of entries) {
    if (entry.scope !== scope || (entry.programId === programId && entry.revision < revision)) remove(previousKey, entry)
  }
  trim()
  let entry = entries.get(key)
  if (!entry) {
    const controller = new AbortController()
    let resolve!: (result: Result) => void
    const promise = new Promise<Result>(done => { resolve = done })
    let settled = false
    const timer = setTimeout(() => { controller.abort(); created.finish({ success: false }) }, DOWNLOAD_TIMEOUT_MS)
    const created: Entry = { scope, programId, revision, controller, promise, users: 0, expiresAt: 0, finish: result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (controller.signal.aborted || getAuthScope() !== scope || entries.get(key) !== created) result = { success: false }
      if (result.success && result.blob) {
        created.blob = result.blob
        created.expiresAt = Date.now() + PROGRAM_AVATAR_CACHE_TTL_MS
        created.expiry = setTimeout(() => remove(key, created), PROGRAM_AVATAR_CACHE_TTL_MS)
        trim()
      } else if (entries.get(key) === created) entries.delete(key)
      resolve(result)
    } }
    entries.set(key, created)
    void apiBlob(`/api/programs/${encodeURIComponent(programId)}/avatar/content?v=${revision}`, { signal: controller.signal })
      .then(created.finish, () => created.finish({ success: false }))
    entry = created
  }
  // Reinsert to keep eviction in least-recently-used order without prolonging TTL.
  entries.delete(key)
  entries.set(key, entry)
  entry.users++
  const acquired = entry
  let released = false
  return { promise: entry.promise, release: () => {
    if (released) return
    released = true
    acquired.users--
    // A view switch may acquire the same request in the same commit.
    queueMicrotask(() => { if (!acquired.users && !acquired.blob) remove(key, acquired) })
  } }
}

export function invalidateProgramAvatarBlob(scope: string, programId: string) {
  for (const [key, entry] of entries) if (entry.scope === scope && entry.programId === programId) remove(key, entry)
}
