import { describe, expect, it } from 'vitest'
import { messageBelongsToChat } from './chatEventScope'

const scope = { chatId: 'web-chat', jid: 'synthetic@test', deviceId: 'web-device', provider: 'whatsapp_web' }
describe('chat realtime identity', () => {
  it('rejects another canonical channel even with the same JID', () => {
    expect(messageBelongsToChat(scope, { chat_id: 'cloud-chat' }, { from_jid: scope.jid })).toBe(false)
    expect(messageBelongsToChat(scope, {}, { chat_id: 'cloud-chat', from_jid: scope.jid })).toBe(false)
    expect(messageBelongsToChat(scope, { chat_id: scope.chatId }, { device_id: 'historical-web-device' })).toBe(true)
  })
  it('admits legacy JID events only with matching device and compatible provider', () => {
    expect(messageBelongsToChat(scope, {}, { from_jid: scope.jid })).toBe(false)
    expect(messageBelongsToChat(scope, {}, { from_jid: scope.jid, device_id: 'cloud-device' })).toBe(false)
    expect(messageBelongsToChat(scope, {}, { from_jid: scope.jid, device_id: scope.deviceId, provider: 'whatsapp_cloud_api' })).toBe(false)
    expect(messageBelongsToChat(scope, {}, { from_jid: scope.jid, device_id: scope.deviceId })).toBe(true)
    expect(messageBelongsToChat(scope, { device_id: scope.deviceId, provider: scope.provider }, { to: scope.jid })).toBe(true)
  })
})
