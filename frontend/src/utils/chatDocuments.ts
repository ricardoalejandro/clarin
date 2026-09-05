import type { Message } from '@/types/chat'

export interface ChatDocumentDescriptor {
  sessionId: string
  src: string
  filename: string
  mimeType?: string
  size?: number
}

type ChatDocumentFields = Pick<Message, 'id' | 'message_id' | 'media_filename' | 'media_mimetype' | 'media_size' | 'media_url'>

function normalizedMimeType(value?: string): string {
  return (value || '').split(';', 1)[0].trim().toLowerCase()
}

function hasPdfExtension(value?: string): boolean {
  if (!value) return false
  const withoutQuery = value.split(/[?#]/, 1)[0]
  return withoutQuery.toLowerCase().endsWith('.pdf')
}

export function isPdfChatDocument(document: Pick<ChatDocumentFields, 'media_filename' | 'media_mimetype' | 'media_url'>): boolean {
  return normalizedMimeType(document.media_mimetype) === 'application/pdf'
    || hasPdfExtension(document.media_filename)
    || hasPdfExtension(document.media_url)
}

export function chatDocumentDescriptor(message: ChatDocumentFields, src: string): ChatDocumentDescriptor {
  return {
    sessionId: `${message.id || message.message_id}:${src}`,
    src,
    filename: message.media_filename?.trim() || 'Documento',
    mimeType: message.media_mimetype,
    size: message.media_size,
  }
}
