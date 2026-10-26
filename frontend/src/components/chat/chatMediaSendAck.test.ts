import { describe, expect, it } from 'vitest'
import type { Message } from '@/types/chat'
import { isCanonicalMediaSendAck } from './chatMediaSendAck'

const expected = { chatId: 'chat', deviceId: 'device', mediaType: 'audio', mediaUrl: '/api/media/file/account/audio.ogg' }
const confirmed: Message = { id: 'canonical-local', message_id: 'provider-id', chat_id: expected.chatId, device_id: expected.deviceId, message_type: 'audio', media_url: expected.mediaUrl, status: 'sent', is_from_me: true, is_read: false, timestamp: '2026-10-25T00:00:00Z' }

describe('canonical attachment acknowledgement', () => {
  it.each(['sent', 'delivered', 'read'])('accepts confirmed status %s without inventing a delivery receipt', status => {
    const message = { ...confirmed, status }
    expect(isCanonicalMediaSendAck(message, expected)).toBe(true)
    expect(message.status).toBe(status)
  })
  it('recognizes the same account object through its authenticated and legacy public URLs', () => {
    expect(isCanonicalMediaSendAck({ ...confirmed, media_url: 'https://media.test.invalid/clarin-media/account/audio.ogg' }, expected)).toBe(true)
  })
  it.each([null, undefined, {}, { ...confirmed, id: 'optimistic-1' }, { ...confirmed, message_id: '' }, { ...confirmed, chat_id: 'other' }, { ...confirmed, device_id: 'other' }, { ...confirmed, message_type: 'text' }, { ...confirmed, media_url: undefined }, { ...confirmed, media_url: 'blob:local' }, { ...confirmed, media_url: '/api/media/file/account/other.ogg' }, { ...confirmed, status: 'failed' }, { ...confirmed, status: undefined }, { ...confirmed, is_from_me: false }])('does not confirm incomplete or contradictory attachment data %#', value => {
    expect(isCanonicalMediaSendAck(value, expected)).toBe(false)
  })
})
