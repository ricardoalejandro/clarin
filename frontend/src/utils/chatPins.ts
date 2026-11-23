import type { Chat, ChatPinState } from '@/types/chat'

export function applyChatPin(chat: Chat, state?: ChatPinState): Chat {
  if (!state || state.chat_id !== chat.id || state.pin_version < (chat.pin_version || 0)) return chat
  return { ...chat, is_pinned: state.is_pinned, pinned_at: state.pinned_at, pin_version: state.pin_version }
}
export function compareChatPins(a: Chat, b: Chat): number {
  const pinned = Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned))
  if (pinned) return pinned
  if (a.is_pinned && b.is_pinned) return (Date.parse(b.pinned_at || '') || 0) - (Date.parse(a.pinned_at || '') || 0) || a.id.localeCompare(b.id)
  return 0
}
export function pinSnapshot(chat: Chat): ChatPinState { return { chat_id: chat.id, is_pinned: Boolean(chat.is_pinned), pinned_at: chat.pinned_at || null, pin_version: chat.pin_version || 0 } }
