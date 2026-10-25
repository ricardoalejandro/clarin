import { describe, expect, it } from 'vitest'
import type { Chat, Message } from '@/types/chat'
import { bindingRevision, chatDeletionIssue, parseChatContinuityEvent, restrictedChatContinuity, reconcileContinuityRows, remapContinuityDeviceFilter, remapContinuityIds, verifiedChatContinuity } from './chatContinuity'
import { validatePinnedChatSender } from './chatSenderSession'
import { mergeChatSnapshot } from './chatExperience'
import { forwardActionIssue } from './messageForwarding'
const original: Chat = { id: 'historical', account_id: 'account', jid: 'group@g.us', name: 'Grupo', device_id: 'old', unread_count: 2, last_message: '', last_message_at: '' }
const canonical: Chat = { ...original, device_id: 'new', canonical_chat_id: 'historical', alias_chat_ids: ['duplicate'], binding_state: 'verified_continuity', binding_revision: 2 }
const event = { canonical_chat_id: 'historical', alias_chat_ids: ['duplicate'], device_id: 'new', binding_revision: 2 }
describe('verified WhatsApp conversation continuity', () => {
  it('requires a canonical verified scoped snapshot and rejects old or unrelated evidence', () => {
    expect(parseChatContinuityEvent(event)).toEqual(event)
    expect(parseChatContinuityEvent({ ...event, binding_revision: -1 })).toBeNull()
    expect(verifiedChatContinuity(canonical, original, event)).toBe(true)
    expect(verifiedChatContinuity({ ...canonical, binding_state: 'pending' }, original, event)).toBe(false)
    expect(verifiedChatContinuity({ ...canonical, account_id: 'other' }, original, event)).toBe(false)
    expect(verifiedChatContinuity({ ...canonical, jid: 'other@g.us' }, original, event)).toBe(false)
    expect(verifiedChatContinuity(canonical, { ...original, binding_revision: 3 }, event)).toBe(false)
    expect(verifiedChatContinuity(canonical, original, { ...event, binding_revision: 3 })).toBe(false)
    expect(verifiedChatContinuity(canonical, { ...original, id: 'unrelated' }, event)).toBe(false)
    expect(bindingRevision({ binding_revision: Number.NaN })).toBe(0)
  })
  it('treats a null device event as a restrictive invalidation, never sender authorization', () => {
    const invalidation = { ...event, device_id: null, binding_revision: 3 }
    const restricted = { ...canonical, device_id: undefined, binding_state: 'conflict' as const, binding_revision: 3 }
    expect(parseChatContinuityEvent(invalidation)).toEqual(invalidation)
    expect(restrictedChatContinuity(restricted, canonical, invalidation)).toBe(true)
    expect(verifiedChatContinuity(restricted, canonical, invalidation)).toBe(false)
    expect(restrictedChatContinuity({ ...restricted, account_id: 'other' }, canonical, invalidation)).toBe(false)
  })
  it('blocks deletion only for actual consolidated aliases', () => {
    expect(chatDeletionIssue(original)).toBeNull()
    expect(chatDeletionIssue({ ...original, alias_chat_ids: [original.id] })).toBeNull()
    expect(chatDeletionIssue(canonical)).toBe('La eliminación de este historial consolidado requiere revisión.')
  })
  it('keeps the canonical row at the previous position and remaps only proven IDs', () => {
    const other = { ...original, id: 'other' }
    expect(reconcileContinuityRows([other, { ...original, id: 'duplicate' }, original], canonical)).toEqual([other, canonical])
    expect([...remapContinuityIds(new Set(['duplicate', 'other', 'historical']), canonical)]).toEqual(['historical', 'other'])
    expect(remapContinuityDeviceFilter([], ['old'], 'new')).toEqual([])
    expect(remapContinuityDeviceFilter(['old', 'other', 'new'], ['old'], 'new')).toEqual(['new', 'other'])
  })
  it('replaces a pinned transport only with newer verified continuity, never another own number', () => {
    const session = { chatId: 'historical', deviceId: 'old', phone: '51900000001', accountId: 'account', jid: 'group@g.us', bindingRevision: 1 }
    const device = { id: 'new', name: 'Nuevo', status: 'connected', phone: '+51 900 000 001' }
    expect(validatePinnedChatSender(session, device, canonical)).toBe('ready')
    expect(validatePinnedChatSender(session, device)).toBe('changed')
    expect(validatePinnedChatSender(session, device, { ...canonical, binding_state: 'conflict' })).toBe('changed')
    expect(validatePinnedChatSender(session, { ...device, phone: '51900000002' }, canonical)).toBe('changed')
    expect(validatePinnedChatSender(session, device, { ...canonical, binding_revision: 1 })).toBe('changed')
  })
  it('retains the newer binding against a late historical snapshot', () => {
    expect(mergeChatSnapshot(canonical, original)).toMatchObject({ device_id: 'new', binding_revision: 2, binding_state: 'verified_continuity' })
  })
  it('allows a historical source through its verified conversation without rewriting its provenance', () => {
    const message = { id: 'message', message_id: 'provider', chat_id: original.id, device_id: 'old', status: 'sent', body: 'Texto', message_type: 'text' } as Message
    expect(forwardActionIssue(message, 'new')).toContain('otro dispositivo')
    expect(forwardActionIssue(message, 'new', canonical)).toBeNull()
    expect(message.device_id).toBe('old')
    expect(forwardActionIssue({ ...message, chat_id: 'foreign' }, 'new', canonical)).toContain('otro dispositivo')
    expect(forwardActionIssue({ ...message, is_revoked: true }, 'new', canonical)).toContain('eliminado')
  })
})
