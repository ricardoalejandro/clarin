import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apiPost,
  clearIdleTimeout,
  getLoginNoticeForLogoutReason,
  getLoginRedirectForLogout,
  markAuthSessionDetected,
  markAuthTokenRefreshed,
  tryRefreshToken,
  tryRefreshTokenOutcome,
} from './api'

const AUTH_REFRESHED_KEY = 'clarin:auth_refreshed_at'
const LAST_ACTIVITY_KEY = 'clarin:last_activity_at'

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(Date, 'now').mockReturnValue(1_750_000_000_000)
})

afterEach(() => {
  clearIdleTimeout()
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('logout navigation', () => {
  it('explains inactivity and expiry on the login route', () => {
    expect(getLoginRedirectForLogout('idle')).toBe('/login?reason=idle')
    expect(getLoginRedirectForLogout('expired')).toBe('/login?reason=expired')
    expect(getLoginRedirectForLogout('manual')).toBe('/login')
  })

  it('renders an explicit notice only for automatic session expiry', () => {
    expect(getLoginNoticeForLogoutReason('idle')).toContain('30 minutos sin actividad')
    expect(getLoginNoticeForLogoutReason('expired')).toBe('Tu sesión expiró. Inicia sesión nuevamente para continuar.')
    expect(getLoginNoticeForLogoutReason('manual')).toBe('')
    expect(getLoginNoticeForLogoutReason('unexpected')).toBe('')
    expect(getLoginNoticeForLogoutReason(null)).toBe('')
  })
})

describe('auth session evidence', () => {
  it('records a detected cookie session without pretending the access token was refreshed', () => {
    localStorage.setItem(AUTH_REFRESHED_KEY, '1749999999000')

    markAuthSessionDetected()

    expect(localStorage.getItem('token')).toBe('cookie-session')
    expect(localStorage.getItem(LAST_ACTIVITY_KEY)).toBe('1750000000000')
    expect(localStorage.getItem(AUTH_REFRESHED_KEY)).toBe('1749999999000')
  })

  it('does not create a refresh timestamp when only the cookie session was detected', () => {
    markAuthSessionDetected()

    expect(localStorage.getItem(AUTH_REFRESHED_KEY)).toBeNull()
  })

  it('records a refresh timestamp only when a token was actually issued', () => {
    markAuthTokenRefreshed()

    expect(localStorage.getItem('token')).toBe('cookie-session')
    expect(localStorage.getItem(LAST_ACTIVITY_KEY)).toBe('1750000000000')
    expect(localStorage.getItem(AUTH_REFRESHED_KEY)).toBe('1750000000000')
  })

  it('marks a successful refresh response as a real token refresh', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))

    await expect(tryRefreshToken()).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    })
    expect(localStorage.getItem(AUTH_REFRESHED_KEY)).toBe('1750000000000')
  })

  it('clears stale auth markers when refresh is rejected', async () => {
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem(AUTH_REFRESHED_KEY, '1749999999000')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ success: false }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ))

    await expect(tryRefreshToken()).resolves.toBe(false)

    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem(AUTH_REFRESHED_KEY)).toBeNull()
  })

  it.each([
    ['a 503 response', () => Promise.resolve(new Response(
      JSON.stringify({ success: false, code: 'authorization_unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    ))],
    ['a network failure', () => Promise.reject(new TypeError('network unavailable'))],
  ] as const)('preserves auth markers when refresh has %s', async (_label, refreshResult) => {
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem(AUTH_REFRESHED_KEY, '1749999999000')
    localStorage.setItem(LAST_ACTIVITY_KEY, '1750000000000')
    vi.spyOn(globalThis, 'fetch').mockImplementation(refreshResult)

    await expect(tryRefreshTokenOutcome()).resolves.toBe('unavailable')

    expect(localStorage.getItem('token')).toBe('cookie-session')
    expect(localStorage.getItem(AUTH_REFRESHED_KEY)).toBe('1749999999000')
    expect(localStorage.getItem(LAST_ACTIVITY_KEY)).toBe('1750000000000')
  })

  it('returns a recoverable 503 instead of logging out when proactive refresh is unavailable', async () => {
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem(AUTH_REFRESHED_KEY, '1749998700000')
    localStorage.setItem(LAST_ACTIVITY_KEY, '1750000000000')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ success: false, code: 'authorization_unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    ))

    await expect(apiPost('/api/whiteboards/board-1/collab-ticket', {})).resolves.toEqual({
      success: false,
      error: 'No se pudo verificar la sesión temporalmente',
      status: 503,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/refresh')
    expect(localStorage.getItem('token')).toBe('cookie-session')
    expect(localStorage.getItem(AUTH_REFRESHED_KEY)).toBe('1749998700000')
  })

  it('recovers on the next API attempt after a temporary refresh failure', async () => {
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem(AUTH_REFRESHED_KEY, '1749998700000')
    localStorage.setItem(LAST_ACTIVITY_KEY, '1750000000000')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ success: false, code: 'authorization_unavailable' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ success: true, ticket: 'ticket-after-recovery' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ))

    await expect(apiPost('/api/whiteboards/board-1/collab-ticket', {})).resolves.toMatchObject({
      success: false,
      status: 503,
    })
    await expect(apiPost<{ ticket: string }>('/api/whiteboards/board-1/collab-ticket', {})).resolves.toMatchObject({
      success: true,
      data: { success: true, ticket: 'ticket-after-recovery' },
      status: 201,
    })

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/api/auth/refresh',
      '/api/auth/refresh',
      '/api/whiteboards/board-1/collab-ticket',
    ])
    expect(localStorage.getItem(AUTH_REFRESHED_KEY)).toBe('1750000000000')
  })

  it('does not log out from the heartbeat when refresh is temporarily unavailable', async () => {
    vi.useFakeTimers()
    localStorage.setItem('token', 'cookie-session')
    localStorage.setItem(AUTH_REFRESHED_KEY, '1749998700000')
    localStorage.setItem(LAST_ACTIVITY_KEY, '1750000000000')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ success: false, code: 'authorization_unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    ))

    const { initIdleTimeout } = await import('./api')
    initIdleTimeout()
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/refresh')
    expect(fetchMock.mock.calls.some(call => call[0] === '/api/auth/logout')).toBe(false)
    expect(localStorage.getItem('token')).toBe('cookie-session')
    expect(localStorage.getItem(AUTH_REFRESHED_KEY)).toBe('1749998700000')
  })
})
