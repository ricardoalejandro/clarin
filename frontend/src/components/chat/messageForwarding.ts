import type { Chat, Message, MessageForwarding } from '@/types/chat'
import { groupWriteRestriction, isGroupChat } from '@/utils/chatGroups'

const rank = { unknown: 0, not_forwarded: 1, forwarded: 2, frequently_forwarded: 3 }
export function normalizeForwarding(value: unknown): MessageForwarding {
  if (!value || typeof value !== 'object') return { state: 'unknown', score: null }
  const raw = value as Partial<MessageForwarding>
  if (!raw.state || !Object.hasOwn(rank, raw.state)) return { state: 'unknown', score: null }
  const score = typeof raw.score === 'number' && Number.isInteger(raw.score) && raw.score >= 0 && raw.score <= 4294967295 ? raw.score : null
  if (raw.state === 'unknown') return { state: 'unknown', score: null }
  if (score !== null && score >= 5) return { state: 'frequently_forwarded', score }
  if (raw.state === 'not_forwarded') return score === 0 ? { state: raw.state, score } : { state: 'unknown', score: null }
  return { state: raw.state, score }
}

/** A partial/older snapshot cannot erase established forwarding provenance. */
export function mergeMessageForwarding(current: Pick<Message, 'forwarding' | 'audio_ptt'>, incoming: Pick<Message, 'forwarding' | 'audio_ptt'>): Pick<Message, 'forwarding' | 'audio_ptt'> {
  const before = normalizeForwarding(current.forwarding)
  const next = normalizeForwarding(incoming.forwarding)
  let forwarding: MessageForwarding
  if (rank[before.state] > rank[next.state]) forwarding = before
  else if (rank[next.state] > rank[before.state]) forwarding = next
  else {
    const scores = [before.score, next.score].filter((score): score is number => score !== null)
    forwarding = normalizeForwarding({ state: next.state, score: scores.length ? Math.max(...scores) : null })
  }
  return { forwarding, audio_ptt: typeof incoming.audio_ptt === 'boolean' ? incoming.audio_ptt : current.audio_ptt }
}

export function forwardingLabel(value?: MessageForwarding): string | null {
  const state = normalizeForwarding(value).state
  return state === 'frequently_forwarded' ? 'Reenviado muchas veces' : state === 'forwarded' ? 'Reenviado' : null
}

export function forwardSourceIssue(message: Message, deviceId?: string): string | null {
  if (message.is_revoked) return 'Este mensaje fue eliminado y no se puede reenviar.'
  if (message.is_view_once) return 'Los mensajes de visualización única no se pueden reenviar.'
  if ((message.id || '').startsWith('optimistic-') || ['sending', 'failed'].includes(message.status)) return 'Solo puedes reenviar mensajes confirmados.'
  if (deviceId && message.device_id && message.device_id !== deviceId) return 'El mensaje pertenece a otro dispositivo de WhatsApp.'
  const forwarding = normalizeForwarding(message.forwarding)
  if (forwarding.state === 'unknown') return 'No conocemos si este mensaje fue reenviado. No se puede reenviar con fidelidad.'
  if (forwarding.score === null) return 'No conocemos el contador de reenvíos de este mensaje.'
  const type = message.message_type || 'text'
  if (type === 'text') return message.body?.trim() ? null : 'El texto de este mensaje no está disponible.'
  if (!['image', 'video', 'gif', 'audio', 'document', 'sticker'].includes(type)) return 'Este tipo de mensaje todavía no admite reenvío.'
  if (!message.media_url || message.media_deleted || message.media_recoverable || message.media_unavailable_reason) return 'El archivo no está disponible para reenviarlo.'
  if (type === 'audio' && typeof message.audio_ptt !== 'boolean') return 'No conocemos si este audio es una nota de voz.'
  return null
}

export function forwardLimits(message: Message) {
  const value = normalizeForwarding(message.forwarding)
  return { maxChats: value.state === 'frequently_forwarded' ? 1 : 5, maxGroups: value.state === 'forwarded' || value.state === 'frequently_forwarded' ? 1 : 5 }
}

export function forwardDestinationIssue(chat: Chat, selected: Chat[], message: Message, deviceId: string): string | null {
  if (chat.device_id !== deviceId) return 'Pertenece a otro dispositivo de WhatsApp.'
  const restriction = groupWriteRestriction(chat)
  if (restriction) return restriction
  if (chat.lead_is_blocked) return 'Este contacto está marcado como No contactar.'
  if (selected.some(row => row.id === chat.id)) return null
  const limits = forwardLimits(message)
  if (selected.length >= limits.maxChats) return limits.maxChats === 1 ? 'Este mensaje solo se puede reenviar a un chat por vez.' : 'Selecciona hasta cinco chats por reenvío.'
  if (isGroupChat(chat) && selected.filter(isGroupChat).length >= limits.maxGroups) return 'Este mensaje solo se puede reenviar a un grupo por vez.'
  return null
}

/** These codes are returned before an operation is recorded or any destination is sent. */
export const forwardValidationCodes = new Set(['forward_capability_unverified', 'forward_invalid_request', 'forward_destination_limit', 'forward_duplicate_destination', 'forward_device_unavailable', 'forward_device_not_found', 'forward_source_not_found', 'forward_source_unavailable', 'forward_provider_unsupported', 'forwarding_source_unknown', 'forwarding_score_unknown', 'forward_media_unavailable', 'forward_media_too_large', 'forward_audio_kind_unknown', 'forward_type_unsupported', 'forward_destination_not_found', 'forward_destination_invalid', 'forward_group_unavailable', 'do_not_contact', 'forward_frequent_limit', 'forward_group_limit', 'forward_source_changed'])

export interface ForwardBatchRequest {
  source_chat_id: string
  source_message_id: string
  device_id: string
  destination_chat_ids: string[]
  client_operation_id: string
}
export interface ForwardDestinationResult {
  chat_id: string
  state: 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain'
  code?: string
  error?: string
  can_retry?: boolean
  message?: Message
}
export interface ForwardBatchReceipt {
  operation_id: string
  complete: boolean
  results: ForwardDestinationResult[]
  forwarding?: MessageForwarding
}
export interface StoredForwardBatch { request: ForwardBatchRequest; receipt?: ForwardBatchReceipt }
export const forwardingSessionKey = (scope: string, chatId: string, messageId: string, deviceId: string) => `clarin:forward:${scope}:${deviceId}:${chatId}:${messageId}`

export function parseForwardReceipt(data: unknown, request: ForwardBatchRequest): ForwardBatchReceipt {
  const raw = data as Partial<ForwardBatchReceipt> & { success?: unknown }
  if (raw?.success !== true || raw.operation_id !== request.client_operation_id || !Array.isArray(raw.results) || raw.results.length !== request.destination_chat_ids.length) throw new Error('No pudimos comprobar el resultado del reenvío.')
  const ids = new Set<string>()
  const states = new Set(['pending', 'sending', 'sent', 'failed', 'uncertain'])
  for (const result of raw.results) {
    if (!result || !request.destination_chat_ids.includes(result.chat_id) || ids.has(result.chat_id) || !states.has(result.state)) throw new Error('El resultado del reenvío no coincide con los chats seleccionados.')
    ids.add(result.chat_id)
  }
  return { operation_id: raw.operation_id, complete: raw.complete === true, results: raw.results, forwarding: raw.forwarding }
}

const pendingForwardBatches = new Map<string, StoredForwardBatch>()
export function rememberForwardBatch(key: string, batch: StoredForwardBatch | null) {
  // Retain only operation/destination identities and delivery outcomes, never message content.
  const clean = batch ? { request: batch.request, receipt: batch.receipt && { ...batch.receipt, results: batch.receipt.results.map(({ message: _message, ...result }) => result) } } : null
  if (clean) pendingForwardBatches.set(key, clean); else pendingForwardBatches.delete(key)
  try {
    if (clean) sessionStorage.setItem(key, JSON.stringify(clean))
    else sessionStorage.removeItem(key)
  } catch { /* Keep the same operation across modal sessions even when browser storage is blocked. */ }
}
export function restoreForwardBatch(key: string): StoredForwardBatch | null {
  if (pendingForwardBatches.has(key)) return pendingForwardBatches.get(key)!
  try {
    const raw = JSON.parse(sessionStorage.getItem(key) || 'null') as StoredForwardBatch | null
    if (!raw || !raw.request || !Array.isArray(raw.request.destination_chat_ids) || typeof raw.request.client_operation_id !== 'string' || raw.request.destination_chat_ids.length < 1 || raw.request.destination_chat_ids.length > 5) return null
    if (raw.receipt) parseForwardReceipt({ success: true, ...raw.receipt }, raw.request)
    return raw
  } catch { return null }
}
