// API helper for Clarin frontend

const API_BASE = process.env.NEXT_PUBLIC_API_URL || ''

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

    const data = await res.json()

    if (!res.ok) {
      // Handle 401 - redirect to login
      if (res.status === 401 && typeof window !== 'undefined') {
        localStorage.removeItem('token')
        window.location.href = '/'
        return { success: false, error: 'Sesión expirada' }
      }
      return { success: false, error: data.error || `Error ${res.status}` }
    }

    return { success: true, data }
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
