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
  it('replaces duplicate alias snapshots in place and clears revoked optional identity data', () => {
    const before = { ...member, jid: 'before@lid', lid: 'before@lid', name: 'Antes' }
    const after = { ...member, jid: 'after@lid', lid: 'after@lid', name: 'Después' }
    const previous: GroupParticipant = {
      ...member,
      jid: '51999999999@s.whatsapp.net',
      phone: '51999999999',
      redacted_phone: '+51 *** 999',
      username: 'nombre.anterior',
      name: 'Nombre anterior',
      name_source: 'contact',
      whatsapp_name: 'Perfil anterior',
      role: 'admin',
      avatar_url: '/avatar-anterior',
      avatar_source: 'contact',
    }
    const canonical: GroupParticipant = { ...member, name: 'Nombre actual', role: 'member' }
    const result = mergeParticipantPage([before, previous, after], [canonical], true)
    expect(result).toEqual([before, canonical, after])
    expect(result[0]).toBe(before)
    expect(result[1]).toBe(canonical)
    expect(result[2]).toBe(after)
    for (const key of ['phone', 'redacted_phone', 'username', 'name_source', 'whatsapp_name', 'avatar_url', 'avatar_source']) {
      expect(result[1]).not.toHaveProperty(key)
    }
    expect(result[1].role).toBe('member')
  })
  it.each([
    ['7001@lid', '7002@lid', '51999999999@s.whatsapp.net', '51999999999@s.whatsapp.net'],
    [undefined, '7002@lid', '7001@lid', '51999999999@s.whatsapp.net'],
    [undefined, undefined, '7001@lid', '7002@lid'],
  ])('does not merge distinct stable LIDs when a phone is reassigned (%s, %s)', (leftLID, rightLID, leftJID, rightJID) => {
    const previous: GroupParticipant = { ...member, jid: leftJID!, lid: leftLID, phone: '51999999999', name: 'Anterior' }
    const canonical: GroupParticipant = { ...member, jid: rightJID!, lid: rightLID, phone: '51999999999', name: 'Actual' }
    expect(sameParticipant(previous, canonical)).toBe(false)
    expect(mergeParticipantPage([previous], [canonical], true)).toEqual([previous, canonical])
  })
  it('replaces a refreshed page so departed participants cannot survive as a stale tail', () => {
    const other = { ...member, jid: 'other@lid', lid: 'other@lid', name: 'Otro' }
    expect(mergeParticipantPage([member, other], [member])).toEqual([member])
  })
  it('never presents LID digits as a telephone and keeps redacted numbers separate', () => {
    expect(groupParticipantLabel({ ...member, jid: '123456789012345@lid', name: 'Integrante' })).toBe('Nombre no disponible')
    expect(groupParticipantPhone(member)).toBe('Teléfono no disponible')
    expect(groupParticipantPhone({ ...member, username: 'ale.test' })).toBe('Teléfono no disponible')
    expect(groupParticipantLabel({ ...member, name: '123456789@lid', username: 'ale.test' })).toBe('Nombre no disponible')
    expect(sameParticipant({ ...member, username: 'ale.test' }, { ...member, jid: 'different@lid', lid: 'different@lid', username: 'ale.test' })).toBe(false)
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
