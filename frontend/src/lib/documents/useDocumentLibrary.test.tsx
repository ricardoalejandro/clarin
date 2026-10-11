import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useDocumentLibrary } from './useDocumentLibrary'
vi.mock('@/lib/api', () => ({ api: vi.fn() }))
vi.mock('@/lib/authScope', () => ({ getAuthScope: () => 'account:user', subscribeAuthScope: () => () => {}, isAuthIdentityChanging: () => false }))
const page = (templates: any[], cursor = '') => ({ success: true, data: { templates, total: templates.length, has_more: !!cursor, next_cursor: cursor } })
afterEach(() => vi.useRealTimers())
it('queries exactly at 500 ms, aborts the previous request and clears immediately', async () => {
 vi.mocked(api).mockResolvedValue(page([]))
 const { result, unmount } = renderHook(useDocumentLibrary)
 await waitFor(() => expect(result.current.loading).toBe(false))
 const first = vi.mocked(api).mock.calls[0][1]?.signal
 vi.useFakeTimers()
 act(() => result.current.setQuery('ficha'))
 await act(async () => { vi.advanceTimersByTime(499) })
 expect(api).toHaveBeenCalledTimes(1)
 await act(async () => { vi.advanceTimersByTime(1) })
 expect(api).toHaveBeenCalledTimes(2); expect(first?.aborted).toBe(true)
 expect(vi.mocked(api).mock.calls[1][0]).toContain('q=ficha')
 await act(async () => { result.current.setQuery('') })
 expect(api).toHaveBeenCalledTimes(3)
 unmount(); expect(vi.mocked(api).mock.calls[2][1]?.signal?.aborted).toBe(true)
})
it('merges canonical pages without duplicate cards and retains rows on error', async () => {
 vi.mocked(api).mockReset().mockResolvedValueOnce(page([{ id: '1', name: 'old' }], 'next')).mockResolvedValueOnce(page([{ id: '1', name: 'updated' }, { id: '2' }])).mockResolvedValueOnce({ success: false, error: 'Sin conexión' })
 const { result } = renderHook(useDocumentLibrary)
 await waitFor(() => expect(result.current.templates).toHaveLength(1))
 await act(async () => { await result.current.loadMore() })
 expect(result.current.templates).toEqual([{ id: '1', name: 'updated' }, { id: '2' }])
 await act(async () => { await result.current.retry() })
 expect(result.current.error).toBe('Sin conexión'); expect(result.current.templates).toHaveLength(2)
})
