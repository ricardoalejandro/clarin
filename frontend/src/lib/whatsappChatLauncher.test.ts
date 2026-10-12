import { describe, expect, it } from 'vitest'
import { senderConfirmation, usableWhatsAppDevice, type WhatsAppDeviceOption } from './whatsappChatLauncher'

const channel: WhatsAppDeviceOption = { id: 'sender', phone: '+51 900 000 001', normalized_phone: '51900000001', status: 'connected', provider: 'whatsapp_web', history_revision: 'revision', runtime_capabilities: { can_start_chat: true, can_check_whatsapp: true, can_send_reaction: true, can_send_sticker: true, can_send_animated_sticker: false, can_publish_status: false, can_sync_own_status: false } }

describe('WhatsApp channel availability and confirmation', () => {
  it('accepts only a connected capable Web device', () => {
    expect(usableWhatsAppDevice(channel)).toBe(true)
    expect(usableWhatsAppDevice({ ...channel, status: 'disconnected' })).toBe(false)
    expect(usableWhatsAppDevice({ ...channel, provider: 'whatsapp_cloud_api' })).toBe(false)
    expect(usableWhatsAppDevice({ ...channel, runtime_capabilities: undefined })).toBe(false)
    expect(usableWhatsAppDevice({ ...channel, deletion: { operation_id: 'pending', phase: 'pending', attempts: 0 } })).toBe(false)
  })
  it('binds explicit confirmation to the exact device, normalized sender number and historical revision', () => {
    expect(senderConfirmation(channel)).toEqual({ device_id: 'sender', device_phone: '51900000001', history_revision: 'revision' })
    expect(senderConfirmation({ ...channel, normalized_phone: undefined })).toEqual({ device_id: 'sender', device_phone: '51900000001', history_revision: 'revision' })
    expect(senderConfirmation({ ...channel, history_revision: undefined })).toBeUndefined()
  })
})
