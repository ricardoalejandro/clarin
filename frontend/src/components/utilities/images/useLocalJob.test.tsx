import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useLocalJob } from './useLocalJob'

it('aborts old input, ignores late completion and cancels work on close', async () => {
  const { result, unmount } = renderHook(() => useLocalJob<string>())
  let signal: AbortSignal | undefined
  let complete: (value: string) => void = () => {}
  const old = new Promise<string>(resolve => { complete = resolve })
  act(() => { void result.current.run(current => { signal = current; return old }) })
  expect(result.current.state).toEqual({ status: 'pending' })
  await act(async () => { await result.current.run(async () => 'new input') })
  expect(signal?.aborted).toBe(true)
  await act(async () => { complete('obsolete input') })
  expect(result.current.state).toEqual({ status: 'ready', value: 'new input' })

  act(() => {
    void result.current.run(current => { signal = current; return new Promise(() => {}) })
  })
  unmount()
  expect(signal?.aborted).toBe(true)
})
