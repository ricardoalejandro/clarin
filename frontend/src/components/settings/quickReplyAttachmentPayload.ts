import type { QuickReplyAttachment } from '@/types/quick-reply'

/** Preserve the short-lived upload grant until the server attaches the asset.
 * The server still resolves the canonical object from media_asset_id; this URL
 * proves possession of a fresh upload and is not trusted as its storage path.
 */
export function quickReplyAttachmentPayload(attachments: QuickReplyAttachment[]) {
  return attachments.map((attachment, position) => ({
    id: attachment.id,
    media_asset_id: attachment.media_asset_id,
    media_url: attachment.media_url,
    media_type: attachment.media_type,
    media_filename: attachment.media_filename,
    caption: attachment.caption || '',
    position,
  }))
}
