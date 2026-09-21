import { describe, expect, it } from 'vitest'
import type { Chat, ChatState, Message } from '@/types/chat'
import { applyChatState, matchesInbox, mergeMessageSender, messageAuthor, nextPendingChat, orderInbox, reconcileInboxPage } from './chatInbox'

const a: Chat = { id: 'a', jid: 'qa', name: 'QA', last_message: 'Hola', last_message_at: '2026-09-20T12:00:00Z', unread_count: 2, needs_reply: true, waiting_since: '2026-09-20T10:00:00Z', state_version: 3 }
const b: Chat = { ...a, id: 'b', waiting_since: '2026-09-20T11:00:00Z', last_message_at: '2026-09-20T13:00:00Z' }
const read: ChatState = { chat_id: 'a', unread_count: 0, needs_reply: true, waiting_since: a.waiting_since!, state_version: 4 }
describe('CRM attention queue', () => {
  it('reading removes unread membership but preserves the attention queue', () => {
    const next = applyChatState(a, read)
    expect(matchesInbox(next, 'unread')).toBe(false)
    expect(matchesInbox(next, 'pending')).toBe(true)
  })
  it('keeps oldest unanswered inbound order when an outgoing preview changes', () => {
    expect(orderInbox([b, { ...a, last_message_at: '2026-09-21T15:00:00Z' }], 'pending').map(c => c.id)).toEqual(['a', 'b'])
    expect(orderInbox([a, b], 'all').map(c => c.id)).toEqual(['b', 'a'])
  })
  it('rejects old read events and stale HTTP rows, including removed rows', () => {
    expect(applyChatState(a, { ...read, state_version: 2 })).toBe(a)
    const states = new Map([['a', { ...read, needs_reply: false, waiting_since: null }]])
    expect(reconcileInboxPage([b], [a], states, 'pending', true).map(c => c.id)).toEqual(['b'])
    expect(reconcileInboxPage([], [a], new Map([['a', read]]), 'unread', false)).toEqual([])
  })
  it('accepts a new inbound after an answer and deduplicates pages', () => {
    const states = new Map([['a', { ...read, state_version: 5, unread_count: 1 }]])
    expect(reconcileInboxPage([a, b], [a], states, 'pending', true)).toHaveLength(2)
    expect(reconcileInboxPage([], [a], states, 'unread', false)[0].unread_count).toBe(1)
  })
  it('next skips the active chat and conversations already handled elsewhere', () => {
    expect(nextPendingChat([a, b], 'a', { id: a.id, waiting_since: a.waiting_since! })?.id).toBe('b')
    expect(nextPendingChat([a, { ...b, needs_reply: false }], 'a')).toBeNull()
  })
  it('never invents an advisor for historical or external messages', () => {
    const message = { is_from_me: true } as Message
    expect(messageAuthor(message).name).toBe('Autor no registrado')
    expect(messageAuthor({ ...message, sender: { origin: 'whatsapp_external' } }).name).toContain('no identificado')
    expect(messageAuthor({ ...message, sender: { user_id: 'advisor', name: 'Ana', origin: 'quick_reply' } })).toEqual({ name: 'Ana', origin: 'Respuesta rápida' })
  })
  it('does not lose authenticated attribution to a delayed provider echo', () => {
    const advisor = { user_id: 'advisor', name: 'Ana', origin: 'manual' }
    expect(mergeMessageSender({ origin: 'whatsapp_external' }, advisor)).toBe(advisor)
    expect(mergeMessageSender(advisor, { origin: 'whatsapp_external' })).toBe(advisor)
  })
})
