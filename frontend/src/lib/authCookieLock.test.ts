import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_COOKIE_LOCK_NAME, AuthCookieLockUnavailableError, fetchAuthCookie } from './authCookieLock'

const sharedIdentity = vi.hoisted(() => ({ scope: 'active:a' }))
vi.mock('@/lib/authScope', () => ({ getAuthScope: () => sharedIdentity.scope }))

function queuedOriginLocks() {
  type Job = {
    name: string
    signal?: AbortSignal
    callback: (lock: Lock) => unknown
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
    abort: () => void
    granted: boolean
  }
  const queue: Job[] = []
  let held = false
  const pump = () => {
    if (held) return
    const job = queue.shift()
    if (!job) return
    job.granted = true
    job.signal?.removeEventListener('abort', job.abort)
    held = true
    Promise.resolve().then(() => job.callback({ name: job.name, mode: 'exclusive' } as Lock))
      .then(job.resolve, job.reject).finally(() => { held = false; pump() })
  }
  return {
    request: vi.fn((name: string, options: LockOptions, callback: (lock: Lock) => unknown) => new Promise((resolve, reject) => {
      const job: Job = {
        name, signal: options.signal, callback, resolve, reject, granted: false,
        abort: () => {
          if (job.granted) return
          const index = queue.indexOf(job)
          if (index !== -1) queue.splice(index, 1)
          reject(new DOMException('Cancelled lock request', 'AbortError'))
        },
      }
      if (job.signal?.aborted) { job.abort(); return }
      job.signal?.addEventListener('abort', job.abort, { once: true })
      queue.push(job)
      pump()
    })),
  }
}

beforeEach(() => {
  sharedIdentity.scope = 'active:a'
  vi.stubGlobal('navigator', { locks: queuedOriginLocks() })
})
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

describe('authentication cookie lock across tab callers', () => {
  it('waits for refresh A before switching B, so the late A cookie cannot overwrite B', async () => {
    const tabA = await import('./authCookieLock')
    vi.resetModules()
    const tabB = await import('./authCookieLock')
    let release!: () => void
    let cookie = 'a'
    const fetchMock = vi.fn((url: string) => url.endsWith('refresh')
      ? new Promise<Response>(resolve => { release = () => { cookie = 'a'; resolve(new Response('{}')) } })
      : Promise.resolve().then(() => { cookie = 'b'; return new Response('{}') }))
    vi.stubGlobal('fetch', fetchMock)
    const refresh = tabA.fetchAuthCookie('/api/auth/refresh', { method: 'POST', credentials: 'include' }, sharedIdentity.scope)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    sharedIdentity.scope = 'changing:b'
    const switched = tabB.fetchAuthCookie('/api/auth/switch-account', { method: 'POST', credentials: 'include' }, sharedIdentity.scope)
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/auth/refresh'])
    release()
    await Promise.all([refresh, switched])
    expect(cookie).toBe('b')
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['/api/auth/refresh', '/api/auth/switch-account'])
    expect(navigator.locks.request).toHaveBeenCalledWith(AUTH_COOKIE_LOCK_NAME, { mode: 'exclusive' }, expect.any(Function))
  })

  it('rejects a superseded identity while queued before sending any cookie mutation', async () => {
    let release!: () => void
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { release = () => resolve(new Response('{}')) }))
    vi.stubGlobal('fetch', fetchMock)
    const held = fetchAuthCookie('/api/auth/refresh', {}, sharedIdentity.scope)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    sharedIdentity.scope = 'changing:b'
    const waiting = fetchAuthCookie('/api/auth/login', {}, sharedIdentity.scope)
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    sharedIdentity.scope = 'active:c'
    release()
    await held
    await rejected
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('aborts a queued request without waiting for the current cookie operation to finish', async () => {
    let release!: () => void
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { release = () => resolve(new Response('{}')) }))
    vi.stubGlobal('fetch', fetchMock)
    const held = fetchAuthCookie('/api/auth/refresh', {}, sharedIdentity.scope)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const controller = new AbortController()
    const waiting = fetchAuthCookie('/api/auth/logout', { signal: controller.signal }, sharedIdentity.scope)
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(fetchMock).toHaveBeenCalledOnce()
    release()
    await held
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('fails recoverably without a lock manager and never falls back to an unsafe fetch', async () => {
    vi.stubGlobal('navigator', {})
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchAuthCookie('/api/auth/login', {}, sharedIdentity.scope)).rejects.toBeInstanceOf(AuthCookieLockUnavailableError)
    await expect(fetchAuthCookie('/api/auth/login', {}, sharedIdentity.scope)).rejects.toMatchObject({ code: 'auth_cookie_lock_unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
