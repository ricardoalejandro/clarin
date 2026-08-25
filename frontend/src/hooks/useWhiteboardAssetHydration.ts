'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { BinaryFileData } from '@excalidraw/excalidraw/types'
import { blobToDataURL, referencedWhiteboardFileIDs, type WhiteboardBinaryFile } from '@/lib/whiteboardMedia'
import { mapWhiteboardConcurrently, whiteboardAbortError } from '@/lib/whiteboardAsync'

export const WHITEBOARD_ASSET_DOWNLOAD_CONCURRENCY = 4

export type WhiteboardSceneBounds = readonly [number, number, number, number]

export interface WhiteboardHydrationAsset {
  id: string
  file_id: string
  kind: string
  content_type: string
  created_at: string
}

export interface WhiteboardAssetHydrationProgress {
  phase: 'idle' | 'loading' | 'offline' | 'complete' | 'error'
  total: number
  loaded: number
  failed: number
}

interface WhiteboardAssetHydrationSession {
  ownerKey: string
  controller: AbortController
  known: Set<string>
  pending: Set<string>
  pendingOrder: string[]
  active: Set<string>
  hydrated: Set<string>
  failed: Set<string>
  running: boolean
}

interface WhiteboardAssetHydrationOptions {
  ownerKey: string
  enabled: boolean
  listAssets: (fileIDs: string[], signal: AbortSignal) => Promise<{
    assets: WhiteboardHydrationAsset[]
    error?: string
  }>
  downloadAsset: (asset: WhiteboardHydrationAsset, signal: AbortSignal) => Promise<{
    blob?: Blob
    error?: string
  }>
  onFile: (file: BinaryFileData) => void
  onPersistedFileIDs?: (fileIDs: string[]) => void
}

const IDLE_PROGRESS: WhiteboardAssetHydrationProgress = {
  phase: 'idle',
  total: 0,
  loaded: 0,
  failed: 0,
}

function createSession(ownerKey: string): WhiteboardAssetHydrationSession {
  return {
    ownerKey,
    controller: new AbortController(),
    known: new Set(),
    pending: new Set(),
    pendingOrder: [],
    active: new Set(),
    hydrated: new Set(),
    failed: new Set(),
    running: false,
  }
}

function finiteElementBounds(value: unknown): WhiteboardSceneBounds | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const element = value as Record<string, unknown>
  if (element.type !== 'image' || element.isDeleted === true) return null
  const x = Number(element.x)
  const y = Number(element.y)
  const width = Number(element.width)
  const height = Number(element.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  return [Math.min(x, x + width), Math.min(y, y + height), Math.max(x, x + width), Math.max(y, y + height)]
}

function boundsIntersect(left: WhiteboardSceneBounds, right: WhiteboardSceneBounds) {
  return left[0] <= right[2] && left[2] >= right[0] && left[1] <= right[3] && left[3] >= right[1]
}

/** Keeps visible image files first while retaining stable scene order. */
export function prioritizedWhiteboardFileIDs(
  elements: readonly unknown[],
  visibleBounds?: WhiteboardSceneBounds | null,
) {
  const ordered = referencedWhiteboardFileIDs(elements)
  if (!visibleBounds) return ordered
  const visible = new Set<string>()
  for (const value of elements) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const element = value as Record<string, unknown>
    if (typeof element.fileId !== 'string' || !element.fileId.trim()) continue
    const bounds = finiteElementBounds(value)
    if (bounds && boundsIntersect(bounds, visibleBounds)) visible.add(element.fileId)
  }
  return [...ordered.filter(fileID => visible.has(fileID)), ...ordered.filter(fileID => !visible.has(fileID))]
}

export function whiteboardAssetHydrationMessage(progress: WhiteboardAssetHydrationProgress) {
  if (progress.phase === 'loading') return `Cargando imágenes ${progress.loaded} de ${progress.total}…`
  if (progress.phase === 'offline') return `Hay ${Math.max(0, progress.total - progress.loaded)} imágenes pendientes. Se reanudarán al recuperar la conexión.`
  if (progress.phase === 'error') return `${progress.failed} ${progress.failed === 1 ? 'imagen no pudo cargarse' : 'imágenes no pudieron cargarse'}. La pizarra sigue disponible.`
  return null
}

export function useWhiteboardAssetHydration(options: WhiteboardAssetHydrationOptions) {
  const [progress, setProgress] = useState<WhiteboardAssetHydrationProgress>(IDLE_PROGRESS)
  const ownerKeyRef = useRef(options.ownerKey)
  const enabledRef = useRef(options.enabled)
  const listAssetsRef = useRef(options.listAssets)
  const downloadAssetRef = useRef(options.downloadAsset)
  const onFileRef = useRef(options.onFile)
  const onPersistedFileIDsRef = useRef(options.onPersistedFileIDs)
  const sessionRef = useRef<WhiteboardAssetHydrationSession>(createSession(options.ownerKey))

  ownerKeyRef.current = options.ownerKey
  enabledRef.current = options.enabled
  listAssetsRef.current = options.listAssets
  downloadAssetRef.current = options.downloadAsset
  onFileRef.current = options.onFile
  onPersistedFileIDsRef.current = options.onPersistedFileIDs

  const ensureSession = useCallback(() => {
    const current = sessionRef.current
    if (current.ownerKey === ownerKeyRef.current) return current
    current.controller.abort()
    const next = createSession(ownerKeyRef.current)
    sessionRef.current = next
    setProgress(IDLE_PROGRESS)
    return next
  }, [])

  const publish = useCallback((session: WhiteboardAssetHydrationSession) => {
    if (session !== sessionRef.current || session.controller.signal.aborted) return
    const total = session.known.size
    const loaded = session.hydrated.size
    const failed = session.failed.size
    const hasPending = session.pending.size > 0 || session.active.size > 0 || session.running
    const online = typeof navigator === 'undefined' || navigator.onLine
    const phase: WhiteboardAssetHydrationProgress['phase'] = !online && hasPending
      ? 'offline'
      : hasPending
        ? 'loading'
        : failed > 0
          ? 'error'
          : total > 0
            ? 'complete'
            : 'idle'
    setProgress({ phase, total, loaded, failed })
  }, [])

  const pump = useCallback(async () => {
    const session = ensureSession()
    if (!enabledRef.current || session.running || session.controller.signal.aborted) {
      publish(session)
      return
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      publish(session)
      return
    }
    session.running = true
    publish(session)
    try {
      while (enabledRef.current && !session.controller.signal.aborted) {
        const batch = session.pendingOrder.filter(fileID => session.pending.delete(fileID))
        session.pendingOrder = []
        if (!batch.length) break
        batch.forEach(fileID => session.active.add(fileID))
        publish(session)

        let manifest: { assets: WhiteboardHydrationAsset[]; error?: string }
        try {
          manifest = await listAssetsRef.current(batch, session.controller.signal)
        } catch (error) {
          if (session.controller.signal.aborted) throw whiteboardAbortError()
          manifest = {
            assets: [],
            error: error instanceof Error ? error.message : 'No se pudo cargar el manifiesto de imágenes.',
          }
        }
        if (session.controller.signal.aborted) throw whiteboardAbortError()
        const assets = manifest.assets.filter(asset => asset.kind === 'asset' && batch.includes(asset.file_id))
        const assetsByFileID = new Map(assets.map(asset => [asset.file_id, asset]))
        onPersistedFileIDsRef.current?.(assets.map(asset => asset.file_id))
        for (const fileID of batch) {
          if (assetsByFileID.has(fileID)) continue
          session.active.delete(fileID)
          session.failed.add(fileID)
        }
        publish(session)

        await mapWhiteboardConcurrently(batch, WHITEBOARD_ASSET_DOWNLOAD_CONCURRENCY, async fileID => {
          const asset = assetsByFileID.get(fileID)
          if (!asset) return
          try {
            const response = await downloadAssetRef.current(asset, session.controller.signal)
            if (session.controller.signal.aborted) throw whiteboardAbortError()
            if (!response.blob) throw new Error(response.error || 'No se pudo descargar la imagen.')
            const file: WhiteboardBinaryFile = {
              id: asset.file_id,
              dataURL: await blobToDataURL(response.blob, session.controller.signal),
              mimeType: asset.content_type,
              created: Date.parse(asset.created_at) || Date.now(),
            }
            if (session.controller.signal.aborted) throw whiteboardAbortError()
            onFileRef.current(file as BinaryFileData)
            session.hydrated.add(fileID)
            session.failed.delete(fileID)
          } catch (error) {
            if (session.controller.signal.aborted) throw error
            session.failed.add(fileID)
          } finally {
            session.active.delete(fileID)
            publish(session)
          }
        }, session.controller.signal)
      }
    } catch {
      if (!session.controller.signal.aborted) {
        for (const fileID of Array.from(session.active)) session.failed.add(fileID)
        session.active.clear()
      }
    } finally {
      session.running = false
      publish(session)
      if (enabledRef.current && session.pending.size > 0 && !session.controller.signal.aborted) void pump()
    }
  }, [ensureSession, publish])

  const request = useCallback((elements: readonly unknown[], visibleBounds?: WhiteboardSceneBounds | null) => {
    const session = ensureSession()
    for (const fileID of prioritizedWhiteboardFileIDs(elements, visibleBounds)) {
      if (session.known.has(fileID)) continue
      session.known.add(fileID)
      session.pending.add(fileID)
      session.pendingOrder.push(fileID)
    }
    publish(session)
    void pump()
  }, [ensureSession, publish, pump])

  const retry = useCallback(() => {
    const session = ensureSession()
    for (const fileID of Array.from(session.failed)) {
      if (session.hydrated.has(fileID) || session.pending.has(fileID) || session.active.has(fileID)) continue
      session.pending.add(fileID)
      session.pendingOrder.push(fileID)
    }
    session.failed.clear()
    publish(session)
    void pump()
  }, [ensureSession, publish, pump])

  useEffect(() => {
    const session = ensureSession()
    if (options.enabled) void pump()
    else publish(session)
  }, [ensureSession, options.enabled, options.ownerKey, publish, pump])

  useEffect(() => {
    const onOnline = () => retry()
    const onOffline = () => publish(ensureSession())
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [ensureSession, publish, retry])

  useEffect(() => () => {
    sessionRef.current.controller.abort()
  }, [])

  return { progress, request, retry }
}
