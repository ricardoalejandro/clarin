import type { GroupParticipant } from '@/types/chat'

export function participantAliases(member: GroupParticipant): string[] {
  return [member.jid, member.lid, member.phone ? `${member.phone.replace(/^\+/, '')}@s.whatsapp.net` : ''].filter(Boolean) as string[]
}

export function sameParticipant(left: GroupParticipant, right: GroupParticipant): boolean {
  const aliases = new Set(participantAliases(left))
  return participantAliases(right).some(alias => aliases.has(alias))
}

export function mergeParticipantPage(current: GroupParticipant[], incoming: GroupParticipant[], append = false): GroupParticipant[] {
  const rows = append ? [...current] : []
  for (const member of incoming) {
    const index = rows.findIndex(row => sameParticipant(row, member))
    if (index < 0) rows.push(member)
    else rows[index] = { ...rows[index], ...member }
  }
  return rows
}

export function groupParticipantLabel(member: GroupParticipant): string {
  const name = member.name?.trim()
  if (name && !/^integrante(?: sin nombre)?$|^participante de whatsapp$/i.test(name)) return name
  if (member.phone) return `+${member.phone.replace(/^\+/, '')}`
  return 'Nombre no disponible'
}

export function groupParticipantPhone(member: GroupParticipant): string {
  return member.phone ? `+${member.phone.replace(/^\+/, '')}` : member.redacted_phone || 'Teléfono no disponible'
}

export function groupParticipantPath(chatId: string, jid: string): string {
  return `/api/chats/${encodeURIComponent(chatId)}/group/participants/${encodeURIComponent(jid)}`
}

export function hasGroupMemberHistoryLayer(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false
  const layer = state as { __clarinGroupParticipant?: unknown; __clarinGroupMemberChat?: unknown }
  return typeof layer.__clarinGroupParticipant === 'string' || layer.__clarinGroupMemberChat === true
}
