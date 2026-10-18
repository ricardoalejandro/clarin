import { describe, expect, it } from 'vitest'
import type { Chat, Message } from '@/types/chat'
import { latestReadBoundary, observedIncomingBoundary, mergeChatSnapshot, isConversationAtLatest, followConversationLatest, sendOnEnter } from './chatExperience'
const message = (id: string, incoming = false): Message => ({ id, message_id: id, timestamp: '2026-10-11T12:00:00Z', is_from_me: !incoming, is_read: false, status: 'sent' })
describe('conversation reading and keyboard contract', () => {
  it('uses the last canonical outgoing message when unread incoming messages lie outside the loaded window', () => {
    expect(latestReadBoundary([message('a'), message('z'), message('optimistic-9')])?.id).toBe('z')
    expect(latestReadBoundary([])).toBeUndefined()
    expect(latestReadBoundary([{ ...message('z'), is_revoked: true }, message('a', true)])?.id).toBe('a')
  })
  it('never sends with Android Enter, composition, or Shift+Enter', () => {
    expect(sendOnEnter({ key: 'Enter', shiftKey: false }, true)).toBe(false)
    expect(sendOnEnter({ key: 'Enter', shiftKey: false }, false)).toBe(true)
    expect(sendOnEnter({ key: 'Enter', shiftKey: true }, false)).toBe(false)
    expect(sendOnEnter({ key: 'Enter', shiftKey: false, isComposing: true }, false)).toBe(false)
    expect(sendOnEnter({ key: 'Enter', shiftKey: false, keyCode: 229 }, false)).toBe(false)
  })
  it('uses an older server boundary but never acknowledges an incoming arrival beyond the displayed snapshot', () => {
    const rows = [message('z')]
    expect(observedIncomingBoundary(rows, { last_incoming_message_id: 'a', last_incoming_at: '2026-10-11T11:00:00Z' })).toBe('a')
    expect(observedIncomingBoundary(rows, { last_incoming_message_id: 'new', last_incoming_at: '2026-10-11T12:01:00Z' })).toBeUndefined()
    expect(observedIncomingBoundary([message('a', true), ...rows], { last_incoming_message_id: 'new', last_incoming_at: '2026-10-11T12:01:00Z' })).toBe('a')
  })
})


describe('canonical conversation snapshots', () => {
  const current: Chat = { id: 'chat', jid: 'peer', name: 'Name', last_message: 'Preview', last_message_at: '2026-10-11T12:00:00Z',
    unread_count: 2, needs_reply: true, waiting_since: '2026-10-11T12:00:00Z', state_version: 11,
    last_incoming_message_id: 'new', last_incoming_at: '2026-10-11T12:00:00Z' }
  it('rejects stale HTTP attention fields after a newer realtime snapshot, while refreshing identity', () => {
    const actual = mergeChatSnapshot(current, { ...current, name: 'Updated identity', unread_count: 0, needs_reply: false, waiting_since: null,
      state_version: 10, last_incoming_message_id: 'old', last_incoming_at: '2026-10-11T11:00:00Z' })
    expect(actual).toEqual({ ...current, name: 'Updated identity' })
    expect(mergeChatSnapshot(current, current, { chat_id: current.id, unread_count: 0, needs_reply: false, waiting_since: null, state_version: 10 })).toEqual(current)
  })
  it('preserves an omitted boundary but clears an explicit canonical null', () => {
    const { last_incoming_message_id: _id, last_incoming_at: _at, ...partial } = current
    expect(mergeChatSnapshot(current, partial).last_incoming_message_id).toBe('new')
    const cleared = mergeChatSnapshot(current, partial, { chat_id: current.id, unread_count: 0, needs_reply: false, waiting_since: null,
      state_version: 12, last_incoming_message_id: null, last_incoming_at: null })
    expect(cleared.last_incoming_message_id).toBeNull()
    expect(cleared.last_incoming_at).toBeNull()
    expect(cleared.unread_count).toBe(0)
    expect(cleared).not.toHaveProperty('chat_id')
  })
  it('does not carry state or a boundary to a different chat', () => {
    const other = { id: 'other', jid: 'other-peer', name: 'Other', last_message: '', last_message_at: '', unread_count: 0 }
    expect(mergeChatSnapshot(current, other)).toEqual(other)
  })
  it('prefers a newer observed incoming message over a lagging server boundary, including timestamp ties', () => {
    expect(observedIncomingBoundary([message('m', true), message('z')], { last_incoming_message_id: 'a', last_incoming_at: '2026-10-11T12:00:00Z' })).toBe('m')
    expect(observedIncomingBoundary([message('m', true), message('z')], { last_incoming_message_id: 'a', last_incoming_at: '2026-10-11T11:00:00Z' })).toBe('m')
    expect(observedIncomingBoundary([message('a', true), message('z')], { last_incoming_message_id: 'm', last_incoming_at: '2026-10-11T12:00:00Z' })).toBe('m')
  })
})

describe('conversation viewport intent', () => {
  it('requires a measurable viewport and the actual end for reading, not merely the follow threshold', () => {
    expect(isConversationAtLatest(null)).toBe(false)
    expect(isConversationAtLatest({ clientHeight: 0, scrollHeight: 0, scrollTop: 0 })).toBe(false)
    expect(isConversationAtLatest({ clientHeight: 600, scrollHeight: 1200, scrollTop: 487 })).toBe(false)
    expect(isConversationAtLatest({ clientHeight: 600, scrollHeight: 1200, scrollTop: 598 })).toBe(true)
  })
  it('follows media or viewport resize only while active and following the latest conversation', () => {
    const container = { clientHeight: 600, scrollHeight: 1800, scrollTop: 600 }
    expect(followConversationLatest(container, true, true, false)).toBe(true)
    expect(container.scrollTop).toBe(1800)
    container.scrollTop = 200
    expect(followConversationLatest(container, false, true, false)).toBe(false)
    expect(followConversationLatest(container, true, false, false)).toBe(false)
    expect(followConversationLatest(container, true, true, true)).toBe(false)
    expect(container.scrollTop).toBe(200)
  })
})


it('preserves newer personal pin state while refreshing canonical messages and metadata', () => {
  const current = { id: 'group', jid: 'group@g.us', name: 'Group', unread_count: 1, last_message: '', last_message_at: '', is_pinned: true, pinned_at: '2026-10-18T00:00:00Z', pin_version: 3 } as Chat
  expect(mergeChatSnapshot(current, { ...current, is_pinned: false, pinned_at: null, pin_version: 2, unread_count: 2, last_message: 'Nuevo' })).toMatchObject({ is_pinned: true, pin_version: 3, unread_count: 2, last_message: 'Nuevo' })
})
