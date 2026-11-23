import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginAuthIdentityChange, completeAuthIdentityChange, getAuthScope } from '@/lib/authScope'
import { acquireProgramAvatarBlob, PROGRAM_AVATAR_CACHE_MAX_BYTES, PROGRAM_AVATAR_CACHE_MAX_ENTRIES, PROGRAM_AVATAR_CACHE_TTL_MS } from './programAvatarCache'

const mocks = vi.hoisted(() => ({ apiBlob: vi.fn() }))
vi.mock('@/lib/api', () => ({ apiBlob: mocks.apiBlob }))
const blob = new Blob(['avatar'], { type: 'image/jpeg' })
beforeEach(() => {
  completeAuthIdentityChange()
  mocks.apiBlob.mockReset().mockResolvedValue({ success: true, blob })
})
afterEach(() => { beginAuthIdentityChange(); vi.useRealTimers() })

describe('private program avatar byte cache', () => {
  it('deduplicates one pending revision while preserving another active subscriber', async () => {
    let finish!: (result: { success: boolean; blob: Blob }) => void
    mocks.apiBlob.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const first = acquireProgramAvatarBlob(getAuthScope(), 'p', 1)
    const second = acquireProgramAvatarBlob(getAuthScope(), 'p', 1)
    first.release()
    await Promise.resolve()
    expect(mocks.apiBlob).toHaveBeenCalledTimes(1)
    expect(mocks.apiBlob.mock.calls[0][1].signal.aborted).toBe(false)
    finish({ success: true, blob })
    expect(await second.promise).toEqual({ success: true, blob })
    second.release()
  })

  it('aborts an abandoned request and rejects a transport that completes late', async () => {
    let finish!: (result: { success: boolean; blob: Blob }) => void
    mocks.apiBlob.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const lease = acquireProgramAvatarBlob(getAuthScope(), 'p', 1)
    lease.release()
    await Promise.resolve()
    expect(mocks.apiBlob.mock.calls[0][1].signal.aborted).toBe(true)
    finish({ success: true, blob })
    expect(await lease.promise).toEqual({ success: false })
    acquireProgramAvatarBlob(getAuthScope(), 'p', 1)
    expect(mocks.apiBlob).toHaveBeenCalledTimes(2)
  })

  it('expires bytes after a bounded interval and never extends TTL on access', async () => {
    vi.useFakeTimers()
    const first = acquireProgramAvatarBlob(getAuthScope(), 'p', 1)
    await first.promise; first.release()
    await vi.advanceTimersByTimeAsync(PROGRAM_AVATAR_CACHE_TTL_MS - 1)
    const warm = acquireProgramAvatarBlob(getAuthScope(), 'p', 1)
    await warm.promise; warm.release()
    expect(mocks.apiBlob).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await acquireProgramAvatarBlob(getAuthScope(), 'p', 1).promise
    expect(mocks.apiBlob).toHaveBeenCalledTimes(2)
  })

  it('clears previous revisions and account leases without caching a late response', async () => {
    const oldScope = getAuthScope()
    await acquireProgramAvatarBlob(oldScope, 'p', 1).promise
    await acquireProgramAvatarBlob(oldScope, 'p', 2).promise
    await acquireProgramAvatarBlob(oldScope, 'p', 1).promise
    expect(mocks.apiBlob).toHaveBeenCalledTimes(3)
    beginAuthIdentityChange()
    expect(await acquireProgramAvatarBlob(oldScope, 'p', 1).promise).toEqual({ success: false })
    completeAuthIdentityChange()
    await acquireProgramAvatarBlob(getAuthScope(), 'p', 1).promise
    expect(mocks.apiBlob).toHaveBeenCalledTimes(4)
  })

  it('aborts a pending old-account download before it can fill the new account cache', async () => {
    let finish!: (result: { success: boolean; blob: Blob }) => void
    mocks.apiBlob.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const lease = acquireProgramAvatarBlob(getAuthScope(), 'same-id', 1)
    beginAuthIdentityChange()
    expect(mocks.apiBlob.mock.calls[0][1].signal.aborted).toBe(true)
    finish({ success: true, blob })
    expect(await lease.promise).toEqual({ success: false })
    completeAuthIdentityChange()
    expect(await acquireProgramAvatarBlob(getAuthScope(), 'same-id', 1).promise).toEqual({ success: true, blob })
    expect(mocks.apiBlob).toHaveBeenCalledTimes(2)
  })

  it('does not let an older mounted surface abort a newer revision download', async () => {
    let finishNew!: (result: { success: boolean; blob: Blob }) => void
    mocks.apiBlob.mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve }))
    const newer = acquireProgramAvatarBlob(getAuthScope(), 'p', 2)
    const older = acquireProgramAvatarBlob(getAuthScope(), 'p', 1)
    expect(mocks.apiBlob.mock.calls[0][1].signal.aborted).toBe(false)
    finishNew({ success: true, blob })
    expect(await newer.promise).toEqual({ success: true, blob })
    expect(await older.promise).toEqual({ success: true, blob })
    expect(await acquireProgramAvatarBlob(getAuthScope(), 'p', 2).promise).toEqual({ success: true, blob })
    expect(mocks.apiBlob).toHaveBeenCalledTimes(2)
    newer.release(); older.release()
  })

  it('bounds retained entries and bytes without revoking component-owned resources', async () => {
    for (let index = 0; index <= PROGRAM_AVATAR_CACHE_MAX_ENTRIES; index++) {
      const lease = acquireProgramAvatarBlob(getAuthScope(), `p-${index}`, 1)
      await lease.promise; lease.release()
    }
    await acquireProgramAvatarBlob(getAuthScope(), 'p-0', 1).promise
    expect(mocks.apiBlob).toHaveBeenCalledTimes(PROGRAM_AVATAR_CACHE_MAX_ENTRIES + 2)
    mocks.apiBlob.mockResolvedValue({ success: true, blob: new Blob([new Uint8Array(PROGRAM_AVATAR_CACHE_MAX_BYTES + 1)]) })
    await acquireProgramAvatarBlob(getAuthScope(), 'oversized', 1).promise
    await acquireProgramAvatarBlob(getAuthScope(), 'oversized', 1).promise
    expect(mocks.apiBlob).toHaveBeenCalledTimes(PROGRAM_AVATAR_CACHE_MAX_ENTRIES + 4)
  })
})
