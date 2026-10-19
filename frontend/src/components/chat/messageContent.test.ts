import { describe, expect, it } from 'vitest'
import type { Message } from '@/types/chat'
import { hasUnavailableGroupText } from './messageContent'

const message: Message = { id: 'message', message_id: 'provider', message_type: 'text', is_from_me: false, is_read: true, status: 'read', timestamp: '2026-10-18T12:00:00Z' }

describe('unavailable group text', () => {
  it.each([undefined, '', ' \n\t '])('identifies an empty group text body: %j', body => {
    expect(hasUnavailableGroupText({ ...message, body }, true)).toBe(true)
  })
  it('leaves individual conversations and ordinary text unchanged', () => {
    expect(hasUnavailableGroupText(message, false)).toBe(false)
    expect(hasUnavailableGroupText({ ...message, body: 'Hola' }, true)).toBe(false)
  })
  it.each([
    { is_revoked: true },
    { is_view_once: true },
    { message_type: 'image' },
    { message_type: 'document' },
    { media_url: '/api/media/file/account/image.png' },
    { media_filename: 'Archivo.pdf' },
    { media_mimetype: 'application/pdf' },
    { media_size: 20 },
    { media_recoverable: true },
    { media_deleted: true },
    { media_unavailable_reason: 'group_media_too_large' as const },
  ])('preserves revoked and media-specific states: %j', state => {
    expect(hasUnavailableGroupText({ ...message, ...state }, true)).toBe(false)
  })
})
