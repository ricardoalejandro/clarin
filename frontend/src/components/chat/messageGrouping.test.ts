import { describe, expect, it } from 'vitest'
import type { Message } from '@/types/chat'
import { groupChatMessages } from './messageGrouping'

const base: Message = { id: 'a', message_id: 'wa-a', device_id: 'device-a', from_jid: 'known-sender', is_from_me: false, is_read: true, status: 'delivered', timestamp: new Date(2026, 9, 11, 10, 0).toISOString() }
const next = (patch: Partial<Message> = {}): Message => ({ ...base, id: 'b', message_id: 'wa-b', timestamp: new Date(2026, 9, 11, 10, 2).toISOString(), ...patch })

describe('message grouping', () => {
  it('groups the same known incoming author through the inclusive two minute boundary', () => {
    expect(groupChatMessages(base, next())).toBe(true)
    expect(groupChatMessages(base, next({ timestamp: new Date(2026, 9, 11, 10, 2, 1).toISOString() }))).toBe(false)
  })
  it('does not infer an author from a display name or outgoing direction', () => {
    expect(groupChatMessages({ ...base, from_jid: undefined, from_name: 'Ana' }, next({ from_jid: undefined, from_name: 'Ana' }))).toBe(false)
    expect(groupChatMessages({ ...base, is_from_me: true }, next({ is_from_me: true }))).toBe(false)
  })
  it('groups a known agent but never merges different agents or devices', () => {
    const outgoing = { ...base, is_from_me: true, sender: { origin: 'user', user_id: 'user-a' } }
    expect(groupChatMessages(outgoing, next({ is_from_me: true, sender: outgoing.sender }))).toBe(true)
    expect(groupChatMessages(outgoing, next({ is_from_me: true, sender: { origin: 'user', user_id: 'user-b' } }))).toBe(false)
    expect(groupChatMessages(base, next({ device_id: 'device-b' }))).toBe(false)
  })
  it('breaks at day, direction, revoked, invalid and reversed timestamps', () => {
    expect(groupChatMessages({ ...base, timestamp: new Date(2026, 9, 11, 23, 59).toISOString() }, next({ timestamp: new Date(2026, 9, 12, 0, 0).toISOString() }))).toBe(false)
    expect(groupChatMessages(base, next({ is_from_me: true }))).toBe(false)
    expect(groupChatMessages(base, next({ is_revoked: true }))).toBe(false)
    expect(groupChatMessages(base, next({ timestamp: 'invalid' }))).toBe(false)
    expect(groupChatMessages(next(), base)).toBe(false)
    expect(groupChatMessages(undefined, base)).toBe(false)
  })
})
