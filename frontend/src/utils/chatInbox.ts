import type { Chat, ChatState, Message } from '@/types/chat'

export type InboxView = 'all' | 'unread' | 'pending'
export function mergeMessageSender(incoming: Message['sender'], existing: Message['sender']) {
  return incoming?.user_id ? incoming : existing?.user_id ? existing : incoming || existing
}
export function matchesInbox(chat: Chat, view: InboxView) {
  return view === 'pending' ? Boolean(chat.needs_reply) : view === 'unread' ? chat.unread_count > 0 : true
}
export function applyChatState(chat: Chat, state?: ChatState): Chat {
  if (!state || state.chat_id !== chat.id || state.state_version < (chat.state_version || 0)) return chat
  return { ...chat, unread_count: state.unread_count, waiting_since: state.waiting_since, needs_reply: state.needs_reply, state_version: state.state_version }
}
export function orderInbox(chats: Chat[], view: InboxView): Chat[] {
  return [...chats].sort((a, b) => view === 'pending'
    ? Date.parse(a.waiting_since || '') - Date.parse(b.waiting_since || '') || a.id.localeCompare(b.id)
    : Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned)) || Date.parse(b.last_message_at || '') - Date.parse(a.last_message_at || '') || a.id.localeCompare(b.id))
}
export function reconcileInboxPage(current: Chat[], page: Chat[], states: Map<string, ChatState>, view: InboxView, retainTail: boolean) {
  const previous = new Map(current.map(chat => [chat.id, chat]))
  const rows = page.map(chat => {
    const existing = previous.get(chat.id)
    const canonical = applyChatState(chat, states.get(chat.id))
    if (existing && (existing.state_version || 0) > (canonical.state_version || 0)) return applyChatState(canonical, { ...existing, chat_id: existing.id, state_version: existing.state_version!, needs_reply: Boolean(existing.needs_reply), waiting_since: existing.waiting_since || null })
    return canonical
  })
  const ids = new Set(rows.map(chat => chat.id))
  if (retainTail) rows.push(...current.filter(chat => !ids.has(chat.id)).map(chat => applyChatState(chat, states.get(chat.id))))
  return orderInbox(rows.filter(chat => matchesInbox(chat, view)), view)
}
export function nextPendingChat(chats: Chat[], currentId: string | null, anchor?: { id: string; waiting_since: string }) {
  const queue = orderInbox(chats.filter(chat => chat.needs_reply && chat.id !== currentId), 'pending')
  return queue.find(chat => anchor && (Date.parse(chat.waiting_since || '') > Date.parse(anchor.waiting_since) || Date.parse(chat.waiting_since || '') === Date.parse(anchor.waiting_since) && chat.id > anchor.id)) || queue[0] || null
}
export function messageAuthor(message: Message): { name: string; origin: string } {
  const sender = message.sender
  const origins: Record<string, string> = { manual: 'Enviado desde Clarin', quick_reply: 'Respuesta rápida', automation: 'Envío automático o integración', campaign: 'Campaña', whatsapp_external: 'Enviado desde WhatsApp', history: 'Historial importado' }
  return { name: sender?.name || (sender?.origin === 'whatsapp_external' ? 'Usuario de WhatsApp no identificado' : sender?.origin === 'automation' ? 'Sistema' : sender?.origin === 'campaign' ? 'Campaña' : 'Autor no registrado'), origin: sender ? origins[sender.origin] || 'Origen no registrado' : 'Este mensaje no conserva información del usuario que lo envió.' }
}
