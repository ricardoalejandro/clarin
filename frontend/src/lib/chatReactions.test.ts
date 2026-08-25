import { describe, expect, it } from 'vitest'
import type { Reaction } from '@/types/chat'
import {
  applyReactionMutation,
  applyReactionToPendingBaseline,
  dedupeReactions,
  enqueueReactionIntent,
  hasOwnReaction,
  markReactionRealtimeConfirmation,
  mergeCanonicalReactionSnapshot,
  normalizeAuthoritativeMessageReactions,
  reconcilePendingReactionBaseline,
  settleReactionIntent,
  shouldApplyReactionEvent,
  updateMessageReactionProjection,
  type ReactionIntentQueue,
} from '@/utils/chatReactions'

const own: Reaction = { id: 'own-1', target_message_id: 'message-1', sender_jid: 'device', emoji: '👍', is_from_me: true }
const contact: Reaction = { id: 'contact-1', target_message_id: 'message-1', sender_jid: 'contact', emoji: '❤️', is_from_me: false }

describe('chat reaction reconciliation', () => {
  it('replaces one actor reaction without duplicating its optimistic and realtime forms', () => {
    const optimistic = applyReactionMutation([own, contact], {
      targetMessageId: 'message-1', senderJid: '__clarin_self__', senderName: 'Tú', emoji: '😂', isFromMe: true,
    })
    expect(optimistic).toHaveLength(2)
    expect(hasOwnReaction(optimistic, '😂')).toBe(true)
    const echoed = applyReactionMutation(optimistic, {
      targetMessageId: 'message-1', senderJid: 'real-device-jid', senderName: 'Tú', emoji: '😂', isFromMe: true,
    })
    expect(dedupeReactions(echoed)).toHaveLength(2)
    expect(echoed.filter(reaction => reaction.is_from_me)).toHaveLength(1)
  })

  it('removes only the reacting actor and preserves contact reactions', () => {
    const removed = applyReactionMutation([own, contact], {
      targetMessageId: 'message-1', senderJid: 'device', emoji: '', isFromMe: true, removed: true,
    })
    expect(removed).toEqual([contact])
  })

  it('keeps the latest local intent visible and serializes one provider request at a time', () => {
    const first = enqueueReactionIntent([contact], undefined, {
      operationId: 'op-1', sequence: 1, desiredEmoji: '👍', targetMessageId: 'message-1', startedAt: '2026-08-13T10:00:00Z',
    })
    const second = enqueueReactionIntent(first.reactions, first.queue, {
      operationId: 'op-2', sequence: 2, desiredEmoji: '😂', targetMessageId: 'message-1', startedAt: '2026-08-13T10:00:01Z',
    })

    expect(first.request?.operationId).toBe('op-1')
    expect(second.request).toBeUndefined()
    expect(hasOwnReaction(second.reactions, '😂')).toBe(true)

    const settled = settleReactionIntent(second.queue, 'op-1', true)
    expect(settled.nextRequest?.operationId).toBe('op-2')
    expect(hasOwnReaction(settled.reactions, '😂')).toBe(true)
  })

  it('rolls back exactly on failure and preserves a concurrent contact reaction', () => {
    const first = enqueueReactionIntent([contact], undefined, {
      operationId: 'op-1', sequence: 1, desiredEmoji: '👍', targetMessageId: 'message-1', startedAt: '2026-08-13T10:00:00Z',
    })
    const newContactReaction = { ...contact, emoji: '🙏', timestamp: '2026-08-13T10:00:01Z' }
    const queue = applyReactionToPendingBaseline(first.queue, {
      targetMessageId: 'message-1', senderJid: 'contact', emoji: '🙏', isFromMe: false, timestamp: newContactReaction.timestamp,
    })
    const settled = settleReactionIntent(queue, 'op-1', false)

    expect(settled.rolledBack).toBe(true)
    expect(settled.reactions).toEqual([expect.objectContaining({ sender_jid: 'contact', emoji: '🙏' })])
  })

  it('treats a matching realtime echo as confirmation even if HTTP later fails', () => {
    const first = enqueueReactionIntent([], undefined, {
      operationId: 'op-1', sequence: 1, desiredEmoji: '❤️', targetMessageId: 'message-1', startedAt: '2026-08-13T10:00:00Z',
    })
    const echoed = markReactionRealtimeConfirmation(first.queue, 'op-1')
    const settled = settleReactionIntent(echoed, 'op-1', false)

    expect(settled.rolledBack).toBe(false)
    expect(hasOwnReaction(settled.reactions, '❤️')).toBe(true)
  })

  it('ignores a stale settlement and skips a queued no-op', () => {
    const first = enqueueReactionIntent([own], undefined, {
      operationId: 'op-2', sequence: 2, desiredEmoji: '', targetMessageId: 'message-1', startedAt: '2026-08-13T10:00:00Z',
    })
    const stale = settleReactionIntent(first.queue, 'op-1', true)
    expect(stale.ignored).toBe(true)

    const sameAgain = enqueueReactionIntent(first.reactions, first.queue, {
      operationId: 'op-3', sequence: 3, desiredEmoji: '', targetMessageId: 'message-1', startedAt: '2026-08-13T10:00:01Z',
    })
    const settled = settleReactionIntent(sameAgain.queue, 'op-2', true)
    expect(settled.nextRequest).toBeUndefined()
    expect(settled.queue).toEqual({})
  })

  it('accepts canonical snapshots while preserving only a pending own intent', () => {
    const optimisticOwn = { ...own, emoji: '😂', operation_id: 'op-1' }
    const newerContact = { ...contact, emoji: '🙏', timestamp: '2026-08-13T10:01:00Z' }

    expect(mergeCanonicalReactionSnapshot([optimisticOwn, contact], [own, newerContact], true)).toEqual([
      newerContact,
      optimisticOwn,
    ])
    expect(mergeCanonicalReactionSnapshot([optimisticOwn], [own, newerContact], false)).toEqual([own, newerContact])
    expect(mergeCanonicalReactionSnapshot([own, contact], undefined, false)).toEqual([own, contact])
    expect(mergeCanonicalReactionSnapshot([own, contact], [], false)).toEqual([])
  })

  it('rolls back only the own intent after a canonical contact reaction arrives', () => {
    const pending = enqueueReactionIntent([own, contact], undefined, {
      operationId: 'op-1', sequence: 1, desiredEmoji: '😂', targetMessageId: 'message-1', startedAt: '2026-08-13T10:00:00Z',
    })
    const newerContact = { ...contact, emoji: '🙏', timestamp: '2026-08-13T10:01:00Z' }
    const reconciledQueue = reconcilePendingReactionBaseline(pending.queue, [own, newerContact])

    const failed = settleReactionIntent(reconciledQueue, 'op-1', false)

    expect(failed.rolledBack).toBe(true)
    expect(failed.reactions).toEqual([own, newerContact])
  })

  it('treats an omitted HTTP reaction slice as the authoritative empty set', () => {
    const authoritative = normalizeAuthoritativeMessageReactions({
      id: 'row-1', message_id: 'message-1', device_id: 'device-1', message_type: 'text',
      is_from_me: false, is_read: true, status: 'delivered', timestamp: '2026-08-13T10:00:00Z',
    })
    expect(mergeCanonicalReactionSnapshot([own, contact], authoritative.reactions, false)).toEqual([])

    const pending = enqueueReactionIntent([own], undefined, {
      operationId: 'op-1', sequence: 1, desiredEmoji: '😂', targetMessageId: 'message-1', startedAt: '2026-08-13T10:00:00Z',
    })
    const reconciled = reconcilePendingReactionBaseline(pending.queue, authoritative.reactions)
    expect(settleReactionIntent(reconciled, 'op-1', false).reactions).toEqual([])
  })

  it('rejects out-of-order canonical reaction events by timestamp', () => {
    expect(shouldApplyReactionEvent('2026-08-13T10:00:02Z', '2026-08-13T10:00:01Z')).toBe(false)
    expect(shouldApplyReactionEvent('2026-08-13T10:00:02Z', '2026-08-13T10:00:03Z')).toBe(true)
    expect(shouldApplyReactionEvent(undefined, undefined)).toBe(true)
  })

  it('updates a pending baseline from a self echo without replacing the visible queue', () => {
    const first = enqueueReactionIntent([], undefined, {
      operationId: 'op-1', sequence: 1, desiredEmoji: '👍', targetMessageId: 'message-1', startedAt: '2026-08-13T10:00:00Z',
    })
    const queue: ReactionIntentQueue = applyReactionToPendingBaseline(first.queue, {
      targetMessageId: 'message-1', senderJid: 'device', emoji: '👍', isFromMe: true,
      operationId: 'op-1', timestamp: '2026-08-13T10:00:02Z',
    })
    expect(queue.inFlight?.previousReactions).toEqual([
      expect.objectContaining({ emoji: '👍', operation_id: 'op-1' }),
    ])
  })

  it('confirms a stale HTTP response without overwriting the newer realtime baseline', () => {
    const first = enqueueReactionIntent([], undefined, {
      operationId: 'op-1', sequence: 1, desiredEmoji: '👍', targetMessageId: 'message-1', startedAt: '2026-08-13T10:00:00Z',
    })
    const withNewerRealtime = applyReactionToPendingBaseline(first.queue, {
      targetMessageId: 'message-1', senderJid: 'device', emoji: '😂', isFromMe: true,
      operationId: 'op-newer', timestamp: '2026-08-13T10:00:03Z',
    })
    const settled = settleReactionIntent(withNewerRealtime, 'op-1', true, {
      targetMessageId: 'message-1', senderJid: 'device', emoji: '👍', isFromMe: true,
      operationId: 'op-1', timestamp: '2026-08-13T10:00:02Z',
    }, true)

    expect(settled.rolledBack).toBe(false)
    expect(settled.queue).toEqual({})
    expect(settled.reactions).toEqual([
      expect.objectContaining({ emoji: '😂', timestamp: '2026-08-13T10:00:03Z' }),
    ])
  })

  it('projects reaction updates into an isolated search or quoted-message window', () => {
    const history = [{
      id: 'row-1', message_id: 'message-1', device_id: 'device-1', message_type: 'text',
      is_from_me: false, is_read: true, status: 'delivered', timestamp: '2026-08-13T10:00:00Z', reactions: [],
    }]
    const projected = updateMessageReactionProjection(history, 'message-1', reactions => applyReactionMutation(reactions, {
      targetMessageId: 'message-1', senderJid: 'contact', emoji: '❤️', isFromMe: false,
    }))

    expect(projected[0].reactions).toEqual([expect.objectContaining({ emoji: '❤️' })])
    expect(updateMessageReactionProjection(history, 'other-message', [])).toBeTruthy()
    expect(history[0].reactions).toEqual([])
  })
})
