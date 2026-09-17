import { afterEach, describe, expect, it, vi } from 'vitest'
import { offlineRequestV4, onlineGrantsV4, resourceCandidatesV4 } from './online'

afterEach(() => vi.restoreAllMocks())
const response = (body: unknown, status = 200, trusted = true) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(trusted ? { 'X-Clarin-Response': '1' } : {}) } })

describe('browser offline online control API', () => {
  it('uses only online cookies, no local credentials or bearer session marker', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ items: [] }))
    await onlineGrantsV4('exact-browser')
    expect(fetch).toHaveBeenCalledWith('/api/offline/v4/grants?browser_profile_id=exact-browser', expect.objectContaining({ credentials: 'include', cache: 'no-store', redirect: 'error' }))
    expect(fetch.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization')
  })
  it('rejects access-layer HTML and unmarked JSON even with status 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ items: [] }, 200, false))
    await expect(offlineRequestV4('/api/offline/v4/grants')).rejects.toMatchObject({ code: 'untrusted_response' })
  })
  it('keeps real auth denial separate from a network failure and explains selection conflict', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ error: 'unauthorized' }, 401))
    await expect(offlineRequestV4('/api/offline/v4/grants')).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    fetch.mockResolvedValue(response({ error: 'selection_conflict' }, 409))
    await expect(offlineRequestV4('/api/offline/v4/grants/id/selection', { method: 'PUT' })).rejects.toThrow(/otra pestaña/)
    fetch.mockResolvedValue(response({ error: 'offline_state_conflict' }, 409))
    await expect(offlineRequestV4('/api/admin/offline-v4/enrollment-requests/id/approve', { method: 'POST' })).rejects.toThrow(/estado de esta autorización/)
  })
  it('preserves cancellation and binds search pagination to one grant and module', async () => {
    const controller = new AbortController()
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ items: [], next_cursor: null }))
    await resourceCandidatesV4('grant-a', 'contacts', 'Ana & Juan', 'cursor-a', controller.signal)
    const path = new URL(String(fetch.mock.calls[0][0]), 'https://clarin.invalid')
    expect(path.pathname).toBe('/api/offline/v4/grants/grant-a/resources')
    expect(Object.fromEntries(path.searchParams)).toEqual({ module: 'contacts', q: 'Ana & Juan', after: 'cursor-a', limit: '50' })
    expect(fetch.mock.calls[0][1]?.signal).toBe(controller.signal)
    controller.abort()
    fetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'))
    await expect(offlineRequestV4('/api/offline/v4/grants', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
