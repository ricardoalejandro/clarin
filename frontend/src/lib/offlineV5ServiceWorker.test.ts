import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureOfflineV5ServiceWorkerRegistration,
  hasOfflineV5ServiceWorkerRegistration,
  retireOfflineV5ServiceWorkerAndCaches,
} from './offlineV5ServiceWorker'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('offline v5 service worker lifecycle', () => {
  it('does not register while only checking an ordinary profile', async () => {
    const register = vi.fn()
    const getRegistration = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration, register } })
    await expect(hasOfflineV5ServiceWorkerRegistration()).resolves.toBe(false)
    expect(getRegistration).toHaveBeenCalledWith('/')
    expect(register).not.toHaveBeenCalled()
  })

  it('registers the root worker only when preparation explicitly enables Offline', async () => {
    const registration = { active: {}, waiting: null, installing: null }
    const register = vi.fn().mockResolvedValue(registration)
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      getRegistration: vi.fn().mockResolvedValue(undefined),
      register,
    } })
    await expect(ensureOfflineV5ServiceWorkerRegistration()).resolves.toBe(registration)
    expect(register).toHaveBeenCalledOnce()
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' })
  })

  it('unregisters a revoked worker and removes only Clarin offline cache families', async () => {
    const unregister = vi.fn().mockResolvedValue(true)
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      getRegistration: vi.fn().mockResolvedValue({ unregister }),
    } })
    const remove = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue([
        'clarin-pwa-old',
        'clarin-offline-v5-meta-v1',
        'clarin-offline-v5-shell-old',
        'unrelated-application-cache',
      ]),
      delete: remove,
    })
    await retireOfflineV5ServiceWorkerAndCaches()
    expect(unregister).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledTimes(3)
    expect(remove).not.toHaveBeenCalledWith('unrelated-application-cache')
  })
})
