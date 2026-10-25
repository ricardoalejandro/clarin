import type { Chat, Device } from '@/types/chat'
import { bindingRevision, verifiedChatContinuity } from './chatContinuity'

export interface ChatSenderSession { chatId: string | null; deviceId: string | null; phone?: string | null; bindingRevision?: number; accountId?: string; jid?: string }

export function chatSenderPhone(device: Device | null | undefined) {
  return (device?.phone || '').replace(/[^0-9]/g, '')
}

/** A history refresh may validate a sender, never choose a different sender. */
export function validatePinnedChatSender(session: ChatSenderSession, device: Device | null, snapshot?: Chat | null) {
  if (snapshot?.binding_state === 'pending' || snapshot?.binding_state === 'conflict') return 'changed' as const
  if (session.phone && device && session.phone !== chatSenderPhone(device)) return 'changed' as const
  if (session.deviceId && device?.id && session.deviceId !== device.id) {
    const verified = snapshot && snapshot.device_id === device.id && bindingRevision(snapshot) > (session.bindingRevision || 0)
      && verifiedChatContinuity(snapshot, { id: session.chatId || '', account_id: session.accountId, jid: session.jid || snapshot.jid, binding_revision: session.bindingRevision })
    if (!verified) return 'changed' as const
  }
  return 'ready' as const
}
