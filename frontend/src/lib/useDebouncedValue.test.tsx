import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from './useDebouncedValue'

describe('useDebouncedValue', () => {
  afterEach(() => vi.useRealTimers())

  it('publica únicamente el último valor después de 500 ms exactos', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value), { initialProps: { value: '' } })
    rerender({ value: 'f' })
    rerender({ value: 'fi' })
    rerender({ value: 'finaz' })
    act(() => vi.advanceTimersByTime(499))
    expect(result.current[0]).toBe('')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current[0]).toBe('finaz')
    expect(SEARCH_DEBOUNCE_MS).toBe(500)
  })

  it('permite publicar una limpieza explícita de forma inmediata', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value), { initialProps: { value: 'propaganda' } })
    expect(result.current[0]).toBe('propaganda')

    rerender({ value: '' })
    act(() => result.current[1](''))

    expect(result.current[0]).toBe('')
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(result.current[0]).toBe('')
  })
})
