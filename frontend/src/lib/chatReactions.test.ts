import { describe, expect, it } from 'vitest'
import type { Reaction } from '@/types/chat'
import { applyReactionMutation, dedupeReactions, hasOwnReaction } from '@/utils/chatReactions'

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
})
