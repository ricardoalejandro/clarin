import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import useTaskWindow, {
  TASK_WINDOW_PREFERENCE_VERSION,
  clampTaskWindowGeometry,
  defaultTaskWindowGeometry,
  parseTaskWindowPreference,
  taskWindowScopedStorageKey,
} from './useTaskWindow'

const originalWidth = window.innerWidth
const originalHeight = window.innerHeight

function viewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
  window.dispatchEvent(new Event('resize'))
}

afterEach(() => {
  localStorage.clear()
  viewport(originalWidth, originalHeight)
})

describe('task window geometry preferences', () => {
  it('keeps desktop preferred dimensions separate from a narrow effective clamp', () => {
    const preferred = defaultTaskWindowGeometry({
      defaultWidth: 980,
      defaultHeight: 820,
      align: 'center',
      viewport: { width: 375, height: 667 },
    })
    const effective = clampTaskWindowGeometry(preferred, { width: 375, height: 667 }, 560, 520)

    expect(preferred).toMatchObject({ width: 980, height: 820 })
    expect(effective).toMatchObject({ width: 343, height: 635 })
    expect(preferred).toMatchObject({ width: 980, height: 820 })
  })

  it('uses a versioned account/user key and rejects legacy or malformed preferences', () => {
    expect(taskWindowScopedStorageKey('clarin:tasks:detail-window:v2', 'account:user')).toBe('clarin:tasks:detail-window:v3:account%3Auser')
    expect(parseTaskWindowPreference(JSON.stringify({ version: 2, geometry: { x: 0, y: 0, width: 440, height: 460 } }))).toBeNull()
    expect(parseTaskWindowPreference(JSON.stringify({
      version: TASK_WINDOW_PREFERENCE_VERSION,
      mode: 'floating',
      restoreMode: 'floating',
      preferredGeometry: { x: 20, y: 20, width: 0, height: 700 },
    }))).toBeNull()
  })

  it('restores the same preferred floating size after mobile/zoom-like viewport changes', async () => {
    viewport(1440, 900)
    const storageKey = taskWindowScopedStorageKey('test:window', 'account:user')
    localStorage.setItem(storageKey, JSON.stringify({
      version: TASK_WINDOW_PREFERENCE_VERSION,
      mode: 'floating',
      restoreMode: 'floating',
      preferredGeometry: { x: 160, y: 40, width: 900, height: 700 },
    }))
    const { result } = renderHook(() => useTaskWindow({
      storageKey: 'test:window',
      storageScope: 'account:user',
      defaultMode: 'floating',
      defaultWidth: 980,
      defaultHeight: 820,
      minWidth: 560,
      minHeight: 520,
      align: 'center',
    }))

    await waitFor(() => expect(result.current.panelStyle.width).toBe(900))
    act(() => viewport(700, 700))
    expect(result.current.effectiveMode).toBe('maximized')
    expect(result.current.panelStyle.width).toBe('100vw')

    act(() => viewport(1440, 900))
    expect(result.current.effectiveMode).toBe('floating')
    expect(result.current.panelStyle.width).toBe(900)
    expect(JSON.parse(localStorage.getItem(storageKey) || '{}').preferredGeometry.width).toBe(900)
  })

  it('restores the configured surface dimensions on explicit reset', async () => {
    viewport(1440, 900)
    const storageKey = taskWindowScopedStorageKey('test:reset-window', 'account:user')
    localStorage.setItem(storageKey, JSON.stringify({
      version: TASK_WINDOW_PREFERENCE_VERSION,
      mode: 'floating',
      restoreMode: 'floating',
      preferredGeometry: { x: 80, y: 40, width: 620, height: 540 },
    }))
    const { result } = renderHook(() => useTaskWindow({
      storageKey: 'test:reset-window', storageScope: 'account:user', defaultMode: 'floating',
      defaultWidth: 980, defaultHeight: 820, minWidth: 560, minHeight: 520, align: 'center',
    }))
    await waitFor(() => expect(result.current.panelStyle.width).toBe(620))
    act(() => result.current.resetGeometry())
    expect(result.current.panelStyle).toMatchObject({ width: 980, height: 820 })
  })

  it('keeps only the legacy mode and resets its tiny geometry to defaults', async () => {
    viewport(1440, 900)
    localStorage.setItem('test:legacy:v1', JSON.stringify({ mode: 'docked', geometry: { x: 12, y: 12, width: 440, height: 460 } }))
    const { result } = renderHook(() => useTaskWindow({
      storageKey: 'test:legacy:v1',
      storageScope: 'account:user',
      defaultMode: 'floating',
      defaultWidth: 980,
      defaultHeight: 820,
      minWidth: 560,
      minHeight: 520,
      align: 'center',
    }))

    await waitFor(() => expect(result.current.effectiveMode).toBe('docked'))
    act(() => result.current.setMode('floating'))
    expect(result.current.panelStyle.width).toBe(980)
    const scoped = JSON.parse(localStorage.getItem(taskWindowScopedStorageKey('test:legacy:v1', 'account:user')) || '{}')
    expect(scoped.preferredGeometry).toMatchObject({ width: 980, height: 820 })
  })
})
