import type { Message } from '@/types/chat'
import type { QuickReplyComposerDraft } from '@/types/quick-reply'

// Freeze one request per block. Retries must keep the operation ID and payload,
// including quote and caption; a confirmed block is never resent.
export function freezeQuickReplySequence(draft: QuickReplyComposerDraft, context: {
  chatId: string; deviceId: string; jid: string; through: string; quote: Message | null; trailingText: string
}): QuickReplyComposerDraft {
  if (draft.started) return draft
  const items = [...(draft.items || [])].filter(item => item.type === 'media' || item.text?.trim())
  if (context.trailingText.trim()) items.push({ id: crypto.randomUUID(), operationId: crypto.randomUUID(), type: 'text', text: context.trailingText })
  return { ...draft, started: true, throughMessageId: context.through, items: items.map((item, index) => {
    const attachment = draft.allAttachments?.find(row => row.id === item.attachment_id)
    const quote = index === 0 ? context.quote : null
    return { ...item, payload: {
      device_id: context.deviceId, chat_id: context.chatId, to: context.jid,
      body: item.type === 'text' ? item.text : attachment?.caption || '',
      ...(attachment ? { media_url: attachment.media_url, media_type: attachment.media_type, media_filename: attachment.media_filename } : {}),
      client_operation_id: item.operationId, quick_reply: true, defer_attention: true,
      attention_through_message_id: context.through,
      quoted_message_id: quote?.message_id || quote?.id,
      quoted_body: quote?.body || quote?.media_filename,
      quoted_sender: quote?.is_from_me ? 'Me' : quote?.from_name || quote?.from_jid,
      quoted_is_from_me: quote?.is_from_me,
    } }
  }) }
}
