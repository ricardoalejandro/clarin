import type { Chat, GroupParticipant } from '@/types/chat'

export interface GroupParticipantProfile {
  participant: GroupParticipant
  device_id: string
  identity_fingerprint: string
  contact_context?: { contact_id: string; context: 'contact' | 'chat'; chat_id?: string }
  capabilities: {
    can_message: boolean
    message_disabled_reason?: string
    can_query_avatar: boolean
    can_query_about: boolean
    can_list_common_groups: boolean
  }
}

export interface ParticipantCommonGroup {
  chat_id: string
  subject: string
  participant_count: number
}

export type OpenParticipantChat = (chat: Chat) => void

export function parseGroupParticipantProfile(value: unknown): GroupParticipantProfile {
  const profile = value as Partial<GroupParticipantProfile> | null
  if (!profile || !profile.participant?.jid || !profile.device_id || !profile.identity_fingerprint || !profile.capabilities ||
    ['can_message', 'can_query_avatar', 'can_query_about', 'can_list_common_groups'].some(key => typeof profile.capabilities?.[key as keyof GroupParticipantProfile['capabilities']] !== 'boolean')) {
    throw new Error('No pudimos verificar la identidad del integrante. Vuelve a consultar el perfil.')
  }
  if (profile.contact_context && (!profile.contact_context.contact_id || !['contact', 'chat'].includes(profile.contact_context.context) || profile.contact_context.context === 'chat' && !profile.contact_context.chat_id)) {
    throw new Error('No pudimos comprobar el acceso a la ficha del contacto.')
  }
  return profile as GroupParticipantProfile
}
