import { describe, expect, it } from 'vitest'
import type { Chat, Message } from '@/types/chat'
import { forwardDestinationIssue, forwardingLabel, forwardLimits, forwardSourceIssue, mergeMessageForwarding, normalizeForwarding, parseForwardReceipt, rememberForwardBatch, restoreForwardBatch } from './messageForwarding'
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
