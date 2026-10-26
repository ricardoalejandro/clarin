import type { Message } from '@/types/chat'
import { chatMediaIdentity } from '@/utils/chatMediaUrl'

/** A successful HTTP envelope alone cannot confirm that the requested file was sent. */
export function isCanonicalMediaSendAck(value: unknown, expected: { chatId: string; deviceId: string; mediaType: string; mediaUrl: string }): value is Message {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<Message>
  return typeof message.id === 'string' && message.id.length > 0 && !message.id.startsWith('optimistic-')
    && typeof message.message_id === 'string' && message.message_id.length > 0 && !message.message_id.startsWith('optimistic-')
    && message.chat_id === expected.chatId && message.device_id === expected.deviceId && message.is_from_me === true
    && message.message_type === expected.mediaType && ['sent', 'delivered', 'read'].includes(message.status || '')
    && typeof message.media_url === 'string' && message.media_url.length > 0 && !message.media_url.startsWith('blob:')
    && chatMediaIdentity(message.media_url) === chatMediaIdentity(expected.mediaUrl)
}
