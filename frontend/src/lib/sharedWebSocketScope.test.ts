import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginAuthIdentityChange, completeAuthIdentityChange } from './authScope'
import { subscribeWebSocket } from './api'
class FakeSocket {
  static OPEN = 1
  static CONNECTING = 0
  static sockets: FakeSocket[] = []
  readyState = FakeSocket.OPEN
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: (() => void) | null = null
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 3 })
  constructor(_url: string) { FakeSocket.sockets.push(this) }
}
afterEach(() => { vi.unstubAllGlobals(); FakeSocket.sockets = []; localStorage.removeItem('token') })
describe('shared websocket identity leases', () => {
  it('reopens after a cookie identity change and rejects late events from the previous actor', () => {
    vi.stubGlobal('WebSocket', FakeSocket)
    localStorage.setItem('token', 'cookie-session'); completeAuthIdentityChange()
    const listener = vi.fn(), unsubscribe = subscribeWebSocket(listener)
    const oldSocket = FakeSocket.sockets[0]
    oldSocket.onmessage?.({ data: JSON.stringify({ event: 'chat_pin_updated', data: { chat_id: 'same-chat', pin_version: 2 } }) })
    expect(listener).toHaveBeenCalledTimes(1)
    beginAuthIdentityChange()
    expect(oldSocket.close).toHaveBeenCalledOnce(); expect(FakeSocket.sockets).toHaveLength(1)
    oldSocket.onmessage?.({ data: JSON.stringify({ event: 'chat_pin_updated', data: { chat_id: 'same-chat', pin_version: 3 } }) })
    expect(listener).toHaveBeenCalledTimes(1)
    completeAuthIdentityChange()
    expect(FakeSocket.sockets).toHaveLength(2)
    const nextSocket = FakeSocket.sockets[1]
    oldSocket.onclose?.({ code: 1000 } as CloseEvent)
    oldSocket.onmessage?.({ data: JSON.stringify({ event: 'chat_pin_updated', data: { pin_version: 4 } }) })
    nextSocket.onmessage?.({ data: JSON.stringify({ event: 'chat_pin_updated', data: { pin_version: 1 } }) })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith({ event: 'chat_pin_updated', data: { pin_version: 1 } })
    unsubscribe(); expect(nextSocket.close).toHaveBeenCalledOnce()
  })
})
