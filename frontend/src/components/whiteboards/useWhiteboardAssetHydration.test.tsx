import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  prioritizedWhiteboardFileIDs,
  useWhiteboardAssetHydration,
  whiteboardAssetHydrationMessage,
  type WhiteboardHydrationAsset,
} from '@/hooks/useWhiteboardAssetHydration'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

function image(id: string, x: number, y: number) {
  return { id: `element-${id}`, type: 'image', fileId: id, x, y, width: 100, height: 100 }
}

function asset(fileID: string): WhiteboardHydrationAsset {
  return {
    id: `asset-${fileID}`,
    file_id: fileID,
    kind: 'asset',
    content_type: 'image/png',
    created_at: '2026-08-18T00:00:00Z',
  }
}

describe('whiteboard progressive asset hydration', () => {
  it('prioritizes visible images and keeps stable scene order', () => {
    const elements = [
      image('outside-a', 800, 800),
      image('visible-a', 20, 30),
      image('visible-b', 180, 180),
      image('outside-b', -600, -600),
    ]
    expect(prioritizedWhiteboardFileIDs(elements, [0, 0, 300, 300])).toEqual([
      'visible-a',
      'visible-b',
      'outside-a',
      'outside-b',
    ])
  })

  it('adds each completed file immediately while keeping four downloads at most', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<{ blob: Blob }>>>()
    let active = 0
    let peak = 0
    const onFile = vi.fn()
    const listAssets = vi.fn(async (fileIDs: string[]) => ({ assets: fileIDs.map(asset) }))
    const downloadAsset = vi.fn(async (item: WhiteboardHydrationAsset) => {
      active += 1
      peak = Math.max(peak, active)
      const gate = deferred<{ blob: Blob }>()
      gates.set(item.file_id, gate)
      const result = await gate.promise
      active -= 1
      return result
    })
    const { result } = renderHook(() => useWhiteboardAssetHydration({
      ownerKey: 'board-a',
      enabled: true,
      listAssets,
      downloadAsset,
      onFile,
    }))

    act(() => result.current.request([
      image('file-1', 0, 0),
      image('file-2', 10, 10),
      image('file-3', 20, 20),
      image('file-4', 30, 30),
      image('file-5', 40, 40),
    ], [0, 0, 100, 100]))

    await waitFor(() => expect(gates.size).toBe(4))
    expect(peak).toBe(4)
    act(() => gates.get('file-2')?.resolve({ blob: new Blob(['two'], { type: 'image/png' }) }))
    await waitFor(() => expect(onFile).toHaveBeenCalledTimes(1))
    expect(onFile.mock.calls[0][0].id).toBe('file-2')
    await waitFor(() => expect(gates.has('file-5')).toBe(true))

    for (const fileID of ['file-1', 'file-3', 'file-4', 'file-5']) {
      act(() => gates.get(fileID)?.resolve({ blob: new Blob([fileID], { type: 'image/png' }) }))
    }
    await waitFor(() => expect(result.current.progress.phase).toBe('complete'))
    expect(result.current.progress).toMatchObject({ total: 5, loaded: 5, failed: 0 })
    expect(peak).toBe(4)
  })

  it('deduplicates repeated requests and rejects a late file from the previous owner', async () => {
    const gate = deferred<{ blob: Blob }>()
    const onFile = vi.fn()
    const listAssets = vi.fn(async (fileIDs: string[]) => ({ assets: fileIDs.map(asset) }))
    const downloadAsset = vi.fn(() => gate.promise)
    const { result, rerender } = renderHook(({ ownerKey }) => useWhiteboardAssetHydration({
      ownerKey,
      enabled: true,
      listAssets,
      downloadAsset,
      onFile,
    }), { initialProps: { ownerKey: 'board-a' } })

    act(() => {
      result.current.request([image('shared-file', 0, 0)])
      result.current.request([image('shared-file', 0, 0)])
    })
    await waitFor(() => expect(downloadAsset).toHaveBeenCalledTimes(1))
    rerender({ ownerKey: 'board-b' })
    act(() => gate.resolve({ blob: new Blob(['old'], { type: 'image/png' }) }))
    await waitFor(() => expect(result.current.progress.phase).toBe('idle'))
    expect(onFile).not.toHaveBeenCalled()
  })

  it('retries only failed images without duplicating completed files', async () => {
    const onFile = vi.fn()
    let attempts = 0
    const { result } = renderHook(() => useWhiteboardAssetHydration({
      ownerKey: 'board-retry',
      enabled: true,
      listAssets: async fileIDs => ({ assets: fileIDs.map(asset) }),
      downloadAsset: async () => {
        attempts += 1
        return attempts === 1
          ? { error: 'temporary failure' }
          : { blob: new Blob(['ready'], { type: 'image/png' }) }
      },
      onFile,
    }))

    act(() => result.current.request([image('retry-file', 0, 0)]))
    await waitFor(() => expect(result.current.progress.phase).toBe('error'))
    expect(result.current.progress).toMatchObject({ total: 1, loaded: 0, failed: 1 })
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.progress.phase).toBe('complete'))
    expect(onFile).toHaveBeenCalledTimes(1)
    expect(attempts).toBe(2)
  })

  it('exposes quiet loading, offline and actionable failure messages', () => {
    expect(whiteboardAssetHydrationMessage({ phase: 'loading', total: 12, loaded: 3, failed: 0 }))
      .toBe('Cargando imágenes 3 de 12…')
    expect(whiteboardAssetHydrationMessage({ phase: 'offline', total: 12, loaded: 3, failed: 0 }))
      .toContain('9 imágenes pendientes')
    expect(whiteboardAssetHydrationMessage({ phase: 'error', total: 12, loaded: 11, failed: 1 }))
      .toContain('1 imagen no pudo cargarse')
  })
})
