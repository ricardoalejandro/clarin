import type { Message, MessageLinkPreview } from '@/types/chat'
import { safeWebHref } from '@/lib/webLinks'
import { formattedWebHrefs } from '@/lib/whatsappFormat'
import { linkPreviewVersion, mergeMessageLinkPreview } from './messageState'

export const LINK_PREVIEW_THUMBNAIL_SIZE = 72
const THUMBNAIL_PATH = /^\/api\/media\/file\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/link-previews\/[0-9a-f]{64}(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.jpg$/i

export function localPreviewThumbnail(value: unknown): string | null {
  return typeof value === 'string' && THUMBNAIL_PATH.test(value) ? value : null
}

export function visibleLinkPreview(message: Message) {
  const preview = message.link_preview
  if (!preview || message.is_revoked || message.is_view_once || !message.body) return null
  const href = safeWebHref(preview.url)
  if (!href || !formattedWebHrefs(message.body).includes(href)) return null
  const title = typeof preview.title === 'string' ? preview.title.trim() : ''
  const description = typeof preview.description === 'string' ? preview.description.trim() : ''
  const thumbnail = localPreviewThumbnail(preview.thumbnail_url)
  if (!title && !description && !thumbnail) return null
  return {
    href,
    domain: new URL(href).host,
    title,
    description,
    thumbnail,
  }
}

export interface LinkPreviewUpdate {
  chat_id: string
  device_id: string | null
  /** Local UUID, not the provider message ID. */
  message_id: string
  body_snapshot: string
  is_edited_snapshot: boolean
  link_preview: MessageLinkPreview | null
  link_preview_version: number
}

/** Enrichment owns only metadata and cannot restore content after an edit or revocation. */
export function updateLinkPreviewProjection(messages: Message[], update: LinkPreviewUpdate): Message[] {
  const incomingVersion = linkPreviewVersion(update.link_preview_version)
  if (incomingVersion === undefined) return messages
  let changed = false
  const next = messages.map(message => {
    if (message.id !== update.message_id || message.is_revoked || message.is_view_once
      || (message.chat_id && message.chat_id !== update.chat_id)
      || (message.device_id && message.device_id !== update.device_id)
      || (message.body ?? '') !== update.body_snapshot
      || Boolean(message.is_edited) !== update.is_edited_snapshot
      || update.link_preview === undefined) return message
    const knownVersion = linkPreviewVersion(message.link_preview_version)
    if (knownVersion !== undefined && incomingVersion <= knownVersion) return message
    changed = true
    return { ...message, link_preview: update.link_preview, link_preview_version: incomingVersion }
  })
  return changed ? next : messages
}

export interface MessageEditUpdate {
  message_id: string
  new_body: string
  mentions?: Message['mentions']
  link_preview?: MessageLinkPreview | null
  link_preview_version?: number
}

export function updateEditedMessageProjection(messages: Message[], update: MessageEditUpdate): Message[] {
  let changed = false
  const next = messages.map(message => {
    if (message.message_id !== update.message_id || message.is_revoked) return message
    changed = true
    return { ...message, body: update.new_body, is_edited: true, mentions: update.mentions ?? message.mentions,
      ...mergeMessageLinkPreview(message, update),
      // A confirmed legacy edit may clear the card before its versioned echo arrives.
      ...(update.link_preview === null && update.link_preview_version === undefined ? { link_preview: null } : {}),
    }
  })
  return changed ? next : messages
}

export function updateRevokedMessageProjection(messages: Message[], update: { message_id: string; link_preview_version?: number }): Message[] {
  let changed = false
  const next = messages.map(message => {
    if (message.message_id !== update.message_id) return message
    changed = true
    return { ...message, is_revoked: true, body: undefined, ...mergeMessageLinkPreview(message, update, true) }
  })
  return changed ? next : messages
}
