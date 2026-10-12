export interface ClarinHistoryGuard {
  requestLeave: () => Promise<boolean>
  revision: () => string
  shouldBlock?: () => boolean
}

export interface ClarinNavigationHistory {
  register: (guard: ClarinHistoryGuard) => () => void
}

declare global {
  interface Window {
    __CLARIN_NAVIGATION_HISTORY__?: ClarinNavigationHistory
  }
}

/**
 * Installed in the document head before Next or any interactive navigation.
 * The self-contained body also runs as the root's inline bootstrap script.
 * It adds metadata to existing entries, never a sentinel entry or a reload.
 */
export function installClarinNavigationHistory(win: Window): ClarinNavigationHistory {
  if (win.__CLARIN_NAVIGATION_HISTORY__) return win.__CLARIN_NAVIGATION_HISTORY__
  const key = '__clarin_history_position'
  const history = win.history
  const existing = history.state && typeof history.state === 'object' ? history.state[key] : null
  // A reload can retain same-document sibling entries in some browsers.
  const documentID = typeof existing?.documentID === 'string' && Number.isInteger(existing.index)
    ? existing.documentID : win.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
  const push = history.pushState.bind(history)
  const replace = history.replaceState.bind(history)
  let index = existing?.documentID === documentID && Number.isInteger(existing.index) ? existing.index : 0
  let url = win.location.href
  let guard: ClarinHistoryGuard | null = null
  type NativeEntry = { key: string; index: number; url: string }
  const navigation = (win as unknown as { navigation?: { currentEntry?: NativeEntry; entries: () => NativeEntry[] } }).navigation
  const nativeEntry = () => {
    const entry = navigation?.currentEntry
    return entry?.url === win.location.href && Number.isInteger(entry.index) ? entry : null
  }
  let nativeOrigin = nativeEntry()
  type Pending = {
    owner: ClarinHistoryGuard
    origin: number
    destination: number
    atOrigin: boolean
    started: boolean
    result?: boolean
    revision?: string
    replaying: boolean
    restoreTimer?: number
    traversalIssued: boolean
    issuedDestination?: number
  }
  let pending: Pending | null = null
  const position = (state: unknown) => {
    const item = state && typeof state === 'object' ? (state as Record<string, unknown>)[key] : null
    if (!item || typeof item !== 'object') return null
    const marker = item as { documentID?: string; index?: number }
    return marker.documentID === documentID && Number.isInteger(marker.index) ? marker.index! : null
  }
  const stamped = (state: unknown, value: number) => Object.assign({}, state && typeof state === 'object' ? state : {}, {
    [key]: { documentID, index: value },
  })
  const remember = (value: number) => {
    index = value
    url = win.location.href
    nativeOrigin = nativeEntry()
  }
  const currentPosition = (state: unknown) => {
    const marked = position(state)
    if (marked !== null || !nativeOrigin) return marked
    const target = nativeEntry()
    const origin = navigation?.entries().find(entry => entry.key === nativeOrigin!.key && entry.url === url)
    return target && origin && target.key !== origin.key ? index + target.index - origin.index : null
  }
  const supersede = (value: number) => {
    if (!pending) return
    if (pending.restoreTimer !== undefined) win.clearTimeout(pending.restoreTimer)
    if (!pending.traversalIssued || pending.issuedDestination === value) { pending = null; return }
    // An already-issued traversal cannot be cancelled through History API.
    // Absorb its pop and restore the newly authorized route, never the old one.
    pending.origin = value
    pending.result = false
    pending.replaying = false
    pending.atOrigin = false
  }
  replace(stamped(history.state, index), '', url)
  history.pushState = (state, unused, destination) => {
    const next = (currentPosition(history.state) ?? index) + 1
    push(stamped(state, next), unused, destination)
    supersede(next)
    remember(next)
  }
  history.replaceState = (state, unused, destination) => {
    const current = currentPosition(history.state) ?? index
    replace(stamped(state, current), unused, destination)
    supersede(current)
    remember(current)
  }
  const resume = (attempt: Pending) => {
    if (pending !== attempt || !attempt.atOrigin || attempt.result === undefined) return
    if (!attempt.result || guard !== attempt.owner) { pending = null; return }
    // A gesture can arrive after the promise resolves but before traversal.
    if (attempt.revision !== attempt.owner.revision()) {
      attempt.started = false
      attempt.result = undefined
      advance(attempt)
      return
    }
    attempt.replaying = true
    attempt.atOrigin = false
    attempt.traversalIssued = true
    attempt.issuedDestination = attempt.destination
    history.go(attempt.destination - attempt.origin)
  }
  const advance = (attempt: Pending) => {
    if (pending !== attempt || !attempt.atOrigin) return
    if (attempt.result !== undefined) { resume(attempt); return }
    if (attempt.started) return
    attempt.started = true
    attempt.revision = attempt.owner.revision()
    Promise.resolve().then(() => pending === attempt && guard === attempt.owner
      ? attempt.owner.requestLeave() : false).then(allowed => {
      if (pending !== attempt) return
      attempt.result = allowed
      resume(attempt)
    }, () => { if (pending === attempt) { attempt.result = false; resume(attempt) } })
  }
  const restore = (attempt: Pending) => {
    if (attempt.restoreTimer !== undefined) win.clearTimeout(attempt.restoreTimer)
    // Traversal requests share a browser task queue and may cancel one another.
    // Coalesce the burst, then calculate from the actual current entry, never
    // from the entry that originally scheduled a correction.
    attempt.restoreTimer = win.setTimeout(() => {
      attempt.restoreTimer = undefined
      if (pending !== attempt) return
      const current = currentPosition(history.state)
      if (current !== null && current !== attempt.origin) {
        attempt.traversalIssued = true
        attempt.issuedDestination = attempt.origin
        history.go(attempt.origin - current)
      }
    }, 0)
  }
  win.addEventListener('popstate', event => {
    const destination = currentPosition(event.state)
    if (destination === null) return // Previous documents retain beforeunload; never guess direction.
    const attempt = pending
    if (attempt) {
      attempt.traversalIssued = false
      if (attempt.replaying && destination === attempt.destination && guard === attempt.owner
        && attempt.revision === attempt.owner.revision()) {
        pending = null
        remember(destination)
        return
      }
      event.stopImmediatePropagation()
      attempt.atOrigin = destination === attempt.origin
      if (attempt.atOrigin) {
        if (attempt.restoreTimer !== undefined) win.clearTimeout(attempt.restoreTimer)
        attempt.restoreTimer = undefined
        remember(destination)
        if (guard !== attempt.owner) attempt.result = false
        advance(attempt)
      } else {
        if (attempt.replaying) { attempt.replaying = false; attempt.started = false; attempt.result = undefined }
        restore(attempt)
      }
      return
    }
    const from = new URL(url)
    const to = new URL(win.location.href)
    // Focus mode and hash-only history layers do not leave the editor resource.
    if (!guard || guard.shouldBlock?.() === false || (from.pathname === to.pathname && from.search === to.search)) { remember(destination); return }
    event.stopImmediatePropagation()
    pending = { owner: guard, origin: index, destination, atOrigin: false, started: false, replaying: false, traversalIssued: false }
    restore(pending)
  }, true)
  const controller: ClarinNavigationHistory = {
    register(next) {
      guard = next
      return () => {
        if (guard !== next) return
        guard = null
        if (pending?.owner === next) {
          pending.result = false
          if (pending.atOrigin) pending = null
        }
      }
    },
  }
  win.__CLARIN_NAVIGATION_HISTORY__ = controller
  return controller
}

export function buildNavigationHistoryScript() {
  return `;(${installClarinNavigationHistory.toString()})(window);`
}
