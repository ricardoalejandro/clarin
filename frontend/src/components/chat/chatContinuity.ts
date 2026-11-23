import type { Chat, Device } from '@/types/chat'

export interface ChatContinuityEvent {
  canonical_chat_id: string
  alias_chat_ids: string[]
  device_id: string | null
  binding_revision: number
}
export const bindingRevision = (chat?: Pick<Chat, 'binding_revision'> | null) => Number.isSafeInteger(chat?.binding_revision) && (chat?.binding_revision ?? 0) >= 0 ? chat!.binding_revision! : 0
export function parseChatContinuityEvent(value: unknown): ChatContinuityEvent | null {
  const event = value as Partial<ChatContinuityEvent> | null
  if (!event || typeof event.canonical_chat_id !== 'string' || !event.canonical_chat_id || event.device_id !== null && (typeof event.device_id !== 'string' || !event.device_id)
    || !Number.isSafeInteger(event.binding_revision) || (event.binding_revision ?? 0) <= 0 || !Array.isArray(event.alias_chat_ids)
    || event.alias_chat_ids.some(id => typeof id !== 'string' || !id)) return null
  return event as ChatContinuityEvent
}
export function continuityChatIds(chat: Chat): Set<string> { return new Set([chat.id, ...(chat.alias_chat_ids || [])]) }
/** Only a canonical authenticated server snapshot can authorize a transport replacement. */
export function verifiedChatContinuity(next: Chat | null | undefined, previous: Pick<Chat, 'id' | 'account_id' | 'binding_revision' | 'jid'> | null | undefined, event?: ChatContinuityEvent): boolean {
  if (!next || !previous || next.binding_state !== 'verified_continuity' || next.canonical_chat_id !== next.id || !next.device_id || bindingRevision(next) <= 0
    || bindingRevision(next) < bindingRevision(previous) || !continuityChatIds(next).has(previous.id)
    || next.account_id && previous.account_id && next.account_id !== previous.account_id) return false
  if ((next.jid.endsWith('@g.us') || previous.jid.endsWith('@g.us')) && next.jid !== previous.jid) return false
  return !event || next.id === event.canonical_chat_id && next.device_id === event.device_id && bindingRevision(next) >= event.binding_revision
    && event.alias_chat_ids.every(id => continuityChatIds(next).has(id))
}
export function reconcileContinuityRows(rows: Chat[], canonical: Chat): Chat[] {
  const ids = continuityChatIds(canonical)
  const first = rows.findIndex(row => ids.has(row.id))
  if (first < 0) return rows
  return rows.flatMap((row, index) => ids.has(row.id) ? index === first ? [canonical] : [] : [row])
}
export function continuityDeviceMatches(chat: Chat, device: Device | null | undefined): boolean {
  return Boolean(device && device.id === chat.device_id && device.provider !== 'whatsapp_cloud_api')
}
export function remapContinuityIds(ids: ReadonlySet<string>, chat: Chat): Set<string> {
  const aliases = continuityChatIds(chat)
  return new Set([...ids].map(id => aliases.has(id) ? chat.id : id))
}
export function remapContinuityDeviceFilter(selected: string[], oldDeviceIds: readonly string[], newDeviceId: string): string[] {
  if (!selected.length || !newDeviceId) return selected
  const old = new Set(oldDeviceIds.filter(Boolean))
  const next = [...new Set(selected.map(id => old.has(id) ? newDeviceId : id))]
  return next.every((id, index) => id === selected[index]) ? selected : next
}

/** A restrictive canonical snapshot invalidates capability; it never authorizes another sender. */
export function restrictedChatContinuity(next: Chat | null | undefined, previous: Pick<Chat, 'id' | 'account_id' | 'binding_revision' | 'jid'> | null | undefined, event?: ChatContinuityEvent): boolean {
  if (!next || !previous || !['pending', 'conflict'].includes(next.binding_state || '') || next.canonical_chat_id !== next.id
    || bindingRevision(next) <= 0 || bindingRevision(next) < bindingRevision(previous) || !continuityChatIds(next).has(previous.id)
    || next.account_id && previous.account_id && next.account_id !== previous.account_id) return false
  if ((next.jid.endsWith('@g.us') || previous.jid.endsWith('@g.us')) && next.jid !== previous.jid) return false
  return !event || event.canonical_chat_id === next.id && bindingRevision(next) >= event.binding_revision && event.alias_chat_ids.every(id => continuityChatIds(next).has(id))
}
export function chatDeletionIssue(chat?: Pick<Chat, 'id' | 'alias_chat_ids'> | null): string | null {
  return chat?.alias_chat_ids?.some(id => id !== chat.id) ? 'La eliminación de este historial consolidado requiere revisión.' : null
}
