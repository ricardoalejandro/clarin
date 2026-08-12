'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { exportToSvg } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types'
import { Clock3, Eye, Loader2, RefreshCw, RotateCcw, Save, X } from 'lucide-react'
import type { WhiteboardSceneDocument, WhiteboardSceneRecord, WhiteboardVersion } from '@/lib/whiteboards'
import {
  downloadWhiteboardRevisionAsset,
  listWhiteboardRevisionAssets,
  listWhiteboardVersions,
  loadWhiteboardRevision,
  restoreWhiteboardVersion,
} from '@/lib/whiteboardsApi'
import { blobToDataURL, referencedWhiteboardFileIDs, sanitizeWhiteboardSvg, type WhiteboardBinaryFile } from '@/lib/whiteboardMedia'
import { mapWhiteboardConcurrently, whiteboardAbortError } from '@/lib/whiteboardAsync'
import WhiteboardModal from './WhiteboardModal'

function versionLabel(version: WhiteboardVersion) {
  if (version.write_kind === 'create') return 'Inicial'
  if (version.write_kind === 'restore') return 'Restauración'
  if (version.revision_kind === 'manual') return 'Manual'
  if (version.revision_kind === 'automatic') return 'Automática'
  return 'Sistema'
}

function formatRevisionSize(size: number | undefined) {
  if (!size || size < 1) return null
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function versionRetention(version: WhiteboardVersion) {
  if (version.revision_kind !== 'automatic') return 'Se conserva'
  if (!version.expires_at) return 'Retención de 30 días'
  return `Se elimina el ${new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(version.expires_at))}`
}

function canonicalRevisionScene(value: unknown): WhiteboardSceneDocument {
  const parsed = typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : value as Record<string, unknown>
  return {
    type: 'excalidraw',
    version: 2,
    source: 'clarin',
    elements: Array.isArray(parsed?.elements) ? parsed.elements : [],
    appState: parsed?.appState && typeof parsed.appState === 'object' ? parsed.appState as Record<string, unknown> : {},
    files: {},
  }
}

interface RevisionPreview {
  version: WhiteboardVersion
  url: string
  warning: string | null
}

export default function WhiteboardHistoryDialog({
  boardID,
  sequence,
  canRestore,
  onCreateCheckpoint,
  onRestored,
  onClose,
}: {
  boardID: string
  sequence: number
  canRestore: boolean
  onCreateCheckpoint: () => Promise<{ success: boolean; error?: string }>
  onRestored: (scene: WhiteboardSceneRecord) => void
  onClose: () => void
}) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [versions, setVersions] = useState<WhiteboardVersion[]>([])
  const [versionsHaveMore, setVersionsHaveMore] = useState(false)
  const [versionsLoadingMore, setVersionsLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyID, setBusyID] = useState<string | null>(null)
  const [previewBusyID, setPreviewBusyID] = useState<string | null>(null)
  const [checkpointSaving, setCheckpointSaving] = useState(false)
  const [preview, setPreview] = useState<RevisionPreview | null>(null)
  const previewControllerRef = useRef<AbortController | null>(null)
  const previewURLRef = useRef<string | null>(null)
  const versionsControllerRef = useRef<AbortController | null>(null)
  const versionsGenerationRef = useRef(0)

  const clearPreview = useCallback(() => {
    previewControllerRef.current?.abort()
    previewControllerRef.current = null
    if (previewURLRef.current) URL.revokeObjectURL(previewURLRef.current)
    previewURLRef.current = null
    setPreview(null)
    setPreviewBusyID(null)
  }, [])

  const load = useCallback(async (input: { append?: boolean; beforeSequence?: number | null } = {}) => {
    versionsControllerRef.current?.abort()
    const controller = new AbortController()
    versionsControllerRef.current = controller
    const generation = ++versionsGenerationRef.current
    if (input.append) setVersionsLoadingMore(true)
    else {
      setVersionsLoadingMore(false)
      setPhase('loading')
    }
    setError(null)
    const response = await listWhiteboardVersions(boardID, {
      beforeSequence: input.beforeSequence,
      signal: controller.signal,
    })
    if (controller.signal.aborted || generation !== versionsGenerationRef.current) return
    setVersionsLoadingMore(false)
    if (!response.success) {
      setError(response.status === 403 ? 'No tienes permiso para ver el historial.' : response.error || 'No se pudo cargar el historial.')
      if (!input.append) setPhase('error')
      return
    }
    const incoming = response.data?.revisions || []
    setVersions(current => input.append
      ? [...current, ...incoming.filter(version => !current.some(item => item.id === version.id))]
      : incoming)
    setVersionsHaveMore(Boolean(response.data?.has_more))
    setPhase('ready')
  }, [boardID])

  useEffect(() => {
    void load()
    return () => {
      versionsControllerRef.current?.abort()
      versionsGenerationRef.current += 1
      previewControllerRef.current?.abort()
      if (previewURLRef.current) URL.revokeObjectURL(previewURLRef.current)
    }
  }, [load])

  const loadMoreVersions = async () => {
    const last = versions[versions.length - 1]
    if (!last || !versionsHaveMore || versionsLoadingMore) return
    await load({ append: true, beforeSequence: last.sequence })
  }

  const openPreview = async (version: WhiteboardVersion) => {
    previewControllerRef.current?.abort()
    const controller = new AbortController()
    previewControllerRef.current = controller
    setPreviewBusyID(version.id)
    setError(null)
    try {
      const revisionResponse = await loadWhiteboardRevision(boardID, version.id, controller.signal)
      if (!revisionResponse.success || revisionResponse.data?.scene === undefined) {
        if (revisionResponse.status === 404 && version.revision_kind === 'automatic') {
          await load()
          throw new Error('Esta versión automática ya venció y fue depurada. El historial se actualizó con las versiones disponibles.')
        }
        throw new Error(revisionResponse.error || 'No se pudo cargar esta versión.')
      }
      const scene = canonicalRevisionScene(revisionResponse.data.scene)
      const fileIDs = referencedWhiteboardFileIDs(scene.elements)
      const assetsResponse = await listWhiteboardRevisionAssets(boardID, version.id, fileIDs, controller.signal)
      if (!assetsResponse.success || !assetsResponse.data) {
        throw new Error(assetsResponse.error || 'No se pudo cargar el inventario histórico de recursos.')
      }

      const files: Record<string, WhiteboardBinaryFile> = {}
      const manifest = assetsResponse.data.assets.filter(asset => asset.kind === 'asset')
      const outcomes = await mapWhiteboardConcurrently(manifest, 4, async asset => {
        const download = await downloadWhiteboardRevisionAsset(boardID, version.id, asset.id, controller.signal)
        if (controller.signal.aborted) throw whiteboardAbortError()
        if (!download.success || !download.blob) {
          return { asset, file: null }
        }
        try {
          const file: WhiteboardBinaryFile = {
            id: asset.file_id,
            dataURL: await blobToDataURL(download.blob, controller.signal),
            mimeType: asset.content_type,
            created: Date.parse(asset.created_at) || Date.now(),
          }
          return { asset, file }
        } catch (downloadError) {
          if (controller.signal.aborted) throw downloadError
          return { asset, file: null }
        }
      }, controller.signal)
      if (controller.signal.aborted) return
      let failures = fileIDs.length - new Set(manifest.map(asset => asset.file_id)).size
      for (const outcome of outcomes) {
        if (!outcome.file) {
          failures += 1
          continue
        }
        files[outcome.asset.file_id] = outcome.file
      }

      const svg = await exportToSvg({
        elements: scene.elements.filter(element => !(element as { isDeleted?: boolean }).isDeleted) as readonly ExcalidrawElement[],
        appState: scene.appState as unknown as AppState,
        files: files as unknown as BinaryFiles,
        renderEmbeddables: false,
        skipInliningFonts: true,
      })
      if (controller.signal.aborted) return
      const safeMarkup = sanitizeWhiteboardSvg(new XMLSerializer().serializeToString(svg))
      const url = URL.createObjectURL(new Blob([safeMarkup], { type: 'image/svg+xml' }))
      if (previewURLRef.current) URL.revokeObjectURL(previewURLRef.current)
      previewURLRef.current = url
      setPreview({
        version,
        url,
        warning: failures > 0 ? `${failures} recursos históricos referenciados no pudieron cargarse en la vista previa.` : null,
      })
    } catch (previewError) {
      if (!controller.signal.aborted) {
        setError(previewError instanceof Error ? previewError.message : 'No se pudo visualizar esta versión.')
      }
    } finally {
      if (previewControllerRef.current === controller) {
        previewControllerRef.current = null
        setPreviewBusyID(null)
      }
    }
  }

  const restore = async (version: WhiteboardVersion) => {
    if (busyID || !canRestore) return
    setBusyID(version.id)
    setError(null)
    const response = await restoreWhiteboardVersion(boardID, version.id, sequence)
    setBusyID(null)
    if (!response.success || !response.data?.result.scene) {
      setError(response.status === 409 ? 'La pizarra cambió en otra sesión. Cierra el historial y actualiza antes de restaurar.' : response.error || 'No se pudo restaurar la versión.')
      return
    }
    onRestored(response.data.result.scene)
    onClose()
  }

  const createCheckpoint = async () => {
    if (!canRestore || checkpointSaving || busyID) return
    setCheckpointSaving(true)
    setError(null)
    const result = await onCreateCheckpoint()
    setCheckpointSaving(false)
    if (!result.success) {
      setError(result.error || 'No se pudo guardar la versión actual.')
      return
    }
    await load()
  }

  return <WhiteboardModal title="Historial de versiones" description="Las versiones automáticas duran 30 días; las manuales, iniciales y restauraciones se conservan hasta eliminar definitivamente la pizarra." onClose={onClose} wide>
    {phase === 'loading' && <div className="flex min-h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /><span className="sr-only">Cargando historial</span></div>}
    {phase === 'error' && <div className="flex min-h-64 flex-col items-center justify-center p-6 text-center"><p className="text-sm text-rose-700">{error}</p><button type="button" onClick={() => void load()} className="mt-4 flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white"><RefreshCw className="h-4 w-4" />Reintentar</button></div>}
    {phase === 'ready' && <div className="p-4 sm:p-5">
      {error && <p className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{error}</p>}
      <div className="mb-4 rounded-2xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-xs leading-5 text-sky-900"><p className="font-black">Retención clara y controlada</p><p>Los guardados automáticos se depuran a los 30 días. Los puntos manuales, la versión inicial y las restauraciones permanecen. Las imágenes se referencian desde cada versión y no se duplican por cada guardado.</p></div>
      {canRestore && <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3"><div className="min-w-0 flex-1"><p className="text-sm font-black text-emerald-950">Crear punto de versión</p><p className="mt-0.5 text-xs leading-5 text-emerald-800">Confirma primero cualquier cambio pendiente y guarda una revisión manual inmutable.</p></div><button type="button" onClick={() => void createCheckpoint()} disabled={checkpointSaving || Boolean(busyID)} className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-700 px-3 text-xs font-black text-white disabled:opacity-40">{checkpointSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Guardar versión actual</button></div>}
      {preview && <section className="mb-4 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50" aria-label={`Vista previa de la versión ${preview.version.revision_number}`}>
        <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-3 py-2"><div className="min-w-0 flex-1"><p className="text-xs font-black text-slate-800">Vista previa · Versión {preview.version.revision_number}</p><p className="text-[10px] text-slate-500">Recursos del manifest histórico de esta versión</p></div><button type="button" onClick={clearPreview} className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100" aria-label="Cerrar vista previa"><X className="h-4 w-4" /></button></div>
        <div className="flex h-72 items-center justify-center overflow-hidden bg-white p-3"><img src={preview.url} alt={`Contenido de la versión ${preview.version.revision_number}`} className="h-full w-full object-contain" /></div>
        {preview.warning && <p className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{preview.warning}</p>}
      </section>}
      {!versions.length ? <div className="flex min-h-52 flex-col items-center justify-center text-center"><Clock3 className="h-8 w-8 text-slate-300" /><p className="mt-3 text-sm font-bold text-slate-700">Aún no hay versiones guardadas.</p></div> : <div className="space-y-2">{versions.map(version => {
        const size = formatRevisionSize(version.snapshot_size_bytes)
        return <article key={version.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 p-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500"><Clock3 className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="text-sm font-black text-slate-800">Versión {version.revision_number}</p><p className="mt-0.5 text-xs text-slate-500">{versionLabel(version)} · {new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(version.created_at))}</p><p className="mt-1 text-[11px] font-semibold text-slate-500">{versionRetention(version)}{size ? ` · ${size}` : ''}</p></div><div className="flex gap-2"><button type="button" onClick={() => void openPreview(version)} disabled={Boolean(previewBusyID)} className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 px-3 text-xs font-black text-slate-600 hover:bg-slate-50 disabled:opacity-35">{previewBusyID === version.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}Ver</button><button type="button" onClick={() => void restore(version)} disabled={!canRestore || Boolean(busyID)} title={!canRestore ? 'Necesitas permiso de edición para restaurar.' : undefined} className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 px-3 text-xs font-black text-slate-600 hover:bg-slate-50 disabled:opacity-35">{busyID === version.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}Restaurar</button></div></article>
      })}</div>}
      {versionsHaveMore && <div className="mt-4 flex justify-center"><button type="button" onClick={() => void loadMoreVersions()} disabled={versionsLoadingMore} className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-xs font-black text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40">{versionsLoadingMore && <Loader2 className="h-4 w-4 animate-spin" />}Cargar versiones anteriores</button></div>}
    </div>}
  </WhiteboardModal>
}
