import { describe, expect, it } from 'vitest'
import type { Message } from '@/types/chat'
import { canReactToCloudMessage, CLOUD_REACTION_MAX_AGE_MS } from './cloudChatCapabilities'

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'db-1', message_id: 'wamid.1', is_from_me: false, is_read: true,
    status: 'received', timestamp: new Date(1_000_000).toISOString(), message_type: 'text',
    ...overrides,
  }
}

describe('WhatsApp Cloud reaction capability', () => {
  it('allows a canonical recent message only while the service window is open', () => {
    const now = 1_000_000 + CLOUD_REACTION_MAX_AGE_MS
    expect(canReactToCloudMessage(message(), true, now)).toBe(true)
    expect(canReactToCloudMessage(message(), false, now)).toBe(false)
  })

  it('rejects future, expired, revoked and reaction-event targets', () => {
    expect(canReactToCloudMessage(message(), true, 999_999)).toBe(false)
    expect(canReactToCloudMessage(message(), true, 1_000_001 + CLOUD_REACTION_MAX_AGE_MS)).toBe(false)
    expect(canReactToCloudMessage(message({ is_revoked: true }), true, 1_000_001)).toBe(false)
    expect(canReactToCloudMessage(message({ message_type: 'reaction' }), true, 1_000_001)).toBe(false)
    expect(canReactToCloudMessage(message({ message_id: '' }), true, 1_000_001)).toBe(false)
  })
})
