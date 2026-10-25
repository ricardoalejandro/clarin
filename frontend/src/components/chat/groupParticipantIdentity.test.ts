import { describe, expect, it } from 'vitest'
import type { GroupParticipant } from '@/types/chat'
import { groupParticipantLabel, groupParticipantPhone, mergeParticipantPage, sameParticipant } from './groupParticipantIdentity'
import { parseGroupParticipantProfile } from './groupParticipantTypes'

const member: GroupParticipant = { jid: 'hidden@lid', lid: 'hidden@lid', name: '', role: 'member', is_self: false }
describe('participant identity', () => {
  it('reconciles a newly resolved number against the same LID without keeping a duplicate', () => {
    const resolved = { ...member, jid: '51999999999@s.whatsapp.net', phone: '51999999999', name: 'Nombre disponible' }
    expect(sameParticipant(member, resolved)).toBe(true)
    expect(mergeParticipantPage([member], [resolved], true)).toEqual([resolved])
  })
  it('replaces a refreshed page so departed participants cannot survive as a stale tail', () => {
    const other = { ...member, jid: 'other@lid', lid: 'other@lid', name: 'Otro' }
    expect(mergeParticipantPage([member, other], [member])).toEqual([member])
  })
  it('never presents LID digits as a telephone and keeps redacted numbers separate', () => {
    expect(groupParticipantLabel({ ...member, jid: '123456789012345@lid', name: 'Integrante' })).toBe('Nombre no disponible')
    expect(groupParticipantPhone(member)).toBe('Teléfono no disponible')
    expect(groupParticipantPhone({ ...member, redacted_phone: '+51 *** 123' })).toBe('+51 *** 123')
    expect(groupParticipantLabel({ ...member, phone: '51999999999' })).toBe('+51999999999')
  })
  it('rejects incomplete identities or fabricated contact access contexts before enabling actions', () => {
    expect(() => parseGroupParticipantProfile({ participant: member })).toThrow()
    const profile = { participant: member, device_id: 'device', identity_fingerprint: 'fingerprint', capabilities: { can_message: false, can_query_avatar: false, can_query_about: false, can_list_common_groups: true } }
    expect(parseGroupParticipantProfile(profile)).toEqual(profile)
    expect(() => parseGroupParticipantProfile({ ...profile, contact_context: { contact_id: 'contact', context: 'chat' } })).toThrow(/acceso/)
  })
})
