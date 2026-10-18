import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useOperationalWindow from './useOperationalWindow'

beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const options = { storageKey: 'test-pointer-window', defaultMode: 'floating' as const, defaultWidth: 700, defaultHeight: 600 }
const start = (pointerId = 1) => ({ button: 0, clientX: 10, clientY: 10, target: document.createElement('header'), pointerId, preventDefault: vi.fn() }) as any
function pointer(type: string, x: number, y: number, pointerId = 1) {
  const event = new Event(type)
  Object.assign(event, { clientX: x, clientY: y, pointerId })
  return event as PointerEvent
}

describe('operational window pointer ownership', () => {
  it('stops a gesture during suspension and rejects desktop handlers captured earlier', () => {
    const { result, rerender } = renderHook(({ suspended }) => useOperationalWindow({ ...options, suspended }), { initialProps: { suspended: false } })
    const drag = result.current.beginDrag
    const resize = result.current.beginResize
    act(() => drag(start()))
    expect(result.current.isInteracting).toBe(true)
    act(() => window.dispatchEvent(pointer('pointermove', 30, 20)))
    const geometry = result.current.effectiveGeometry
    rerender({ suspended: true })
    expect(result.current.isInteracting).toBe(false)
    act(() => { window.dispatchEvent(pointer('pointermove', 60, 40)); drag(start()); resize('se', start()); result.current.setMode('docked'); result.current.toggleMaximized(); result.current.resetGeometry() })
    expect(result.current.effectiveGeometry).toEqual(geometry)
    expect(result.current.effectiveMode).toBe('floating')
    rerender({ suspended: false })
    act(() => window.dispatchEvent(pointer('pointermove', 90, 50)))
    expect(result.current.effectiveGeometry).toEqual(geometry)
    expect(result.current.isInteracting).toBe(false)
  })

  it('requires the owning pointer and invalidates old movement/end callbacks after a replacement gesture', () => {
    const listeners = vi.spyOn(window, 'addEventListener')
    const { result } = renderHook(() => useOperationalWindow(options))
    act(() => result.current.beginDrag(start(1)))
    const oldMove = listeners.mock.calls.findLast(([type]) => String(type) === 'pointermove')![1] as (event: PointerEvent) => void
    const oldEnd = listeners.mock.calls.findLast(([type]) => String(type) === 'pointerup')![1] as (event: PointerEvent) => void
    const before = result.current.effectiveGeometry
    act(() => { window.dispatchEvent(pointer('pointermove', 70, 20, 2)); window.dispatchEvent(pointer('pointerup', 70, 20, 2)) })
    expect(result.current.effectiveGeometry).toEqual(before)
    expect(result.current.isInteracting).toBe(true)
    act(() => result.current.beginResize('se', start(2)))
    act(() => { oldMove(pointer('pointermove', 100, 60, 1)); oldEnd(pointer('pointerup', 100, 60, 1)) })
    expect(result.current.effectiveGeometry).toEqual(before)
    expect(result.current.isInteracting).toBe(true)
    act(() => window.dispatchEvent(pointer('pointermove', 70, 60, 2)))
    expect(result.current.effectiveGeometry.width).toBeGreaterThan(before.width)
    act(() => window.dispatchEvent(pointer('pointerup', 70, 60, 2)))
    expect(result.current.isInteracting).toBe(false)
  })

  it('rejects a floating drag callback after docking and stops gestures when changing account scope', () => {
    const { result, rerender } = renderHook(({ scope }) => useOperationalWindow({ ...options, storageScope: scope }), { initialProps: { scope: 'account-a' } })
    const drag = result.current.beginDrag
    act(() => result.current.setMode('docked'))
    act(() => drag(start()))
    expect(result.current.isInteracting).toBe(false)
    act(() => result.current.setMode('floating'))
    act(() => result.current.beginDrag(start()))
    rerender({ scope: 'account-b' })
    const before = result.current.effectiveGeometry
    act(() => window.dispatchEvent(pointer('pointermove', 70, 60)))
    expect(result.current.isInteracting).toBe(false)
    expect(result.current.effectiveGeometry).toEqual(before)
  })
})
