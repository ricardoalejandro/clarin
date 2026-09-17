import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginOfflineV3OnlineReauth,
  OFFLINE_V3_MODE_MESSAGE,
  OFFLINE_V3_ONLINE_REAUTH_MESSAGE,
  setOfflineV3Mode,
} from '@/lib/offlineV3ServiceWorker'

class TestMessageChannel {
  port1 = { onmessage: null as null | ((event: MessageEvent) => void), close: vi.fn() }
  port2 = {}
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('offline v3 persistent mode commands', () => {
  it('sends only public mode state and waits for service-worker acknowledgement', async () => {
    let channel: TestMessageChannel | undefined
    vi.stubGlobal('MessageChannel', class extends TestMessageChannel {
      constructor() {
        super()
        channel = this
      }
    })
    const postMessage = vi.fn((payload: unknown) => {
      expect(payload).toEqual({ type: OFFLINE_V3_MODE_MESSAGE, mode: 'offline' })
      queueMicrotask(() => channel?.port1.onmessage?.({ data: { ok: true } } as MessageEvent))
    })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: vi.fn().mockResolvedValue({ active: { postMessage } }) },
    })

    await expect(setOfflineV3Mode('offline')).resolves.toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('uses an explicit transition command before the authenticated online login', async () => {
    let channel: TestMessageChannel | undefined
    vi.stubGlobal('MessageChannel', class extends TestMessageChannel {
      constructor() {
        super()
        channel = this
      }
    })
    const postMessage = vi.fn((payload: unknown) => {
      expect(payload).toEqual({ type: OFFLINE_V3_ONLINE_REAUTH_MESSAGE })
      queueMicrotask(() => channel?.port1.onmessage?.({ data: { ok: true } } as MessageEvent))
    })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: vi.fn().mockResolvedValue({ active: { postMessage } }) },
    })

    await expect(beginOfflineV3OnlineReauth()).resolves.toBe(true)
  })
})
