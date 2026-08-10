import type { Message } from '@/types/chat'

export const CLOUD_REACTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function canReactToCloudMessage(message: Message, customerServiceWindowOpen: boolean, now = Date.now()) {
  if (!customerServiceWindowOpen || !message.message_id || message.is_revoked || message.message_type === 'reaction') return false
  const timestamp = new Date(message.timestamp).getTime()
  if (!Number.isFinite(timestamp)) return false
  const age = now - timestamp
  return age >= 0 && age <= CLOUD_REACTION_MAX_AGE_MS
}
