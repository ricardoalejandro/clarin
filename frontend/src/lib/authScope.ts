const STORAGE_KEY = 'clarin:auth_scope'
export const AUTH_SCOPE_EVENT = 'clarin:auth-scope-changed'
let fallbackScope = ''
let memoryOverridesStorage = false
let synchronized = false
let listeningForStorage = false

function newScope(changing: boolean) {
  const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
  return `${changing ? 'changing' : 'active'}:${id}`
}

function persistScope(scope: string) {
  fallbackScope = scope
  memoryOverridesStorage = true
  synchronized = false
  try {
    localStorage.setItem(STORAGE_KEY, scope)
    if (localStorage.getItem(STORAGE_KEY) === scope) {
      memoryOverridesStorage = false
      synchronized = true
    }
  } catch { /* Keep the new local lease even when an older value is still readable. */ }
}

function ensureStorageListener() {
  if (listeningForStorage || typeof window === 'undefined') return
  listeningForStorage = true
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY && event.key !== null) return
    if (event.storageArea && event.storageArea !== localStorage) return
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        fallbackScope = stored
        memoryOverridesStorage = false
        synchronized = true
      } else persistScope(newScope(false))
    } catch {
      if (event.newValue) fallbackScope = event.newValue
      memoryOverridesStorage = true
      synchronized = false
    }
    window.dispatchEvent(new Event(AUTH_SCOPE_EVENT))
  })
}

/** A non-secret generation, shared by tabs. Refreshing a cookie does not change it. */
export function getAuthScope(): string {
  if (typeof window === 'undefined') return 'server'
  ensureStorageListener()
  if (memoryOverridesStorage) return fallbackScope
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      fallbackScope = stored
      synchronized = true
      return stored
    }
    persistScope(newScope(false))
    return fallbackScope
  } catch {
    fallbackScope ||= newScope(false)
    memoryOverridesStorage = true
    synchronized = false
    return fallbackScope
  }
}

export function isAuthIdentityChanging(scope = getAuthScope()) {
  return scope.startsWith('changing:')
}

function replaceScope(changing: boolean) {
  fallbackScope = newScope(changing)
  if (typeof window === 'undefined') return fallbackScope
  ensureStorageListener()
  persistScope(fallbackScope)
  window.dispatchEvent(new Event(AUTH_SCOPE_EVENT))
  return fallbackScope
}

/** Call before a logout or account switch; existing requests lose their lease immediately. */
export function beginAuthIdentityChange() { return replaceScope(true) }
/** Call after the new cookie identity is committed, or after a failed switch restores the old one. */
export function completeAuthIdentityChange() { return replaceScope(false) }
export function invalidateAuthScope() { return beginAuthIdentityChange() }

/** An identity-changing HTTP request must refuse to change the cookie when false. */
export function isAuthScopeSynchronized() {
  if (typeof window === 'undefined') return false
  getAuthScope()
  return synchronized && !memoryOverridesStorage
}

export function subscribeAuthScope(listener: () => void) {
  if (typeof window === 'undefined') return () => {}
  ensureStorageListener()
  window.addEventListener(AUTH_SCOPE_EVENT, listener)
  return () => {
    window.removeEventListener(AUTH_SCOPE_EVENT, listener)
  }
}
