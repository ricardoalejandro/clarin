import { describe, expect, it } from 'vitest'
import { quickReplyAttachmentPayload } from './quickReplyAttachmentPayload'
import type { QuickReplyAttachment } from '@/types/quick-reply'

const attachment: QuickReplyAttachment = {
  id: 'attachment-1', media_asset_id: 'asset-1', media_type: 'image',
  media_url: '/api/media/account-a/photo.png?media_preview=synthetic-signature%2Fabc&expires=123',
  media_filename: 'Foto.png', caption: 'Hola', position: 5,
}
describe('quick reply attachment save payload', () => {
  it('preserves the uploaded URL grant byte-for-byte alongside the canonical asset ID', () => {
    const [payload] = quickReplyAttachmentPayload([attachment])
    expect(payload.media_asset_id).toBe('asset-1')
    expect(payload.media_url).toBe(attachment.media_url)
    expect(JSON.parse(JSON.stringify(payload)).media_url).toContain('?media_preview=synthetic-signature%2Fabc&expires=123')
  })
  it('preserves existing attachments and normalizes only array order and empty captions', () => {
    const existing = { ...attachment, id: 'existing', media_url: '/api/media/account-a/existing.png', caption: '' }
    const payload = quickReplyAttachmentPayload([existing, attachment])
    expect(payload.map(item => item.position)).toEqual([0, 1])
    expect(payload[0].media_url).toBe(existing.media_url)
    expect(payload[0].caption).toBe('')
    expect(payload[1].caption).toBe('Hola')
    expect(attachment.position).toBe(5)
  })
  it('keeps an intentionally empty attachment list empty', () => {
    expect(quickReplyAttachmentPayload([])).toEqual([])
  })
})
