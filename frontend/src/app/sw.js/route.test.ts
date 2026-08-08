import { describe, expect, it } from 'vitest'
import { GET } from './route'

describe('PWA service worker', () => {
  it('is non-cacheable and limits persistence to the public shell and static assets', async () => {
    const response = GET()
    const source = await response.text()

    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('service-worker-allowed')).toBe('/')
    expect(source).toContain("request.mode === 'navigate'")
    expect(source).toContain("url.pathname.startsWith('/_next/static/')")
    expect(source).toContain("url.pathname.startsWith('/icons/')")
    expect(source).toContain("cache.match('/offline')")
    expect(source).toContain('STATIC_FETCH_TIMEOUT_MS')
    expect(source).toContain("fetchWithTimeout(request, 'reload')")
    expect(source).toContain('if (!results.every(Boolean))')
    expect(source).toContain('const cached = await cache.match(request)')
    expect(source).not.toContain('const cached = await caches.match(request)')
    expect(source).not.toContain('self.skipWaiting()')
    expect(source).not.toContain('self.clients.claim()')
    expect(source).not.toContain("url.pathname.startsWith('/api/')")
  })
})
