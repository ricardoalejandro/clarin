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

// WebSocket helper
export function createWebSocket(onMessage: (data: unknown) => void) {
  if (typeof window === 'undefined') return null

  const token = localStorage.getItem('token')
  if (!token) return null

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${window.location.host}/ws?token=${token}`

  const ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    console.log('WebSocket connected')
  }

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      onMessage(data)
    } catch (err) {
      console.error('WebSocket parse error:', err)
    }
  }

  ws.onerror = (err) => {
    console.error('WebSocket error:', err)
  }

  ws.onclose = () => {
    console.log('WebSocket disconnected')
  }

  return ws
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

export interface Lead {
  id: string
  jid: string
  name: string
  phone: string
  email: string
  status: string
  notes: string
  tags: string[]
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
