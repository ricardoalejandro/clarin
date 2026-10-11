import type { Message } from '@/types/chat'

export const CHAT_MESSAGE_GROUP_WINDOW_MS = 120_000

function knownAuthor(message: Message): string | null {
  if (message.sender?.user_id) return `user:${message.sender.user_id}`
  if (!message.is_from_me && message.from_jid?.trim()) return `jid:${message.from_jid.trim()}`
  // A direction or display name cannot identify which person sent a message.
  return null
}

export function groupChatMessages(previous: Message | undefined, current: Message): boolean {
  if (!previous || previous.is_revoked || current.is_revoked || previous.is_from_me !== current.is_from_me || previous.device_id !== current.device_id) return false
  const author = knownAuthor(current)
  if (!author || author !== knownAuthor(previous)) return false
  const before = new Date(previous.timestamp)
  const after = new Date(current.timestamp)
  const elapsed = after.getTime() - before.getTime()
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= CHAT_MESSAGE_GROUP_WINDOW_MS && before.toDateString() === after.toDateString()
}
