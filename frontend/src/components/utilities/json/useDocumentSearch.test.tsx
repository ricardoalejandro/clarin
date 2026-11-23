import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDocumentSearch } from './useDocumentSearch'

class SearchWorker {
  static instances: SearchWorker[] = []
  requests: { kind: string; id?: number; query?: string }[] = []
  onmessage?: (event: { data: unknown }) => void
  onerror?: (event: { preventDefault(): void }) => void
  terminated = false
  constructor() { SearchWorker.instances.push(this) }
  postMessage(request: { kind: string; id?: number; query?: string }) { this.requests.push(request) }
  terminate() { this.terminated = true }
}

beforeEach(() => { vi.useFakeTimers(); SearchWorker.instances = []; vi.stubGlobal('Worker', SearchWorker) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('starts search at exactly 500ms, rejects stale completions and clears immediately', async () => {
  const { result } = renderHook(() => useDocumentSearch(true, 'document-a', 1, () => 'one two'))
  act(() => result.current.setQuery('one'))
  await act(() => vi.advanceTimersByTimeAsync(499))
  expect(SearchWorker.instances).toHaveLength(0)
  await act(() => vi.advanceTimersByTimeAsync(1))
  const worker = SearchWorker.instances[0]
  const first = worker.requests.find(request => request.kind === 'find')!
  expect(first.query).toBe('one')
  act(() => result.current.setQuery('two'))
  await act(() => vi.advanceTimersByTimeAsync(500))
  const last = worker.requests.at(-1)!
  act(() => worker.onmessage?.({ data: { id: first.id, matches: [{ offset: 0, length: 3, preview: 'old' }], nextOffset: null } }))
  expect(result.current.matches).toEqual([])
  act(() => worker.onmessage?.({ data: { id: last.id, matches: [{ offset: 4, length: 3, preview: 'two' }], nextOffset: null } }))
  expect(result.current.matches[0].offset).toBe(4)
  act(() => result.current.setQuery(''))
  expect(result.current.matches).toEqual([])
  expect(worker.terminated).toBe(true)
})

it('destroys the source-scoped worker on switching documents, closing and unmount', async () => {
  const { result, rerender, unmount } = renderHook(({ id, open }) => useDocumentSearch(open, id, 1, () => 'source'), { initialProps: { id: 'a', open: true } })
  act(() => result.current.setQuery('source'))
  await act(() => vi.advanceTimersByTimeAsync(500))
  const first = SearchWorker.instances[0]
  rerender({ id: 'b', open: true })
  expect(first.terminated).toBe(true)
  const second = SearchWorker.instances[1]
  rerender({ id: 'b', open: false })
  expect(second.terminated).toBe(true)
  unmount()
})

it('does not copy the whole large document on each editing keystroke', async () => {
  const snapshot = vi.fn(() => 'needle in large source')
  const { result, rerender } = renderHook(({ revision }) => useDocumentSearch(true, 'a', revision, snapshot), { initialProps: { revision: 1 } })
  act(() => result.current.setQuery('needle'))
  await act(() => vi.advanceTimersByTimeAsync(500))
  expect(snapshot).toHaveBeenCalledTimes(1)
  rerender({ revision: 2 })
  await act(() => vi.advanceTimersByTimeAsync(499))
  rerender({ revision: 3 })
  await act(() => vi.advanceTimersByTimeAsync(499))
  expect(snapshot).toHaveBeenCalledTimes(1)
  expect(result.current.pending).toBe(true)
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(snapshot).toHaveBeenCalledTimes(2)
})

it('bounds a stalled search and releases its worker with actionable feedback', async () => {
  const { result } = renderHook(() => useDocumentSearch(true, 'a', 1, () => 'source'))
  act(() => result.current.setQuery('source'))
  await act(() => vi.advanceTimersByTimeAsync(500))
  expect(result.current.working).toBe(true)
  await act(() => vi.advanceTimersByTimeAsync(10_000))
  expect(SearchWorker.instances[0].terminated).toBe(true)
  expect(result.current.working).toBe(false)
  expect(result.current.error).toContain('No se pudo completar')
})

it('suspends current and debounced work before deactivation and resumes only on a new user request', async () => {
  const { result } = renderHook(() => useDocumentSearch(true, 'a', 1, () => 'source'))
  act(() => result.current.setQuery('source'))
  await act(() => vi.advanceTimersByTimeAsync(500))
  const old = SearchWorker.instances[0]
  const request = old.requests.find(request => request.kind === 'find')!
  act(() => result.current.setQuery('pending'))
  act(() => result.current.suspend())
  await act(() => vi.advanceTimersByTimeAsync(500))
  expect(old.terminated).toBe(true)
  expect(SearchWorker.instances).toHaveLength(1)
  act(() => old.onmessage?.({ data: { id: request.id, matches: [{ offset: 0, length: 6, preview: 'stale' }], nextOffset: null } }))
  expect(result.current.matches).toEqual([])
  act(() => result.current.setQuery('new request'))
  await act(() => vi.advanceTimersByTimeAsync(500))
  expect(SearchWorker.instances).toHaveLength(2)
})
