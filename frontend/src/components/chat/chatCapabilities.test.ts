import { describe, expect, it } from 'vitest'
import type { Device, Message } from '@/types/chat'
import { canReactToMessage, getMessageReactionAvailability } from '@/utils/chatCapabilities'

const connectedDevice: Device = {
  id: 'device-1',
  name: 'WhatsApp principal',
  status: 'connected',
  provider: 'whatsapp_web',
  runtime_capabilities: {
    can_start_chat: true,
    can_check_whatsapp: true,
    can_send_reaction: true,
    can_send_sticker: true,
    can_send_animated_sticker: false,
    can_publish_status: false,
    can_sync_own_status: false,
  },
}

const canonicalMessage: Message = {
  id: 'row-1',
  message_id: 'message-1',
  device_id: 'device-1',
  message_type: 'text',
  body: 'Hola',
  is_from_me: false,
  is_read: true,
  status: 'delivered',
  timestamp: '2026-08-13T10:00:00Z',
}

describe('chat reaction capability', () => {
  it('allows every canonical content type, including stickers and emoji-only text', () => {
    for (const message of [
      canonicalMessage,
      { ...canonicalMessage, message_type: 'sticker', body: undefined },
      { ...canonicalMessage, body: '👨‍👩‍👧‍👦' },
      { ...canonicalMessage, message_type: 'image', body: undefined },
    ]) {
      expect(canReactToMessage({ message, device: connectedDevice, deviceValidated: true })).toBe(true)
    }
  })

  it('fails closed while the channel has not been validated', () => {
    expect(getMessageReactionAvailability({ message: canonicalMessage, device: connectedDevice, deviceValidated: false })).toEqual({
      allowed: false,
      reason: 'Validando el canal de WhatsApp.',
    })
  })

  it.each([
    [{ ...connectedDevice, status: 'disconnected' }, 'El dispositivo de WhatsApp no está conectado.'],
    [{ ...connectedDevice, provider: 'whatsapp_cloud_api' as const }, 'Las reacciones de Cloud API se administran desde Chat API.'],
    [{ ...connectedDevice, runtime_capabilities: { ...connectedDevice.runtime_capabilities!, can_send_reaction: false } }, 'Este dispositivo no admite reacciones desde Clarin.'],
  ])('explains unavailable device truth', (device, reason) => {
    expect(getMessageReactionAvailability({ message: canonicalMessage, device, deviceValidated: true })).toEqual({ allowed: false, reason })
  })

  it('rejects revoked, optimistic and other-device messages', () => {
    expect(canReactToMessage({ message: { ...canonicalMessage, is_revoked: true }, device: connectedDevice, deviceValidated: true })).toBe(false)
    expect(canReactToMessage({ message: { ...canonicalMessage, id: 'optimistic-1' }, device: connectedDevice, deviceValidated: true })).toBe(false)
    expect(canReactToMessage({ message: { ...canonicalMessage, device_id: undefined }, device: connectedDevice, deviceValidated: true })).toBe(false)
    expect(getMessageReactionAvailability({ message: { ...canonicalMessage, device_id: 'device-2' }, device: connectedDevice, deviceValidated: true }).reason).toContain('otro dispositivo')
  })
})
