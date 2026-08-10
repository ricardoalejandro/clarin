'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  Check,
  Clock3,
  CloudOff,
  Download,
  FileImage,
  FileJson,
  FileUp,
  History,
  LibraryBig,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Save,
  Share2,
  ShieldAlert,
  WifiOff,
} from 'lucide-react'
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  exportToBlob,
  exportToSvg,
  getLibraryItemsHash,
  loadFromBlob,
  loadLibraryFromBlob,
  mergeLibraryItems,
  reconcileElements,
  restoreLibraryItems,
  serializeAsJSON,
  serializeLibraryAsJSON,
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI, LibraryItems } from '@excalidraw/excalidraw/types'
import {
  combineWhiteboardLibraryItems,
  buildWhiteboardRealtimePatch,
  buildWhiteboardSceneWritePlan,
  createWhiteboardOperationID,
  hasWhiteboardDocumentMutation,
  mergeWhiteboardAcknowledgedElements,
  mergeWhiteboardFileRecords,
  parseWhiteboardLibraryItems,
  personalWhiteboardLibraryItems,
  reconcileWhiteboardCollaborators,
  reconcileWhiteboardCanonicalAck,
  reconcileWhiteboardLibraryConflict,
  retainWhiteboardPendingSave,
  sanitizeWhiteboardAppState,
  sanitizeWhiteboardExternalLink,
  sanitizeWhiteboardFilesForPersistence,
  selectWhiteboardPersonalLibrary,
  shouldRetryWhiteboardDirtySave,
  shouldApplyWhiteboardRealtimeEvent,
  isWhiteboardSceneSequence,
  WHITEBOARD_AUTOSAVE_DELAY_MS,
  whiteboardEditorLayout,
  whiteboardSaveFailureAction,
  whiteboardSaveRetryDelay,
  whiteboardThumbnailDelay,
  whiteboardFileName,
  whiteboardNavigationAction,
  whiteboardNavigationWritesCovered,
  whiteboardPersonalLibraryStorageName,
  whiteboardSceneRootExtensions,
  type WhiteboardCollaboratorState,
  type WhiteboardEditorLayout,
  type WhiteboardLibraryRecord,
  type WhiteboardRealtimeEvent,
  type WhiteboardSavePayload,
  type WhiteboardSceneDocument,
  type WhiteboardScenePatch,
  type WhiteboardSceneRecord,
  type WhiteboardSummary,
} from '@/lib/whiteboards'
import {
  buildExcalidrawWhiteboardSavePayload,
  restoreClarinWhiteboardScene,
} from '@/lib/whiteboardExcalidrawAdapter'
import {
  archiveWhiteboardLibrary,
  collectWhiteboardLibraryPages,
  downloadWhiteboardAsset,
  connectWhiteboardRoom,
  createWhiteboardVersion,
  createWhiteboardLibrary,
  getWhiteboardCurrentActor,
  getWhiteboardLibrary,
  listWhiteboardAssets,
  listWhiteboardLibraries,
  loadWhiteboardMetadata,
  loadWhiteboardScene,
  requestWhiteboardCollabTicket,
  saveWhiteboard,
  updateWhiteboard,
  updateWhiteboardLibrary,
  uploadWhiteboardAsset,
  uploadWhiteboardThumbnail,
  type WhiteboardRealtimeRoom,
} from '@/lib/whiteboardsApi'
import {
  blobToDataURL,
  dataURLToBlob,
  rasterizeWhiteboardFiles,
  referencedWhiteboardFileIDs,
  type WhiteboardBinaryFile,
} from '@/lib/whiteboardMedia'
import { mapWhiteboardConcurrently, whiteboardAbortError } from '@/lib/whiteboardAsync'
import { whiteboardEditorAssetBase } from '@/lib/whiteboardEditorAssets'
import { excalidrawWhiteboardCollaborators } from '@/lib/whiteboardPresence'
import { renderBlockedWhiteboardEmbeddable } from '@/lib/whiteboardEmbeds'
import {
  downloadWhiteboardLibraryAsset,
  listWhiteboardLibraryAssets,
  uploadWhiteboardLibraryAsset,
} from '@/lib/whiteboardLibraryAssets'
import {
  buildWhiteboardCatalogImportPlan,
  whiteboardCatalogFilename,
  whiteboardLibraryDocument,
  whiteboardLibraryElements,
} from '@/lib/whiteboardLibraryCatalog'
import WhiteboardHistoryDialog from './WhiteboardHistoryDialog'
import WhiteboardLibraryDialog, {
  type WhiteboardLibraryCatalogBusyState,
  type WhiteboardLibraryCatalogDraft,
  type WhiteboardLibraryCatalogSummary,
  type WhiteboardLibrarySaveState,
} from './WhiteboardLibraryDialog'
import WhiteboardShareDialog from './WhiteboardShareDialog'

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}

type SaveState = 'saved' | 'pending' | 'saving' | 'offline' | 'error' | 'conflict'
type EditorPhase = 'loading' | 'ready' | 'error'

interface LatestScene {
  elements: readonly ExcalidrawElement[]
  appState: AppState
  files: BinaryFiles
}

interface PendingWhiteboardSave {
  operationID: string
  payload: WhiteboardSavePayload
  realtimePatch: WhiteboardScenePatch | null
  capturedVersion: number
  capturedElements: readonly unknown[]
  capturedAppState: Record<string, unknown>
  automaticFailures: number
  automaticRetryBlocked: boolean
  notFoundDiagnosed: boolean
}

interface LoadedWhiteboardLibraries {
  personal: WhiteboardLibraryRecord
  personalItems: LibraryItems
  catalogItems: LibraryItems[]
  catalogSummaries: WhiteboardLibraryCatalogSummary[]
  combinedItems: LibraryItems
  readOnlyItemIDs: Set<string>
  files: BinaryFiles
  warning: string | null
}

function errorMessage(status?: number, fallback?: string) {
  if (status === 403) return 'No tienes permiso para editar esta pizarra.'
  if (status === 404) return 'La pizarra no existe o ya no está disponible para tu usuario.'
  if (status === 409) return 'La pizarra cambió en otra sesión.'
  return fallback || 'No se pudo completar la operación.'
}

function restoredWhiteboardLibraryItems(value: unknown): LibraryItems {
  try {
    return restoreLibraryItems(parseWhiteboardLibraryItems(value) as never, 'unpublished')
  } catch {
    return []
  }
}

function extensionForMimeType(mimeType: string) {
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  return 'gif'
}

async function hydrateWhiteboardLibraryFiles(
  libraryID: string,
  items: LibraryItems,
  signal?: AbortSignal,
) {
  const referencedFileIDs = referencedWhiteboardFileIDs(whiteboardLibraryElements(items))
  if (referencedFileIDs.length === 0) return { files: {} as BinaryFiles, failures: 0 }
  const manifestResponse = await listWhiteboardLibraryAssets(libraryID, { referencedFileIDs, signal })
  if (!manifestResponse.success || !manifestResponse.data) {
    return { files: {} as BinaryFiles, failures: referencedFileIDs.length }
  }
  const assetsByFileID = new Map(manifestResponse.data.assets.map(asset => [asset.file_id, asset]))
  let failures = referencedFileIDs.filter(fileID => !assetsByFileID.has(fileID)).length
  const files: Record<string, WhiteboardBinaryFile> = {}
  const outcomes = await mapWhiteboardConcurrently(referencedFileIDs, 4, async fileID => {
    const asset = assetsByFileID.get(fileID)
    if (!asset) return null
    const response = await downloadWhiteboardLibraryAsset(libraryID, asset.id, signal)
    if (!response.success || !response.blob) return null
    return {
      id: fileID,
      dataURL: await blobToDataURL(response.blob, signal),
      mimeType: asset.content_type,
      created: Date.parse(asset.created_at) || Date.now(),
    } satisfies WhiteboardBinaryFile
  }, signal)
  for (const outcome of outcomes) {
    if (!outcome) {
      failures += 1
      continue
    }
    files[outcome.id] = outcome
  }
  return { files: files as unknown as BinaryFiles, failures }
}

async function emptyWhiteboardThumbnail(backgroundColor: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 400
  const context = canvas.getContext('2d')
  if (!context) throw new Error('El navegador no permite crear la miniatura.')
  context.fillStyle = /^#[0-9a-f]{6}$/i.test(backgroundColor) ? backgroundColor : '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('No se pudo crear la miniatura.')), 'image/png', 0.86)
  })
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function SaveIndicator({ state, showLabel = true }: { state: SaveState; showLabel?: boolean }) {
  const presentation = {
    saved: { label: 'Guardado en Clarin', icon: Check, tone: 'text-emerald-700 bg-emerald-50 border-emerald-100' },
    pending: { label: 'Cambios pendientes', icon: Clock3, tone: 'text-amber-700 bg-amber-50 border-amber-100' },
    saving: { label: 'Guardando en Clarin', icon: Loader2, tone: 'text-sky-700 bg-sky-50 border-sky-100' },
    offline: { label: 'No guardado · Reintentar', icon: WifiOff, tone: 'text-slate-600 bg-slate-100 border-slate-200' },
    error: { label: 'No guardado · Reintentar', icon: CloudOff, tone: 'text-rose-700 bg-rose-50 border-rose-100' },
    conflict: { label: 'No guardado · Reintentar', icon: ShieldAlert, tone: 'text-rose-700 bg-rose-50 border-rose-100' },
  }[state]
  return <span title={presentation.label} aria-label={presentation.label} className={`inline-flex h-9 items-center gap-2 rounded-xl border px-2.5 text-xs font-bold ${presentation.tone}`}><presentation.icon className={`h-3.5 w-3.5 ${state === 'saving' ? 'animate-spin' : ''}`} />{showLabel ? <span className="hidden sm:inline">{presentation.label}</span> : null}<span className={showLabel ? 'sr-only sm:hidden' : 'sr-only'}>{presentation.label}</span></span>
}

export default function WhiteboardEditor({ boardID }: { boardID: string }) {
  const router = useRouter()
  const editorShellRef = useRef<HTMLDivElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const libraryImportInputRef = useRef<HTMLInputElement>(null)
  const editorAPIRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const latestSceneRef = useRef<LatestScene | null>(null)
  const sequenceRef = useRef(0)
  const lastOperationIDRef = useRef<string | null>(null)
  const acknowledgedElementsRef = useRef<readonly unknown[]>([])
  const acknowledgedAppStateRef = useRef<Record<string, unknown>>({})
  const sceneRootExtensionsRef = useRef<Record<string, unknown>>({})
  const sceneFileMetadataRef = useRef<Record<string, unknown>>({})
  const roomRef = useRef<WhiteboardRealtimeRoom | null>(null)
  const canonicalSyncControllerRef = useRef<AbortController | null>(null)
  const canonicalSyncGenerationRef = useRef(0)
  const canonicalSyncAppliedSequenceRef = useRef(-1)
  const canonicalSyncLoadingSequenceRef = useRef(-1)
  const uploadedFileIDsRef = useRef(new Set<string>())
  const assetHydrationControllerRef = useRef<AbortController | null>(null)
  const assetHydrationGenerationRef = useRef(0)
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const thumbnailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const thumbnailSavingRef = useRef(false)
  const lastThumbnailAttemptAtRef = useRef(0)
  const thumbnailAttemptedSequenceRef = useRef(-1)
  const thumbnailScheduledSequenceRef = useRef(-1)
  const savingRef = useRef(false)
  const queuedSaveRef = useRef(false)
  const pendingSaveRef = useRef<PendingWhiteboardSave | null>(null)
  const changeVersionRef = useRef(0)
  const lastSavedChangeVersionRef = useRef(0)
  const dirtyRef = useRef(false)
  const suppressChangesRef = useRef(true)
  const transientSceneSuppressionRef = useRef(0)
  const navigationInProgressRef = useRef(false)
  const mountedRef = useRef(true)
  const collaboratorsRef = useRef(new Map<string, WhiteboardCollaboratorState>())
  const personalLibraryRef = useRef<WhiteboardLibraryRecord | null>(null)
  const personalLibraryItemsRef = useRef<LibraryItems>([])
  const catalogLibraryItemsRef = useRef<LibraryItems[]>([])
  const readOnlyLibraryItemIDsRef = useRef(new Set<string>())
  const suppressLibraryChangesRef = useRef(true)
  const librarySaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const librarySavingRef = useRef(false)
  const libraryQueuedSaveRef = useRef(false)
  const libraryChangeVersionRef = useRef(0)
  const lastSavedLibraryChangeVersionRef = useRef(0)
  const libraryConflictRef = useRef(false)
  const libraryDirtyRef = useRef(false)
  const libraryLoadControllerRef = useRef<AbortController | null>(null)
  const libraryLoadGenerationRef = useRef(0)

  const [phase, setPhase] = useState<EditorPhase>('loading')
  const [board, setBoard] = useState<WhiteboardSummary | null>(null)
  const [initialData, setInitialData] = useState<{ elements: readonly ExcalidrawElement[]; appState: Partial<AppState>; files: BinaryFiles; libraryItems: LibraryItems } | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [error, setError] = useState<string | null>(null)
  const [assetWarning, setAssetWarning] = useState<string | null>(null)
  const [thumbnailWarning, setThumbnailWarning] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleSaving, setTitleSaving] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [librarySaveState, setLibrarySaveState] = useState<WhiteboardLibrarySaveState>('saved')
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [personalLibraryItemCount, setPersonalLibraryItemCount] = useState(0)
  const [libraryCatalogs, setLibraryCatalogs] = useState<WhiteboardLibraryCatalogSummary[]>([])
  const [libraryCatalogBusy, setLibraryCatalogBusy] = useState<WhiteboardLibraryCatalogBusyState | null>(null)
  const [libraryCatalogError, setLibraryCatalogError] = useState<string | null>(null)
  const [editorLayout, setEditorLayout] = useState<WhiteboardEditorLayout>('compact')
  const [editorAvailableWidth, setEditorAvailableWidth] = useState(0)
  const [moreOpen, setMoreOpen] = useState(false)
  const [moreMenuPosition, setMoreMenuPosition] = useState({ top: 60, right: 12 })

  const canEdit = Boolean(board?.effective_access?.can_edit) && !board?.archived_at
  const canManageAccess = Boolean(board?.effective_access?.can_manage_access) && !board?.archived_at
  const showIntegratedTitle = editorLayout === 'wide' || (editorLayout === 'compact' && editorAvailableWidth >= 1_100)

  useEffect(() => {
    if (phase !== 'ready') return
    const shell = editorShellRef.current
    if (!shell) return
    const update = () => {
      const width = shell.getBoundingClientRect().width
      setEditorAvailableWidth(width)
      setEditorLayout(whiteboardEditorLayout(width))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(shell)
    return () => observer.disconnect()
  }, [phase])

  useEffect(() => {
    if (!moreOpen) return
    const close = (event: Event) => {
      const target = event.target
      if (target instanceof Node && (moreButtonRef.current?.contains(target) || document.getElementById('whiteboard-more-menu')?.contains(target))) return
      setMoreOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMoreOpen(false)
      moreButtonRef.current?.focus()
    }
    const closeForViewportChange = () => setMoreOpen(false)
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', closeForViewportChange)
    window.addEventListener('scroll', closeForViewportChange, true)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', closeForViewportChange)
      window.removeEventListener('scroll', closeForViewportChange, true)
    }
  }, [moreOpen])

  const toggleMoreMenu = useCallback(() => {
    setMoreOpen(current => {
      if (current) return false
      const rect = moreButtonRef.current?.getBoundingClientRect()
      if (rect) {
        setMoreMenuPosition({
          top: Math.min(rect.bottom + 8, Math.max(12, window.innerHeight - 520)),
          right: Math.max(12, window.innerWidth - rect.right),
        })
      }
      return true
    })
  }, [])

  const runWithTransientSceneSuppressed = useCallback((update: () => void) => {
    transientSceneSuppressionRef.current += 1
    try {
      update()
    } finally {
      requestAnimationFrame(() => {
        transientSceneSuppressionRef.current = Math.max(0, transientSceneSuppressionRef.current - 1)
      })
    }
  }, [])

  const fetchLibraries = useCallback(async (signal?: AbortSignal): Promise<LoadedWhiteboardLibraries> => {
    const [actorResponse, listResponse] = await Promise.all([
      getWhiteboardCurrentActor(signal),
      collectWhiteboardLibraryPages(cursor => listWhiteboardLibraries(signal, '', cursor)),
    ])
    const actorID = actorResponse.data?.user?.id
    const actorIsAdmin = Boolean(actorResponse.data?.user?.is_admin)
    if (!actorResponse.success || !actorID) throw new Error(actorResponse.error || 'No se pudo identificar tu biblioteca privada.')
    if (!listResponse.success) throw new Error(listResponse.error || 'No se pudieron cargar las bibliotecas de Pizarras.')
    let libraries = listResponse.data?.libraries || []
    let personal = selectWhiteboardPersonalLibrary(libraries, actorID)
    if (!personal) {
      const storageName = whiteboardPersonalLibraryStorageName(actorID)
      const exactResponse = await collectWhiteboardLibraryPages(cursor => listWhiteboardLibraries(signal, storageName, cursor))
      if (exactResponse.success) {
        libraries = [...libraries, ...(exactResponse.data?.libraries || []).filter(item => !libraries.some(current => current.id === item.id))]
        personal = selectWhiteboardPersonalLibrary(libraries, actorID)
      }
      if (!personal && !signal?.aborted) {
        const created = await createWhiteboardLibrary({
          name: storageName,
          description: 'Biblioteca privada personal administrada por Clarin.',
          library_json: { libraryItems: [] },
          visibility: 'private',
        })
        if (created.success && created.data?.library) {
          personal = created.data.library
          libraries = [...libraries, personal]
        } else if (created.status === 409) {
          const raced = await collectWhiteboardLibraryPages(cursor => listWhiteboardLibraries(signal, storageName, cursor))
          if (raced.success) personal = selectWhiteboardPersonalLibrary(raced.data?.libraries || [], actorID)
        } else {
          throw new Error(created.error || 'No se pudo crear Mi biblioteca.')
        }
      }
    }
    if (!personal) throw new Error('No se pudo resolver Mi biblioteca después de una creación concurrente.')
    if (signal?.aborted) throw whiteboardAbortError()

    const catalogSummaries = libraries.filter(library => library.id !== personal?.id && !library.archived_at)
    const accountSummaries = catalogSummaries.filter(library => library.visibility === 'account')
    const requiredSummaries = [personal, ...accountSummaries.filter(library => library.id !== personal?.id)]
    const details = await mapWhiteboardConcurrently(requiredSummaries, 4, async summary => {
      if (summary.library_json !== undefined) return { summary, library: summary, error: null as string | null }
      const response = await getWhiteboardLibrary(summary.id, signal)
      if (signal?.aborted) throw whiteboardAbortError()
      if (!response.success || !response.data?.library) {
        return { summary, library: null, error: response.error || `No se pudo cargar ${summary.name}.` }
      }
      return { summary, library: response.data.library, error: null as string | null }
    }, signal)

    const personalDetail = details.find(item => item.summary.id === personal?.id)?.library
    if (!personalDetail) throw new Error('No se pudo cargar el contenido de Mi biblioteca.')
    const accountDetails = details
      .filter(item => item.summary.visibility === 'account' && item.library)
      .map(item => item.library as WhiteboardLibraryRecord)
    const failedCatalogs = details.filter(item => item.summary.visibility === 'account' && !item.library)
    const personalItems = restoredWhiteboardLibraryItems(personalDetail.library_json)
    const catalogItems = accountDetails.map(library => restoredWhiteboardLibraryItems(library.library_json))
    const libraryFileResults = await mapWhiteboardConcurrently([
      { library: personalDetail, items: personalItems },
      ...accountDetails.map((library, index) => ({ library, items: catalogItems[index] })),
    ], 4, entry => hydrateWhiteboardLibraryFiles(entry.library.id, entry.items, signal), signal)
    const libraryFiles = Object.assign({}, ...libraryFileResults.map(result => result.files)) as BinaryFiles
    const libraryFileFailures = libraryFileResults.reduce((total, result) => total + result.failures, 0)
    const composition = combineWhiteboardLibraryItems(personalItems, catalogItems)
    return {
      personal: personalDetail,
      personalItems,
      catalogItems,
      catalogSummaries: catalogSummaries.map(library => {
        const loadedIndex = accountDetails.findIndex(detail => detail.id === library.id)
        return {
          id: library.id,
          name: library.name,
          description: library.description,
          itemCount: loadedIndex >= 0 ? catalogItems[loadedIndex].length : library.item_count || 0,
          visibility: library.visibility,
          version: library.version,
          canManage: actorIsAdmin || library.created_by === actorID,
        }
      }),
      combinedItems: composition.combined,
      readOnlyItemIDs: composition.readOnlyItemIDs,
      files: libraryFiles,
      warning: [
        failedCatalogs.length ? `${failedCatalogs.length} bibliotecas compartidas no pudieron cargarse.` : '',
        libraryFileFailures ? `${libraryFileFailures} recursos de biblioteca no están disponibles.` : '',
      ].filter(Boolean).join(' ') || null,
    }
  }, [])

  const applyLibraryComposition = useCallback(async (personalItems: LibraryItems, catalogItems = catalogLibraryItemsRef.current) => {
    const composition = combineWhiteboardLibraryItems(personalItems, catalogItems)
    personalLibraryItemsRef.current = personalItems
    catalogLibraryItemsRef.current = catalogItems
    readOnlyLibraryItemIDsRef.current = composition.readOnlyItemIDs
    setPersonalLibraryItemCount(personalItems.length)
    const api = editorAPIRef.current
    if (api) {
      suppressLibraryChangesRef.current = true
      try {
        await api.updateLibrary({ libraryItems: composition.combined, merge: false, defaultStatus: 'unpublished', openLibraryMenu: false })
      } finally {
        suppressLibraryChangesRef.current = false
      }
    }
    return composition.combined
  }, [])

  const openElementLibrary = useCallback(() => {
    const api = editorAPIRef.current
    if (!api) return
    const composition = combineWhiteboardLibraryItems(personalLibraryItemsRef.current, catalogLibraryItemsRef.current)
    void api.updateLibrary({
      libraryItems: composition.combined,
      merge: false,
      defaultStatus: 'unpublished',
      openLibraryMenu: true,
    })
  }, [])

  const hydrateAssets = useCallback(async (elements: readonly unknown[], signal?: AbortSignal) => {
    assetHydrationControllerRef.current?.abort()
    const controller = new AbortController()
    assetHydrationControllerRef.current = controller
    const generation = ++assetHydrationGenerationRef.current
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const fileIDs = referencedWhiteboardFileIDs(elements)
      .filter(fileID => !uploadedFileIDsRef.current.has(fileID))
    try {
      if (!fileIDs.length) return { files: {} as BinaryFiles, warning: null as string | null }
      const response = await listWhiteboardAssets(boardID, fileIDs, controller.signal)
      if (controller.signal.aborted || generation !== assetHydrationGenerationRef.current) {
        return { files: {} as BinaryFiles, warning: null as string | null }
      }
      if (!response.success) {
        return { files: {} as BinaryFiles, warning: response.error || 'No se pudieron cargar los recursos referenciados.' }
      }
      const manifest = (response.data?.assets || []).filter(asset => asset.kind === 'asset')
      const outcomes = await mapWhiteboardConcurrently(manifest, 4, async asset => {
        const download = await downloadWhiteboardAsset(boardID, asset.id, controller.signal)
        if (controller.signal.aborted) throw whiteboardAbortError()
        if (!download.success || !download.blob) return { asset, file: null }
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
      if (controller.signal.aborted || generation !== assetHydrationGenerationRef.current) {
        return { files: {} as BinaryFiles, warning: null as string | null }
      }
      const files: Record<string, WhiteboardBinaryFile> = {}
      let failures = fileIDs.length - new Set(manifest.map(asset => asset.file_id)).size
      for (const outcome of outcomes) {
        if (!outcome.file) {
          failures += 1
          continue
        }
        files[outcome.asset.file_id] = outcome.file
        uploadedFileIDsRef.current.add(outcome.asset.file_id)
      }
      return {
        files: files as unknown as BinaryFiles,
        warning: failures > 0
          ? `${failures} recursos referenciados no están disponibles. La pizarra seguirá disponible sin ellos.`
          : null,
      }
    } catch (loadError) {
      if (controller.signal.aborted) return { files: {} as BinaryFiles, warning: null as string | null }
      return {
        files: {} as BinaryFiles,
        warning: loadError instanceof Error ? loadError.message : 'No se pudieron cargar los recursos referenciados.',
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      if (assetHydrationControllerRef.current === controller) assetHydrationControllerRef.current = null
    }
  }, [boardID])

  const load = useCallback(async (signal?: AbortSignal) => {
    setPhase('loading')
    setError(null)
    setAssetWarning(null)
    uploadedFileIDsRef.current = new Set()
    canonicalSyncControllerRef.current?.abort()
    canonicalSyncAppliedSequenceRef.current = -1
    canonicalSyncLoadingSequenceRef.current = -1
    const [metadataResponse, sceneResponse] = await Promise.all([
      loadWhiteboardMetadata(boardID, signal),
      loadWhiteboardScene(boardID, signal),
    ])
    if (!metadataResponse.success || !metadataResponse.data?.whiteboard) {
      setError(errorMessage(metadataResponse.status, metadataResponse.error))
      setPhase('error')
      return
    }
    if (!sceneResponse.success || !sceneResponse.data?.scene) {
      setError(errorMessage(sceneResponse.status, sceneResponse.error))
      setPhase('error')
      return
    }
    const metadata = metadataResponse.data.whiteboard
    const record = sceneResponse.data.scene
    const scene = restoreClarinWhiteboardScene(record.scene)
    sceneRootExtensionsRef.current = whiteboardSceneRootExtensions(scene)
    sceneFileMetadataRef.current = sanitizeWhiteboardFilesForPersistence(scene.files)
    const [assets, libraryResult] = await Promise.all([
      hydrateAssets(scene.elements, signal),
      fetchLibraries(signal).then(value => ({ value, error: null as string | null })).catch(loadError => ({
        value: null,
        error: loadError instanceof Error ? loadError.message : 'No se pudieron cargar las bibliotecas de Pizarras.',
      })),
    ])
    const hydratedFileIDs = new Set(Object.keys(assets.files))
    for (const fileID of Object.keys(libraryResult.value?.files || {})) hydratedFileIDs.add(fileID)
    const files = Object.fromEntries(Object.entries(mergeWhiteboardFileRecords(
      mergeWhiteboardFileRecords(scene.files, assets.files),
      libraryResult.value?.files as unknown as Record<string, unknown> | undefined,
    ))
      .filter(([fileID]) => hydratedFileIDs.has(fileID))) as unknown as BinaryFiles
    if (signal?.aborted) return
    uploadedFileIDsRef.current = new Set(Object.keys(assets.files))
    sequenceRef.current = record.sequence
    acknowledgedElementsRef.current = [...scene.elements]
    acknowledgedAppStateRef.current = sanitizeWhiteboardAppState(scene.appState)
    latestSceneRef.current = {
      elements: scene.elements as readonly ExcalidrawElement[],
      appState: scene.appState as unknown as AppState,
      files,
    }
    dirtyRef.current = false
    changeVersionRef.current = 0
    lastSavedChangeVersionRef.current = 0
    suppressChangesRef.current = true
    suppressLibraryChangesRef.current = true
    if (libraryResult.value) {
      personalLibraryRef.current = libraryResult.value.personal
      personalLibraryItemsRef.current = libraryResult.value.personalItems
      catalogLibraryItemsRef.current = libraryResult.value.catalogItems
      readOnlyLibraryItemIDsRef.current = libraryResult.value.readOnlyItemIDs
      libraryConflictRef.current = false
      libraryDirtyRef.current = false
      libraryChangeVersionRef.current = 0
      lastSavedLibraryChangeVersionRef.current = 0
      setPersonalLibraryItemCount(libraryResult.value.personalItems.length)
      setLibraryCatalogs(libraryResult.value.catalogSummaries)
      setLibrarySaveState(libraryResult.value.warning ? 'error' : 'saved')
      setLibraryError(libraryResult.value.warning)
    } else {
      personalLibraryRef.current = null
      libraryDirtyRef.current = false
      libraryChangeVersionRef.current = 0
      lastSavedLibraryChangeVersionRef.current = 0
      personalLibraryItemsRef.current = []
      catalogLibraryItemsRef.current = []
      readOnlyLibraryItemIDsRef.current = new Set()
      setPersonalLibraryItemCount(0)
      setLibraryCatalogs([])
      setLibrarySaveState('error')
      setLibraryError(libraryResult.error)
    }
    setBoard(metadata)
    setTitleDraft(metadata.name)
    setInitialData({
      elements: scene.elements as readonly ExcalidrawElement[],
      appState: scene.appState as Partial<AppState>,
      files,
      libraryItems: libraryResult.value?.combinedItems || [],
    })
    setAssetWarning(assets.warning)
    setSaveState('saved')
    setPhase('ready')
  }, [boardID, fetchLibraries, hydrateAssets])

  useEffect(() => {
    window.EXCALIDRAW_ASSET_PATH = whiteboardEditorAssetBase(window.location.origin)
    mountedRef.current = true
    const controller = new AbortController()
    void load(controller.signal)
    return () => {
      mountedRef.current = false
      controller.abort()
      assetHydrationControllerRef.current?.abort()
      assetHydrationGenerationRef.current += 1
      canonicalSyncControllerRef.current?.abort()
      canonicalSyncGenerationRef.current += 1
      libraryLoadControllerRef.current?.abort()
      libraryLoadGenerationRef.current += 1
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
      if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current)
      if (librarySaveTimerRef.current) clearTimeout(librarySaveTimerRef.current)
    }
  }, [load])

  useEffect(() => {
    if (phase !== 'ready' || !editorAPIRef.current) return
    const frame = requestAnimationFrame(() => {
      suppressChangesRef.current = false
      suppressLibraryChangesRef.current = false
    })
    return () => cancelAnimationFrame(frame)
  }, [phase, initialData])

  useEffect(() => {
    const onOnline = () => {
      if (dirtyRef.current) setSaveState('pending')
    }
    const onOffline = () => setSaveState('offline')
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current && !libraryDirtyRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [])

  const persistPersonalLibrary = useCallback(async (manual = false) => {
    if (librarySavingRef.current) {
      libraryQueuedSaveRef.current = true
      return
    }
    const library = personalLibraryRef.current
    if (!library || !libraryDirtyRef.current || (libraryConflictRef.current && !manual)) return
    librarySavingRef.current = true
    libraryQueuedSaveRef.current = false
    const capturedVersion = libraryChangeVersionRef.current
    const items = personalLibraryItemsRef.current
    setLibrarySaveState('saving')
    setLibraryError(null)
    try {
      const serialized = JSON.parse(serializeLibraryAsJSON(items)) as Record<string, unknown>
      const referencedFileIDs = referencedWhiteboardFileIDs(whiteboardLibraryElements(items))
      const manifestResponse = await listWhiteboardLibraryAssets(library.id, { referencedFileIDs })
      if (!manifestResponse.success || !manifestResponse.data) {
        throw new Error(manifestResponse.error || 'No se pudieron verificar los recursos de Mi biblioteca.')
      }
      const storedFileIDs = new Set(manifestResponse.data.assets.map(asset => asset.file_id))
      const currentFiles = latestSceneRef.current?.files || {}
      const filesForPersistence = sanitizeWhiteboardFilesForPersistence(currentFiles as unknown as Record<string, unknown>)
      for (const fileID of referencedFileIDs) {
        if (storedFileIDs.has(fileID)) continue
        const rawFile = currentFiles[fileID] as unknown as WhiteboardBinaryFile | undefined
        if (!rawFile?.dataURL) throw new Error('Mi biblioteca contiene una imagen cuyo binario local ya no está disponible.')
        const safeFiles = await rasterizeWhiteboardFiles({ [fileID]: rawFile }) as Record<string, WhiteboardBinaryFile>
        const safeFile = safeFiles[fileID]
        if (!safeFile?.dataURL) throw new Error('No se pudo preparar una imagen de Mi biblioteca.')
        const blob = dataURLToBlob(safeFile.dataURL)
        const upload = await uploadWhiteboardLibraryAsset(library.id, {
          fileID,
          blob,
          filename: `${fileID}.${extensionForMimeType(blob.type)}`,
        })
        if (!upload.success) throw new Error(upload.error || 'No se pudo guardar una imagen de Mi biblioteca.')
      }
      const response = await updateWhiteboardLibrary(library.id, {
        name: library.name,
        description: library.description,
        library_json: whiteboardLibraryDocument({
          ...whiteboardLibraryDocument(library.library_json),
          ...serialized,
          files: filesForPersistence,
        }),
        visibility: 'private',
        expected_version: library.version,
      })
      if (!response.success || !response.data?.library) {
        if (response.status === 409) {
          const canonicalResponse = await getWhiteboardLibrary(library.id)
          if (!canonicalResponse.success || !canonicalResponse.data?.library) {
            throw new Error(canonicalResponse.error || 'La biblioteca cambió y no se pudo recargar la versión actual.')
          }
          const canonical = canonicalResponse.data.library
          const canonicalItems = restoredWhiteboardLibraryItems(canonical.library_json)
          const reconciled = reconcileWhiteboardLibraryConflict(canonicalItems, personalLibraryItemsRef.current) as LibraryItems
          personalLibraryRef.current = canonical
          personalLibraryItemsRef.current = reconciled
          libraryConflictRef.current = true
          libraryDirtyRef.current = true
          libraryChangeVersionRef.current += 1
          await applyLibraryComposition(reconciled)
          setLibrarySaveState('conflict')
          setLibraryError('Mi biblioteca cambió en otra sesión. Clarin conservó la versión canónica y añadió sólo tus elementos nuevos; revisa y pulsa “Guardar conciliación”.')
          return
        }
        throw new Error(response.error || 'No se pudo guardar Mi biblioteca.')
      }
      personalLibraryRef.current = response.data.library
      lastSavedLibraryChangeVersionRef.current = Math.max(lastSavedLibraryChangeVersionRef.current, capturedVersion)
      libraryConflictRef.current = false
      const unchanged = capturedVersion === libraryChangeVersionRef.current
      libraryDirtyRef.current = !unchanged
      setLibrarySaveState(unchanged ? 'saved' : 'pending')
    } catch (saveError) {
      if (!mountedRef.current) return
      libraryDirtyRef.current = true
      setLibrarySaveState('error')
      setLibraryError(saveError instanceof Error ? saveError.message : 'No se pudo guardar Mi biblioteca.')
    } finally {
      librarySavingRef.current = false
      if (!libraryConflictRef.current && (libraryQueuedSaveRef.current || capturedVersion !== libraryChangeVersionRef.current)) {
        libraryQueuedSaveRef.current = false
        if (librarySaveTimerRef.current) clearTimeout(librarySaveTimerRef.current)
        librarySaveTimerRef.current = setTimeout(() => { void persistPersonalLibrary() }, 500)
      }
    }
  }, [applyLibraryComposition])

  const onLibraryChange = useCallback(async (items: LibraryItems) => {
    if (suppressLibraryChangesRef.current || !personalLibraryRef.current) return
    const personalItems = personalWhiteboardLibraryItems(items, readOnlyLibraryItemIDsRef.current) as LibraryItems
    const personalChanged = getLibraryItemsHash(personalItems) !== getLibraryItemsHash(personalLibraryItemsRef.current)
    const composition = combineWhiteboardLibraryItems(personalItems, catalogLibraryItemsRef.current)
    const needsCanonicalRestore = getLibraryItemsHash(items) !== getLibraryItemsHash(composition.combined)
    personalLibraryItemsRef.current = personalItems
    readOnlyLibraryItemIDsRef.current = composition.readOnlyItemIDs
    setPersonalLibraryItemCount(personalItems.length)
    if (needsCanonicalRestore) await applyLibraryComposition(personalItems)
    if (!personalChanged) return
    libraryChangeVersionRef.current += 1
    libraryDirtyRef.current = true
    setLibrarySaveState(libraryConflictRef.current ? 'conflict' : 'pending')
    if (libraryConflictRef.current) return
    if (librarySaveTimerRef.current) clearTimeout(librarySaveTimerRef.current)
    librarySaveTimerRef.current = setTimeout(() => { void persistPersonalLibrary() }, 800)
  }, [applyLibraryComposition, persistPersonalLibrary])

  const reloadLibraries = useCallback(async () => {
    libraryLoadControllerRef.current?.abort()
    const controller = new AbortController()
    libraryLoadControllerRef.current = controller
    const generation = ++libraryLoadGenerationRef.current
    setLibraryError(null)
    try {
      const loaded = await fetchLibraries(controller.signal)
      if (controller.signal.aborted || generation !== libraryLoadGenerationRef.current || !mountedRef.current) return
      const hadLocalChanges = libraryDirtyRef.current
      const personalItems = hadLocalChanges
        ? reconcileWhiteboardLibraryConflict(loaded.personalItems, personalLibraryItemsRef.current) as LibraryItems
        : loaded.personalItems
      personalLibraryRef.current = loaded.personal
      catalogLibraryItemsRef.current = loaded.catalogItems
      setLibraryCatalogs(loaded.catalogSummaries)
      if (Object.keys(loaded.files).length > 0) {
        editorAPIRef.current?.addFiles(Object.values(loaded.files) as BinaryFileData[])
        if (latestSceneRef.current) latestSceneRef.current = {
          ...latestSceneRef.current,
          files: { ...latestSceneRef.current.files, ...loaded.files },
        }
      }
      await applyLibraryComposition(personalItems, loaded.catalogItems)
      if (hadLocalChanges) {
        libraryConflictRef.current = true
        libraryDirtyRef.current = true
        libraryChangeVersionRef.current += 1
        setLibrarySaveState('conflict')
        setLibraryError('Se recargó la biblioteca canónica y se conciliaron tus elementos nuevos. Confirma el resultado antes de guardarlo.')
      } else {
        libraryConflictRef.current = false
        libraryDirtyRef.current = false
        setLibrarySaveState(loaded.warning ? 'error' : 'saved')
        setLibraryError(loaded.warning)
      }
    } catch (loadError) {
      if (controller.signal.aborted || generation !== libraryLoadGenerationRef.current || !mountedRef.current) return
      setLibrarySaveState('error')
      setLibraryError(loadError instanceof Error ? loadError.message : 'No se pudieron recargar las bibliotecas.')
    } finally {
      if (libraryLoadControllerRef.current === controller) libraryLoadControllerRef.current = null
    }
  }, [applyLibraryComposition, fetchLibraries])

  const importLibrary = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !personalLibraryRef.current) return
    if (!file.name.toLocaleLowerCase('en').endsWith('.excalidrawlib') || file.size > 8 * 1024 * 1024) {
      setLibrarySaveState('error')
      setLibraryError('Selecciona un archivo .excalidrawlib de hasta 8 MB.')
      setLibraryOpen(true)
      return
    }
    try {
      const raw = JSON.parse(await file.text()) as unknown
      const rawFiles = raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).files
      const importedFiles = await rasterizeWhiteboardFiles(
        rawFiles && typeof rawFiles === 'object' && !Array.isArray(rawFiles) ? rawFiles as Record<string, unknown> : {},
      ) as unknown as BinaryFiles
      const imported = await loadLibraryFromBlob(file, 'unpublished')
      const occupied = new Set([...personalLibraryItemsRef.current, ...catalogLibraryItemsRef.current.flat()].map(item => item.id))
      const safeImported = imported.map(item => occupied.has(item.id)
        ? { ...item, id: createWhiteboardOperationID() }
        : item) as LibraryItems
      const merged = mergeLibraryItems(personalLibraryItemsRef.current, safeImported)
      if (Object.keys(importedFiles).length > 0) {
        editorAPIRef.current?.addFiles(Object.values(importedFiles) as BinaryFileData[])
        if (latestSceneRef.current) latestSceneRef.current = {
          ...latestSceneRef.current,
          files: { ...latestSceneRef.current.files, ...importedFiles },
        }
      }
      personalLibraryItemsRef.current = merged
      libraryChangeVersionRef.current += 1
      libraryDirtyRef.current = true
      libraryConflictRef.current = false
      await applyLibraryComposition(merged)
      setLibrarySaveState('pending')
      setLibraryError(null)
      await persistPersonalLibrary(true)
      setLibraryOpen(true)
    } catch (importError) {
      setLibrarySaveState('error')
      setLibraryError(importError instanceof Error ? importError.message : 'No se pudo importar la biblioteca.')
      setLibraryOpen(true)
    }
  }

  const exportCatalogFile = async (catalogID: string, name: string) => {
    const detailResponse = await getWhiteboardLibrary(catalogID)
    if (!detailResponse.success || !detailResponse.data?.library) {
      throw new Error(detailResponse.error || 'No se pudo cargar el catálogo para exportarlo.')
    }
    const document = whiteboardLibraryDocument(detailResponse.data.library.library_json)
    const items = restoredWhiteboardLibraryItems(document)
    const referencedFileIDs = referencedWhiteboardFileIDs(whiteboardLibraryElements(items))
    if (referencedFileIDs.length > 0) {
      const manifestResponse = await listWhiteboardLibraryAssets(catalogID, { referencedFileIDs })
      if (!manifestResponse.success || !manifestResponse.data) {
        throw new Error(manifestResponse.error || 'No se pudieron cargar los recursos del catálogo.')
      }
      const assetsByFileID = new Map(manifestResponse.data.assets.map(asset => [asset.file_id, asset]))
      const missing = referencedFileIDs.filter(fileID => !assetsByFileID.has(fileID))
      if (missing.length > 0) throw new Error('El catálogo tiene recursos incompletos y no puede exportarse todavía.')
      const files = { ...sanitizeWhiteboardFilesForPersistence(document.files as Record<string, unknown> | undefined) }
      const downloaded = await mapWhiteboardConcurrently(referencedFileIDs, 4, async fileID => {
        const asset = assetsByFileID.get(fileID)
        if (!asset) throw new Error('El recurso del catálogo ya no está disponible.')
        const response = await downloadWhiteboardLibraryAsset(catalogID, asset.id)
        if (!response.success || !response.blob) throw new Error(response.error || 'No se pudo descargar un recurso del catálogo.')
        return {
          fileID,
          value: {
            ...(files[fileID] && typeof files[fileID] === 'object' ? files[fileID] as Record<string, unknown> : {}),
            id: fileID,
            mimeType: asset.content_type,
            created: Date.parse(asset.created_at) || Date.now(),
            dataURL: await blobToDataURL(response.blob),
          },
        }
      })
      for (const downloadedFile of downloaded) files[downloadedFile.fileID] = downloadedFile.value
      document.files = files
    }
    downloadBlob(new Blob([JSON.stringify(document)], { type: 'application/json' }), whiteboardCatalogFilename(name))
  }

  const exportLibrary = async () => {
    const personal = personalLibraryRef.current
    if (!personal) return
    setLibraryError(null)
    try {
      await exportCatalogFile(personal.id, 'mi-biblioteca')
    } catch (exportError) {
      setLibrarySaveState('error')
      setLibraryError(exportError instanceof Error ? exportError.message : 'No se pudo exportar Mi biblioteca.')
    }
  }

  const createCatalog = async (draft: WhiteboardLibraryCatalogDraft) => {
    setLibraryCatalogBusy({ action: 'create' })
    setLibraryCatalogError(null)
    let created: WhiteboardLibraryRecord | null = null
    try {
      let document = whiteboardLibraryDocument({ libraryItems: [] })
      let importedItems: LibraryItems = []
      let importedFiles: BinaryFiles = {}
      if (draft.sourceFile) {
        const raw = JSON.parse(await draft.sourceFile.text()) as unknown
        const rawDocument = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
        importedItems = await loadLibraryFromBlob(draft.sourceFile, 'unpublished')
        const official = JSON.parse(serializeLibraryAsJSON(importedItems)) as Record<string, unknown>
        importedFiles = await rasterizeWhiteboardFiles(
          rawDocument.files && typeof rawDocument.files === 'object' && !Array.isArray(rawDocument.files)
            ? rawDocument.files as Record<string, unknown>
            : {},
        ) as unknown as BinaryFiles
        const importPlan = buildWhiteboardCatalogImportPlan({
          rawDocument,
          officialDocument: official,
          importedItems,
          importedFiles: importedFiles as unknown as Record<string, unknown>,
        })
        document = importPlan.document
      }
      const importPlan = buildWhiteboardCatalogImportPlan({
        rawDocument: document,
        officialDocument: document,
        importedItems,
        importedFiles: importedFiles as unknown as Record<string, unknown>,
      })
      const { referencedFileIDs, missingFileIDs: missing, createDocument } = importPlan
      if (missing.length > 0) {
        throw new Error('El catálogo contiene imágenes sin sus binarios locales. Expórtalo desde Clarin para conservarlas.')
      }
      const response = await createWhiteboardLibrary({
        name: draft.name.trim(),
        description: draft.description.trim(),
        library_json: createDocument,
        visibility: draft.visibility,
      })
      if (!response.success || !response.data?.library) throw new Error(response.error || 'No se pudo crear el catálogo.')
      created = response.data.library
      if (referencedFileIDs.length > 0) {
        for (const fileID of referencedFileIDs) {
          const file = importedFiles[fileID] as unknown as WhiteboardBinaryFile
          const blob = dataURLToBlob(file.dataURL)
          const upload = await uploadWhiteboardLibraryAsset(created.id, {
            fileID,
            blob,
            filename: `${fileID}.${extensionForMimeType(blob.type)}`,
          })
          if (!upload.success) throw new Error(upload.error || 'No se pudo guardar un recurso del catálogo.')
        }
        const promoted = await updateWhiteboardLibrary(created.id, {
          name: draft.name.trim(),
          description: draft.description.trim(),
          library_json: document,
          visibility: draft.visibility,
          expected_version: created.version,
        })
        if (!promoted.success || !promoted.data?.library) throw new Error(promoted.error || 'No se pudo confirmar el catálogo importado.')
      }
      await reloadLibraries()
      return true
    } catch (catalogError) {
      if (created) await archiveWhiteboardLibrary(created.id, created.version).catch(() => undefined)
      setLibraryCatalogError(catalogError instanceof Error ? catalogError.message : 'No se pudo crear el catálogo.')
      return false
    } finally {
      setLibraryCatalogBusy(null)
    }
  }

  const updateCatalog = async (catalogID: string, draft: Omit<WhiteboardLibraryCatalogDraft, 'sourceFile'>, expectedVersion: number) => {
    setLibraryCatalogBusy({ action: 'update', catalogID })
    setLibraryCatalogError(null)
    try {
      const detail = await getWhiteboardLibrary(catalogID)
      if (!detail.success || !detail.data?.library) throw new Error(detail.error || 'No se pudo cargar el catálogo actual.')
      const response = await updateWhiteboardLibrary(catalogID, {
        name: draft.name.trim(),
        description: draft.description.trim(),
        library_json: whiteboardLibraryDocument(detail.data.library.library_json),
        visibility: draft.visibility,
        expected_version: expectedVersion,
      })
      if (!response.success || !response.data?.library) {
        throw new Error(response.status === 409 ? 'El catálogo cambió en otra sesión. Se recargará la versión actual.' : response.error || 'No se pudo actualizar el catálogo.')
      }
      await reloadLibraries()
      return true
    } catch (catalogError) {
      setLibraryCatalogError(catalogError instanceof Error ? catalogError.message : 'No se pudo actualizar el catálogo.')
      if (catalogError instanceof Error && catalogError.message.includes('otra sesión')) await reloadLibraries()
      return false
    } finally {
      setLibraryCatalogBusy(null)
    }
  }

  const archiveCatalog = async (catalogID: string, expectedVersion: number) => {
    setLibraryCatalogBusy({ action: 'archive', catalogID })
    setLibraryCatalogError(null)
    try {
      const response = await archiveWhiteboardLibrary(catalogID, expectedVersion)
      if (!response.success) throw new Error(response.error || 'No se pudo archivar el catálogo.')
      await reloadLibraries()
      return true
    } catch (catalogError) {
      setLibraryCatalogError(catalogError instanceof Error ? catalogError.message : 'No se pudo archivar el catálogo.')
      return false
    } finally {
      setLibraryCatalogBusy(null)
    }
  }

  const exportCatalog = async (catalogID: string) => {
    const catalog = libraryCatalogs.find(item => item.id === catalogID)
    setLibraryCatalogBusy({ action: 'export', catalogID })
    setLibraryCatalogError(null)
    try {
      await exportCatalogFile(catalogID, catalog?.name || 'catalogo-clarin')
      return true
    } catch (catalogError) {
      setLibraryCatalogError(catalogError instanceof Error ? catalogError.message : 'No se pudo exportar el catálogo.')
      return false
    } finally {
      setLibraryCatalogBusy(null)
    }
  }

  const uploadPendingFiles = useCallback(async (files: BinaryFiles, elements: readonly unknown[]) => {
    const referencedFileIDs = new Set(referencedWhiteboardFileIDs(elements))
    const referencedFiles = Object.fromEntries(Object.entries(files).filter(([fileID]) => referencedFileIDs.has(fileID)))
    const safeFiles = await rasterizeWhiteboardFiles(referencedFiles as unknown as Record<string, unknown>) as unknown as BinaryFiles
    for (const [fileID, rawFile] of Object.entries(safeFiles)) {
      if (uploadedFileIDsRef.current.has(fileID)) continue
      const file = rawFile as unknown as WhiteboardBinaryFile
      if (!file.dataURL) continue
      const blob = dataURLToBlob(file.dataURL)
      const response = await uploadWhiteboardAsset(boardID, fileID, blob, `${fileID}.${extensionForMimeType(blob.type)}`)
      if (!response.success) throw new Error(response.error || 'No se pudo guardar un recurso de la pizarra.')
      uploadedFileIDsRef.current.add(fileID)
    }
    if (Object.keys(safeFiles).length > 0) editorAPIRef.current?.addFiles(Object.values(safeFiles) as BinaryFileData[])
    return { ...files, ...safeFiles }
  }, [boardID])

  const hydrateReferencedAssets = useCallback(async (elements: readonly unknown[]) => {
    const assets = await hydrateAssets(elements)
    if (!mountedRef.current) return
    if (Object.keys(assets.files).length > 0) {
      editorAPIRef.current?.addFiles(Object.values(assets.files) as BinaryFileData[])
      if (latestSceneRef.current) latestSceneRef.current = { ...latestSceneRef.current, files: { ...latestSceneRef.current.files, ...assets.files } }
    }
    setAssetWarning(assets.warning)
  }, [hydrateAssets])

  const generateThumbnail = useCallback(async (confirmedSequence: number) => {
    if (!canEdit || thumbnailSavingRef.current || !mountedRef.current || !navigator.onLine) return
    const scene = latestSceneRef.current
    if (!scene || confirmedSequence <= 0 || confirmedSequence > sequenceRef.current) return
    thumbnailSavingRef.current = true
    lastThumbnailAttemptAtRef.current = Date.now()
    thumbnailAttemptedSequenceRef.current = confirmedSequence
    try {
      const visibleElements = (acknowledgedElementsRef.current as readonly ExcalidrawElement[])
        .filter(element => !element.isDeleted)
      const blob = visibleElements.length
        ? await exportToBlob({
          elements: visibleElements as never,
          appState: { ...scene.appState, ...acknowledgedAppStateRef.current, exportBackground: true },
          files: scene.files,
          mimeType: 'image/png',
          maxWidthOrHeight: 640,
        })
        : await emptyWhiteboardThumbnail(String(scene.appState.viewBackgroundColor || '#ffffff'))
      const response = await uploadWhiteboardThumbnail(boardID, blob)
      if (!response.success || !response.data?.asset) {
        throw new Error(response.error || 'No se pudo actualizar la miniatura.')
      }
      let canonical = response.data.whiteboard
      if (!canonical) {
        const metadata = await loadWhiteboardMetadata(boardID)
        if (metadata.success) canonical = metadata.data?.whiteboard
      }
      const thumbnailURL = response.data.thumbnail_url
        || canonical?.thumbnail_url
        || `/api/whiteboards/${encodeURIComponent(boardID)}/assets/${encodeURIComponent(response.data.asset.id)}`
      setBoard(current => {
        if (!current) return current
        if (canonical) return { ...current, ...canonical, effective_access: canonical.effective_access || current.effective_access }
        return {
          ...current,
          version: response.data?.board_version || current.version + 1,
          thumbnail_asset_id: response.data?.asset.id,
          thumbnail_url: thumbnailURL,
        }
      })
      setThumbnailWarning(null)
    } catch (thumbnailError) {
      if (mountedRef.current) setThumbnailWarning(thumbnailError instanceof Error ? thumbnailError.message : 'No se pudo actualizar la miniatura.')
    } finally {
      thumbnailSavingRef.current = false
    }
  }, [boardID, canEdit])

  const scheduleThumbnail = useCallback((confirmedSequence = sequenceRef.current, force = false) => {
    if (!canEdit || !mountedRef.current || confirmedSequence <= 0) return
    if (!force && thumbnailAttemptedSequenceRef.current >= confirmedSequence) return
    if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current)
    thumbnailScheduledSequenceRef.current = confirmedSequence
    thumbnailTimerRef.current = setTimeout(() => {
      thumbnailTimerRef.current = null
      const scheduledSequence = thumbnailScheduledSequenceRef.current
      if (force || thumbnailAttemptedSequenceRef.current < scheduledSequence) {
        void generateThumbnail(scheduledSequence)
      }
    }, whiteboardThumbnailDelay(lastThumbnailAttemptAtRef.current))
  }, [canEdit, generateThumbnail])

  const retryThumbnail = useCallback(() => {
    setThumbnailWarning(null)
    thumbnailAttemptedSequenceRef.current = -1
    scheduleThumbnail(sequenceRef.current, true)
  }, [scheduleThumbnail])

  const diagnoseWhiteboardWriteNotFound = useCallback(async () => {
    const [metadata, scene] = await Promise.all([
      loadWhiteboardMetadata(boardID),
      loadWhiteboardScene(boardID),
    ])
    if (metadata.success && scene.success) {
      return 'Clarin puede abrir la pizarra, pero rechazó su ruta de escritura. Tus cambios siguen en pantalla; reintenta el guardado.'
    }
    if (metadata.status === 404 || scene.status === 404) {
      return 'La pizarra dejó de estar disponible en la cuenta activa. Tus cambios siguen en pantalla y no se marcarán como guardados.'
    }
    if (metadata.status === 403 || scene.status === 403) {
      return 'Tu acceso de edición cambió mientras trabajabas. Tus cambios siguen en pantalla.'
    }
    return 'Clarin no pudo confirmar que la pizarra siga disponible. Tus cambios siguen en pantalla; reintenta el guardado.'
  }, [boardID])

  const applyCanonicalWriteConfirmation = useCallback((
    document: WhiteboardSceneDocument,
    capturedElements: readonly unknown[],
    capturedAppState: Record<string, unknown>,
  ) => {
    const canonical = restoreClarinWhiteboardScene(document)
    const current = latestSceneRef.current
    const api = editorAPIRef.current
    if (current) {
      const currentAppState = api?.getAppState() || current.appState
      const reconciled = reconcileWhiteboardCanonicalAck({
        canonicalElements: canonical.elements,
        capturedElements,
        currentElements: api?.getSceneElementsIncludingDeleted() || current.elements,
        canonicalAppState: canonical.appState,
        capturedAppState,
        currentAppState: currentAppState as unknown as Record<string, unknown>,
      })
      const elements = api
        ? reconcileElements(api.getSceneElementsIncludingDeleted(), reconciled.elements as never, currentAppState)
        : reconciled.elements as readonly ExcalidrawElement[]
      const appState = { ...currentAppState, ...reconciled.appState } as AppState
      const files = mergeWhiteboardFileRecords(
        current.files as unknown as Record<string, unknown>,
        canonical.files,
      ) as unknown as BinaryFiles
      suppressChangesRef.current = true
      api?.updateScene({ elements, appState, captureUpdate: CaptureUpdateAction.NEVER })
      latestSceneRef.current = { elements, appState, files }
      requestAnimationFrame(() => { suppressChangesRef.current = false })
      void hydrateReferencedAssets(elements)
    }
    sceneRootExtensionsRef.current = whiteboardSceneRootExtensions(canonical)
    sceneFileMetadataRef.current = sanitizeWhiteboardFilesForPersistence(
      mergeWhiteboardFileRecords(sceneFileMetadataRef.current, canonical.files),
    )
    return {
      elements: [...canonical.elements] as readonly unknown[],
      appState: sanitizeWhiteboardAppState(canonical.appState),
    }
  }, [hydrateReferencedAssets])

  const reconcileWhiteboardWriteConflict = useCallback(async () => {
    const response = await loadWhiteboardScene(boardID)
    if (!response.success || !response.data?.scene) return false
    const record = response.data.scene
    const confirmed = applyCanonicalWriteConfirmation(
      record.scene,
      acknowledgedElementsRef.current,
      acknowledgedAppStateRef.current,
    )
    sequenceRef.current = record.sequence
    acknowledgedElementsRef.current = confirmed.elements
    acknowledgedAppStateRef.current = confirmed.appState
    setBoard(current => current ? { ...current, scene_sequence: record.sequence, updated_at: record.updated_at } : current)
    dirtyRef.current = true
    return true
  }, [applyCanonicalWriteConfirmation, boardID])

  const flushSave = useCallback(async (reason: 'autosave' | 'manual' | 'import' = 'autosave') => {
    if (!canEdit || !dirtyRef.current) return
    if (reason === 'autosave' && pendingSaveRef.current?.automaticRetryBlocked) return
    if (reason !== 'autosave' && pendingSaveRef.current) {
      pendingSaveRef.current.automaticFailures = 0
      pendingSaveRef.current.automaticRetryBlocked = false
    }
    if (!navigator.onLine) {
      setSaveState('offline')
      return
    }
    if (savingRef.current) {
      queuedSaveRef.current = true
      return
    }
    const scene = latestSceneRef.current
    if (!scene) return
    savingRef.current = true
    queuedSaveRef.current = false
    let capturedVersion = pendingSaveRef.current?.capturedVersion ?? changeVersionRef.current
    setSaveState('saving')
    setError(null)
    try {
      let pending = pendingSaveRef.current
      if (!pending) {
        const files = await uploadPendingFiles(scene.files, scene.elements)
        latestSceneRef.current = { ...scene, files }
        const operationID = createWhiteboardOperationID()
        const writePlan = buildWhiteboardSceneWritePlan(scene.elements, acknowledgedElementsRef.current)
        const canPatch = reason === 'autosave' && writePlan.kind === 'patch'
        pending = retainWhiteboardPendingSave(pending, () => ({
          operationID,
          capturedVersion,
          payload: buildExcalidrawWhiteboardSavePayload({
            sceneSequence: sequenceRef.current,
            operationID,
            reason,
            elements: scene.elements,
            appState: scene.appState as unknown as Record<string, unknown>,
            files: mergeWhiteboardFileRecords(scene.files as unknown as Record<string, unknown>, sceneFileMetadataRef.current),
            rootExtensions: sceneRootExtensionsRef.current,
            includePatch: canPatch,
            patchElements: writePlan.elements,
          }),
          realtimePatch: canPatch ? buildWhiteboardRealtimePatch({
            sceneSequence: sequenceRef.current,
            operationID,
            elements: writePlan.elements,
            appState: scene.appState as unknown as Record<string, unknown>,
          }) : null,
          capturedElements: [],
          capturedAppState: {},
          automaticFailures: 0,
          automaticRetryBlocked: false,
          notFoundDiagnosed: false,
        }))
        pending.capturedElements = [...pending.payload.scene.elements]
        pending.capturedAppState = sanitizeWhiteboardAppState(pending.payload.scene.appState)
        pendingSaveRef.current = pending
      }
      capturedVersion = pending.capturedVersion
      lastOperationIDRef.current = pending.operationID
      const realtimeSave = pending.realtimePatch
        ? roomRef.current?.sendPatch(pending.realtimePatch)
        : null
      let acknowledgement: WhiteboardRealtimeEvent | null = null
      if (realtimeSave) {
        try {
          acknowledgement = await realtimeSave
        } catch {
          // The immutable operation immediately falls through to authenticated
          // REST with the same operation_id and payload hash.
        }
      }
      let nextSequence: number
      let updatedAt = new Date().toISOString()
      let nextAcknowledgedElements: readonly unknown[] = pending.capturedElements
      let nextAcknowledgedAppState = pending.capturedAppState
      if (acknowledgement) {
        if (typeof acknowledgement.sequence !== 'number') throw new Error('Clarin no confirmó la secuencia guardada.')
        nextSequence = acknowledgement.sequence
        if (acknowledgement.scene) {
          const confirmed = applyCanonicalWriteConfirmation(
            acknowledgement.scene,
            pending.capturedElements,
            pending.capturedAppState,
          )
          nextAcknowledgedElements = confirmed.elements
          nextAcknowledgedAppState = confirmed.appState
        }
      } else {
        const response = await saveWhiteboard(boardID, pending.payload)
        if (!response.success || !response.data?.result.scene) {
          pending.automaticFailures += 1
          const failureAction = whiteboardSaveFailureAction(response.status, pending.automaticFailures)
          if (failureAction === 'conflict') {
            pending.automaticRetryBlocked = true
            if (await reconcileWhiteboardWriteConflict()) {
              pendingSaveRef.current = null
              queuedSaveRef.current = true
              setSaveState('pending')
              setError('Otra sesión guardó antes. Clarin concilió la versión canónica con tus cambios y volverá a guardarlos.')
            } else {
              setSaveState('conflict')
              setError('Otra sesión guardó cambios antes que tú. Tus cambios siguen en pantalla; recarga la versión actual antes de continuar.')
            }
            return
          }
          pending.automaticRetryBlocked = failureAction === 'block'
          let message = errorMessage(response.status, response.error)
          if (response.status === 400) {
            message = 'Clarin rechazó el formato de esta escena. Tus cambios siguen en pantalla; no se volverán a enviar automáticamente.'
          } else if (response.status === 401) {
            message = 'Tu sesión expiró antes de confirmar el guardado. Tus cambios siguen en pantalla.'
          } else if (response.status === 404 && !pending.notFoundDiagnosed) {
            pending.notFoundDiagnosed = true
            message = await diagnoseWhiteboardWriteNotFound()
          }
          throw new Error(message)
        }
        nextSequence = response.data.result.scene.sequence
        updatedAt = response.data.result.scene.updated_at
        const confirmed = applyCanonicalWriteConfirmation(
          response.data.result.scene.scene,
          pending.capturedElements,
          pending.capturedAppState,
        )
        nextAcknowledgedElements = confirmed.elements
        nextAcknowledgedAppState = confirmed.appState
      }
      nextSequence = Math.max(sequenceRef.current, nextSequence)
      sequenceRef.current = nextSequence
      acknowledgedElementsRef.current = nextAcknowledgedElements
      acknowledgedAppStateRef.current = nextAcknowledgedAppState
      lastSavedChangeVersionRef.current = Math.max(lastSavedChangeVersionRef.current, capturedVersion)
      if (pendingSaveRef.current === pending) pendingSaveRef.current = null
      const unchanged = capturedVersion === changeVersionRef.current
      dirtyRef.current = !unchanged
      setBoard(current => current ? { ...current, scene_sequence: nextSequence, updated_at: updatedAt } : current)
      setSaveState(unchanged ? 'saved' : 'pending')
      setError(null)
      scheduleThumbnail(nextSequence)
    } catch (saveError) {
      if (!mountedRef.current) return
      dirtyRef.current = true
      setSaveState(navigator.onLine ? 'error' : 'offline')
      setError(saveError instanceof Error ? saveError.message : 'No se pudo guardar la pizarra.')
    } finally {
      savingRef.current = false
      const retryUnacknowledged = Boolean(
        pendingSaveRef.current
        && !pendingSaveRef.current.automaticRetryBlocked
        && dirtyRef.current
        && navigator.onLine,
      )
      if (queuedSaveRef.current || capturedVersion !== changeVersionRef.current || retryUnacknowledged) {
        queuedSaveRef.current = false
        if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
        const delay = retryUnacknowledged && pendingSaveRef.current
          ? whiteboardSaveRetryDelay(pendingSaveRef.current.automaticFailures)
          : 250
        autosaveTimerRef.current = setTimeout(() => { void flushSave('autosave') }, delay)
      }
    }
  }, [applyCanonicalWriteConfirmation, boardID, canEdit, diagnoseWhiteboardWriteNotFound, reconcileWhiteboardWriteConflict, scheduleThumbnail, uploadPendingFiles])

  const onChange = useCallback((elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    const previous = latestSceneRef.current
    latestSceneRef.current = { elements, appState, files }
    if (suppressChangesRef.current || transientSceneSuppressionRef.current > 0 || !canEdit) return
    if (previous && !hasWhiteboardDocumentMutation({
      currentElements: elements,
      previousElements: previous.elements,
      currentAppState: appState as unknown as Record<string, unknown>,
      previousAppState: previous.appState as unknown as Record<string, unknown>,
      currentFiles: files as unknown as Record<string, unknown>,
      previousFiles: previous.files as unknown as Record<string, unknown>,
    })) return
    changeVersionRef.current += 1
    dirtyRef.current = true
    const retryBlocked = Boolean(pendingSaveRef.current?.automaticRetryBlocked)
    setSaveState(!navigator.onLine ? 'offline' : retryBlocked ? 'error' : 'pending')
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    if (!retryBlocked) autosaveTimerRef.current = setTimeout(() => { void flushSave('autosave') }, WHITEBOARD_AUTOSAVE_DELAY_MS)
  }, [canEdit, flushSave])

  const applySceneRecord = useCallback((record: WhiteboardSceneRecord, preserveLocalChanges = false) => {
    const api = editorAPIRef.current
    const scene = restoreClarinWhiteboardScene(record.scene)
    sceneRootExtensionsRef.current = whiteboardSceneRootExtensions(scene)
    sceneFileMetadataRef.current = sanitizeWhiteboardFilesForPersistence(scene.files)
    const existingFiles = mergeWhiteboardFileRecords(
      latestSceneRef.current?.files as unknown as Record<string, unknown> | undefined,
      scene.files,
    ) as unknown as BinaryFiles
    const remoteElements = scene.elements as readonly ExcalidrawElement[]
    const currentAppState = api?.getAppState()
    const reconciled = preserveLocalChanges && api && currentAppState
      ? reconcileWhiteboardCanonicalAck({
        canonicalElements: remoteElements,
        capturedElements: acknowledgedElementsRef.current,
        currentElements: api.getSceneElementsIncludingDeleted(),
        canonicalAppState: scene.appState,
        capturedAppState: acknowledgedAppStateRef.current,
        currentAppState: currentAppState as unknown as Record<string, unknown>,
      })
      : null
    const elements = reconciled && api && currentAppState
      ? reconcileElements(api.getSceneElementsIncludingDeleted(), reconciled.elements as never, currentAppState)
      : remoteElements
    const appState = reconciled && currentAppState
      ? { ...currentAppState, ...reconciled.appState } as AppState
      : scene.appState as unknown as AppState
    sequenceRef.current = record.sequence
    acknowledgedElementsRef.current = [...remoteElements]
    acknowledgedAppStateRef.current = sanitizeWhiteboardAppState(scene.appState)
    suppressChangesRef.current = true
    api?.updateScene({
      elements,
      appState,
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    latestSceneRef.current = { elements, appState, files: existingFiles }
    setBoard(current => current ? { ...current, scene_sequence: record.sequence, updated_at: record.updated_at } : current)
    if (!preserveLocalChanges) dirtyRef.current = false
    setSaveState(preserveLocalChanges ? 'pending' : 'saved')
    setError(null)
    requestAnimationFrame(() => { suppressChangesRef.current = false })
  }, [])

  const reloadCanonicalForRealtime = useCallback(async (event: WhiteboardRealtimeEvent, force = false) => {
    const requestedSequence = isWhiteboardSceneSequence(event.sequence) ? event.sequence : sequenceRef.current
    if (!force && canonicalSyncAppliedSequenceRef.current >= requestedSequence) return
    if (!force && canonicalSyncLoadingSequenceRef.current >= requestedSequence) return
    canonicalSyncControllerRef.current?.abort()
    const controller = new AbortController()
    canonicalSyncControllerRef.current = controller
    canonicalSyncLoadingSequenceRef.current = requestedSequence
    const generation = ++canonicalSyncGenerationRef.current
    try {
      const response = await loadWhiteboardScene(boardID, controller.signal)
      if (controller.signal.aborted || generation !== canonicalSyncGenerationRef.current || !mountedRef.current) return
      if (!response.success || !response.data?.scene) {
        throw new Error(response.error || 'No se pudo recargar la escena canónica por REST.')
      }
      if (response.data.scene.sequence < requestedSequence) {
        throw new Error('La escena canónica todavía no alcanzó la secuencia solicitada. Clarin volverá a sincronizarla.')
      }
      const preserveLocalChanges = dirtyRef.current || Boolean(pendingSaveRef.current)
      applySceneRecord(response.data.scene, preserveLocalChanges)
      const canonical = restoreClarinWhiteboardScene(response.data.scene.scene)
      void hydrateReferencedAssets(
        preserveLocalChanges && editorAPIRef.current
          ? editorAPIRef.current.getSceneElementsIncludingDeleted()
          : canonical.elements,
      )
      canonicalSyncAppliedSequenceRef.current = Math.max(requestedSequence, response.data.scene.sequence)
      if (preserveLocalChanges && canEdit) {
        if (!savingRef.current) pendingSaveRef.current = null
        dirtyRef.current = true
        setSaveState('pending')
        if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = setTimeout(() => { void flushSave('autosave') }, savingRef.current ? 1_000 : 250)
      }
    } catch (syncError) {
      if (!controller.signal.aborted && generation === canonicalSyncGenerationRef.current && mountedRef.current) {
        setError(syncError instanceof Error ? syncError.message : 'No se pudo sincronizar la escena canónica.')
      }
    } finally {
      if (canonicalSyncControllerRef.current === controller) canonicalSyncControllerRef.current = null
      if (generation === canonicalSyncGenerationRef.current) canonicalSyncLoadingSequenceRef.current = -1
    }
  }, [applySceneRecord, boardID, canEdit, flushSave, hydrateReferencedAssets])

  const createCheckpoint = useCallback(async () => {
    if (!canEdit) return { success: false, error: 'Necesitas permiso de edición para crear una versión.' }
    if (savingRef.current) return { success: false, error: 'Espera a que termine el guardado actual.' }
    if (dirtyRef.current) await flushSave('manual')
    if (dirtyRef.current || savingRef.current || pendingSaveRef.current) {
      return { success: false, error: 'No se pudo confirmar primero el guardado pendiente. Reinténtalo cuando figure como guardado.' }
    }
    const response = await createWhiteboardVersion(boardID, sequenceRef.current)
    if (!response.success || !response.data?.result.scene) {
      return {
        success: false,
        error: response.status === 409
          ? 'La pizarra cambió en otra sesión. Actualiza antes de crear una versión.'
          : response.error || 'No se pudo crear la versión manual.',
      }
    }
    applySceneRecord(response.data.result.scene)
    scheduleThumbnail()
    return { success: true }
  }, [applySceneRecord, boardID, canEdit, flushSave, scheduleThumbnail])

  const applyCollaboratorEvent = useCallback((event: WhiteboardRealtimeEvent) => {
    const next = reconcileWhiteboardCollaborators(collaboratorsRef.current, event)
    collaboratorsRef.current = next
    const api = editorAPIRef.current
    if (!api) return
    runWithTransientSceneSuppressed(() => {
      api.updateScene({
        collaborators: excalidrawWhiteboardCollaborators(next),
        captureUpdate: CaptureUpdateAction.NEVER,
      })
    })
  }, [runWithTransientSceneSuppressed])

  useEffect(() => {
    if (phase !== 'ready') return
    const room = connectWhiteboardRoom({
      whiteboardID: boardID,
      getSequence: () => sequenceRef.current,
      getTicket: () => requestWhiteboardCollabTicket(boardID),
      onEvent: event => {
        if (event.event === 'presence.snapshot' || event.event === 'presence.update' || event.event === 'cursor.update') {
          applyCollaboratorEvent(event)
          return
        }
        if (event.event === 'access.revoked') {
          setError('Tu acceso a esta pizarra fue revocado.')
          setPhase('error')
          return
        }
        if (event.event === 'error') {
          // Correlated operation errors reject sendPatch() and are recovered by
          // the idempotent REST fallback before any user-facing failure state.
          if (!event.operation_id) setError(event.error || 'La colaboración en tiempo real encontró un error.')
          return
        }
        if (event.event === 'sync.required') {
          void reloadCanonicalForRealtime(event, true)
          return
        }
        if (event.event === 'ack') {
          if (!event.operation_id && isWhiteboardSceneSequence(event.sequence)) {
            sequenceRef.current = Math.max(sequenceRef.current, event.sequence)
            if (shouldRetryWhiteboardDirtySave({ dirty: dirtyRef.current, saving: savingRef.current, online: navigator.onLine, canEdit })) {
              if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
              autosaveTimerRef.current = setTimeout(() => { void flushSave('autosave') }, 250)
            }
          }
          return
        }
        const remoteSequence = event.sequence
        if (!isWhiteboardSceneSequence(remoteSequence)) {
          void reloadCanonicalForRealtime(event, true)
          return
        }
        if (!shouldApplyWhiteboardRealtimeEvent({
          currentSceneSequence: sequenceRef.current,
          localOperationID: lastOperationIDRef.current,
          event: { sequence: remoteSequence, operation_id: event.operation_id },
        })) return
        if (event.scene) {
          const preserveLocalChanges = dirtyRef.current
          applySceneRecord({
            board_id: boardID,
            scene: event.scene,
            sequence: remoteSequence,
            scene_schema_version: 'excalidraw',
            editor_version: '0.18.1',
            updated_at: new Date().toISOString(),
          }, preserveLocalChanges)
          void hydrateReferencedAssets(event.scene.elements)
          if (preserveLocalChanges && !savingRef.current) {
            if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
            autosaveTimerRef.current = setTimeout(() => { void flushSave('autosave') }, 250)
          }
          return
        }
        if (event.event === 'scene.patch' && event.elements && editorAPIRef.current) {
          const api = editorAPIRef.current
          const local = api.getSceneElementsIncludingDeleted()
          const appState = api.getAppState()
          const elements = reconcileElements(local, event.elements as never, appState)
          acknowledgedElementsRef.current = mergeWhiteboardAcknowledgedElements(acknowledgedElementsRef.current, event.elements)
          acknowledgedAppStateRef.current = {
            ...acknowledgedAppStateRef.current,
            ...sanitizeWhiteboardAppState(event.app_state || {}),
          }
          suppressChangesRef.current = true
          api.updateScene({ elements, appState: event.app_state as unknown as AppState, captureUpdate: CaptureUpdateAction.NEVER })
          sequenceRef.current = remoteSequence
          latestSceneRef.current = { elements, appState: { ...appState, ...(event.app_state || {}) }, files: api.getFiles() } as LatestScene
          requestAnimationFrame(() => { suppressChangesRef.current = false })
          void hydrateReferencedAssets(elements)
        }
      },
      onConnectionChange: state => {
        if (state === 'open') {
          if (shouldRetryWhiteboardDirtySave({ dirty: dirtyRef.current, saving: savingRef.current, online: navigator.onLine, canEdit })) {
            if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
            autosaveTimerRef.current = setTimeout(() => { void flushSave('autosave') }, 250)
          }
          return
        }
        if (state === 'closed') {
          if (dirtyRef.current && navigator.onLine) setSaveState('pending')
          collaboratorsRef.current = new Map()
          const api = editorAPIRef.current
          if (api) runWithTransientSceneSuppressed(() => {
            api.updateScene({ collaborators: new Map(), captureUpdate: CaptureUpdateAction.NEVER })
          })
        }
      },
    })
    roomRef.current = room
    return () => {
      if (roomRef.current === room) roomRef.current = null
      room.close()
    }
  }, [applyCollaboratorEvent, applySceneRecord, boardID, flushSave, hydrateReferencedAssets, phase, reloadCanonicalForRealtime, runWithTransientSceneSuppressed])

  const reloadCanonical = async () => {
    const response = await loadWhiteboardScene(boardID)
    if (!response.success || !response.data?.scene) {
      setError(errorMessage(response.status, response.error))
      return
    }
    pendingSaveRef.current = null
    applySceneRecord(response.data.scene, true)
    dirtyRef.current = true
    setSaveState('pending')
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = setTimeout(() => { void flushSave('autosave') }, 250)
  }

  const saveTitle = async () => {
    if (!board || !canEdit || titleSaving) return
    const name = titleDraft.trim()
    if (!name) {
      setTitleDraft(board.name)
      return
    }
    if (name === board.name) return
    setTitleSaving(true)
    const response = await updateWhiteboard(boardID, {
      name,
      description: board.description || '',
      folder_id: board.folder_id || null,
      expected_version: board.version,
    })
    setTitleSaving(false)
    if (!response.success || !response.data?.whiteboard) {
      setTitleDraft(board.name)
      setError(errorMessage(response.status, response.error))
      return
    }
    setBoard(response.data.whiteboard)
    setTitleDraft(response.data.whiteboard.name)
  }

  const exportJSON = () => {
    const scene = latestSceneRef.current
    if (!scene || !board) return
    const serialized = JSON.parse(serializeAsJSON(scene.elements, scene.appState, scene.files, 'local')) as Record<string, unknown>
    serialized.files = mergeWhiteboardFileRecords(
      serialized.files && typeof serialized.files === 'object' ? serialized.files as Record<string, unknown> : {},
      sceneFileMetadataRef.current,
    )
    const source = JSON.stringify({ ...sceneRootExtensionsRef.current, ...serialized })
    downloadBlob(new Blob([source], { type: 'application/json' }), whiteboardFileName(board.name, 'excalidraw'))
  }

  const exportPNG = async () => {
    const scene = latestSceneRef.current
    if (!scene || !board) return
    try {
      const blob = await exportToBlob({ elements: scene.elements.filter(element => !element.isDeleted) as never, appState: { ...scene.appState, exportBackground: true }, files: scene.files, mimeType: 'image/png' })
      downloadBlob(blob, whiteboardFileName(board.name, 'png'))
    } catch {
      setError('No se pudo exportar la imagen PNG.')
    }
  }

  const exportSVG = async () => {
    const scene = latestSceneRef.current
    if (!scene || !board) return
    try {
      const svg = await exportToSvg({ elements: scene.elements.filter(element => !element.isDeleted) as never, appState: scene.appState, files: scene.files, renderEmbeddables: false, skipInliningFonts: true })
      downloadBlob(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }), whiteboardFileName(board.name, 'svg'))
    } catch {
      setError('No se pudo exportar la imagen SVG.')
    }
  }

  const importScene = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    const api = editorAPIRef.current
    if (!file || !api || !canEdit) return
    if (file.size > 25 * 1024 * 1024) {
      setError('El archivo supera el límite de 25 MB.')
      return
    }
    try {
      const importedSource = JSON.parse(await file.text()) as unknown
      const importedRecord = importedSource && typeof importedSource === 'object' && !Array.isArray(importedSource) ? importedSource as Record<string, unknown> : {}
      const importedScene = importedRecord.scene && typeof importedRecord.scene === 'object' ? importedRecord.scene : importedRecord
      const restored = await loadFromBlob(file, api.getAppState(), api.getSceneElements())
      const files = await rasterizeWhiteboardFiles((restored.files || {}) as unknown as Record<string, unknown>) as unknown as BinaryFiles
      sceneRootExtensionsRef.current = whiteboardSceneRootExtensions(importedScene)
      const importedSceneRecord = importedScene && typeof importedScene === 'object' && !Array.isArray(importedScene)
        ? importedScene as Record<string, unknown>
        : {}
      sceneFileMetadataRef.current = sanitizeWhiteboardFilesForPersistence(
        importedSceneRecord.files && typeof importedSceneRecord.files === 'object'
          ? importedSceneRecord.files as Record<string, unknown>
          : restored.files as unknown as Record<string, unknown>,
      )
      suppressChangesRef.current = true
      api.updateScene({ elements: restored.elements || [], appState: restored.appState || {}, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
      api.addFiles(Object.values(files) as BinaryFileData[])
      latestSceneRef.current = { elements: restored.elements || [], appState: { ...api.getAppState(), ...(restored.appState || {}) }, files } as LatestScene
      changeVersionRef.current += 1
      dirtyRef.current = true
      setSaveState('pending')
      requestAnimationFrame(() => { suppressChangesRef.current = false })
      await flushSave('import')
    } catch (importError) {
      suppressChangesRef.current = false
      setError(importError instanceof Error ? importError.message : 'No se pudo importar la pizarra.')
    }
  }

  const navigateFromWhiteboard = useCallback(async (href: string) => {
    if (navigationInProgressRef.current) return
    navigationInProgressRef.current = true
    const requiredSceneVersion = dirtyRef.current || pendingSaveRef.current || savingRef.current
      ? changeVersionRef.current
      : null
    const requiredLibraryVersion = libraryDirtyRef.current || librarySavingRef.current
      ? libraryChangeVersionRef.current
      : null
    let flushAttempted = false
    const state = () => ({
      dirty: dirtyRef.current,
      pending: Boolean(pendingSaveRef.current),
      saving: savingRef.current,
      libraryDirty: libraryDirtyRef.current,
      librarySaving: librarySavingRef.current,
      flushAttempted,
    })
    const waitForActiveWrites = async () => {
      const deadline = Date.now() + 15_000
      while ((savingRef.current || librarySavingRef.current) && Date.now() < deadline) {
        await new Promise(resolve => window.setTimeout(resolve, 50))
      }
    }
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (whiteboardNavigationAction(state()) === 'wait') await waitForActiveWrites()
        const action = whiteboardNavigationAction({ ...state(), flushAttempted: false })
        if (action === 'leave') break
        if (action !== 'flush') break
        flushAttempted = true
        if (dirtyRef.current || pendingSaveRef.current) await flushSave('manual')
        if (libraryDirtyRef.current) await persistPersonalLibrary(true)
        await waitForActiveWrites()
        if (whiteboardNavigationAction(state()) === 'leave') break
      }
      const durableWritesCoverClick = whiteboardNavigationWritesCovered({
        requiredSceneVersion,
        savedSceneVersion: lastSavedChangeVersionRef.current,
        requiredLibraryVersion,
        savedLibraryVersion: lastSavedLibraryChangeVersionRef.current,
      })
      const action = durableWritesCoverClick ? 'leave' : whiteboardNavigationAction(state())
      if (action !== 'leave') {
        const discard = window.confirm('Clarin no pudo confirmar todos los cambios. ¿Salir y descartar únicamente lo que siga pendiente?')
        if (!discard) return
      }
      router.push(href)
    } finally {
      navigationInProgressRef.current = false
    }
  }, [flushSave, persistPersonalLibrary, router])

  useEffect(() => {
    if (phase !== 'ready') return
    const guardInternalNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const target = event.target
      const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null
      if (!anchor || anchor.download || (anchor.target && anchor.target !== '_self')) return
      const destination = new URL(anchor.href, window.location.href)
      if (destination.origin !== window.location.origin || destination.href === window.location.href) return
      event.preventDefault()
      event.stopPropagation()
      void navigateFromWhiteboard(`${destination.pathname}${destination.search}${destination.hash}`)
    }
    document.addEventListener('click', guardInternalNavigation, true)
    return () => document.removeEventListener('click', guardInternalNavigation, true)
  }, [navigateFromWhiteboard, phase])

  const editorMenu = useMemo(() => <MainMenu>
    <MainMenu.Group title="Pizarra Clarin">
      <MainMenu.Item icon={<ArrowLeft className="h-4 w-4" />} onSelect={() => void navigateFromWhiteboard('/dashboard/whiteboards')}>Volver a Pizarras</MainMenu.Item>
      {canEdit && <MainMenu.Item icon={<Save className="h-4 w-4" />} shortcut="Ctrl+S" onSelect={() => void flushSave('manual')}>Guardar ahora</MainMenu.Item>}
      {canEdit && <MainMenu.Item icon={<FileUp className="h-4 w-4" />} onSelect={() => importInputRef.current?.click()}>Importar archivo</MainMenu.Item>}
    </MainMenu.Group>
    <MainMenu.Separator />
    <MainMenu.Group title="Exportar copia">
      <MainMenu.Item icon={<FileJson className="h-4 w-4" />} onSelect={exportJSON}>Archivo editable</MainMenu.Item>
      <MainMenu.Item icon={<FileImage className="h-4 w-4" />} onSelect={() => void exportPNG()}>Imagen PNG</MainMenu.Item>
      <MainMenu.Item icon={<Download className="h-4 w-4" />} onSelect={() => void exportSVG()}>Imagen SVG</MainMenu.Item>
    </MainMenu.Group>
    <MainMenu.Separator />
    <MainMenu.Group title="Bibliotecas internas">
      <MainMenu.Item icon={<LibraryBig className="h-4 w-4" />} onSelect={() => setLibraryOpen(true)}>Administrar Mi biblioteca</MainMenu.Item>
    </MainMenu.Group>
    {(canManageAccess || board?.effective_access?.can_view) && <><MainMenu.Separator /><MainMenu.Group title="Colaboración">
      {canManageAccess && <MainMenu.Item icon={<Share2 className="h-4 w-4" />} onSelect={() => setShareOpen(true)}>Compartir desde Clarin</MainMenu.Item>}
      <MainMenu.Item icon={<History className="h-4 w-4" />} onSelect={() => setHistoryOpen(true)}>Historial de Clarin</MainMenu.Item>
    </MainMenu.Group></>}
  </MainMenu>, [board?.effective_access?.can_view, canEdit, canManageAccess, flushSave, navigateFromWhiteboard])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      const isWritable = target instanceof HTMLElement
        && (target.matches('input, textarea, select') || target.isContentEditable)
      if (!isWritable && (event.key === '?' || (event.key === '/' && event.shiftKey))) {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase('en') === 's') {
        event.preventDefault()
        void flushSave('manual')
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [flushSave])

  if (phase === 'loading') return <div className="flex h-full min-h-0 items-center justify-center bg-slate-50"><div className="flex flex-col items-center gap-3 text-sm font-bold text-slate-500"><Loader2 className="h-7 w-7 animate-spin text-emerald-600" />Abriendo pizarra…</div></div>

  if (phase === 'error' || !board || !initialData) return <div className="flex h-full min-h-0 items-center justify-center bg-slate-50 p-5"><div className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-sm"><ShieldAlert className="mx-auto h-9 w-9 text-rose-500" /><h1 className="mt-4 text-xl font-black text-slate-900">No se pudo abrir la pizarra</h1><p className="mt-2 text-sm leading-6 text-slate-500">{error}</p><div className="mt-5 flex flex-wrap justify-center gap-2"><button type="button" onClick={() => router.push('/dashboard/whiteboards')} className="min-h-11 rounded-xl border border-slate-200 px-4 text-sm font-bold text-slate-600">Volver</button><button type="button" onClick={() => void load()} className="flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white"><RefreshCw className="h-4 w-4" />Reintentar</button></div></div></div>

  return <div ref={editorShellRef} data-whiteboard-layout={editorLayout} className="whiteboard-editor-shell flex h-full min-h-0 flex-col overflow-hidden bg-slate-100">
    <input ref={importInputRef} type="file" accept=".excalidraw,.json,application/json" className="hidden" onChange={importScene} />
    <input ref={libraryImportInputRef} type="file" accept=".excalidrawlib,application/json" className="hidden" onChange={importLibrary} />

    <div className="relative min-h-0 flex-1 bg-white">
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={api => {
          editorAPIRef.current = api
          requestAnimationFrame(() => {
            if (!mountedRef.current || editorAPIRef.current !== api) return
            suppressChangesRef.current = false
            suppressLibraryChangesRef.current = false
          })
        }}
        onChange={onChange}
        onLibraryChange={onLibraryChange}
        onPointerUpdate={({ pointer, button }) => { roomRef.current?.sendCursor({ pointer, button }) }}
        langCode="es-ES"
        name={board.name}
        isCollaborating
        viewModeEnabled={!canEdit}
        autoFocus
        renderTopRightUI={() => editorLayout !== 'wide' ? null : <div className="whiteboard-integrated-actions flex items-center gap-2">
          <SaveIndicator state={saveState} showLabel={false} />
          <>
            <button type="button" onClick={() => setLibraryOpen(true)} title="Administrar bibliotecas de Clarin" aria-label="Administrar bibliotecas de Clarin" className="whiteboard-integrated-action"><LibraryBig className="h-4 w-4" /></button>
            {canManageAccess && <button type="button" onClick={() => setShareOpen(true)} title="Compartir desde Clarin" aria-label="Compartir desde Clarin" className="whiteboard-integrated-action"><Share2 className="h-4 w-4" /></button>}
            <button type="button" onClick={() => setHistoryOpen(true)} title="Abrir historial de Clarin" aria-label="Abrir historial de Clarin" className="whiteboard-integrated-action"><History className="h-4 w-4" /></button>
            {canEdit && <button type="button" onClick={() => void flushSave('manual')} disabled={saveState === 'saving' || saveState === 'saved'} title="Guardar ahora en Clarin" aria-label="Guardar ahora en Clarin" className="whiteboard-integrated-action whiteboard-integrated-action--primary">{saveState === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}</button>}
          </>
        </div>}
        aiEnabled={false}
        validateEmbeddable={false}
        renderEmbeddable={renderBlockedWhiteboardEmbeddable}
        onLinkOpen={(element, event) => {
          event.preventDefault()
          const link = sanitizeWhiteboardExternalLink(element.link)
          if (link) window.open(link, '_blank', 'noopener,noreferrer')
        }}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            saveAsImage: false,
            export: false,
            toggleTheme: false,
          },
          tools: { image: canEdit },
        }}
      >
        {editorMenu}
      </Excalidraw>
      {showIntegratedTitle && <div className="whiteboard-integrated-title absolute left-16 top-2 z-30 flex h-11 min-w-0 items-center gap-1">
        <button type="button" onClick={() => void navigateFromWhiteboard('/dashboard/whiteboards')} aria-label="Volver a Pizarras" title="Volver a Pizarras" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><ArrowLeft className="h-5 w-5" /></button>
        <span className="mx-1 h-8 w-px shrink-0 bg-slate-200" />
        <label className="min-w-0"><span className="sr-only">Nombre de la pizarra</span><span className="block text-[9px] font-black uppercase tracking-[.14em] text-emerald-600">Pizarras Clarin</span><span className="flex items-center gap-1"><input value={titleDraft} onChange={event => setTitleDraft(event.target.value)} onBlur={() => void saveTitle()} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setTitleDraft(board.name); event.currentTarget.blur() } }} readOnly={!canEdit} maxLength={200} aria-label="Nombre de la pizarra" className="h-6 min-w-0 w-full truncate border-0 bg-transparent p-0 text-sm font-black text-slate-900 outline-none read-only:cursor-default" />{titleSaving && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" />}</span></label>
      </div>}
      {editorLayout !== 'wide' && <div className="whiteboard-mobile-actions absolute right-2 top-2 z-30 flex items-center gap-2">
        <SaveIndicator state={saveState} showLabel={false} />
        <button ref={moreButtonRef} type="button" onClick={toggleMoreMenu} aria-haspopup="menu" aria-expanded={moreOpen} title="Más acciones de Pizarras" aria-label="Más acciones de Pizarras" className="whiteboard-integrated-action"><MoreHorizontal className="h-5 w-5" /></button>
      </div>}
      {(error || libraryError || assetWarning || board.archived_at) && <div className={`whiteboard-canvas-notice absolute left-1/2 top-[4.25rem] z-40 flex w-[min(92%,52rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold shadow-lg ${error || librarySaveState === 'error' ? 'border-rose-200 bg-rose-50 text-rose-800' : board.archived_at || librarySaveState === 'conflict' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-sky-200 bg-sky-50 text-sky-800'}`} role={error ? 'alert' : 'status'}><span className="min-w-0 flex-1">{error || libraryError || (board.archived_at ? 'Esta pizarra está en la Papelera y se abre en modo lectura.' : assetWarning)}</span>{saveState === 'error' && canEdit && <button type="button" onClick={() => void flushSave('manual')} className="min-h-9 rounded-lg bg-white px-3 font-black shadow-sm">Reintentar guardado</button>}{saveState === 'conflict' && <button type="button" onClick={() => void reloadCanonical()} className="min-h-9 rounded-lg bg-white px-3 font-black shadow-sm">Recargar y conservar mis cambios</button>}{libraryError && <button type="button" onClick={() => setLibraryOpen(true)} className="min-h-9 rounded-lg bg-white px-3 font-black shadow-sm">Revisar biblioteca</button>}</div>}
      {!canEdit && <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-xs font-bold text-slate-600 shadow-lg">Solo lectura</div>}
    </div>

    {moreOpen && typeof document !== 'undefined' && createPortal(<div id="whiteboard-more-menu" role="menu" aria-label="Más acciones de Pizarras" style={{ top: moreMenuPosition.top, right: moreMenuPosition.right }} className="whiteboard-more-menu fixed z-[120] w-[min(21rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 shadow-2xl">
      <div className="border-b border-slate-100 px-3 py-2.5">
        <div className="text-[10px] font-black uppercase tracking-[.14em] text-emerald-600">Pizarras Clarin</div>
        <div className="mt-0.5 truncate text-sm font-black text-slate-900" title={board.name}>{board.name}</div>
        {thumbnailWarning && <button type="button" onClick={retryThumbnail} className="mt-2 flex min-h-9 w-full items-center gap-2 rounded-lg bg-amber-50 px-2.5 text-left text-xs font-bold text-amber-800"><RefreshCw className="h-3.5 w-3.5 shrink-0" />Miniatura pendiente · Reintentar</button>}
      </div>
      <div className="grid gap-1 py-1">
        {!showIntegratedTitle && <button autoFocus type="button" role="menuitem" onClick={() => { setMoreOpen(false); void navigateFromWhiteboard('/dashboard/whiteboards') }} className="whiteboard-more-item"><ArrowLeft className="h-4 w-4" />Volver a Pizarras</button>}
        <button autoFocus={showIntegratedTitle} type="button" role="menuitem" onClick={() => { setMoreOpen(false); openElementLibrary() }} className="whiteboard-more-item"><LibraryBig className="h-4 w-4" />Biblioteca</button>
        <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); setLibraryOpen(true) }} className="whiteboard-more-item"><LibraryBig className="h-4 w-4" />Administrar bibliotecas</button>
        {canManageAccess && <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); setShareOpen(true) }} className="whiteboard-more-item"><Share2 className="h-4 w-4" />Compartir</button>}
        <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); setHistoryOpen(true) }} className="whiteboard-more-item"><History className="h-4 w-4" />Historial</button>
        {canEdit && <button type="button" role="menuitem" disabled={saveState === 'saving' || saveState === 'saved'} onClick={() => { setMoreOpen(false); void flushSave('manual') }} className="whiteboard-more-item disabled:opacity-40"><Save className="h-4 w-4" />Guardar ahora</button>}
      </div>
      <div className="grid gap-1 border-t border-slate-100 pt-1">
        {canEdit && <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); importInputRef.current?.click() }} className="whiteboard-more-item"><FileUp className="h-4 w-4" />Importar archivo</button>}
        <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); exportJSON() }} className="whiteboard-more-item"><FileJson className="h-4 w-4" />Exportar editable</button>
        <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); void exportPNG() }} className="whiteboard-more-item"><FileImage className="h-4 w-4" />Exportar PNG</button>
        <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); void exportSVG() }} className="whiteboard-more-item"><Download className="h-4 w-4" />Exportar SVG</button>
      </div>
    </div>, document.body)}

    {shareOpen && <WhiteboardShareDialog boardID={boardID} onClose={() => setShareOpen(false)} />}
    {historyOpen && <WhiteboardHistoryDialog boardID={boardID} sequence={sequenceRef.current} canRestore={canEdit} onCreateCheckpoint={createCheckpoint} onRestored={record => {
      applySceneRecord(record)
      void hydrateReferencedAssets(restoreClarinWhiteboardScene(record.scene).elements)
    }} onClose={() => setHistoryOpen(false)} />}
    {libraryOpen && <WhiteboardLibraryDialog
      personalItemCount={personalLibraryItemCount}
      catalogs={libraryCatalogs}
      saveState={librarySaveState}
      error={libraryError}
      onImport={() => libraryImportInputRef.current?.click()}
      onExport={() => void exportLibrary()}
      onSave={() => void persistPersonalLibrary(true)}
      onReload={() => void reloadLibraries()}
      canManageCatalogs
      catalogBusy={libraryCatalogBusy}
      catalogError={libraryCatalogError}
      onCreateCatalog={createCatalog}
      onUpdateCatalog={updateCatalog}
      onArchiveCatalog={archiveCatalog}
      onExportCatalog={exportCatalog}
      onClose={() => setLibraryOpen(false)}
    />}
  </div>
}
