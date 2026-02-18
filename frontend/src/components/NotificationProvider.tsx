'use client'

import { createContext, useContext, useEffect, useRef, useCallback, useState } from 'react'
import { createWebSocket } from '@/lib/api'
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
  const wsRef = useRef<ReturnType<typeof createWebSocket>>(null)

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
    const ws = createWebSocket((data: unknown) => {
      const msg = data as { event?: string; data?: { is_from_me?: boolean } }
      if (msg.event === 'new_message' && !msg.data?.is_from_me) {
        handleIncomingMessage(msg.data as Parameters<typeof handleIncomingMessage>[0])
      }
    })
    wsRef.current = ws

    return () => {
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
