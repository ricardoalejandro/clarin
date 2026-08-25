import { describe, expect, it } from 'vitest'
import { formatPhone, getChatDisplayName, isPendingChatIdentity, reconcileChatIdentity } from '@/utils/chat'
import type { Chat } from '@/types/chat'

const chat = (id: string, jid: string, overrides: Partial<Chat> = {}): Chat => ({
  id,
  jid,
  name: '',
  last_message: '',
  last_message_at: '2026-08-15T15:00:00Z',
  unread_count: 0,
  ...overrides,
})

describe('pending WhatsApp chat identity', () => {
  it('never renders LID digits as a phone or fallback name', () => {
    const pending = chat('lid-chat', '65657383165996@lid', { identity_pending: true })
    expect(isPendingChatIdentity(pending)).toBe(true)
    expect(formatPhone(pending.jid, '65657383165996')).toBe('')
    expect(getChatDisplayName(pending)).toBe('Contacto de WhatsApp')
  })

  it('keeps a useful push name while the phone identity is pending', () => {
    const pending = chat('lid-chat', '65657383165996@lid', { name: 'Torres', identity_pending: true })
    expect(getChatDisplayName(pending)).toBe('Torres')
  })

  it('atomically replaces the source row with the canonical chat snapshot', () => {
    const source = chat('lid-chat', '65657383165996@lid', { identity_pending: true, unread_count: 3 })
    const other = chat('other', '51999999999@s.whatsapp.net', { last_message_at: '2026-08-15T14:00:00Z' })
    const canonical = chat('phone-chat', '51904806007@s.whatsapp.net', {
      name: 'MARTIN TORRES',
      last_message_at: '2026-08-15T16:00:00Z',
      unread_count: 3,
      identity_pending: false,
    })
    const reconciled = reconcileChatIdentity([source, other], {
      source_chat_id: source.id,
      canonical_chat: canonical,
    })
    expect(reconciled.map(item => item.id)).toEqual(['phone-chat', 'other'])
    expect(reconciled[0]).toBe(canonical)
  })
})
