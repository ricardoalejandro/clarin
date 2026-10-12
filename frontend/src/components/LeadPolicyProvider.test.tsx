import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginAuthIdentityChange, completeAuthIdentityChange } from '@/lib/authScope'
import { useAccountLeadPolicy } from './LeadPolicyProvider'

const websocket = vi.hoisted(() => ({ listeners: new Set<(value: unknown) => void>() }))
vi.mock('@/lib/api', () => ({ subscribeWebSocket: (callback: (value: unknown) => void) => { websocket.listeners.add(callback); return () => websocket.listeners.delete(callback) } }))
const policy = (account = 'a', version = 1, enabled = true, automation = true) => ({ account_id: account, leads_enabled: enabled, lead_automation_enabled: automation, leads_policy_version: version })
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function deferred() { let resolve!: (value: Response) => void; const promise = new Promise<Response>(next => { resolve = next }); return { promise, resolve } }

beforeEach(() => { completeAuthIdentityChange() })
afterEach(() => { cleanup(); websocket.listeners.clear(); vi.unstubAllGlobals() })

describe('account Lead policy scope and reconciliation', () => {
  it.each([[true, true, true], [true, false, false], [false, true, false], [false, false, false]])('resolves module %s and automation %s', async (enabled, automation, effective) => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ success: true, policy: policy('a', 1, enabled, automation) })))
    const { result } = renderHook(() => useAccountLeadPolicy('a'))
    expect(result.current.leadsEnabled).toBe(false)
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.leadsEnabled).toBe(enabled)
    expect(result.current.automationEnabled).toBe(effective)
  })

  it('rejects a previous account completion even if transport ignores abort', async () => {
    const old = deferred(), current = deferred()
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise))
    const { result, rerender } = renderHook(({ account }) => useAccountLeadPolicy(account), { initialProps: { account: 'a' } })
    rerender({ account: 'b' })
    expect(result.current.ready).toBe(false)
    await act(async () => { current.resolve(response({ success: true, policy: policy('b', 2, false) })); await current.promise })
    await waitFor(() => expect(result.current.policy?.account_id).toBe('b'))
    await act(async () => { old.resolve(response({ success: true, policy: policy('a', 99, true) })); await old.promise })
    expect(result.current.policy?.account_id).toBe('b')
    expect(result.current.leadsEnabled).toBe(false)
  })

  it('invalidates on auth transition and does not request policy with an identity being changed', async () => {
    const old = deferred()
    const fetchMock = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(response({ success: true, policy: policy('a', 2, false) }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAccountLeadPolicy('a'))
    act(() => { beginAuthIdentityChange() })
    expect(result.current.policy).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => { old.resolve(response({ success: true, policy: policy('a', 1) })); await old.promise })
    expect(result.current.leadsEnabled).toBe(false)
    act(() => { completeAuthIdentityChange() })
    await waitFor(() => expect(result.current.policy?.leads_policy_version).toBe(2))
  })

  it('accepts canonical realtime versions and rejects another account and older GET/WS versions', async () => {
    const initial = deferred()
    vi.stubGlobal('fetch', vi.fn(() => initial.promise))
    const { result } = renderHook(() => useAccountLeadPolicy('a'))
    act(() => websocket.listeners.forEach(callback => callback({ event: 'account_capabilities_changed', data: { account_id: 'a', policy: policy('a', 5, false) } })))
    expect(result.current.leadsEnabled).toBe(false)
    expect(result.current.ready).toBe(true)
    await act(async () => { initial.resolve(response({ success: true, policy: policy('a', 3, true) })); await initial.promise })
    act(() => websocket.listeners.forEach(callback => callback({ type: 'account_capabilities_changed', data: { account_id: 'b', policy: policy('b', 99, true) } })))
    act(() => websocket.listeners.forEach(callback => callback({ type: 'account_capabilities_changed', data: { policy: policy('a', 4, true) } })))
    expect(result.current.policy?.leads_policy_version).toBe(5)
    expect(result.current.leadsEnabled).toBe(false)
  })

  it('fails closed on malformed/wrong-account GET and recovers only after explicit retry', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ success: true, policy: policy('b') })).mockResolvedValueOnce(response({ success: true, policy: policy('a', 2) }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAccountLeadPolicy('a'))
    await waitFor(() => expect(result.current.error).not.toBe(''))
    expect(result.current.ready).toBe(false)
    expect(result.current.leadsEnabled).toBe(false)
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.error).toBe('')
  })

  it('aborts a previous focus refresh and does not let its stale failure replace the latest result', async () => {
    const first = deferred(), next = deferred()
    const fetchMock = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise)
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useAccountLeadPolicy('a'))
    act(() => window.dispatchEvent(new Event('focus')))
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true)
    await act(async () => { next.resolve(response({ success: true, policy: policy('a', 3) })); await next.promise })
    await act(async () => { first.resolve(response({ success: false }, 500)); await first.promise })
    expect(result.current.policy?.leads_policy_version).toBe(3)
    expect(result.current.error).toBe('')
  })

  it('does not reuse online policy or make requests offline', async () => {
    const fetchMock = vi.fn(async () => response({ success: true, policy: policy() }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, rerender } = renderHook(({ offline }) => useAccountLeadPolicy('a', offline), { initialProps: { offline: false } })
    await waitFor(() => expect(result.current.leadsEnabled).toBe(true))
    rerender({ offline: true })
    expect(result.current.leadsEnabled).toBe(false)
    expect(result.current.automationEnabled).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
