import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginAuthIdentityChange, completeAuthIdentityChange } from '@/lib/authScope'
import { groupIdentityRecoveryLabel, groupIdentityRecoveryPollDelay, parseGroupIdentityRecovery } from './groupIdentityRecovery'
import GroupIdentityRecoveryNotice from './GroupIdentityRecoveryNotice'
import { useGroupIdentityRecovery } from './useGroupIdentityRecovery'

vi.mock('@/lib/api', () => ({ subscribeWebSocket: () => () => {} }))
const job = (state = 'recovering') => ({ state, phase: 'contacts', processed: 10, resolved: 8, pending: 2, conflicts: 0, last_error_code: '', updated_at: '2026-10-25T12:00:00Z' })
const response = (state = 'recovering', revision = 1) => new Response(JSON.stringify({ success: true, identity_revision: revision, recovery: job(state) }))
beforeEach(() => { completeAuthIdentityChange() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('group identity recovery', () => {
  it('distinguishes an absent job, active progress, waiting and partial recovery honestly', () => {
    const absent = parseGroupIdentityRecovery({ success: true, identity_revision: 0, recovery: null }, 'device')
    expect(groupIdentityRecoveryLabel(absent)).toBeNull()
    expect(groupIdentityRecoveryPollDelay([absent])).toBeNull()
    const active = parseGroupIdentityRecovery({ success: true, identity_revision: 1, recovery: job() }, 'device')
    expect(groupIdentityRecoveryLabel(active)).toContain('10 candidatos revisados · 8 coincidencias verificadas · 2 verificaciones pendientes')
    expect(groupIdentityRecoveryPollDelay([active])).toBe(5000)
    const waiting = { ...active, recovery: { ...active.recovery!, state: 'waiting_connection' as const } }
    expect(groupIdentityRecoveryLabel(waiting)).toMatch(/espera de conexión/)
    expect(groupIdentityRecoveryPollDelay([waiting])).toBe(30000)
    const partial = { ...active, recovery: { ...active.recovery!, state: 'partial' as const, conflicts: 1 } }
    expect(groupIdentityRecoveryLabel(partial)).toMatch(/1 identidad por revisar/)
    expect(groupIdentityRecoveryPollDelay([partial])).toBeNull()
    const unresolved = { ...partial, recovery: { ...partial.recovery, pending: 0, unresolved_members: 3 } }
    expect(groupIdentityRecoveryLabel(unresolved)).toContain('0 verificaciones pendientes · 3 integrantes sin identificar')
    expect(groupIdentityRecoveryLabel({ ...unresolved, recovery: { ...unresolved.recovery, state: 'completed' } })).toContain('3 integrantes sin identificar')
    expect(() => parseGroupIdentityRecovery({ success: true, identity_revision: -1, recovery: job() }, 'device')).toThrow()
    expect(() => parseGroupIdentityRecovery({ success: true, identity_revision: 0, recovery: { ...job(), processed: -1 } }, 'device')).toThrow()
    expect(() => parseGroupIdentityRecovery({ success: true, identity_revision: 0, recovery: { ...job(), unresolved_members: -1 } }, 'device')).toThrow()
  })
  it('polls one bounded request per unique device while active, then stops on completion', async () => {
    const fetcher = vi.fn().mockImplementationOnce(async () => response()).mockImplementation(async () => response('completed', 2))
    vi.stubGlobal('fetch', fetcher)
    vi.useFakeTimers()
    const { result } = renderHook(() => useGroupIdentityRecovery(['device', 'device'], 'account'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.rows[0]?.recovery?.state).toBe('recovering')
    await act(async () => { await vi.advanceTimersByTimeAsync(4999) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result.current.rows[0]?.recovery?.state).toBe('completed')
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'include', cache: 'no-store' })
    expect(fetcher.mock.calls[0][1].method).toBeUndefined()
  })
  it('aborts and rejects the previous device completion even if transport ignores abort', async () => {
    let finish!: (value: Response) => void
    const fetcher = vi.fn((url: string, _init?: RequestInit) => url.includes('/old/') ? new Promise<Response>(resolve => { finish = resolve }) : Promise.resolve(response('completed', 4)))
    vi.stubGlobal('fetch', fetcher)
    const { result, rerender } = renderHook(({ id }) => useGroupIdentityRecovery([id], 'account'), { initialProps: { id: 'old' } })
    rerender({ id: 'new' })
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    await waitFor(() => expect(result.current.rows[0]?.deviceId).toBe('new'))
    await act(async () => finish(response('partial', 99)))
    expect(result.current.rows).toHaveLength(1)
    expect(result.current.rows[0]).toMatchObject({ deviceId: 'new', identityRevision: 4 })
    await act(async () => { beginAuthIdentityChange() })
    expect(result.current.rows).toEqual([])
  })
  it('does no hidden-tab work and coalesces simultaneous focus requests', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    let finish!: (value: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const { result } = renderHook(() => useGroupIdentityRecovery(['device']))
    expect(fetcher).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')) })
    expect(fetcher).toHaveBeenCalledOnce()
    await act(async () => finish(response('completed')))
    expect(result.current.rows[0]?.recovery?.state).toBe('completed')
  })
})


it('keeps multi-device progress compact and points retry to the existing action', () => {
  const rows = Array.from({ length: 5 }, (_, index) => parseGroupIdentityRecovery({ success: true, identity_revision: 1, recovery: job('partial') }, `device-${index}`))
  render(<GroupIdentityRecoveryNotice rows={rows} retryHint />)
  expect(screen.getAllByRole('status')).toHaveLength(3)
  expect(screen.getByText('2 dispositivos más con recuperación pendiente.')).toBeInTheDocument()
  expect(screen.getAllByText('Puedes reintentar desde Actualizar grupos de WhatsApp.')).toHaveLength(3)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
