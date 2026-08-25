import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  useWhiteboardFontPreload,
  whiteboardFontPreloadFirstPassComplete,
  whiteboardFontPreloadMessage,
  type WhiteboardFontPreloadProgress,
} from '@/hooks/useWhiteboardFontPreload'
import {
  selectClarinFontPreloadTargets,
  shouldResetClarinFontFace,
} from '../../vendor/excalidraw-clarin/packages/excalidraw/fonts/clarinFontPreload'

const progress = (
  phase: WhiteboardFontPreloadProgress['phase'],
  loaded = 0,
  failed = 0,
): WhiteboardFontPreloadProgress => ({
  phase,
  total: 32,
  loaded,
  failed,
  readyFamilyIds: Array.from({ length: loaded }, (_, index) => index + 1),
  failedFamilyIds: Array.from({ length: failed }, (_, index) => 100 + index),
})

describe('whiteboard font preloading', () => {
  it('reports deterministic Spanish progress and terminal states', () => {
    expect(whiteboardFontPreloadMessage(progress('loading', 7))).toBe('Preparando fuentes 7 de 32…')
    expect(whiteboardFontPreloadMessage(progress('offline', 7))).toContain('Se reanudará')
    expect(whiteboardFontPreloadMessage(progress('error', 31, 1))).toBe(
      '1 fuente no pudo prepararse. Las fuentes disponibles ya pueden usarse.',
    )
    expect(whiteboardFontPreloadMessage(progress('complete', 32))).toBeNull()
    expect(whiteboardFontPreloadFirstPassComplete(progress('offline', 7))).toBe(false)
    expect(whiteboardFontPreloadFirstPassComplete(progress('error', 31, 1))).toBe(true)
    expect(whiteboardFontPreloadFirstPassComplete(progress('complete', 32))).toBe(true)
  })

  it('retries only terminal failures, but resumes every pending family after offline startup', () => {
    expect(selectClarinFontPreloadTargets({
      orderedFamilyIds: [2, 1, 3],
      readyFamilyIds: new Set([1]),
      failedFamilyIds: new Set([3]),
      retryFailed: true,
    })).toEqual([3])
    expect(selectClarinFontPreloadTargets({
      orderedFamilyIds: [2, 1, 3],
      readyFamilyIds: new Set<number>(),
      failedFamilyIds: new Set<number>(),
      retryFailed: true,
    })).toEqual([2, 1, 3])
    expect(shouldResetClarinFontFace({
      retryFailed: true,
      familyFailed: true,
      status: 'error',
    })).toBe(true)
    expect(shouldResetClarinFontFace({
      retryFailed: false,
      familyFailed: true,
      status: 'error',
    })).toBe(false)
    expect(shouldResetClarinFontFace({
      retryFailed: true,
      familyFailed: true,
      status: 'loaded',
    })).toBe(false)
  })

  it('subscribes before preloading and exposes an imperative retry', async () => {
    let listener: ((next: WhiteboardFontPreloadProgress) => void) | null = null
    const calls: string[] = []
    const api = {
      subscribeFontPreloadProgress: vi.fn((next: typeof listener) => {
        calls.push('subscribe')
        listener = next
        return () => {
          calls.push('unsubscribe')
          listener = null
        }
      }),
      preloadFonts: vi.fn(async () => {
        calls.push('preload')
        return progress('complete', 32)
      }),
      retryFontPreload: vi.fn(async () => progress('complete', 32)),
    }
    const { result, unmount } = renderHook(() => useWhiteboardFontPreload('board-one', api as never))
    await waitFor(() => expect(api.preloadFonts).toHaveBeenCalledOnce())
    expect(calls.slice(0, 2)).toEqual(['subscribe', 'preload'])

    act(() => listener?.(progress('loading', 12)))
    expect(result.current.progress).toMatchObject({ phase: 'loading', loaded: 12, total: 32 })
    act(() => result.current.retry())
    expect(api.retryFontPreload).toHaveBeenCalledOnce()

    unmount()
    expect(calls).toContain('unsubscribe')
  })

  it('fails honestly when an older editor API has no preload contract', async () => {
    const legacyAPI = {}
    const { result } = renderHook(() => useWhiteboardFontPreload('board-two', legacyAPI as never))
    await waitFor(() => expect(result.current.progress.phase).toBe('error'))
    expect(result.current.progress.failed).toBe(32)
  })
})
