import { describe, expect, it } from 'vitest'
import { validatePinnedChatSender } from './chatSenderSession'

describe('fixed sender session', () => {
  it('accepts only the channel chosen for this session', () => {
    const session = { chatId: 'chat', deviceId: 'chosen' }
    expect(validatePinnedChatSender(session, { id: 'chosen', name: 'Chosen', status: 'connected' })).toBe('ready')
    expect(validatePinnedChatSender(session, { id: 'another', name: 'Other', status: 'connected' })).toBe('changed')
    expect(session.deviceId).toBe('chosen')
  })
  it('allows initial validation without choosing a fallback for a missing channel', () => {
    expect(validatePinnedChatSender({ chatId: 'chat', deviceId: null }, { id: 'first', name: 'First', status: 'connected' })).toBe('ready')
    expect(validatePinnedChatSender({ chatId: 'chat', deviceId: 'chosen' }, null)).toBe('ready')
  })
  it('rejects a relinked number even if the device id stayed unchanged', () => {
    expect(validatePinnedChatSender({ chatId: 'chat', deviceId: 'chosen', phone: '51900000001' }, { id: 'chosen', name: 'Chosen', status: 'connected', phone: '51900000002' })).toBe('changed')
  })
})
