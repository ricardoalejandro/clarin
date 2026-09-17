// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const serviceWorkerMocks = vi.hoisted(() => ({
  clearAuthority: vi.fn(async () => 'controlling' as const),
  clearFallback: vi.fn(async () => 'controlling' as const),
}))

vi.mock('../lib/offlineV5ServiceWorker', () => ({
  clearOfflineV5FallbackOffer: serviceWorkerMocks.clearFallback,
  clearOfflineV5LocalAuthority: serviceWorkerMocks.clearAuthority,
  enableOfflineV5Shell: vi.fn(async () => 'controlling' as const),
  setOfflineV5ServiceWorkerMode: vi.fn(async () => 'controlling' as const),
}))

import { BrowserOfflineV5Client, markOfflineV5WorkerRecovery, offlineV5SharedWorkerName } from './client'
import type { OfflineV5SessionSnapshot } from './types'

class WorkerDouble {
  static instances: WorkerDouble[] = []
  port = { start: vi.fn(), close: vi.fn(), postMessage: vi.fn(), onmessage: null as ((event: { data: unknown }) => void) | null }
  onerror: (() => void) | null = null

  constructor(readonly url: string, readonly options: WorkerOptions) {
    WorkerDouble.instances.push(this)
  }

  state(buildID: string, state: OfflineV5SessionSnapshot) {
    this.port.onmessage?.({ data: { type: 'state', protocol: 5, schema: 1, build_id: buildID, state } })
  }
}

let clients: BrowserOfflineV5Client[] = []

beforeEach(() => {
  vi.clearAllMocks()
  WorkerDouble.instances = []
  clients = []
  window.sessionStorage.clear()
  vi.stubGlobal('SharedWorker', WorkerDouble)
  vi.stubGlobal('isSecureContext', true)
})

afterEach(() => {
  for (const client of clients) client.close()
  vi.unstubAllGlobals()
})

describe('Offline v5 SharedWorker release isolation', () => {
  it('uses the release in the worker name so an older tab cannot retain stale code', () => {
    expect(offlineV5SharedWorkerName('2026.09.15-2')).toBe('clarin-offline-v5-schema-1:2026.09.15-2')

    const client = new BrowserOfflineV5Client()
    clients.push(client)
    client.subscribe(() => undefined)

    const worker = WorkerDouble.instances[0]
    expect(worker.url).toBe('/offline-v5/worker.js')
    expect(worker.options).toEqual({
      name: offlineV5SharedWorkerName(process.env.NEXT_PUBLIC_BUILD_VERSION || 'dev'),
      type: 'module',
    })
  })

  it('closes a worker whose build does not match the page release', async () => {
    const reload = vi.fn()
    const client = new BrowserOfflineV5Client(reload)
    clients.push(client)
    const listener = vi.fn()
    client.subscribe(listener)

    const worker = WorkerDouble.instances[0]
    worker.state('stale-release', {
      generation: 1,
      active: false,
      mode: 'locked',
      authorizedModules: [],
      selectedRoots: {},
      capabilities: [],
      pendingCount: 0,
      conflictCount: 0,
    })

    expect(worker.port.close).toHaveBeenCalledOnce()
    expect(listener.mock.lastCall?.[0]).toMatchObject({ active: false, mode: 'locked' })
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
  })

  it('bounds automatic recovery to one reload for the same page and worker builds', () => {
    const storage = new Map<string, string>()
    const session = {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    }

    expect(markOfflineV5WorkerRecovery(session, 'page-a', 'worker-b')).toBe(true)
    expect(markOfflineV5WorkerRecovery(session, 'page-a', 'worker-b')).toBe(false)
    expect(markOfflineV5WorkerRecovery(session, 'page-a', 'worker-c')).toBe(true)
  })

  it('clears stale navigation authority even when the revoked grant was already absent locally', async () => {
    const client = new BrowserOfflineV5Client()
    clients.push(client)
    const request = vi.spyOn(client as unknown as {
      request: (method: string, args?: unknown[]) => Promise<unknown>
    }, 'request')
      .mockResolvedValueOnce({ removed: [] })
      .mockResolvedValueOnce(false)

    await expect(client.purgeLocalGrant('grant-already-absent')).resolves.toEqual({ removed: [] })

    expect(request).toHaveBeenNthCalledWith(1, 'purgeLocalGrant', ['grant-already-absent'])
    expect(request).toHaveBeenNthCalledWith(2, 'hasAnyPreparedCopy')
    expect(serviceWorkerMocks.clearAuthority).toHaveBeenCalledOnce()
    expect(serviceWorkerMocks.clearFallback).toHaveBeenCalledOnce()
  })
})
