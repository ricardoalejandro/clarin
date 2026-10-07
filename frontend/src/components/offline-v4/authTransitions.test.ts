import { beforeEach, describe, expect, it, vi } from 'vitest'
const invalidation = vi.hoisted(() => ({
  v4: vi.fn().mockResolvedValue(undefined),
  v5: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/offline-v4/client', () => ({ invalidateActiveOfflineSession: invalidation.v4 }))
vi.mock('@/offline-v5/client', () => ({ invalidateActiveOfflineV5Session: invalidation.v5 }))
vi.mock('@/lib/authCookieLock', () => ({ fetchAuthCookie: (url: string, init: RequestInit) => fetch(url, init) }))
import { clearAuthState, invalidateOfflineBeforeIdentityChange, logoutFromBrowser, tryRefreshTokenOutcome } from '@/lib/api'
import { completeAuthIdentityChange, getAuthScope, isAuthIdentityChanging } from '@/lib/authScope'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  invalidation.v4.mockResolvedValue(undefined)
  invalidation.v5.mockResolvedValue(undefined)
})

describe('online identity change offline barrier', () => {
  it('rejects a superseded barrier without sending an old logout or replacing the newer account', async () => {
    localStorage.setItem('token', 'cookie-session')
    let release!: () => void
    invalidation.v5.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const fetch = vi.spyOn(globalThis, 'fetch')
    const pending = logoutFromBrowser('manual', { redirect: false })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(invalidation.v5).toHaveBeenCalledOnce())
    const newer = completeAuthIdentityChange()
    release()
    await rejected
    expect(fetch).not.toHaveBeenCalled()
    expect(getAuthScope()).toBe(newer)
    expect(localStorage.getItem('token')).toBe('cookie-session')
    fetch.mockRestore()
  })

  it('waits for an existing refresh cookie before sending logout', async () => {
    localStorage.setItem('token', 'cookie-session')
    let release!: (response: Response) => void
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      .mockResolvedValueOnce(new Response('{}'))
    const refresh = tryRefreshTokenOutcome()
    const pending = logoutFromBrowser('manual', { redirect: false })
    await vi.waitFor(() => expect(invalidation.v5).toHaveBeenCalledOnce())
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/auth/refresh'])
    release(new Response('{"success":true}'))
    await refresh
    await pending
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/auth/refresh', '/api/auth/logout'])
    expect(localStorage.getItem('token')).toBeNull()
    fetch.mockRestore()
  })

  it('refuses to mutate the cookie when the new identity generation cannot reach other tabs', async () => {
    localStorage.setItem('token', 'cookie-session')
    getAuthScope()
    const setItem = Storage.prototype.setItem
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key, value) {
      if (key === 'clarin:auth_scope') throw new DOMException('Quota', 'QuotaExceededError')
      return setItem.call(this, key, value)
    })
    const fetch = vi.spyOn(globalThis, 'fetch')
    try {
      await expect(logoutFromBrowser('manual', { redirect: false })).rejects.toThrow('coordinar el cambio de sesión')
      expect(fetch).not.toHaveBeenCalled()
      expect(localStorage.getItem('token')).toBe('cookie-session')
    } finally {
      storage.mockRestore()
      fetch.mockRestore()
      completeAuthIdentityChange()
    }
  })

  it('waits for the offline invalidation barrier before sending logout and clearing online state', async () => {
    let release!: () => void
    invalidation.v5.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    localStorage.setItem('token', 'cookie-session')
    const pending = logoutFromBrowser('manual', { redirect: false })
    await vi.waitFor(() => {
      expect(invalidation.v4).toHaveBeenCalledOnce()
      expect(invalidation.v5).toHaveBeenCalledOnce()
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(localStorage.getItem('token')).toBe('cookie-session')
    release()
    await pending
    expect(fetch).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ credentials: 'include' }))
    expect(localStorage.getItem('token')).toBeNull()
    fetch.mockRestore()
  })
  it('notifies the worker when an online session expires without retaining online credentials', async () => {
    localStorage.setItem('token', 'cookie-session')
    clearAuthState()
    expect(localStorage.getItem('token')).toBeNull()
    await vi.waitFor(() => {
      expect(invalidation.v4).toHaveBeenCalledOnce()
      expect(invalidation.v5).toHaveBeenCalledOnce()
    })
  })
  it('does not silently accept an unsuccessful identity barrier', async () => {
    invalidation.v5.mockRejectedValueOnce(new Error('Cannot safely invalidate'))
    await expect(invalidateOfflineBeforeIdentityChange()).rejects.toThrow('Cannot safely invalidate')
  })
  it('restores a valid online identity when logout is refused before cookie mutation', async () => {
    localStorage.setItem('token', 'cookie-session')
    const previous = getAuthScope()
    invalidation.v5.mockRejectedValueOnce(new Error('Cannot safely invalidate'))
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(logoutFromBrowser()).rejects.toThrow('Cannot safely invalidate')
    expect(localStorage.getItem('token')).toBe('cookie-session')
    expect(isAuthIdentityChanging()).toBe(false)
    expect(getAuthScope()).not.toBe(previous)
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockRestore()
  })
})
