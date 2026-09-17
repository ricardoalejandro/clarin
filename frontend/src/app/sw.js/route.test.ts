import { describe, expect, it, vi } from 'vitest'
import { GET } from './route'

describe('offline v5 canonical application service worker', () => {
  it('never caches API/private responses and preserves credentials for online navigation', async () => {
    const response = GET()
    const source = await response.text()

    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('service-worker-allowed')).toBe('/')
    expect(source).toContain("event.respondWith(protectOfflineV5API(request))")
    expect(source).toContain("fetch(request, { cache: 'no-cache', signal: controller.signal })")
    expect(source).not.toContain("fetch(request, { cache: 'no-cache', credentials: 'omit'")
    expect(source).not.toContain('cache.put(request, response)')
    expect(source).not.toContain('127.0.0.1:17373')
  })

  it('blocks every accidental account API network call while offline except signed sync and the expiring login latch', async () => {
    const source = await GET().text()
    const stores = new Map<string, Map<string, Response>>()
    const normalize = (key: string | Request) => new URL(typeof key === 'string' ? key : key.url, 'https://clarin.example').pathname
    const caches = {
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      open: async (name: string) => {
        if (!stores.has(name)) stores.set(name, new Map())
        const store = stores.get(name)!
        return {
          match: async (key: string | Request) => store.get(normalize(key))?.clone(),
          put: async (key: string | Request, value: Response) => { store.set(normalize(key), value.clone()) },
        }
      },
    }
    const network = vi.fn(async () => new Response('NETWORK'))
    const runtime = new Function(
      'self',
      'caches',
      'fetch',
      source + '\nreturn {protectOfflineV5API,writeMeta};',
    )({ location: { origin: 'https://clarin.example' }, addEventListener: vi.fn() }, caches, network)
    await runtime.writeMeta('v5', {
      enabled: true,
      mode: 'offline',
      online_transition: false,
      online_transition_expires_at: 0,
      fallback_offer: false,
      shell_generations: [],
      pwa_generations: [],
    })

    const blocked = await runtime.protectOfflineV5API(new Request('https://clarin.example/api/contacts'))
    expect(blocked.status).toBe(503)
    expect(await blocked.json()).toMatchObject({ error: 'offline_network_blocked', offline: true })
    expect(network).not.toHaveBeenCalled()

    await expect(runtime.protectOfflineV5API(new Request('https://clarin.example/api/offline/v5/sync/challenge', { method: 'POST' })))
      .resolves.toHaveProperty('status', 200)
    expect(network).toHaveBeenCalledTimes(1)
    await expect(runtime.protectOfflineV5API(new Request('https://clarin.example/api/offline/v5/grants/status', { method: 'POST' })))
      .resolves.toHaveProperty('status', 200)
    expect(network).toHaveBeenCalledTimes(2)

    await runtime.writeMeta('v5', {
      enabled: true,
      mode: 'offline',
      online_transition: true,
      online_transition_expires_at: Date.now() + 60_000,
      fallback_offer: false,
      shell_generations: [],
      pwa_generations: [],
    })
    await expect(runtime.protectOfflineV5API(new Request('https://clarin.example/api/auth/login', { method: 'POST' })))
      .resolves.toHaveProperty('status', 200)
    expect(network).toHaveBeenCalledTimes(3)

    await runtime.writeMeta('v5', {
      enabled: true,
      mode: 'offline',
      online_transition: true,
      online_transition_expires_at: Date.now() - 1,
      fallback_offer: false,
      shell_generations: [],
      pwa_generations: [],
    })
    expect((await runtime.protectOfflineV5API(new Request('https://clarin.example/api/auth/login', { method: 'POST' }))).status).toBe(503)
    expect(network).toHaveBeenCalledTimes(3)
  })

  it('publishes only a complete hash-verified v5 generation and retains two rollback generations', async () => {
    const source = await GET().text()

    expect(source).toContain("protocol: 5, manifest: '/offline-v5/manifest.json'")
    expect(source).toContain('manifest.protocol_version !== spec.protocol')
    expect(source).toContain('await sha256(bytes) !== asset.sha256')
    expect(source).toContain("validV5Path(url.pathname)")
    expect(source).toContain("!required.every(path => paths.has(path))")
    expect(source).toContain('64 * 1024 * 1024')
    expect(source).toContain('PRECACHE_CONCURRENCY = 6')
    expect(source).toContain("finalName + '-staging'")
    expect(source).toContain('publishing READY last')
    expect(source).toContain('.slice(0, 2)')
    expect(source).toContain("data.type.endsWith('_USE_PREVIOUS')")
    expect(source).toContain('if (await onlyLoginWindowsAreOpen()) await self.skipWaiting()')
    expect(source).not.toContain('self.clients.claim()')
  })

  it('activates a waiting update only when every open Clarin window is a login page', async () => {
    const source = await GET().text()
    const matchAll = vi.fn()
    const runtime = new Function(
      'self',
      source + '\nreturn {onlyLoginWindowsAreOpen};',
    )({
      addEventListener: vi.fn(),
      clients: { matchAll },
      location: { origin: 'https://clarin.example' },
    })

    matchAll.mockResolvedValueOnce([])
    await expect(runtime.onlyLoginWindowsAreOpen()).resolves.toBe(true)

    matchAll.mockResolvedValueOnce([
      { url: 'https://clarin.example/login' },
      { url: 'https://clarin.example/?reason=idle' },
    ])
    await expect(runtime.onlyLoginWindowsAreOpen()).resolves.toBe(true)

    matchAll.mockResolvedValueOnce([
      { url: 'https://clarin.example/login' },
      { url: 'https://clarin.example/dashboard/tasks' },
    ])
    await expect(runtime.onlyLoginWindowsAreOpen()).resolves.toBe(false)
    expect(matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true })
  })

  it('downloads the large canonical corpus only after explicit enablement', async () => {
    const source = await GET().text()

    expect(source).toContain('await cacheBaseShell();')
    expect(source).not.toContain('stageShell(\'v5\')]);')
    expect(source).toContain('async function setEnabled(kind, enabled)')
    expect(source).toContain('const generation = await ensureShell(kind)')
    expect(source.indexOf('await commitGeneration(kind, generation)')).toBeLessThan(source.indexOf('enabled, fallback_offer'))
    expect(source).toContain("error: 'offline_shell_unavailable'")
  })

  it('builds the unauthorised fallback locally and never caches a navigation response', async () => {
    const source = await GET().text()
    const stores = new Map<string, Map<string, Response>>()
    const normalize = (key: string | Request) => new URL(typeof key === 'string' ? key : key.url, 'https://clarin.example').pathname
    const caches = {
      open: async (name: string) => {
        if (!stores.has(name)) stores.set(name, new Map())
        const store = stores.get(name)!
        return {
          match: async (key: string | Request) => store.get(normalize(key))?.clone(),
          put: async (key: string | Request, value: Response) => { store.set(normalize(key), value.clone()) },
        }
      },
    }
    const privateSentinel = 'PRIVATE_NAVIGATION_RESPONSE_MUST_NOT_BE_CACHED'
    const network = vi.fn(async (_request: string | URL | Request) => new Response(privateSentinel, { status: 200 }))
    const runtime = new Function(
      'self',
      'caches',
      'fetch',
      source + '\nreturn {cacheBaseShell};',
    )({ location: { origin: 'https://clarin.example' }, addEventListener: vi.fn() }, caches, network)

    await runtime.cacheBaseShell()

    const cache = await caches.open('clarin-pwa-dev')
    const fallback = await cache.match('/offline')
    expect(fallback).toBeDefined()
    expect(await fallback!.text()).not.toContain(privateSentinel)
    expect(fallback!.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(network).toHaveBeenCalledTimes(5)
    expect(network.mock.calls.some(([request]) => new URL(String(request), 'https://clarin.example').pathname === '/offline')).toBe(false)
  })

  it('bounds streamed public artifacts without trusting Content-Length', async () => {
    const source = await GET().text()
    const runtime = new Function('self', source + '\nreturn {readBoundedBody};')({ addEventListener: vi.fn() })
    await expect(runtime.readBoundedBody(new Response('oversized'), 4, true, 'v5')).rejects.toThrow('budget rejected')
    await expect(runtime.readBoundedBody(new Response('short'), 10, true, 'v5')).rejects.toThrow('length rejected')
    expect(new TextDecoder().decode(await runtime.readBoundedBody(new Response('exact'), 5, true, 'v5'))).toBe('exact')
  })

  it('maps only the canonical supported Clarin routes, including selected resource details', async () => {
    const source = await GET().text()
    const runtime = new Function('self', source + '\nreturn {routeKey};')({ addEventListener: vi.fn() })
    const id = 'd9428888-122b-4d6f-9f57-f50758b42f11'

    expect(runtime.routeKey('/login')).toBe('login')
    expect(runtime.routeKey('/dashboard/tasks')).toBe('tasks')
    expect(runtime.routeKey('/dashboard/contacts')).toBe('contacts')
    expect(runtime.routeKey('/dashboard/programs/' + id)).toBe('program_detail')
    expect(runtime.routeKey('/dashboard/whiteboards/' + id)).toBe('whiteboard_detail')
    expect(runtime.routeKey('/dashboard/chats')).toBeUndefined()
    expect(runtime.routeKey('/dashboard/programs/not-a-uuid')).toBeUndefined()
  })

  it('keeps ordinary login network-first across F5 while dashboards remain in the selected offline mode', async () => {
    const source = await GET().text()
    const stores = new Map<string, Map<string, Response>>()
    const normalize = (key: string | Request) => new URL(typeof key === 'string' ? key : key.url, 'https://clarin.example').pathname
    const caches = {
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      open: async (name: string) => {
        if (!stores.has(name)) stores.set(name, new Map())
        const store = stores.get(name)!
        return {
          match: async (key: string | Request) => store.get(normalize(key))?.clone(),
          put: async (key: string | Request, value: Response) => { store.set(normalize(key), value.clone()) },
        }
      },
    }
    const network = vi.fn()
      .mockResolvedValueOnce(new Response('ONLINE LOGIN'))
      .mockResolvedValueOnce(new Response('ONLINE LOGIN RSC'))
      .mockResolvedValueOnce(new Response('ONLINE LEGACY LOGIN'))
    const runtime = new Function(
      'self',
      'caches',
      'fetch',
      source + '\nreturn {clearLocalAuthority,networkFirstFlight,networkFirstNavigation,writeMeta};',
    )({ location: { origin: 'https://clarin.example' }, addEventListener: vi.fn() }, caches, network)

    const v5 = await caches.open('verified-v5')
    await v5.put('/offline-v5/.ready.json', new Response('{}'))
    await v5.put('/offline-v5/routes/login.html', new Response('OFFLINE LOGIN'))
    await v5.put('/offline-v5/routes/login.rsc', new Response('OFFLINE LOGIN RSC'))
    await v5.put('/offline-v5/routes/tasks.html', new Response('OFFLINE TASKS'))
    await runtime.writeMeta('v5', {
      enabled: true,
      mode: 'offline',
      online_transition: false,
      online_transition_expires_at: 0,
      fallback_offer: false,
      shell_generations: ['verified-v5'],
      pwa_generations: [],
    })
    const v4 = await caches.open('verified-v4')
    await v4.put('/offline-v4/.ready.json', new Response('{}'))
    await v4.put('/offline-v4/index.html', new Response('OFFLINE LEGACY LOGIN'))
    await runtime.writeMeta('v4', {
      enabled: true,
      mode: 'offline',
      online_transition: false,
      online_transition_expires_at: 0,
      fallback_offer: false,
      shell_generations: ['verified-v4'],
      pwa_generations: [],
    })

    expect(await (await runtime.networkFirstNavigation(new Request('https://clarin.example/login'))).text()).toBe('ONLINE LOGIN')
    expect(await (await runtime.networkFirstFlight(new Request('https://clarin.example/login?_rsc=f5', { headers: { RSC: '1' } }))).text()).toBe('ONLINE LOGIN RSC')
    expect(await (await runtime.networkFirstNavigation(new Request('https://clarin.example/dashboard/tasks'))).text()).toBe('OFFLINE TASKS')

    // A revoked v5 copy can leave a legacy v4 navigation latch behind. It
    // must not make an ordinary login alternate between F5 and Ctrl+F5.
    await runtime.clearLocalAuthority('v5')
    expect(await (await runtime.networkFirstNavigation(new Request('https://clarin.example/login'))).text()).toBe('ONLINE LEGACY LOGIN')
    expect(await (await runtime.networkFirstNavigation(new Request('https://clarin.example/dashboard/tasks'))).text()).toBe('OFFLINE LEGACY LOGIN')
    expect(network).toHaveBeenCalledTimes(3)
  })

  it('offers cached offline only for infrastructure failure and never bypasses a trusted auth denial', async () => {
    const source = await GET().text()
    const stores = new Map<string, Map<string, Response>>()
    const normalize = (key: string | Request) => {
      const raw = typeof key === 'string' ? key : key.url
      const url = new URL(raw, 'https://clarin.example')
      return url.pathname + url.search
    }
    const caches = {
      open: async (name: string) => {
        if (!stores.has(name)) stores.set(name, new Map())
        const store = stores.get(name)!
        return {
          match: async (key: string | Request) => store.get(normalize(key))?.clone(),
          put: async (key: string | Request, value: Response) => { store.set(normalize(key), value.clone()) },
        }
      },
    }
    const network = vi.fn()
    const scope = { location: { origin: 'https://clarin.example' }, addEventListener: vi.fn() }
    const runtime = new Function(
      'self',
      'caches',
      'fetch',
      source + '\nreturn {readMeta,writeMeta,networkFirstNavigation,isInfrastructureFailure};',
    )(scope, caches, network)
    const generation = await caches.open('verified-v5')
    await generation.put('/offline-v5/.ready.json', new Response('{}'))
    await generation.put('/offline-v5/routes/tasks.html', new Response('CANONICAL TASKS'))
    await runtime.writeMeta('v5', {
      enabled: true,
      mode: 'online',
      online_transition: false,
      fallback_offer: false,
      shell_generations: ['verified-v5'],
      pwa_generations: [],
    })

    network.mockResolvedValueOnce(new Response('DENIED', { status: 403, headers: { 'X-Clarin-Response': '1' } }))
    expect(await (await runtime.networkFirstNavigation(new Request('https://clarin.example/dashboard/tasks'))).text()).toBe('DENIED')
    expect((await runtime.readMeta('v5')).fallback_offer).toBe(false)

    network.mockResolvedValueOnce(new Response('CLOUDFLARE', { status: 403 }))
    const fallback = await runtime.networkFirstNavigation(new Request('https://clarin.example/dashboard/tasks'))
    expect(await fallback.text()).toBe('CANONICAL TASKS')
    expect(fallback.headers.get('x-clarin-offline-route')).toBe('tasks')
    expect((await runtime.readMeta('v5')).fallback_offer).toBe(true)
    expect(runtime.isInfrastructureFailure(new Response('', { status: 401, headers: { 'X-Clarin-Response': '1' } }))).toBe(false)
  })

  it('expires and atomically consumes the v5 online reauthentication latch', async () => {
    const source = await GET().text()
    const stores = new Map<string, Map<string, Response>>()
    const normalize = (key: string | Request) => new URL(typeof key === 'string' ? key : key.url, 'https://clarin.example').pathname
    const caches = {
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      open: async (name: string) => {
        if (!stores.has(name)) stores.set(name, new Map())
        const store = stores.get(name)!
        return {
          match: async (key: string | Request) => store.get(normalize(key))?.clone(),
          put: async (key: string | Request, value: Response) => { store.set(normalize(key), value.clone()) },
        }
      },
    }
    const runtime = new Function(
      'self',
      'caches',
      'fetch',
      source + '\nreturn {beginOnlineTransition,clearLocalAuthority,readMeta,setMode,writeMeta,transitionOpen};',
    )({ location: { origin: 'https://clarin.example' }, addEventListener: vi.fn() }, caches, vi.fn())
    await runtime.writeMeta('v5', {
      enabled: true,
      mode: 'offline',
      online_transition: false,
      online_transition_expires_at: 0,
      fallback_offer: false,
      shell_generations: [],
      pwa_generations: [],
    })
    await runtime.beginOnlineTransition('v5')
    expect(runtime.transitionOpen(await runtime.readMeta('v5'), 'v5')).toBe(true)
    await runtime.setMode('v5', 'online')
    expect(await runtime.readMeta('v5')).toMatchObject({ mode: 'online', online_transition: false, online_transition_expires_at: 0 })

    await runtime.writeMeta('v5', {
      enabled: true,
      mode: 'offline',
      online_transition: true,
      online_transition_expires_at: Date.now() - 1,
      fallback_offer: false,
      shell_generations: [],
      pwa_generations: [],
    })
    expect(runtime.transitionOpen(await runtime.readMeta('v5'), 'v5')).toBe(false)
    await expect(runtime.setMode('v5', 'online')).rejects.toThrow('explicit reauthentication required')
    await runtime.clearLocalAuthority('v5')
    expect(await runtime.readMeta('v5')).toMatchObject({ enabled: false, mode: 'online', online_transition: false, fallback_offer: false, shell_generations: [] })
  })
})
