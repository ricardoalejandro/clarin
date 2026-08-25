import type { Device, Message } from '@/types/chat'

export type MessageReactionAvailability = {
  allowed: boolean
  reason?: string
}

type MessageReactionInput = {
  message: Message
  device: Device | null | undefined
  deviceValidated: boolean
  chatReadOnly?: boolean
}

export function getMessageReactionAvailability({
  message,
  device,
  deviceValidated,
  chatReadOnly = false,
}: MessageReactionInput): MessageReactionAvailability {
  if (chatReadOnly) {
    return { allowed: false, reason: 'Esta conversación está disponible en modo de solo lectura.' }
  }
  if (!deviceValidated) {
    return { allowed: false, reason: 'Validando el canal de WhatsApp.' }
  }
  if (!device) {
    return { allowed: false, reason: 'Esta conversación no tiene un dispositivo asociado.' }
  }
  if ((device.provider || 'whatsapp_web') !== 'whatsapp_web') {
    return { allowed: false, reason: 'Las reacciones de Cloud API se administran desde Chat API.' }
  }
  if (device.status !== 'connected') {
    return { allowed: false, reason: 'El dispositivo de WhatsApp no está conectado.' }
  }
  if (device.runtime_capabilities?.can_send_reaction !== true) {
    return { allowed: false, reason: 'Este dispositivo no admite reacciones desde Clarin.' }
  }
  if (message.is_revoked) {
    return { allowed: false, reason: 'No se puede reaccionar a un mensaje eliminado.' }
  }
  if (!message.message_id || message.id.startsWith('optimistic-')) {
    return { allowed: false, reason: 'Espera a que WhatsApp confirme el mensaje.' }
  }
  if ((message.message_type || '').toLowerCase() === 'reaction') {
    return { allowed: false, reason: 'Este registro de reacción no admite otra reacción.' }
  }
  if (!message.device_id) {
    return { allowed: false, reason: 'No se pudo confirmar el dispositivo de este mensaje.' }
  }
  if (message.device_id !== device.id) {
    return { allowed: false, reason: 'Este mensaje pertenece a otro dispositivo de WhatsApp.' }
  }
  return { allowed: true }
}

export function canReactToMessage(input: MessageReactionInput): boolean {
  return getMessageReactionAvailability(input).allowed
}
