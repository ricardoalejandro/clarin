import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedValue } from './useDebouncedValue'

describe('useDebouncedValue', () => {
  afterEach(() => vi.useRealTimers())

  it('publica únicamente el último valor después de 500 ms exactos', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 500), { initialProps: { value: '' } })
    rerender({ value: 'f' })
    rerender({ value: 'fi' })
    rerender({ value: 'finaz' })
    act(() => vi.advanceTimersByTime(499))
    expect(result.current[0]).toBe('')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current[0]).toBe('finaz')
  })
})
