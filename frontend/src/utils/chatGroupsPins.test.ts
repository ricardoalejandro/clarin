import { describe, expect, it } from 'vitest'
import type { Chat, Message } from '@/types/chat'
import { chatPreview, displayMentionText, groupReactionsUnavailable, groupMessageAuthor, groupWriteRestriction, participantName } from './chatGroups'
import { formatPhone, getChatDisplayName, mergeReconciledChatIdentity, reconcileChatIdentity } from './chat'
import { orderInbox, reconcileInboxPage } from './chatInbox'
import { applyChatPin } from './chatPins'
const chat: Chat = { id: 'group', jid: '120000@g.us', kind: 'group', name: 'Grupo', last_message: 'Hola', last_message_at: '2026-10-18T12:00:00Z', unread_count: 3 }
describe('group identity and private pins', () => {
  it('never turns a group or unresolved participant LID into a telephone', () => {
    expect(formatPhone(chat.jid, '120000')).toBe('')
    expect(participantName('120000@lid')).toBe('Participante de WhatsApp')
    expect(getChatDisplayName({ ...chat, contact_custom_name: 'Persona equivocada' })).toBe('Grupo')
    expect(groupMessageAuthor({ is_from_me: false, from_name: 'María', from_jid: '51@s.whatsapp.net' } as Message)).toBe('María')
  })
  it('keeps membership and admin restrictions authoritative', () => {
    expect(groupWriteRestriction(chat)).toContain('Actualizando')
    expect(groupWriteRestriction({ ...chat, group: { subject: 'Grupo', participant_count: 3, membership_status: 'left', announce: false, can_send: false } })).toContain('ya no pertenece')
    expect(groupWriteRestriction({ ...chat, group: { subject: 'Grupo', participant_count: 3, membership_status: 'member', announce: false, can_send: true } })).toBeNull()
  })
  it('qualifies group previews with their actual author', () => {
    expect(chatPreview({ ...chat, last_message_from_name: 'María' })).toBe('María: Hola')
    expect(chatPreview({ ...chat, last_message_from_me: true })).toBe('Tú: Hola')
  })
  it('preserves pin order under new messages and preserves pending FIFO', () => {
    const first = { ...chat, id: 'first', is_pinned: true, pinned_at: '2026-10-18T10:00:00Z', waiting_since: '2026-10-18T11:00:00Z' }
    const second = { ...chat, id: 'second', is_pinned: true, pinned_at: '2026-10-18T09:00:00Z', last_message_at: '2026-10-19T12:00:00Z', waiting_since: '2026-10-18T10:00:00Z' }
    expect(orderInbox([chat, second, first], 'all').map(row => row.id)).toEqual(['first', 'second', 'group'])
    expect(orderInbox([first, second], 'pending').map(row => row.id)).toEqual(['second', 'first'])
  })
  it('rejects stale pin versions without reverting messages or unread state', () => {
    const pinned = applyChatPin(chat, { chat_id: chat.id, is_pinned: true, pinned_at: '2026-10-18T10:00:00Z', pin_version: 4 })
    expect(applyChatPin(pinned, { chat_id: chat.id, is_pinned: false, pinned_at: null, pin_version: 3 })).toBe(pinned)
    const fresh = reconcileInboxPage([pinned], [{ ...chat, last_message: 'nuevo', unread_count: 4, pin_version: 2 }], new Map(), 'all', false)[0]
    expect(fresh).toMatchObject({ is_pinned: true, pin_version: 4, last_message: 'nuevo', unread_count: 4 })
  })
  it('keeps discovered groups with no activity below active chats and preserves stable ties', () => {
    const rows: Chat[] = [
      { ...chat, id: 'b-empty', last_message_at: null as unknown as string },
      { ...chat, id: 'y-old', last_message_at: '2026-01-01T12:00:00Z' },
      { ...chat, id: 'a-empty', last_message_at: '' },
      { ...chat, id: 'z-new', last_message_at: '2026-10-18T12:00:00Z' },
      { ...chat, id: 'c-empty', last_message_at: null as unknown as string },
      { ...chat, id: 'pinned-empty', last_message_at: null as unknown as string, is_pinned: true, pinned_at: '2026-10-18T13:00:00Z' },
    ]
    const expected = ['pinned-empty', 'z-new', 'y-old', 'a-empty', 'b-empty', 'c-empty']
    expect(orderInbox(rows, 'all').map(row => row.id)).toEqual(expected)
    expect(orderInbox(rows, 'unread').map(row => row.id)).toEqual(expected)
    expect(reconcileChatIdentity(rows, { source_chat_id: 'b-empty', canonical_chat: rows[0] }).map(row => row.id)).toEqual(expected)
  })
  it('transfers local personal pins on identity merge while preserving canonical conversation data', () => {
    const source = { ...chat, id: 'lid-source', jid: '120000@lid', is_pinned: true, pinned_at: '2026-10-18T13:00:00Z', pin_version: 4, unread_count: 2 }
    const target = { ...chat, id: 'target', is_pinned: false, pin_version: 7 }
    const reconciliation = { source_chat_id: source.id, canonical_chat: { ...target, name: 'Identidad canónica', is_pinned: false, pin_version: 0, unread_count: 9, last_message: 'Mensaje canónico nuevo' } }
    const merged = mergeReconciledChatIdentity([source, target], reconciliation)
    expect(merged).toMatchObject({ id: 'target', name: 'Identidad canónica', unread_count: 9, last_message: 'Mensaje canónico nuevo', is_pinned: true, pinned_at: source.pinned_at, pin_version: 7 })
    expect(reconcileChatIdentity([source, target], reconciliation)).toEqual([merged])
    const newerPin = { ...target, is_pinned: true, pinned_at: '2026-10-18T14:00:00Z' }
    expect(mergeReconciledChatIdentity([source, newerPin], reconciliation)).toMatchObject({ is_pinned: true, pinned_at: newerPin.pinned_at, pin_version: 7 })
    const http = { ...reconciliation.canonical_chat, is_pinned: false, pinned_at: null, pin_version: 8 }
    expect(reconcileInboxPage([merged], [http], new Map(), 'all', false)).toEqual([http])
  })
  it('does not adopt global pins from identity broadcasts or revive local unpinned preferences', () => {
    const source = { ...chat, id: 'source', is_pinned: false, pin_version: 3 }
    const target = { ...chat, id: 'target', is_pinned: false, pin_version: 5 }
    const reconciliation = { source_chat_id: source.id, canonical_chat: { ...target, is_pinned: true, pinned_at: '2026-10-18T15:00:00Z', pin_version: 0 } }
    expect(mergeReconciledChatIdentity([source, target], reconciliation)).toMatchObject({ is_pinned: false, pinned_at: null, pin_version: 5 })
    expect(mergeReconciledChatIdentity([], reconciliation)).toMatchObject({ is_pinned: false, pinned_at: null, pin_version: 0 })
  })
})


it('matches whole mention tokens and keeps reactions available to announcement members', () => {
  expect(displayMentionText('@123 @1234', [{ jid: '123@s.whatsapp.net', name: 'Ana' }])).toBe('@Ana @1234')
  const announcement = { ...chat, group: { subject: 'Avisos', participant_count: 3, membership_status: 'member' as const, announce: true, can_send: false } }
  expect(groupReactionsUnavailable(announcement)).toBe(false)
  expect(groupReactionsUnavailable({ ...announcement, group: { ...announcement.group, membership_status: 'left' } })).toBe(true)
})
