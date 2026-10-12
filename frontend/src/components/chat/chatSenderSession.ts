import type { Device } from '@/types/chat'

export interface ChatSenderSession { chatId: string | null; deviceId: string | null; phone?: string | null }

export function chatSenderPhone(device: Device | null | undefined) {
  return (device?.phone || '').replace(/[^0-9]/g, '')
}

/** A history refresh may validate a sender, never choose a different sender. */
export function validatePinnedChatSender(session: ChatSenderSession, device: Device | null) {
  if (session.deviceId && device?.id && session.deviceId !== device.id) return 'changed' as const
  if (session.phone && device && session.phone !== chatSenderPhone(device)) return 'changed' as const
  return 'ready' as const
}
