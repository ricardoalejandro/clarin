// @vitest-environment node
import { NextRequest } from 'next/server'
// Next 16.3.5 still exports the matcher helper under its legacy name.
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const APP_HOST = 'clarin.naperu.cloud'
const MARKETING_HOST = 'landing.clarin.naperu.cloud'

function request(path: string, host = APP_HOST, cookie = '', method = 'GET') {
  return new NextRequest(`https://${host}${path}`, { method, headers: { host, cookie } })
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', `https://${APP_HOST}`)
  vi.resetModules()
})

afterEach(() => vi.unstubAllEnvs())

describe('Next proxy host boundary and session navigation', () => {
  it.each(['/api/offline/v3/grants', '/ws', '/mcp', '/mcp/sse', '/oauth/token', '/.well-known/oauth-authorization-server', '/health'])('keeps %s unavailable on the marketing host, including POST and cookies', async path => {
    const { proxy } = await import('./proxy')
    for (const method of ['GET', 'POST']) {
      const response = proxy(request(path, MARKETING_HOST, 'auth-token=synthetic-cookie', method))
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('Not found')
      expect(response.headers.get('location')).toBeNull()
    }
  })

  it('normalizes host case and port without trusting a forwarded host to bypass the marketing boundary', async () => {
    const { proxy } = await import('./proxy')
    const input = request('/api/offline/v3/grants', `${MARKETING_HOST.toUpperCase()}:443`)
    input.headers.set('x-forwarded-host', APP_HOST)
    expect(proxy(input).status).toBe(404)
  })

  it.each(['/login?next=%2Fdashboard%2Ftasks', '/dashboard/tasks?view=board', '/dashboard/whiteboards/test-board'])('redirects marketing navigation %s to the exact app origin and path', async path => {
    const { proxy } = await import('./proxy')
    const response = proxy(request(path, MARKETING_HOST))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(`https://${APP_HOST}${path}`)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it.each([APP_HOST, MARKETING_HOST])('keeps signup disabled for %s', async host => {
    const { proxy } = await import('./proxy')
    expect(proxy(request('/signup?next=https%3A%2F%2Fexample.invalid', host)).headers.get('location')).toBe(`https://${APP_HOST}/login`)
  })

  it.each(['', 'auth-token=; refresh-token='])('redirects a dashboard without a nonempty session cookie', async cookie => {
    const { proxy } = await import('./proxy')
    const response = proxy(request('/dashboard/tasks', APP_HOST, cookie))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(`https://${APP_HOST}/login`)
  })

  it.each(['auth-token=synthetic-cookie', 'refresh-token=synthetic-refresh'])('preserves existing client validation for cookie presence without granting or rewriting identity', async cookie => {
    const { proxy } = await import('./proxy')
    const input = request('/dashboard/tasks', APP_HOST, cookie)
    const response = proxy(input)
    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('authorization')).toBeNull()
    expect(input.headers.get('cookie')).toBe(cookie)
  })

  it.each(['/', '/login', '/api/auth/login', '/mcp', '/oauth/authorize', '/.well-known/oauth-protected-resource', '/health'])('leaves %s on the app host to its authoritative route handler', async path => {
    const { proxy } = await import('./proxy')
    const response = proxy(request(path))
    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('keeps dynamic protected routes covered while public offline/runtime assets remain outside proxy', async () => {
    const { config } = await import('./proxy')
    const matches = (url: string) => unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })
    for (const path of ['/dashboard/whiteboards/board-id', '/dashboard/tasks', '/api/offline/v3/grants', '/mcp/sse', '/oauth/token', '/.well-known/oauth-authorization-server', '/health']) {
      expect(matches(path), path).toBe(true)
    }
    for (const path of ['/offline-v3/index.html', '/offline-v3/assets/runtime.js', '/sw.js', '/_next/static/chunks/app.js', '/shared/whiteboards/share-id']) {
      expect(matches(path), path).toBe(false)
    }
  })
})
