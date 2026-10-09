import type { Message } from '@/types/chat'
import { mergeMessageSender } from '@/utils/chatInbox'
import { mergeCanonicalReactionSnapshot } from '@/utils/chatReactions'

export function hasSameMessageIdentity(message: Message, candidate: Message): boolean {
  return message.id === candidate.id || Boolean(candidate.message_id && message.message_id === candidate.message_id)
}

const deliveryLevel: Record<string, number> = { sending: 0, sent: 1, delivered: 2, read: 3 }

/** A server snapshot owns content; already received delivery receipts cannot regress. */
export function mergeCanonicalMessage(current: Message | undefined, canonical: Message, pendingReaction = false): Message {
  if (!current) return canonical
  const status = (deliveryLevel[current.status] ?? -1) > (deliveryLevel[canonical.status] ?? -1)
    ? current.status : canonical.status
  return {
    ...current,
    ...canonical,
    status,
    is_read: current.is_read || canonical.is_read,
    delivered_at: canonical.delivered_at ?? current.delivered_at,
    read_at: canonical.read_at ?? current.read_at,
    body: canonical.is_revoked ? undefined : Object.hasOwn(canonical, 'body') ? canonical.body : current.body,
    quoted_message_id: canonical.quoted_message_id ?? current.quoted_message_id,
    quoted_body: canonical.quoted_body ?? current.quoted_body,
    quoted_sender: canonical.quoted_sender ?? current.quoted_sender,
    quoted_is_from_me: canonical.quoted_is_from_me ?? current.quoted_is_from_me,
    sender: mergeMessageSender(canonical.sender, current.sender),
    reactions: mergeCanonicalReactionSnapshot(current.reactions, canonical.reactions, pendingReaction),
  }
}

export function orderChatMessages(messages: Message[]): Message[] {
  const time = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0
  return [...messages].sort((left, right) => time(left.timestamp) - time(right.timestamp) || left.id.localeCompare(right.id))
}

export function reconcileOptimisticMessage(messages: Message[], tempId: string, realMessage: Message): Message[] {
  const optimistic = messages.find(message => message.id === tempId)
  const existing = messages.find(message => hasSameMessageIdentity(message, realMessage) && message.id !== tempId)
  const canonical = mergeCanonicalMessage(existing || optimistic, { ...realMessage, is_from_me: true })
  const remaining = messages.filter(message => message.id !== tempId && !hasSameMessageIdentity(message, canonical))
  return orderChatMessages([...remaining, canonical])
}

export function mergeFetchedMessages(current: Message[], fetched: Message[], pending: (id: string) => boolean = () => false): Message[] {
  const merged = fetched.map(message => mergeCanonicalMessage(current.find(row => hasSameMessageIdentity(row, message)), message, pending(message.message_id)))
  merged.push(...current.filter(message => !fetched.some(row => hasSameMessageIdentity(row, message))))
  return orderChatMessages(merged)
}
