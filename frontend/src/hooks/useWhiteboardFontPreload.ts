'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

export interface WhiteboardFontPreloadProgress {
  phase: 'idle' | 'loading' | 'offline' | 'complete' | 'error'
  total: number
  loaded: number
  failed: number
  readyFamilyIds: readonly number[]
  failedFamilyIds: readonly number[]
}

type WhiteboardFontPreloadAPI = ExcalidrawImperativeAPI & {
  preloadFonts: () => Promise<WhiteboardFontPreloadProgress>
  retryFontPreload: () => Promise<WhiteboardFontPreloadProgress>
  subscribeFontPreloadProgress: (
    listener: (progress: WhiteboardFontPreloadProgress) => void,
  ) => () => void
  getFontPreloadProgress: () => WhiteboardFontPreloadProgress
}

const IDLE_FONT_PROGRESS: WhiteboardFontPreloadProgress = {
  phase: 'idle',
  total: 32,
  loaded: 0,
  failed: 0,
  readyFamilyIds: [],
  failedFamilyIds: [],
}

export function whiteboardFontPreloadMessage(progress: WhiteboardFontPreloadProgress) {
  if (progress.phase === 'idle' || progress.phase === 'loading') {
    return `Preparando fuentes ${progress.loaded} de ${progress.total || 32}…`
  }
  if (progress.phase === 'offline') {
    return `Preparando fuentes ${progress.loaded} de ${progress.total || 32}… Se reanudará al recuperar la conexión.`
  }
  if (progress.phase === 'error') {
    return `${progress.failed} ${progress.failed === 1 ? 'fuente no pudo prepararse' : 'fuentes no pudieron prepararse'}. Las fuentes disponibles ya pueden usarse.`
  }
  return null
}

export function whiteboardFontPreloadFirstPassComplete(progress: WhiteboardFontPreloadProgress) {
  return progress.phase === 'complete' || progress.phase === 'error'
}

export function useWhiteboardFontPreload(
  ownerKey: string,
  editorAPI: ExcalidrawImperativeAPI | null,
) {
  const [progress, setProgress] = useState(IDLE_FONT_PROGRESS)

  useEffect(() => {
    setProgress(IDLE_FONT_PROGRESS)
    if (!editorAPI) return
    const api = editorAPI as WhiteboardFontPreloadAPI
    if (
      typeof api.preloadFonts !== 'function'
      || typeof api.subscribeFontPreloadProgress !== 'function'
    ) {
      setProgress({ ...IDLE_FONT_PROGRESS, phase: 'error', failed: 32 })
      return
    }
    const unsubscribe = api.subscribeFontPreloadProgress(next => {
      setProgress({ ...next, total: next.total || 32 })
    })
    void api.preloadFonts()
    return unsubscribe
  }, [editorAPI, ownerKey])

  const retry = useCallback(() => {
    const api = editorAPI as WhiteboardFontPreloadAPI | null
    if (typeof api?.retryFontPreload === 'function') void api.retryFontPreload()
  }, [editorAPI])

  return { progress, retry }
}

