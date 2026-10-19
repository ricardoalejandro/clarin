import { describe, expect, it } from 'vitest'
import type { Message } from '@/types/chat'
import { mergeCanonicalMessage, mergeCanonicalMessageProjection, mergeFetchedMessages, orderChatMessages, reconcileOptimisticMessage } from './messageState'

const message: Message = { id: 'row', message_id: 'provider', body: 'Antes', is_from_me: true, is_read: false, status: 'sent', timestamp: '2026-10-07T12:00:00Z' }

describe('canonical chat message state', () => {
  it('accepts edits and revocation from history rather than keeping cached content', () => {
    expect(mergeCanonicalMessage(message, { ...message, body: 'Después', is_edited: true })).toMatchObject({ body: 'Después', is_edited: true })
    expect(mergeCanonicalMessage(message, { ...message, is_revoked: true })).toMatchObject({ body: undefined, is_revoked: true })
  })

  it('preserves advanced receipts across older snapshots and provider echoes', () => {
    const read = { ...message, status: 'read', is_read: true, read_at: '2026-10-07T12:01:00Z' }
    expect(mergeCanonicalMessage(read, message)).toMatchObject({ status: 'read', is_read: true, read_at: read.read_at })
    expect(mergeCanonicalMessage(message, { ...read, body: 'Editado' })).toMatchObject({ status: 'read', body: 'Editado' })
  })

  it('reconciles a delayed HTTP result with the existing echo, preserving its quote and receipt', () => {
    const optimistic = { ...message, id: 'optimistic-1', message_id: 'optimistic-1', status: 'sending', quoted_message_id: 'original', quoted_body: 'Cita' }
    const echo = { ...message, status: 'read', quoted_message_id: 'original', quoted_body: 'Cita', read_at: '2026-10-07T12:01:00Z' }
    const result = reconcileOptimisticMessage([optimistic, echo], optimistic.id, message)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: message.id, status: 'read', quoted_body: 'Cita', read_at: echo.read_at })
  })

  it('orders timestamps and ties deterministically without mutating the input', () => {
    const older = { ...message, id: 'older', timestamp: '2026-10-07T11:00:00Z' }
    const tie = { ...message, id: 'another' }
    const rows = [message, older, tie]
    expect(orderChatMessages(rows).map(row => row.id)).toEqual(['older', 'another', 'row'])
    expect(rows[0]).toBe(message)
  })

  it('keeps loaded older history and pending sends while accepting canonical replacements', () => {
    const older = { ...message, id: 'older', message_id: 'older-provider', timestamp: '2026-10-07T11:00:00Z' }
    const pending = { ...message, id: 'optimistic-1', message_id: 'optimistic-1', status: 'failed' }
    const rows = mergeFetchedMessages([older, message, pending], [{ ...message, body: 'Actualizado' }])
    expect(rows).toHaveLength(3)
    expect(rows.find(row => row.id === message.id)?.body).toBe('Actualizado')
    expect(rows.find(row => row.id === pending.id)?.status).toBe('failed')
  })

  it('does not erase content in a partial quote hydration event', () => {
    const partial = { id: message.id, message_id: message.message_id, status: message.status, quoted_body: 'Original', timestamp: message.timestamp, is_from_me: true, is_read: false }
    expect(mergeCanonicalMessage(message, partial)).toMatchObject({ body: message.body, quoted_body: 'Original' })
  })
})

describe('canonical loaded message projections', () => {
  const own = { id: 'own', target_message_id: message.message_id, sender_jid: 'self', emoji: '👍', is_from_me: true }
  const other = { id: 'other', target_message_id: message.message_id, sender_jid: 'member', emoji: '❤️', is_from_me: false }
  const current: Message = { ...message, status: 'read', is_read: true, read_at: '2026-10-07T12:01:00Z', media_recoverable: true, mentions: [{ jid: 'member', name: 'Ana' }], reactions: [own] }

  it('patches a loaded message without adding historical rows or changing unrelated references', () => {
    const unrelated = { ...message, id: 'other-row' }
    const rows = [current, unrelated]
    const result = mergeCanonicalMessageProjection(rows, { ...message, body: 'Recuperado', media_url: '/api/media/file/account/file' })
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ body: 'Recuperado', media_recoverable: false, status: 'read', is_read: true, read_at: current.read_at, mentions: current.mentions, reactions: [own] })
    expect(result[1]).toBe(unrelated)
    expect(mergeCanonicalMessageProjection(rows, { ...message, id: 'missing' })).toBe(rows)
    expect(current.body).toBe('Antes')
  })

  it.each([{ media_url: '/api/media/file/account/file' }, { media_deleted: true }, { is_revoked: true }, { media_unavailable_reason: 'group_media_too_large' as const }])('clears omitted recoverability only for resolved or terminal media: %j', terminal => {
    expect(mergeCanonicalMessageProjection([current], { ...message, ...terminal })[0].media_recoverable).toBe(false)
  })

  it('keeps recoverability on partial updates and respects explicit empty mentions and reactions', () => {
    expect(mergeCanonicalMessageProjection([current], { ...message, body: 'Reparado' })[0]).toMatchObject({ media_recoverable: true, mentions: current.mentions, reactions: [own] })
    expect(mergeCanonicalMessageProjection([current], { ...message, mentions: [], reactions: [] })[0]).toMatchObject({ mentions: [], reactions: [] })
  })

  it('keeps the pending own reaction while accepting the canonical participants snapshot', () => {
    expect(mergeCanonicalMessageProjection([current], { ...message, reactions: [other] }, true)[0].reactions).toEqual([other, own])
    expect(mergeCanonicalMessageProjection([current], { ...message, reactions: [other] }, false)[0].reactions).toEqual([other])
  })
})
