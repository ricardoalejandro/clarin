const OFFLINE_V5_BOOT_MARKER = 'clarin:offline-v5:mode'
const OFFLINE_V5_BOOT_VALUE = 'offline'

export type OfflineV5BootStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function browserStorage(): OfflineV5BootStorage | undefined {
  if (typeof window === 'undefined') return undefined
  try { return window.localStorage } catch { return undefined }
}

/**
 * Contains no identity or private data. Its only purpose is to start the next
 * page load fail-closed before the asynchronous service-worker status arrives.
 */
export function readOfflineV5BootMarker(storage: OfflineV5BootStorage | undefined = browserStorage()): boolean {
  if (!storage) return false
  try { return storage.getItem(OFFLINE_V5_BOOT_MARKER) === OFFLINE_V5_BOOT_VALUE } catch { return false }
}

export function markOfflineV5Boot(storage: OfflineV5BootStorage | undefined = browserStorage()): boolean {
  if (!storage) return false
  try {
    storage.setItem(OFFLINE_V5_BOOT_MARKER, OFFLINE_V5_BOOT_VALUE)
    return storage.getItem(OFFLINE_V5_BOOT_MARKER) === OFFLINE_V5_BOOT_VALUE
  } catch { return false }
}

export function clearOfflineV5BootMarker(storage: OfflineV5BootStorage | undefined = browserStorage()): boolean {
  if (!storage) return false
  try {
    storage.removeItem(OFFLINE_V5_BOOT_MARKER)
    return storage.getItem(OFFLINE_V5_BOOT_MARKER) !== OFFLINE_V5_BOOT_VALUE
  } catch { return false }
}
