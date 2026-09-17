import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginOfflineV4OnlineReauth, setOfflineV4Mode, setOfflineV4NavigationEnabled } from './offlineV4ServiceWorker'

class Channel {
  port1 = { onmessage: null as ((event: { data: unknown }) => void) | null, close: vi.fn() }
  port2 = { reply: (data: unknown) => this.port1.onmessage?.({ data }) }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('browser-only worker preparation acknowledgement', () => {
  function setup(registration: unknown, controller?: unknown) {
    vi.stubGlobal('MessageChannel', Channel)
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn().mockResolvedValue(registration), controller } })
  }
  it('accepts only an explicit positive active-worker acknowledgement', async () => {
    const postMessage = vi.fn((_message, ports) => ports[0].reply({ ok: true }))
    setup({ active: { postMessage } })
    expect(await setOfflineV4Mode('offline')).toBe(true)
    expect(postMessage.mock.calls[0][0]).toEqual({ type: 'CLARIN_OFFLINE_V4_SET_MODE', mode: 'offline' })
    postMessage.mockImplementation((_message, ports) => ports[0].reply({ ok: false }))
    expect(await setOfflineV4NavigationEnabled(true)).toBe(false)
  })
  it('does not mistake an installing or waiting worker for a working offline entry', async () => {
    const postMessage = vi.fn()
    setup({ waiting: { postMessage }, installing: { postMessage } })
    expect(await setOfflineV4NavigationEnabled(true)).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()
  })
  it('explains how to finish a pending web update without an installer', async () => {
    const postMessage = vi.fn()
    setup({ active: { postMessage }, waiting: { postMessage } })
    await expect(setOfflineV4NavigationEnabled(true)).rejects.toThrow('No necesitas instalar nada')
    expect(postMessage).not.toHaveBeenCalled()
  })
  it('contains a closed-message-channel failure without reporting successful preparation', async () => {
    setup({ active: { postMessage: () => { throw new DOMException('Closed port') } } })
    expect(await beginOfflineV4OnlineReauth()).toBe(false)
  })
})
