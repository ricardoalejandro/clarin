// API helper for Clarin frontend

const API_BASE = process.env.NEXT_PUBLIC_API_URL || ''

// ─── Version Detection ────────────────────────────────────────────────────────
// Tracks server version from X-Clarin-Version header and notifies listeners
let _latestServerVersion: string | null = null
const _versionListeners = new Set<(version: string) => void>()

export function getLatestServerVersion(): string | null {
  return _latestServerVersion
}

export function onServerVersionChange(cb: (version: string) => void): () => void {
  _versionListeners.add(cb)
  return () => _versionListeners.delete(cb)
}

function checkVersionHeader(res: Response) {
  const serverVersion = res.headers.get('x-clarin-version')
  if (serverVersion && serverVersion !== _latestServerVersion) {
    _latestServerVersion = serverVersion
    _versionListeners.forEach(cb => {
      try { cb(serverVersion) } catch (e) { console.error('Version listener error:', e) }
    })
  }
}

interface FetchOptions extends RequestInit {
  skipAuth?: boolean
}

export async function api<T>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<{ success: boolean; data?: T; error?: string }> {
  const { skipAuth = false, ...fetchOptions } = options

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...fetchOptions.headers,
  }

  // Add auth token if available and not skipped
  if (!skipAuth && typeof window !== 'undefined') {
    const token = localStorage.getItem('token')
    if (token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`
    }
  }

  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      ...fetchOptions,
      headers,
    })

    // Check for server version changes
    checkVersionHeader(res)

    // Handle empty responses (204 No Content, etc.)
    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return { success: true, data: undefined as unknown as T }
    }

    let data: any
    try {
      data = await res.json()
    } catch {
      // Response body is not JSON (empty or non-JSON)
      if (res.ok) return { success: true, data: undefined as unknown as T }
      return { success: false, error: `Error ${res.status}` }
    }

    if (!res.ok) {
      // Handle 401 - redirect to login
      if (res.status === 401 && typeof window !== 'undefined') {
        localStorage.removeItem('token')
        window.location.href = '/'
        return { success: false, error: 'Sesión expirada' }
      }
      return { success: false, error: data?.error || `Error ${res.status}` }
    }

    return { success: true, data: data as T }
  } catch (err) {
    console.error('API Error:', err)
    return { success: false, error: 'Error de conexión' }
  }
}

// Convenience methods
export const apiGet = <T>(endpoint: string) => api<T>(endpoint, { method: 'GET' })

export const apiPost = <T>(endpoint: string, body: unknown) =>
  api<T>(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  })

export const apiPut = <T>(endpoint: string, body: unknown) =>
  api<T>(endpoint, {
    method: 'PUT',
    body: JSON.stringify(body),
  })

export const apiDelete = <T>(endpoint: string) =>
  api<T>(endpoint, { method: 'DELETE' })

// WebSocket helper with auto-reconnect and exponential backoff
export function createWebSocket(
  onMessage: (data: unknown) => void,
  onConnect?: (send: (data: string) => void) => void
) {
  if (typeof window === 'undefined') return null

  const token = localStorage.getItem('token')
  if (!token) return null

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${window.location.host}/ws?token=${token}`

  let ws: WebSocket | null = null
  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let intentionallyClosed = false

  function connect() {
    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      console.log('WebSocket connected')
      reconnectAttempts = 0
      if (onConnect) {
        onConnect((data: string) => {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(data)
        })
      }
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        onMessage(data)
      } catch (err) {
        console.error('WebSocket parse error:', err)
      }
    }

    ws.onerror = () => {
      // Error is logged by the browser natively
    }

    ws.onclose = () => {
      if (intentionallyClosed) return
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
      reconnectAttempts++
      console.log(`WebSocket reconnecting in ${delay / 1000}s...`)
      reconnectTimer = setTimeout(connect, delay)
    }
  }

  connect()

  // Return proxy that delegates to current ws instance
  return {
    close() {
      intentionallyClosed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (ws) ws.close()
    },
    get readyState() {
      return ws ? ws.readyState : WebSocket.CLOSED
    },
    send(data: string) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data)
    },
  }
}

// ─── Shared WebSocket Singleton ───────────────────────────────────────────────
// A single WS connection shared across all components. Components subscribe to
// events via callbacks and unsubscribe on unmount. This prevents the
// "WebSocket closed before the connection is established" error caused by
// multiple components each opening/closing their own WS rapidly during navigation.

type WSListener = (data: unknown) => void
type WSConnectListener = (send: (data: string) => void) => void

let _sharedWS: WebSocket | null = null
let _sharedReconnectTimer: ReturnType<typeof setTimeout> | null = null
let _sharedReconnectAttempts = 0
let _sharedIntentionallyClosed = false
let _sharedRefCount = 0
const _sharedListeners = new Set<WSListener>()
const _sharedConnectListeners = new Set<WSConnectListener>()

function _sharedSend(data: string) {
  if (_sharedWS && _sharedWS.readyState === WebSocket.OPEN) {
    _sharedWS.send(data)
  }
}

function _sharedConnect() {
  if (typeof window === 'undefined') return

  const token = localStorage.getItem('token')
  if (!token) return

  // Don't create a new connection if one is already open/connecting
  if (_sharedWS && (_sharedWS.readyState === WebSocket.OPEN || _sharedWS.readyState === WebSocket.CONNECTING)) {
    return
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${window.location.host}/ws?token=${token}`

  _sharedWS = new WebSocket(wsUrl)

  _sharedWS.onopen = () => {
    console.log('WebSocket connected')
    _sharedReconnectAttempts = 0
    _sharedConnectListeners.forEach(cb => {
      try { cb(_sharedSend) } catch (e) { console.error('WS connect listener error:', e) }
    })
  }

  _sharedWS.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      _sharedListeners.forEach(cb => {
        try { cb(data) } catch (e) { console.error('WS listener error:', e) }
      })
    } catch (err) {
      console.error('WebSocket parse error:', err)
    }
  }

  _sharedWS.onerror = () => {
    // Logged natively by the browser
  }

  _sharedWS.onclose = () => {
    _sharedWS = null
    if (_sharedIntentionallyClosed || _sharedRefCount <= 0) return
    const delay = Math.min(1000 * Math.pow(2, _sharedReconnectAttempts), 30000)
    _sharedReconnectAttempts++
    console.log(`WebSocket reconnecting in ${delay / 1000}s...`)
    _sharedReconnectTimer = setTimeout(_sharedConnect, delay)
  }
}

/**
 * Subscribe to the shared WebSocket. Returns an unsubscribe function.
 * The WS connection is opened on first subscribe, closed when all unsubscribe.
 */
export function subscribeWebSocket(
  onMessage: WSListener,
  onConnect?: WSConnectListener
): () => void {
  _sharedListeners.add(onMessage)
  if (onConnect) _sharedConnectListeners.add(onConnect)

  _sharedRefCount++
  _sharedIntentionallyClosed = false

  // Ensure connection is alive
  _sharedConnect()

  // If already connected, fire onConnect immediately
  if (onConnect && _sharedWS && _sharedWS.readyState === WebSocket.OPEN) {
    try { onConnect(_sharedSend) } catch (e) { console.error('WS connect listener error:', e) }
  }

  // Return unsubscribe function
  return () => {
    _sharedListeners.delete(onMessage)
    if (onConnect) _sharedConnectListeners.delete(onConnect)
    _sharedRefCount--

    if (_sharedRefCount <= 0) {
      _sharedRefCount = 0
      _sharedIntentionallyClosed = true
      if (_sharedReconnectTimer) {
        clearTimeout(_sharedReconnectTimer)
        _sharedReconnectTimer = null
      }
      if (_sharedWS) {
        _sharedWS.close()
        _sharedWS = null
      }
    }
  }
}

/** Send a message through the shared WebSocket */
export function sendSharedWS(data: string) {
  _sharedSend(data)
}

// Type definitions for API responses
export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

export interface Device {
  id: string
  name: string
  phone_number: string
  status: string
  last_seen: string
  created_at: string
}

export interface Chat {
  id: string
  jid: string
  name: string
  last_message: string
  last_message_at: string
  unread_count: number
}

export interface Message {
  id: string
  message_id: string
  from_jid: string
  from_name: string
  body: string
  message_type: string
  is_from_me: boolean
  is_read: boolean
  status: string
  timestamp: string
}

export interface Tag {
  id: string
  account_id: string
  name: string
  color: string
  created_at: string
}

export interface Lead {
  id: string
  jid: string
  contact_id: string | null
  name: string
  last_name: string | null
  short_name: string | null
  phone: string
  email: string
  company: string | null
  age: number | null
  dni: string | null
  birth_date: string | null
  status: string
  notes: string
  tags: string[]
  structured_tags: Tag[] | null
  assigned_to: string
  created_at: string
  updated_at: string
}

export interface Contact {
  id: string
  account_id: string
  device_id: string | null
  jid: string
  phone: string | null
  name: string | null
  custom_name: string | null
  push_name: string | null
  avatar_url: string | null
  email: string | null
  company: string | null
  tags: string[] | null
  structured_tags: Tag[] | null
  notes: string | null
  source: string | null
  is_group: boolean
  created_at: string
  updated_at: string
}

export interface User {
  id: string
  email: string
  name: string
  role: string
}

export interface Account {
  id: string
  name: string
  slug: string
  plan: string
  created_at: string
}

export interface QuickReply {
  id: string
  account_id: string
  shortcut: string
  title: string
  body: string
  created_at: string
  updated_at: string
}
