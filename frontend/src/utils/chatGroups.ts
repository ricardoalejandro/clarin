import type { Chat, ChatMention, Message } from '@/types/chat'

export function isGroupChat(chat?: Pick<Chat, 'jid' | 'kind'> | null): boolean { return chat?.kind === 'group' || Boolean(chat?.jid.endsWith('@g.us')) }
export function participantName(jid?: string, name?: string): string {
  if (name?.trim()) return name.trim()
  if (jid?.endsWith('@s.whatsapp.net')) return `+${jid.split('@')[0]}`
  return 'Participante de WhatsApp'
}
export function groupMessageAuthor(message: Message): string { return message.is_from_me ? 'Tú' : participantName(message.from_jid, message.from_name) }
export function chatAvatar(chat: Chat): string | undefined { return isGroupChat(chat) ? chat.group?.avatar_url : chat.contact_avatar_url }
export function groupWriteRestriction(chat?: Chat | null): string | null {
  if (!isGroupChat(chat)) return null
  if (!chat?.group) return 'Actualizando los permisos del grupo…'
  if (chat.group.can_send) return null
  return chat.group.send_disabled_reason || (chat.group.membership_status === 'left' ? 'Este número ya no pertenece al grupo.' : chat.group.announce ? 'Solo los administradores pueden enviar mensajes a este grupo.' : 'No se pudo confirmar el permiso para enviar mensajes a este grupo.')
}
export function displayMentionText(body: string, mentions?: ChatMention[]): string {
  const byUser = new Map((mentions || []).map(mention => [mention.jid.split('@')[0], mention.name]))
  return body.replace(/@([0-9]+)(?![0-9])/g, (token, user: string) => byUser.get(user) ? '@' + byUser.get(user) : token)
}
export function chatPreview(chat: Chat): string {
  const body = chat.last_message || 'Sin mensajes'
  if (!isGroupChat(chat) || !chat.last_message) return body
  const author = chat.last_message_from_me ? 'Tú' : chat.last_message_from_name
  return author ? `${author}: ${body}` : body
}

export function groupReactionsUnavailable(chat?: Chat | null): boolean {
  return isGroupChat(chat) && (!chat?.group || chat.group.membership_status !== 'member' || chat.group.kind === 'community')
}
