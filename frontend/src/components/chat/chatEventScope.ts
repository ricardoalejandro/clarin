type ChatEventScope = { chatId: string; jid?: string | null; deviceId?: string | null; provider?: string | null }
type MessageScope = { chat_id?: unknown; device_id?: unknown; provider?: unknown; from_jid?: unknown; to?: unknown }

/** Canonical chat IDs take precedence over legacy phone/JID projections. */
export function messageBelongsToChat(scope: ChatEventScope, payload: MessageScope, message: MessageScope) {
  const canonicalId = payload.chat_id || message.chat_id
  if (canonicalId) return canonicalId === scope.chatId
  const deviceId = payload.device_id || message.device_id
  const provider = payload.provider || message.provider
  if (!scope.jid || !scope.deviceId || deviceId !== scope.deviceId) return false
  // A device ID already identifies one provider; reject contradictory provider metadata.
  if (provider && (!scope.provider || provider !== scope.provider)) return false
  return message.from_jid === scope.jid || message.to === scope.jid
}
