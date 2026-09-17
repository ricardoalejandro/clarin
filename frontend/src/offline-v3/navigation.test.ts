import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isOfflinePathSupported, OfflineNavigationAdapter, safeOfflineDestination } from './navigation'

describe('offline navigation allowlist', () => {
  beforeEach(() => window.history.replaceState({}, '', '/'))

  it('supports only the normal finite offline routes', () => {
    expect(isOfflinePathSupported('/')).toBe(true)
    expect(isOfflinePathSupported('/login')).toBe(true)
    expect(isOfflinePathSupported('/dashboard/tasks')).toBe(true)
    expect(isOfflinePathSupported('/dashboard/conflicts')).toBe(true)
    expect(isOfflinePathSupported('/dashboard/programs/018f1234-1234-7123-8123-123456789abc')).toBe(true)
    expect(isOfflinePathSupported('/dashboard/admin')).toBe(false)
    expect(isOfflinePathSupported('/api/users')).toBe(false)
    expect(safeOfflineDestination('https://evil.example/dashboard')).toBeNull()
  })

  it('uses History API and never reloads the document', () => {
    const adapter = new OfflineNavigationAdapter()
    const listener = vi.fn()
    const pushState = vi.spyOn(window.history, 'pushState')
    adapter.subscribe(listener)

    expect(adapter.navigate('/dashboard/tasks?mine=1')).toBe(true)
    expect(window.location.pathname).toBe('/dashboard/tasks')
    expect(listener).toHaveBeenCalledWith({ pathname: '/dashboard/tasks', search: '?mine=1', hash: '' })
    expect(pushState).toHaveBeenCalledOnce()
  })
})
