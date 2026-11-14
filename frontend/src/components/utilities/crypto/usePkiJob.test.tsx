import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePkiJob } from './usePkiJob'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  terminate = vi.fn()
  postMessage = vi.fn()
  constructor() { FakeWorker.instances.push(this) }
}
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('cancels a predecessor, ignores its completion and terminates the worker after a result', async () => {
  const hook = renderHook(() => usePkiJob())
  let first!: Promise<unknown>, second!: Promise<unknown>
  act(() => { first = hook.result.current.run({ task: 'generate', kind: 'aes', size: 256 }) })
  const firstRejection = expect(first).rejects.toMatchObject({ name: 'AbortError' })
  act(() => { second = hook.result.current.run({ task: 'generate', kind: 'ec', size: 'P-256' }) })
  await firstRejection
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce()
  const id = FakeWorker.instances[1].postMessage.mock.calls[0][0].id
  act(() => { FakeWorker.instances[0].onmessage?.({ data: { id: id - 2, ok: true, result: 'obsolete' } }) })
  await act(async () => { FakeWorker.instances[1].onmessage?.({ data: { id, ok: true, result: 'canonical' } }); await expect(second).resolves.toBe('canonical') })
  expect(hook.result.current.busy).toBe(false)
  expect(FakeWorker.instances[1].terminate).toHaveBeenCalledOnce()
})
it('bounds slow work and destroys a worker on unmount', async () => {
  const hook = renderHook(() => usePkiJob())
  let pending!: Promise<unknown>
  act(() => { pending = hook.result.current.run({ task: 'generate', kind: 'rsa', size: 4096 }) })
  const rejection = expect(pending).rejects.toThrow('60 segundos')
  await act(async () => { vi.advanceTimersByTime(60_000); await rejection })
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce()
  act(() => { pending = hook.result.current.run({ task: 'generate', kind: 'aes', size: 128 }) })
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  hook.unmount()
  await cancelled
  expect(FakeWorker.instances[1].terminate).toHaveBeenCalledOnce()
})
