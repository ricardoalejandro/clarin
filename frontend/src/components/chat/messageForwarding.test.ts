import { describe, expect, it } from 'vitest'
import type { Chat, Message } from '@/types/chat'
import { forwardDestinationIssue, forwardingLabel, forwardLimits, forwardSourceIssue, forwardActionIssue, mergeMessageForwarding, normalizeForwarding, parseForwardReceipt, rememberForwardBatch, restoreForwardBatch } from './messageForwarding'
import { mergeCanonicalMessage, mergeCanonicalMessageProjection, mergeFetchedMessages, reconcileOptimisticMessage } from './messageState'

const message: Message = { id: 'local', message_id: 'provider', device_id: 'device', body: 'Original', message_type: 'text', is_from_me: false, is_read: false, status: 'sent', timestamp: '2026-10-24T00:00:00Z', forwarding: { state: 'not_forwarded', score: 0 } }
const direct = { id: 'direct', jid: '51999999999@s.whatsapp.net', device_id: 'device' } as Chat
const group = { id: 'group', jid: '1@g.us', device_id: 'device', group: { can_send: true } } as Chat

describe('forwarding truth', () => {
  it('normalizes unknown and malformed metadata without inventing a counter', () => {
    for (const value of [undefined, null, {}, { state: '__proto__', score: 0 }, { state: 'unknown', score: 5 }, { state: 'not_forwarded', score: null }]) expect(normalizeForwarding(value)).toEqual({ state: 'unknown', score: null })
    expect(normalizeForwarding({ state: 'forwarded', score: null })).toEqual({ state: 'forwarded', score: null })
    expect(normalizeForwarding({ state: 'forwarded', score: 5 })).toEqual({ state: 'frequently_forwarded', score: 5 })
    expect(forwardingLabel(message.forwarding)).toBeNull()
    expect(forwardingLabel({ state: 'forwarded', score: 1 })).toBe('Reenviado')
    expect(forwardingLabel({ state: 'frequently_forwarded', score: 5 })).toBe('Reenviado muchas veces')
  })
  it('never erases established forwarding or audio metadata during history, partial events and delayed echoes', () => {
    const known = { ...message, forwarding: { state: 'frequently_forwarded' as const, score: 7 }, audio_ptt: false }
    const old = { ...message, forwarding: { state: 'unknown' as const, score: null } }
    for (const row of [mergeCanonicalMessage(known, old), mergeFetchedMessages([known], [old])[0], mergeCanonicalMessageProjection([known], old)[0], reconcileOptimisticMessage([known], 'optimistic-1', old)[0]]) expect(row).toMatchObject({ forwarding: known.forwarding, audio_ptt: false })
    expect(mergeMessageForwarding(message, { forwarding: { state: 'forwarded', score: null } }).forwarding).toEqual({ state: 'forwarded', score: null })
    expect(mergeMessageForwarding({ forwarding: { state: 'forwarded', score: 3 } }, { forwarding: { state: 'forwarded', score: 1 } }).forwarding?.score).toBe(3)
  })
  it('blocks unknown provenance and unsupported or restricted content without copying as text', () => {
    expect(forwardSourceIssue(message, 'device')).toBeNull()
    expect(forwardSourceIssue({ ...message, forwarding: undefined })).toMatch(/No conocemos/)
    expect(forwardSourceIssue({ ...message, forwarding: { state: 'forwarded', score: null } })).toMatch(/contador/)
    expect(forwardSourceIssue({ ...message, is_view_once: true })).toMatch(/única/)
    expect(forwardSourceIssue({ ...message, is_revoked: true })).toMatch(/eliminado/)
    expect(forwardSourceIssue({ ...message, device_id: 'another' }, 'device')).toMatch(/otro dispositivo/)
    for (const message_type of ['poll', 'contact', 'location', 'protocol']) expect(forwardSourceIssue({ ...message, message_type })).toMatch(/tipo/)
    expect(forwardSourceIssue({ ...message, message_type: 'image' })).toMatch(/archivo/)
    const audio = { ...message, message_type: 'audio', media_url: '/api/media/audio' }
    expect(forwardSourceIssue(audio)).toMatch(/nota de voz/)
    expect(forwardSourceIssue({ ...audio, audio_ptt: false })).toBeNull()
  })
  it('restricts the selected batch by total, groups, sender and real permission', () => {
    const forwarded = { ...message, forwarding: { state: 'forwarded' as const, score: 1 } }
    const frequent = { ...message, forwarding: { state: 'frequently_forwarded' as const, score: 5 } }
    expect(forwardLimits(frequent)).toEqual({ maxChats: 1, maxGroups: 1 })
    expect(forwardDestinationIssue(group, [], message, 'device')).toBeNull()
    expect(forwardDestinationIssue({ ...group, id: 'second' }, [group], forwarded, 'device')).toMatch(/un grupo/)
    expect(forwardDestinationIssue(direct, [group], frequent, 'device')).toMatch(/un chat/)
    expect(forwardDestinationIssue({ ...direct, device_id: 'foreign' }, [], message, 'device')).toMatch(/otro dispositivo/)
    expect(forwardDestinationIssue({ ...group, group: undefined }, [], message, 'device')).toMatch(/Actualizando/)
    expect(forwardDestinationIssue({ ...direct, lead_is_blocked: true }, [], message, 'device')).toMatch(/No contactar/)
  })
  it('accepts only a complete receipt for the exact submitted operation and unique target IDs', () => {
    const request = { source_chat_id: 'source', source_message_id: 'local', device_id: 'device', destination_chat_ids: ['a', 'b'], client_operation_id: 'operation' }
    const receipt = { success: true, operation_id: 'operation', complete: false, results: [{ chat_id: 'a', state: 'sent' }, { chat_id: 'b', state: 'uncertain' }] }
    expect(parseForwardReceipt(receipt, request).results).toHaveLength(2)
    expect(() => parseForwardReceipt({ ...receipt, operation_id: 'other' }, request)).toThrow()
    expect(() => parseForwardReceipt({ ...receipt, results: [receipt.results[0], receipt.results[0]] }, request)).toThrow()
    expect(() => parseForwardReceipt({ ...receipt, results: [{ chat_id: 'a', state: 'sent' }] }, request)).toThrow()
    sessionStorage.clear()
    rememberForwardBatch('scope', { request, receipt: { ...receipt, results: [{ ...receipt.results[0], message } as any, receipt.results[1] as any] } })
    expect(sessionStorage.getItem('scope')).not.toContain('Original')
    expect(restoreForwardBatch('scope')?.request).toEqual(request)
    expect(restoreForwardBatch('different-account')).toBeNull()
    rememberForwardBatch('scope', null)
    expect(restoreForwardBatch('scope')).toBeNull()
  })
})


describe('explicit copies and inherited sharing limits', () => {
  const privateChat: Chat = { id: 'private-history', account_id: 'account', jid: '51900000999@s.whatsapp.net', kind: 'direct', device_id: 'current-device', name: 'Historial privado', last_message: '', last_message_at: '2026-10-25T00:00:00Z', unread_count: 0 }
  it.each([null, 'retired-device'])('copies private historical video with source device %s only in its exact current chat context', historicalDevice => {
    const source: Message = { ...message, account_id: 'account', chat_id: privateChat.id, device_id: historicalDevice, message_type: 'video', media_url: '/api/media/file/account/video', is_from_me: true }
    expect(forwardSourceIssue(source, 'current-device', 'copy', 'original', privateChat)).toBeNull()
    expect(forwardActionIssue(source, 'current-device', privateChat)).toBeNull()
    expect(forwardSourceIssue(source, 'current-device', 'native', 'original', privateChat)).toMatch(/otro dispositivo/)
    expect(forwardSourceIssue(source, 'current-device', 'copy')).toMatch(/otro dispositivo/)
    expect(forwardSourceIssue(source, 'current-device', 'copy', 'original', { ...privateChat, id: 'other-chat' })).not.toBeNull()
    expect(forwardSourceIssue(source, 'other-device', 'copy', 'original', privateChat)).not.toBeNull()
    expect(forwardSourceIssue(source, 'current-device', 'copy', 'original', { ...privateChat, account_id: 'other-account' })).toMatch(/otra cuenta/)
    expect(forwardSourceIssue({ ...source, chat_id: undefined }, 'current-device', 'copy', 'original', privateChat)).not.toBeNull()
    expect(source.device_id).toBe(historicalDevice)
  })
  it('does not use private-copy permission for an unverified group or broaden native private history', () => {
    const source: Message = { ...message, account_id: 'account', chat_id: privateChat.id, device_id: null }
    const groupChat: Chat = { ...privateChat, jid: '120099@g.us', kind: 'group' }
    expect(forwardSourceIssue(source, 'current-device', 'copy', 'original', groupChat)).toMatch(/otro dispositivo/)
    const verifiedPrivate: Chat = { ...privateChat, canonical_chat_id: privateChat.id, binding_state: 'verified_continuity', binding_revision: 2 }
    expect(forwardSourceIssue(source, 'current-device', 'native', 'original', verifiedPrivate)).toMatch(/otro dispositivo/)
    const verifiedGroup: Chat = { ...groupChat, canonical_chat_id: groupChat.id, binding_state: 'verified_continuity', binding_revision: 2 }
    expect(forwardSourceIssue(source, 'current-device', 'native', 'original', verifiedGroup)).toBeNull()
    expect(forwardSourceIssue({ ...source, account_id: 'other-account' }, 'current-device', 'copy', 'original', verifiedGroup)).toMatch(/otra cuenta/)
  })
  it('allows safe historical text and media copies while keeping native forwarding strict', () => {
    const historical = { ...message, forwarding: undefined }
    expect(forwardActionIssue(historical, 'device')).toBeNull()
    expect(forwardSourceIssue(historical, 'device', 'copy')).toBeNull()
    expect(forwardSourceIssue(historical, 'device', 'native')).toMatch(/No conocemos/)
    for (const message_type of ['image', 'video', 'gif', 'document', 'sticker']) {
      const media = { ...historical, body: undefined, message_type, media_url: '/api/media/file/account/asset' }
      expect(forwardSourceIssue(media, 'device', 'copy')).toBeNull()
      expect(forwardSourceIssue({ ...media, media_deleted: true }, 'device', 'copy')).toMatch(/archivo/)
      expect(forwardSourceIssue({ ...media, media_recoverable: true }, 'device', 'copy')).toMatch(/archivo/)
    }
    expect(forwardSourceIssue({ ...historical, forwarding: { state: 'forwarded', score: null } }, 'device', 'copy')).toBeNull()
    for (const source of [{ ...historical, is_view_once: true }, { ...historical, is_revoked: true }, { ...historical, message_type: 'poll' }]) expect(forwardActionIssue(source)).not.toBeNull()
  })
  it('requires deliberate audio-as-document selection without inventing PTT', () => {
    const audio = { ...message, message_type: 'audio', media_url: '/api/media/file/audio', forwarding: undefined }
    expect(forwardActionIssue(audio)).toBeNull()
    expect(forwardSourceIssue(audio, 'device', 'copy')).toMatch(/archivo adjunto/)
    expect(forwardSourceIssue(audio, 'device', 'copy', 'audio_document')).toBeNull()
    expect(forwardSourceIssue({ ...audio, audio_ptt: false }, 'device', 'copy')).toBeNull()
    expect(forwardSourceIssue(message, 'device', 'copy', 'audio_document')).toMatch(/conversión/)
    expect(forwardSourceIssue(message, 'device', 'native', 'audio_document')).not.toBeNull()
  })
  it('retains the strictest sharing limits through copies, partial events, history and own echoes', () => {
    const inherited = { max_chats: 1 as const, max_groups: 1 as const }
    const copy = { ...message, sharing_limits: inherited, is_from_me: true }
    const echo = { ...message, is_from_me: true, sharing_limits: undefined }
    for (const row of [mergeCanonicalMessage(copy, echo), mergeFetchedMessages([copy], [echo])[0], mergeCanonicalMessageProjection([copy], echo)[0], reconcileOptimisticMessage([copy], 'optimistic-1', echo)[0]]) {
      expect(row.sharing_limits).toEqual(inherited)
      expect(forwardLimits(row)).toEqual({ maxChats: 1, maxGroups: 1 })
      expect(forwardDestinationIssue(direct, [group], row, 'device')).not.toBeNull()
    }
    expect(mergeMessageForwarding(copy, { sharing_limits: { max_chats: 5, max_groups: 5 } }).sharing_limits).toEqual(inherited)
    expect(forwardLimits({ ...message, sharing_limits: { max_chats: 5, max_groups: 1 } })).toEqual({ maxChats: 5, maxGroups: 1 })
    expect(forwardLimits({ ...message, sharing_limits: {} as any })).toEqual({ maxChats: 1, maxGroups: 1 })
    expect(forwardLimits({ ...message, sharing_limits: null })).toEqual({ maxChats: 5, maxGroups: 5 })
    expect(mergeMessageForwarding(copy, { sharing_limits: null }).sharing_limits).toEqual(inherited)
  })
  it('binds receipts to immutable mode and content variant, with native defaults for legacy operations', () => {
    const request = { source_chat_id: 'source', source_message_id: 'local', device_id: 'device', destination_chat_ids: ['a'], client_operation_id: 'copy-operation', mode: 'copy' as const, content_variant: 'audio_document' as const }
    const receipt = { success: true, operation_id: request.client_operation_id, complete: true, mode: 'copy', content_variant: 'audio_document', results: [{ chat_id: 'a', state: 'sent' }], sharing_limits: { max_chats: 5, max_groups: 1 } }
    expect(parseForwardReceipt(receipt, request)).toMatchObject({ mode: 'copy', content_variant: 'audio_document', sharing_limits: { max_chats: 5, max_groups: 1 } })
    expect(() => parseForwardReceipt({ ...receipt, mode: 'native' }, request)).toThrow(/modo/)
    expect(() => parseForwardReceipt({ ...receipt, mode: null }, request)).toThrow(/modo/)
    expect(() => parseForwardReceipt({ ...receipt, content_variant: null }, request)).toThrow(/modo/)
    expect(() => parseForwardReceipt({ ...receipt, content_variant: 'original' }, request)).toThrow(/modo/)
    expect(() => parseForwardReceipt({ ...receipt, sharing_limits: { max_chats: 0, max_groups: 100 } }, request)).toThrow(/límites/)
    const { mode: _mode, content_variant: _variant, ...legacy } = request
    expect(parseForwardReceipt({ success: true, operation_id: legacy.client_operation_id, complete: true, results: receipt.results }, legacy)).toMatchObject({ mode: 'native', content_variant: 'original' })
  })
})
