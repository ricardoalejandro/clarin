import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RootServiceWorkerRuntime, { shouldRetireRootOfflineWorker } from './RootServiceWorkerRuntime'

const workerMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  retire: vi.fn(),
}))

vi.mock('@/lib/offlineV5ServiceWorker', () => ({
  getOfflineV5ServiceWorkerStatus: workerMocks.getStatus,
  retireOfflineV5ServiceWorkerAndCaches: workerMocks.retire,
}))

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('root browser-only service worker isolation', () => {
  it('does not register or start an offline worker for an ordinary browser profile', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' })
    const getRegistration = vi.fn().mockResolvedValue(undefined)
    const register = vi.fn()
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration, register } })
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    render(<RootServiceWorkerRuntime />)
    await waitFor(() => expect(getRegistration).toHaveBeenCalledWith('/'))
    expect(register).not.toHaveBeenCalled()
    expect(workerMocks.getStatus).not.toHaveBeenCalled()
    expect(workerMocks.retire).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('retires only a previously installed worker whose offline authority is disabled', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' })
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
      getRegistration: vi.fn().mockResolvedValue({ scope: '/' }),
      register: vi.fn(),
    } })
    workerMocks.getStatus.mockResolvedValue({ enabled: false, mode: 'online' })
    render(<RootServiceWorkerRuntime />)
    await waitFor(() => expect(workerMocks.retire).toHaveBeenCalledOnce())
  })

  it('keeps an authorized prepared worker and rejects ambiguous status', () => {
    expect(shouldRetireRootOfflineWorker({ enabled: true, mode: 'online' })).toBe(false)
    expect(shouldRetireRootOfflineWorker({ enabled: true, mode: 'offline' })).toBe(false)
    expect(shouldRetireRootOfflineWorker(undefined)).toBe(false)
    expect(shouldRetireRootOfflineWorker({ enabled: false, mode: 'online' })).toBe(true)
  })
})
