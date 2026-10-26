import type { Chat, ChatState, Message } from '@/types/chat'
import { bindingRevision } from './chatContinuity'
import { applyChatState } from '@/utils/chatInbox'

export function latestReadBoundary(messages: Message[]): Message | undefined {
  return messages.filter(message => !message.id.startsWith('optimistic-') && !message.is_revoked)
    .reduce<Message | undefined>((latest, message) => !latest || Date.parse(message.timestamp) > Date.parse(latest.timestamp)
      || (Date.parse(message.timestamp) === Date.parse(latest.timestamp) && message.id > latest.id) ? message : latest, undefined)
}

export function observedIncomingBoundary(messages: Message[], state: Pick<Chat, 'last_incoming_message_id' | 'last_incoming_at'> | null): string | undefined {
  const latest = latestReadBoundary(messages)
  if (!latest) return undefined
  const incomingAt = Date.parse(state?.last_incoming_at || '')
  const latestAt = Date.parse(latest.timestamp)
  const observed = latestReadBoundary(messages.filter(message => !message.is_from_me))
  const observedAt = observed ? Date.parse(observed.timestamp) : Number.NEGATIVE_INFINITY
  const snapshotId = state?.last_incoming_message_id
  const snapshotFits = snapshotId && (incomingAt < latestAt || incomingAt === latestAt && snapshotId <= latest.id)
  if (snapshotFits && (!observed || incomingAt > observedAt || incomingAt === observedAt && snapshotId > observed.id)) return snapshotId
  return observed?.id
}

/** Identity metadata may refresh independently; canonical attention state only advances. */
export function mergeChatSnapshot(current: Chat | null, snapshot: Chat, state?: ChatState): Chat {
  const incoming = applyChatState(snapshot, state)
  if (!current || current.id !== incoming.id) return incoming
  const merged = { ...current, ...incoming }
  if (bindingRevision(current) > bindingRevision(incoming)) {
    merged.device_id = current.device_id; merged.device_name = current.device_name; merged.device_phone = current.device_phone
    merged.canonical_chat_id = current.canonical_chat_id; merged.alias_chat_ids = current.alias_chat_ids
    merged.binding_revision = current.binding_revision; merged.binding_state = current.binding_state; merged.group = current.group
  }
  if ((incoming.pin_version ?? 0) < (current.pin_version ?? 0)) {
    merged.is_pinned = current.is_pinned; merged.pinned_at = current.pinned_at; merged.pin_version = current.pin_version
  }
  // List/device snapshots omit this full-history boundary. Omission preserves
  // it, while an explicit null from canonical state really clears it.
  if (incoming.last_incoming_message_id === undefined) {
    merged.last_incoming_message_id = current.last_incoming_message_id
    merged.last_incoming_at = current.last_incoming_at
  }
  if ((incoming.state_version || 0) >= (current.state_version || 0)) return merged
  return { ...merged, unread_count: current.unread_count, waiting_since: current.waiting_since,
    needs_reply: current.needs_reply, state_version: current.state_version,
    last_incoming_message_id: current.last_incoming_message_id, last_incoming_at: current.last_incoming_at }
}

export function sendOnEnter(event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }, touchKeyboard: boolean): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !touchKeyboard
}

export type ConversationAnchor = { id?: string; offset: number; scrollTop: number; chatId: string }
export function captureConversationAnchor(container: HTMLElement | null, chatId: string): ConversationAnchor {
  const top = container?.getBoundingClientRect().top || 0
  const row = container && Array.from(container.querySelectorAll<HTMLElement>('[data-chat-message-id]'))
    .find(element => element.getBoundingClientRect().bottom > top)
  return { chatId, id: row?.dataset.chatMessageId, offset: row ? row.getBoundingClientRect().top - top : 0, scrollTop: container?.scrollTop || 0 }
}
export function restoreConversationAnchor(container: HTMLElement | null, anchor: ConversationAnchor | null, chatId: string | null) {
  if (!container || !anchor || anchor.chatId !== chatId) return
  const row = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-message-id]')).find(element => element.dataset.chatMessageId === anchor.id)
  container.scrollTop = row ? container.scrollTop + row.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset : anchor.scrollTop
}


export function isConversationAtLatest(container: Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'> | null): boolean {
  return Boolean(container && container.clientHeight > 0 && container.scrollHeight - container.scrollTop - container.clientHeight <= 2)
}

// Resize follows the previous user intent, never the larger gap created by media.
export function followConversationLatest(container: Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'> | null, following: boolean, active: boolean, inHistory: boolean): boolean {
  if (!container || container.clientHeight <= 0 || !following || !active || inHistory) return false
  container.scrollTop = container.scrollHeight
  return true
}
