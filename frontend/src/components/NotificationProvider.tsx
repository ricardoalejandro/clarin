'use client'

import { createContext, useContext, useEffect, useRef, useCallback, useState } from 'react'
import {
  getNotificationSettings,
  playNotificationSound,
  showBrowserNotification,
  resumeAudioContext,
  type NotificationSettings,
} from '@/lib/notificationSounds'

interface NotificationContextValue {
  /** Current account's notification settings (reactive) */
  settings: NotificationSettings | null
  /** Force refresh settings (e.g. after saving in Settings page) */
  refreshSettings: () => void
}

const NotificationContext = createContext<NotificationContextValue>({
  settings: null,
  refreshSettings: () => {},
})

export const useNotifications = () => useContext(NotificationContext)

interface Props {
  accountId: string
  children: React.ReactNode
}

export default function NotificationProvider({ accountId, children }: Props) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load / refresh settings
  const refreshSettings = useCallback(() => {
    if (accountId) {
      setSettings(getNotificationSettings(accountId))
    }
  }, [accountId])

  useEffect(() => {
    refreshSettings()
  }, [refreshSettings])

  // Ensure AudioContext can resume on user interaction
  useEffect(() => {
    const handler = () => resumeAudioContext()
    document.addEventListener('click', handler, { once: true })
    document.addEventListener('keydown', handler, { once: true })
    return () => {
      document.removeEventListener('click', handler)
      document.removeEventListener('keydown', handler)
    }
  }, [])

  // References for latest values (avoid stale closures in WS handler)
  const settingsRef = useRef(settings)
  useEffect(() => { settingsRef.current = settings }, [settings])

  // WebSocket connection for notifications
  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) return

    let alive = true

    function connect() {
      if (!alive) return
      const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws?token=${token}`
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.event === 'new_message' && !data.data?.is_from_me) {
            handleIncomingMessage(data.data)
          }
        } catch { /* ignore parse errors */ }
      }

      ws.onclose = () => {
        if (alive) {
          // Reconnect after 5s
          reconnectTimer.current = setTimeout(connect, 5000)
        }
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    connect()

    return () => {
      alive = false
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId])

  const handleIncomingMessage = useCallback((data: {
    chat_id?: string
    sender_name?: string
    message?: { body?: string }
    is_from_me?: boolean
  }) => {
    const s = settingsRef.current
    if (!s) return

    // Play sound
    if (s.sound_enabled && s.sound_type !== 'none') {
      playNotificationSound(s.sound_type, s.sound_volume)
    }

    // Browser notification (only if page not focused)
    if (s.browser_notifications && document.hidden) {
      const senderName = data.sender_name || 'Nuevo mensaje'
      const body = s.show_preview
        ? (data.message?.body || 'Mensaje recibido')
        : 'Tienes un nuevo mensaje'

      showBrowserNotification(senderName, body, () => {
        // Navigate to chat on click
        if (data.chat_id) {
          window.location.href = `/dashboard/chats?open=${data.chat_id}`
        }
      })
    }
  }, [])

  return (
    <NotificationContext.Provider value={{ settings, refreshSettings }}>
      {children}
    </NotificationContext.Provider>
  )
}
