import { beforeEach, describe, expect, it, vi } from 'vitest'
const invalidation = vi.hoisted(() => ({
  v4: vi.fn().mockResolvedValue(undefined),
  v5: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/offline-v4/client', () => ({ invalidateActiveOfflineSession: invalidation.v4 }))
vi.mock('@/offline-v5/client', () => ({ invalidateActiveOfflineV5Session: invalidation.v5 }))
import { clearAuthState, invalidateOfflineBeforeIdentityChange, logoutFromBrowser } from '@/lib/api'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  invalidation.v4.mockResolvedValue(undefined)
  invalidation.v5.mockResolvedValue(undefined)
})

describe('online identity change offline barrier', () => {
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
})
