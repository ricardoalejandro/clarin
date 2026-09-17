const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const OFFLINE_PATHS = [
  /^\/$/,
  /^\/login\/?$/,
  /^\/dashboard\/?$/,
  /^\/dashboard\/(tasks|contacts|programs|whiteboards|conflicts)\/?$/,
  new RegExp(`^/dashboard/(programs|whiteboards)/${UUID}/?$`, 'i'),
]

export function isOfflinePathSupported(pathname: string) {
  return OFFLINE_PATHS.some(pattern => pattern.test(pathname))
}

export function safeOfflineDestination(input: string, origin = window.location.origin) {
  const url = new URL(input, origin)
  if (url.origin !== origin || !isOfflinePathSupported(url.pathname)) return null
  return `${url.pathname}${url.search}${url.hash}`
}

export interface NavigationSnapshot {
  pathname: string
  search: string
  hash: string
}

function currentSnapshot(): NavigationSnapshot {
  return { pathname: window.location.pathname, search: window.location.search, hash: window.location.hash }
}

export class OfflineNavigationAdapter {
  private listeners = new Set<(snapshot: NavigationSnapshot) => void>()

  private readonly handlePopState = () => this.emit()

  start() {
    window.addEventListener('popstate', this.handlePopState)
    return () => window.removeEventListener('popstate', this.handlePopState)
  }

  snapshot() {
    return currentSnapshot()
  }

  subscribe(listener: (snapshot: NavigationSnapshot) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  navigate(destination: string, options: { replace?: boolean } = {}) {
    const safe = safeOfflineDestination(destination)
    if (!safe) return false
    if (options.replace) window.history.replaceState(window.history.state, '', safe)
    else window.history.pushState(window.history.state, '', safe)
    this.emit()
    return true
  }

  private emit() {
    const snapshot = currentSnapshot()
    this.listeners.forEach(listener => listener(snapshot))
  }
}
