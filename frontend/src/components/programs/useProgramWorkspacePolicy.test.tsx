import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveProgramLayoutViewport, useProgramWorkspacePolicy } from './useProgramWorkspacePolicy'

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })

describe('Program workspace viewport', () => {
  it('keeps the unobscured height while a keyboard opens, but accepts rotation', () => {
    const previous = { width: 900, height: 800 }
    expect(resolveProgramLayoutViewport(previous, { width: 900, height: 430 }, true)).toEqual(previous)
    expect(resolveProgramLayoutViewport(previous, { width: 800, height: 430 }, true)).toEqual({ width: 800, height: 430 })
    expect(resolveProgramLayoutViewport(previous, { width: 900, height: 430 }, false).height).toBe(430)
  })

  it('uses measured width, reacts to touch layout changes and removes listeners', () => {
    const media = Object.assign(new EventTarget(), { matches: true })
    vi.stubGlobal('matchMedia', () => media)
    vi.stubGlobal('innerWidth', 900)
    vi.stubGlobal('innerHeight', 800)
    const removeWindow = vi.spyOn(window, 'removeEventListener')
    const removeMedia = vi.spyOn(media, 'removeEventListener')
    const hook = renderHook(({ width }) => useProgramWorkspacePolicy(width), { initialProps: { width: 900 } })
    expect(hook.result.current.desktopActions).toBe(true)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    act(() => { vi.stubGlobal('innerHeight', 430); window.dispatchEvent(new Event('resize')) })
    expect(hook.result.current.mobile).toBe(false)
    act(() => { vi.stubGlobal('innerWidth', 800); window.dispatchEvent(new Event('resize')) })
    expect(hook.result.current.mobile).toBe(true)
    hook.rerender({ width: 560 })
    expect(hook.result.current.desktopActions).toBe(false)
    hook.unmount()
    expect(removeWindow).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(removeMedia).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('blocks administration on viewport shrink before the container measurement catches up', () => {
    const media = Object.assign(new EventTarget(), { matches: false })
    vi.stubGlobal('matchMedia', () => media)
    vi.stubGlobal('innerWidth', 1440)
    vi.stubGlobal('innerHeight', 900)
    const hook = renderHook(({ width }) => useProgramWorkspacePolicy(width), { initialProps: { width: 1200 } })
    expect(hook.result.current.desktopActions).toBe(true)

    act(() => { vi.stubGlobal('innerWidth', 536); window.dispatchEvent(new Event('resize')) })
    expect(hook.result.current.desktopActions).toBe(false)

    hook.rerender({ width: 512 })
    act(() => { vi.stubGlobal('innerWidth', 1440); window.dispatchEvent(new Event('resize')) })
    expect(hook.result.current.desktopActions).toBe(false)
    hook.rerender({ width: 1200 })
    expect(hook.result.current.desktopActions).toBe(true)

    // A narrow workspace (for example beside navigation) still controls the mode.
    hook.rerender({ width: 640 })
    expect(hook.result.current.mobile).toBe(true)
    hook.rerender({ width: 0 })
    expect(hook.result.current.desktopActions).toBe(false)
  })
})
