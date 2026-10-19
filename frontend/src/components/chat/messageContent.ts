import type { Message } from '@/types/chat'

export function hasUnavailableGroupText(message: Message, isGroup: boolean): boolean {
  return isGroup
    && message.message_type === 'text'
    && !message.body?.trim()
    && !message.is_revoked
    && !message.is_view_once
    && !message.media_url
    && !message.media_filename
    && !message.media_mimetype
    && !message.media_size
    && !message.media_recoverable
    && !message.media_deleted
    && !message.media_unavailable_reason
}
