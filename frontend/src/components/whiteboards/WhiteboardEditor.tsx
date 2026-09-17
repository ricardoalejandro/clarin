'use client'

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  FileImage,
  FileJson,
  FileUp,
  History,
  LibraryBig,
  Loader2,
  RefreshCw,
  Save,
  Share2,
  ShieldAlert,
} from 'lucide-react'
import {
  CaptureUpdateAction,
  DefaultSidebar,
  Excalidraw,
  MainMenu,
  Sidebar,
  exportToBlob,
  getVisibleSceneBounds,
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
  mergeWhiteboardSessionAppState,
  parseWhiteboardLibraryItems,
  planWhiteboardAssetPersistence,
  personalWhiteboardLibraryItems,
  reconcileWhiteboardCollaborators,
  reconcileWhiteboardConnectionOpen,
  whiteboardRealtimeSyncRecoveryPlan,
  reconcileWhiteboardCanonicalAck,
  reconcileWhiteboardLibraryConflict,
  retainWhiteboardPendingSave,
  sanitizeWhiteboardAppState,
  sanitizeWhiteboardExternalLink,
  sanitizeWhiteboardFilesForPersistence,
  selectWhiteboardPersonalLibrary,
  snapshotWhiteboardFiles,
  shouldRetryWhiteboardDirtySave,
  shouldApplyWhiteboardRealtimeEvent,
  isWhiteboardSceneSequence,
  WHITEBOARD_AUTOSAVE_DELAY_MS,
  WHITEBOARD_COMMENTS_UI_ENABLED,
  WHITEBOARD_SHOW_DEPRECATED_OFFICIAL_FONTS,
  whiteboardEditorCanvasActions,
  whiteboardEditorLayout,
  whiteboardEditorAccess,
  whiteboardImageExportDialogAppState,
  whiteboardMoreMenuPosition,
  whiteboardSaveFailureAction,
  whiteboardSaveRetryStateAfterReconnect,
  whiteboardSaveRetryDelay,
  whiteboardThumbnailDelay,
  whiteboardToolbarShowsShare,
  whiteboardToolbarStacksBelowTools,
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
  type WhiteboardSaveRetryBlockReason,
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
  type WhiteboardRoomConnectionState,
} from '@/lib/whiteboardsApi'
import { logoutFromBrowser } from '@/lib/api'
import {
  classifyWhiteboardCollabTicketFailure,
  whiteboardEffectiveAccessAtLevel,
  whiteboardPermissionChangeFeedback,
  whiteboardRealtimeAccessLevel,
  whiteboardRealtimeConnectionNotice,
  type WhiteboardRealtimeIssue,
} from '@/lib/whiteboardRealtimeConnection'
import {
  blobToDataURL,
  dataURLToBlob,
  rasterizeWhiteboardFiles,
  referencedWhiteboardFileIDs,
  type WhiteboardBinaryFile,
} from '@/lib/whiteboardMedia'
import {
  mapWhiteboardConcurrently,
  whiteboardAbortError,
  whiteboardAsyncResultIsStale,
} from '@/lib/whiteboardAsync'
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
import {
  WhiteboardEditorActionBar,
  type WhiteboardSaveState,
} from './WhiteboardEditorActionBar'
import { WhiteboardPresentationOverlay } from './WhiteboardPresentationControls'
import { useWhiteboardPresentation } from '@/hooks/useWhiteboardPresentation'
import { useWhiteboardFocusMode } from '@/hooks/useWhiteboardFocusMode'
import { useClarinRuntime } from '@/components/offline-v5/ClarinRuntimeProvider'
import { runWhiteboardWrite, whiteboardWriteTransportAvailable } from './whiteboardOfflineTransport'
import {
  WHITEBOARD_OVERLAY_LAYERS,
  whiteboardFocusAppStateHasTransientLayer,
} from '@/lib/whiteboardFocusMode'
import {
  useWhiteboardAssetHydration,
  whiteboardAssetHydrationMessage,
} from '@/hooks/useWhiteboardAssetHydration'
import {
  useWhiteboardFontPreload,
  whiteboardFontPreloadFirstPassComplete,
  whiteboardFontPreloadMessage,
} from '@/hooks/useWhiteboardFontPreload'
import {
  WhiteboardCommentPins,
  WhiteboardCommentsProvider,
  WhiteboardCommentsSidebar,
  type WhiteboardCommentFocusTarget,
  type WhiteboardCommentsProviderHandle,
} from './WhiteboardComments'
import type { WhiteboardCommentChangedEvent } from '@/lib/whiteboardComments'
import WhiteboardFocusModeMenuItem from './WhiteboardFocusModeMenuItem'
import { consumeWhiteboardViewModeCommentPointer } from '@/lib/whiteboardCommentPlacement'
import {
  acknowledgeWhiteboardPublicLibraryImportAfterConflict,
  consumeWhiteboardPublicLibraryImport,
  installWhiteboardPublicLibraryStartPath,
  isWhiteboardPublicLibraryStartPath,
  readWhiteboardPublicLibraryImportID,
  rememberWhiteboardPublicLibraryWorkReturn,
  stripWhiteboardPublicLibraryImportFromPath,
  validateWhiteboardPublicLibraryNavigationPath,
} from '@/lib/whiteboardPublicLibraries'
import {
  completeWhiteboardPublicLibraryImport,
  getWhiteboardPublicLibraryImport,
  startWhiteboardPublicLibraryImport,
} from '@/lib/whiteboardPublicLibrariesApi'

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH: string | string[] | undefined
  }
}

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
  automaticRetryBlockReason: WhiteboardSaveRetryBlockReason
  notFoundDiagnosed: boolean
}

interface LoadedWhiteboardLibraries {
  personal: WhiteboardLibraryRecord
  personalItems: LibraryItems
  catalogItems: LibraryItems[]
  catalogSummaries: WhiteboardLibraryCatalogSummary[]
  readOnlyItemIDs: Set<string>
  assetEntries: Array<{ libraryID: string; items: LibraryItems }>
  warning: string | null
}

interface WhiteboardCurrentActor {
  id: string
  isAdmin: boolean
}

class PublicLibraryImportError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable = true) {
    super(message)
    this.name = 'PublicLibraryImportError'
    this.retryable = retryable
  }
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

function whiteboardSaveIsBusy(state: WhiteboardSaveState) {
  return state === 'preparing-assets' || state === 'uploading-assets' || state === 'saving'
}

function WhiteboardLibrarySidebar() {
  return <DefaultSidebar className="clarin-whiteboard-library-sidebar">
    <DefaultSidebar.TabTriggers>
      <Sidebar.TabTrigger tab="library" data-whiteboard-sidebar-internal="library" aria-label="Biblioteca" title="Biblioteca">
        <LibraryBig className="h-5 w-5" />
        <span className="sr-only">Biblioteca</span>
      </Sidebar.TabTrigger>
    </DefaultSidebar.TabTriggers>
  </DefaultSidebar>
}

function WhiteboardCommentsCapability({
  enabled,
  commentsRef,
  boardID,
  currentUserID,
  canComment,
  disabledReason,
  editorAPI,
  onFocusAnchor,
  children,
}: {
  enabled: boolean
  commentsRef: MutableRefObject<WhiteboardCommentsProviderHandle | null>
  boardID: string
  currentUserID: string | null
  canComment: boolean
  disabledReason: string
  editorAPI: ExcalidrawImperativeAPI | null
  onFocusAnchor: (target: WhiteboardCommentFocusTarget) => void
  children: ReactNode
}) {
  if (!enabled) return <>{children}</>
  return <WhiteboardCommentsProvider
    ref={handle => { commentsRef.current = handle }}
    boardID={boardID}
    currentUserID={currentUserID}
    canComment={canComment}
    disabledReason={disabledReason}
    editorAPI={editorAPI}
    onFocusAnchor={onFocusAnchor}
  >{children}</WhiteboardCommentsProvider>
}

export interface WhiteboardEditorHandle {
  requestLeave: (options?: WhiteboardLeaveGuardOptions) => Promise<boolean>
}

export interface WhiteboardLeaveGuardOptions {
  forced?: boolean
}

export type WhiteboardLeaveGuard = (options?: WhiteboardLeaveGuardOptions) => Promise<boolean>

export interface WhiteboardEditorProps {
  boardID: string
  canonicalName?: string
  hostContext?: 'whiteboards' | 'work'
  returnHref?: string
  returnLabel?: string
  onExit?: () => void
  onLeaveGuardReady?: (guard: WhiteboardLeaveGuard | null) => void
}

const WhiteboardEditor = forwardRef<WhiteboardEditorHandle, WhiteboardEditorProps>(function WhiteboardEditor({
  boardID,
  canonicalName,
  hostContext = 'whiteboards',
  returnHref = '/dashboard/whiteboards',
  returnLabel,
  onExit,
  onLeaveGuardReady,
}, forwardedRef) {
  const router = useRouter()
  const { isOffline, requireOnline } = useClarinRuntime()
  const networkOrLocal = whiteboardWriteTransportAvailable(
    typeof navigator !== 'undefined' && navigator.onLine,
    isOffline,
  )
  const canonicalNameRef = useRef(canonicalName)
  canonicalNameRef.current = canonicalName
  const editorShellRef = useRef<HTMLDivElement>(null)
  const canvasHostRef = useRef<HTMLDivElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const libraryImportInputRef = useRef<HTMLInputElement>(null)
  const editorAPIRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const commentsRef = useRef<WhiteboardCommentsProviderHandle | null>(null)
  const currentActorRef = useRef<WhiteboardCurrentActor | null>(null)
  const publicLibraryStartCleanupRef = useRef<(() => void) | null>(null)
  const publicLibraryImportProcessingRef = useRef<string | null>(null)
  const publicLibraryImportActiveRef = useRef(false)
  const publicLibraryImportControllerRef = useRef<AbortController | null>(null)
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
  const permissionRefreshControllerRef = useRef<AbortController | null>(null)
  const permissionRefreshGenerationRef = useRef(0)
  const persistedFileIDsRef = useRef(new Set<string>())
  const assetUploadControllerRef = useRef<AbortController | null>(null)
  const assetSavingRef = useRef(false)
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
  const sessionLogoutStartedRef = useRef(false)
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
  const libraryAssetEntriesRef = useRef<Array<{ libraryID: string; items: LibraryItems }>>([])
  const libraryAssetsLoadedRef = useRef(false)
  const libraryAssetsPromiseRef = useRef<Promise<void> | null>(null)
  const libraryAssetsControllerRef = useRef<AbortController | null>(null)

  const [phase, setPhase] = useState<EditorPhase>('loading')
  const [board, setBoard] = useState<WhiteboardSummary | null>(null)
  const [editorAPI, setEditorAPI] = useState<ExcalidrawImperativeAPI | null>(null)
  const [currentUserID, setCurrentUserID] = useState<string | null>(null)
  const [initialData, setInitialData] = useState<{ elements: readonly ExcalidrawElement[]; appState: Partial<AppState>; files: BinaryFiles; libraryItems: LibraryItems } | null>(null)
  const [saveState, setSaveState] = useState<WhiteboardSaveState>('saved')
  const [error, setError] = useState<string | null>(null)
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null)
  const [permissionRevalidating, setPermissionRevalidating] = useState(false)
  const [realtimeConnection, setRealtimeConnection] = useState<WhiteboardRoomConnectionState>('connecting')
  const [realtimeHasOpened, setRealtimeHasOpened] = useState(false)
  const [realtimeIssue, setRealtimeIssue] = useState<WhiteboardRealtimeIssue | null>(null)
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
  const [libraryMetadataReady, setLibraryMetadataReady] = useState(false)
  const [libraryAssetsLoading, setLibraryAssetsLoading] = useState(false)
  const [editorLayout, setEditorLayout] = useState<WhiteboardEditorLayout>('compact')
  const [editorAvailableWidth, setEditorAvailableWidth] = useState(0)
  const [moreOpen, setMoreOpen] = useState(false)
  const [moreMenuPosition, setMoreMenuPosition] = useState({ top: 60, right: 12 })
  const [publicLibraryImporting, setPublicLibraryImporting] = useState(false)
  const [publicLibraryImportError, setPublicLibraryImportError] = useState<string | null>(null)
  const [publicLibraryImportRetryable, setPublicLibraryImportRetryable] = useState(true)
  const [publicLibraryImportRetryKey, setPublicLibraryImportRetryKey] = useState(0)

  const isWorkOrigin = hostContext === 'work' || board?.origin === 'work'
  const historicalWorkView = board?.origin === 'work' && board.work_location?.lifecycle === 'location_archived'
  const baseEditorAccess = whiteboardEditorAccess(board?.effective_access, board?.archived_at)
  const editorAccess = historicalWorkView
    ? { canEdit: false, canComment: false, viewModeEnabled: true }
    : baseEditorAccess
  const { canEdit, canComment } = editorAccess
  const canManageAccess = !isOffline && !isWorkOrigin && Boolean(board?.effective_access?.can_manage_access) && !board?.archived_at
  const backLabel = returnLabel || (hostContext === 'work' ? 'Volver a Clarin Work' : 'Volver a Pizarras')
  const showIntegratedTitle = editorLayout === 'wide' || (editorLayout === 'compact' && editorAvailableWidth >= 1_100)
  const showShareInToolbar = whiteboardToolbarShowsShare(editorAvailableWidth, canManageAccess)
  const stackToolbarBelowTools = whiteboardToolbarStacksBelowTools(editorAvailableWidth)
  const focusInteractionBlocked = useCallback(() => {
    if (moreOpen || shareOpen || historyOpen || libraryOpen || permissionRevalidating) return true
    return whiteboardFocusAppStateHasTransientLayer(editorAPIRef.current?.getAppState())
  }, [historyOpen, libraryOpen, moreOpen, permissionRevalidating, shareOpen])
  const {
    active: focusModeActive,
    announcement: focusModeAnnouncement,
    enter: enterFocusMode,
    exit: exitFocusMode,
    clearBeforeNavigation: clearFocusModeBeforeNavigation,
  } = useWhiteboardFocusMode({
    boardID,
    ready: phase === 'ready',
    rootRef: editorShellRef,
    fallbackFocusRef: moreButtonRef,
    editorAPI,
    isInteractionBlocked: focusInteractionBlocked,
  })
  const backActionLabel = focusModeActive ? 'Volver a vista normal' : backLabel

  useEffect(() => {
    if (hostContext !== 'work' || !canonicalName?.trim()) return
    setTitleDraft(canonicalName)
    setBoard(current => current && current.name !== canonicalName ? { ...current, name: canonicalName } : current)
  }, [canonicalName, hostContext])

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
      event.preventDefault()
      event.stopImmediatePropagation()
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
        setMoreMenuPosition(whiteboardMoreMenuPosition(
          rect,
          { width: window.innerWidth, height: window.innerHeight },
        ))
      }
      return true
    })
  }, [])

  const openClarinLibraries = useCallback(() => {
    if (requireOnline('Administrar bibliotecas de Pizarras')) setLibraryOpen(true)
  }, [requireOnline])

  const openWhiteboardShare = useCallback(() => {
    if (requireOnline('Administrar el acceso de la pizarra')) setShareOpen(true)
  }, [requireOnline])

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

  const presentation = useWhiteboardPresentation({
    editorAPI,
    roomRef,
    canPresent: canEdit && !isOffline,
    runWithTransientSceneSuppressed,
  })

  const fetchLibraries = useCallback(async (
    actorID: string,
    actorIsAdmin: boolean,
    signal?: AbortSignal,
  ): Promise<LoadedWhiteboardLibraries> => {
    const listResponse = await collectWhiteboardLibraryPages(cursor => listWhiteboardLibraries(signal, '', cursor))
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
      readOnlyItemIDs: composition.readOnlyItemIDs,
      assetEntries: [
        { libraryID: personalDetail.id, items: personalItems },
        ...accountDetails.map((library, index) => ({ libraryID: library.id, items: catalogItems[index] })),
      ],
      warning: failedCatalogs.length
        ? `${failedCatalogs.length} bibliotecas compartidas no pudieron cargarse.`
        : null,
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

  const loadLibraryAssets = useCallback(() => {
    if (libraryAssetsLoadedRef.current) return Promise.resolve()
    if (libraryAssetsPromiseRef.current) return libraryAssetsPromiseRef.current
    const entries = [...libraryAssetEntriesRef.current]
    if (entries.length === 0) return Promise.resolve()
    const controller = new AbortController()
    libraryAssetsControllerRef.current?.abort()
    libraryAssetsControllerRef.current = controller
    setLibraryAssetsLoading(true)
    const operation = (async () => {
      let failures = 0
      for (const entry of entries) {
        const result = await hydrateWhiteboardLibraryFiles(entry.libraryID, entry.items, controller.signal)
        if (controller.signal.aborted) throw whiteboardAbortError()
        failures += result.failures
        if (Object.keys(result.files).length > 0) {
          runWithTransientSceneSuppressed(() => {
            editorAPIRef.current?.addFiles(Object.values(result.files) as BinaryFileData[])
          })
          if (latestSceneRef.current) latestSceneRef.current = {
            ...latestSceneRef.current,
            files: { ...latestSceneRef.current.files, ...result.files },
          }
        }
      }
      libraryAssetsLoadedRef.current = failures === 0
      if (failures > 0) {
        setLibrarySaveState('error')
        setLibraryError(`${failures} recursos de biblioteca no están disponibles. Vuelve a abrirla para reintentar.`)
      }
    })().catch(loadError => {
      if (controller.signal.aborted) return
      setLibrarySaveState('error')
      setLibraryError(loadError instanceof Error ? loadError.message : 'No se pudieron cargar los recursos de las bibliotecas.')
    }).finally(() => {
      if (libraryAssetsControllerRef.current === controller) libraryAssetsControllerRef.current = null
      if (libraryAssetsPromiseRef.current === operation) libraryAssetsPromiseRef.current = null
      if (!controller.signal.aborted && mountedRef.current) setLibraryAssetsLoading(false)
    })
    libraryAssetsPromiseRef.current = operation
    return operation
  }, [runWithTransientSceneSuppressed])

  const openElementLibrary = useCallback(() => {
    const api = editorAPIRef.current
    if (!api) return
    void loadLibraryAssets()
    const composition = combineWhiteboardLibraryItems(personalLibraryItemsRef.current, catalogLibraryItemsRef.current)
    void api.updateLibrary({
      libraryItems: composition.combined,
      merge: false,
      defaultStatus: 'unpublished',
      openLibraryMenu: true,
    })
  }, [loadLibraryAssets])

  useEffect(() => {
    if (libraryOpen && libraryMetadataReady) void loadLibraryAssets()
  }, [libraryMetadataReady, libraryOpen, loadLibraryAssets])

  useEffect(() => {
    if (phase !== 'ready' || !editorAPI || !libraryMetadataReady || !personalLibraryRef.current) return
    void applyLibraryComposition(personalLibraryItemsRef.current, catalogLibraryItemsRef.current)
  }, [applyLibraryComposition, editorAPI, libraryMetadataReady, phase])

  const discardPublicLibraryImport = useCallback(() => {
    if (typeof window !== 'undefined') {
      const cleanPath = stripWhiteboardPublicLibraryImportFromPath(
        window.location.pathname,
        window.location.search,
        window.location.hash,
      )
      window.history.replaceState(window.history.state, '', cleanPath)
    }
    setPublicLibraryImportError(null)
    setPublicLibraryImportRetryable(true)
  }, [])

  const focusCommentAnchor = useCallback((target: WhiteboardCommentFocusTarget) => {
    window.requestAnimationFrame(() => {
      const api = editorAPIRef.current
      if (!api) return
      const element = target.elementID
        ? api.getSceneElements().find(candidate => candidate.id === target.elementID)
        : null
      if (element) {
        api.scrollToContent(element, { animate: true, duration: 200, fitToContent: true })
        return
      }
      const appState = api.getAppState()
      const zoom = Math.max(0.01, appState.zoom.value)
      const bounds = canvasHostRef.current?.getBoundingClientRect()
      const centerX = (bounds?.left ?? appState.offsetLeft) + (bounds?.width ?? appState.width) / 2
      const centerY = (bounds?.top ?? appState.offsetTop) + (bounds?.height ?? appState.height) / 2
      runWithTransientSceneSuppressed(() => {
        api.updateScene({
          appState: {
            scrollX: (centerX - appState.offsetLeft) / zoom - target.sceneX,
            scrollY: (centerY - appState.offsetTop) / zoom - target.sceneY,
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        })
      })
    })
  }, [runWithTransientSceneSuppressed])

  const onHydratedBoardFile = useCallback((file: BinaryFileData) => {
    runWithTransientSceneSuppressed(() => {
      editorAPIRef.current?.addFiles([file])
    })
    if (latestSceneRef.current) latestSceneRef.current = {
      ...latestSceneRef.current,
      files: { ...latestSceneRef.current.files, [file.id]: file } as BinaryFiles,
    }
  }, [runWithTransientSceneSuppressed])

  const {
    progress: fontPreloadProgress,
    retry: retryFontPreload,
  } = useWhiteboardFontPreload(
    `member:${boardID}:${currentUserID || 'pending'}`,
    editorAPI,
  )
  const fontPreloadFirstPassComplete = whiteboardFontPreloadFirstPassComplete(fontPreloadProgress)
  const fontPreloadMessage = whiteboardFontPreloadMessage(fontPreloadProgress)

  const {
    progress: assetHydrationProgress,
    request: requestAssetHydration,
    retry: retryAssetHydration,
  } = useWhiteboardAssetHydration({
    ownerKey: `member:${boardID}:${currentUserID || 'pending'}`,
    enabled: phase === 'ready' && Boolean(editorAPI) && fontPreloadFirstPassComplete,
    listAssets: async (fileIDs, signal) => {
      const response = await listWhiteboardAssets(boardID, fileIDs, signal)
      return {
        assets: response.success ? response.data?.assets || [] : [],
        error: response.success ? undefined : response.error || 'No se pudieron cargar las imágenes de la pizarra.',
      }
    },
    downloadAsset: async (asset, signal) => {
      const response = await downloadWhiteboardAsset(boardID, asset.id, signal)
      return {
        blob: response.success ? response.blob : undefined,
        error: response.success ? undefined : response.error || 'No se pudo descargar una imagen de la pizarra.',
      }
    },
    onFile: onHydratedBoardFile,
    onPersistedFileIDs: fileIDs => {
      for (const fileID of fileIDs) persistedFileIDsRef.current.add(fileID)
    },
  })

  const assetHydrationMessage = whiteboardAssetHydrationMessage(assetHydrationProgress)

  const load = useCallback(async (signal?: AbortSignal) => {
    setPhase('loading')
    setError(null)
    setPermissionNotice(null)
    setRealtimeIssue(null)
    setRealtimeConnection(isOffline ? 'closed' : 'connecting')
    setRealtimeHasOpened(false)
    sessionLogoutStartedRef.current = false
    setCurrentUserID(null)
    currentActorRef.current = null
    setEditorAPI(null)
    editorAPIRef.current = null
    publicLibraryImportControllerRef.current?.abort()
    publicLibraryImportControllerRef.current = null
    publicLibraryImportActiveRef.current = false
    publicLibraryImportProcessingRef.current = null
    setPublicLibraryImporting(false)
    setPublicLibraryImportError(null)
    setPublicLibraryImportRetryable(true)
    publicLibraryStartCleanupRef.current?.()
    publicLibraryStartCleanupRef.current = null
    persistedFileIDsRef.current = new Set()
    libraryAssetsControllerRef.current?.abort()
    libraryAssetsControllerRef.current = null
    libraryAssetsPromiseRef.current = null
    libraryAssetsLoadedRef.current = false
    libraryAssetEntriesRef.current = []
    setLibraryMetadataReady(false)
    setLibraryAssetsLoading(false)
    canonicalSyncControllerRef.current?.abort()
    canonicalSyncAppliedSequenceRef.current = -1
    canonicalSyncLoadingSequenceRef.current = -1
    const [metadataResponse, sceneResponse, actorResponse] = await Promise.all([
      loadWhiteboardMetadata(boardID, signal),
      loadWhiteboardScene(boardID, signal),
      getWhiteboardCurrentActor(signal),
    ])
    // React development remounts abort the first load before starting the
    // canonical one. An aborted response must never overwrite that newer load
    // with a user-facing "Solicitud cancelada" error.
    if (whiteboardAsyncResultIsStale({ signal, mounted: mountedRef.current })) return
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
    const actorID = actorResponse.success ? actorResponse.data?.user?.id : null
    const actor = actorID ? {
      id: actorID,
      isAdmin: Boolean(actorResponse.data?.user?.is_admin),
    } : null
    currentActorRef.current = actor
    setCurrentUserID(actor?.id || null)
    const scene = restoreClarinWhiteboardScene(record.scene)
    sceneRootExtensionsRef.current = whiteboardSceneRootExtensions(scene)
    sceneFileMetadataRef.current = sanitizeWhiteboardFilesForPersistence(scene.files)
    persistedFileIDsRef.current = new Set(referencedWhiteboardFileIDs(scene.elements))
    const files = {} as BinaryFiles
    if (signal?.aborted) return
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
    personalLibraryRef.current = null
    libraryDirtyRef.current = false
    libraryChangeVersionRef.current = 0
    lastSavedLibraryChangeVersionRef.current = 0
    personalLibraryItemsRef.current = []
    catalogLibraryItemsRef.current = []
    readOnlyLibraryItemIDsRef.current = new Set()
    setPersonalLibraryItemCount(0)
    setLibraryCatalogs([])
    setLibrarySaveState(actor ? 'saving' : 'error')
    setLibraryError(actor ? null : actorResponse.error || 'No se pudo identificar tu biblioteca privada.')
    const canonicalWorkName = hostContext === 'work' ? canonicalNameRef.current?.trim() : ''
    const effectiveMetadata = canonicalWorkName ? { ...metadata, name: canonicalWorkName } : metadata
    setBoard(effectiveMetadata)
    setTitleDraft(effectiveMetadata.name)
    setInitialData({
      elements: scene.elements as readonly ExcalidrawElement[],
      appState: scene.appState as Partial<AppState>,
      files,
      libraryItems: [],
    })
    setSaveState('saved')
    setPhase('ready')

    if (actor && !isOffline) {
      void fetchLibraries(actor.id, actor.isAdmin, signal).then(async loaded => {
        if (whiteboardAsyncResultIsStale({ signal, mounted: mountedRef.current })) return
        personalLibraryRef.current = loaded.personal
        personalLibraryItemsRef.current = loaded.personalItems
        catalogLibraryItemsRef.current = loaded.catalogItems
        readOnlyLibraryItemIDsRef.current = loaded.readOnlyItemIDs
        libraryAssetEntriesRef.current = loaded.assetEntries
        libraryAssetsLoadedRef.current = loaded.assetEntries.every(entry => referencedWhiteboardFileIDs(whiteboardLibraryElements(entry.items)).length === 0)
        libraryConflictRef.current = false
        libraryDirtyRef.current = false
        libraryChangeVersionRef.current = 0
        lastSavedLibraryChangeVersionRef.current = 0
        setPersonalLibraryItemCount(loaded.personalItems.length)
        setLibraryCatalogs(loaded.catalogSummaries)
        setLibraryMetadataReady(true)
        setLibrarySaveState(loaded.warning ? 'error' : 'saved')
        setLibraryError(loaded.warning)
        if (!metadata.archived_at) {
          publicLibraryStartCleanupRef.current = installWhiteboardPublicLibraryStartPath(boardID, loaded.personal.id)
        }
        await applyLibraryComposition(loaded.personalItems, loaded.catalogItems)
      }).catch(loadError => {
        if (whiteboardAsyncResultIsStale({ signal, mounted: mountedRef.current })) return
        setLibrarySaveState('error')
        setLibraryError(loadError instanceof Error ? loadError.message : 'No se pudieron cargar las bibliotecas de Pizarras.')
      })
    } else if (isOffline) {
      // Account-wide and public libraries are not part of one selected board.
      // Keep the canonical editor available without pulling unrelated data.
      setLibrarySaveState('saved')
      setLibraryError(null)
    }
  }, [applyLibraryComposition, boardID, fetchLibraries, hostContext, isOffline])

  useEffect(() => {
    window.EXCALIDRAW_ASSET_PATH = whiteboardEditorAssetBase(window.location.origin)
    mountedRef.current = true
    const controller = new AbortController()
    void load(controller.signal)
    return () => {
      mountedRef.current = false
      controller.abort()
      assetUploadControllerRef.current?.abort()
      canonicalSyncControllerRef.current?.abort()
      canonicalSyncGenerationRef.current += 1
      permissionRefreshControllerRef.current?.abort()
      permissionRefreshGenerationRef.current += 1
      libraryLoadControllerRef.current?.abort()
      libraryLoadGenerationRef.current += 1
      libraryAssetsControllerRef.current?.abort()
      libraryAssetsControllerRef.current = null
      libraryAssetsPromiseRef.current = null
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
      if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current)
      if (librarySaveTimerRef.current) clearTimeout(librarySaveTimerRef.current)
      publicLibraryStartCleanupRef.current?.()
      publicLibraryStartCleanupRef.current = null
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
    const onOffline = () => {
      if (isOffline) {
        if (dirtyRef.current) setSaveState('pending')
        return
      }
      setSaveState('offline')
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current && !savingRef.current && !assetSavingRef.current && !libraryDirtyRef.current && !librarySavingRef.current && !commentsRef.current?.hasUnsavedWork()) return
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
  }, [isOffline])

  const persistPersonalLibrary = useCallback(async (manual = false) => {
    if (librarySavingRef.current) {
      libraryQueuedSaveRef.current = true
      return null
    }
    const library = personalLibraryRef.current
    if (!library) return null
    if (!libraryDirtyRef.current) return library.version
    if (libraryConflictRef.current && !manual) return null
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
          return null
        }
        throw new Error(response.error || 'No se pudo guardar Mi biblioteca.')
      }
      personalLibraryRef.current = response.data.library
      lastSavedLibraryChangeVersionRef.current = Math.max(lastSavedLibraryChangeVersionRef.current, capturedVersion)
      libraryConflictRef.current = false
      const unchanged = capturedVersion === libraryChangeVersionRef.current
      libraryDirtyRef.current = !unchanged
      setLibrarySaveState(unchanged ? 'saved' : 'pending')
      return response.data.library.version
    } catch (saveError) {
      if (!mountedRef.current) return null
      libraryDirtyRef.current = true
      setLibrarySaveState('error')
      setLibraryError(saveError instanceof Error ? saveError.message : 'No se pudo guardar Mi biblioteca.')
      return null
    } finally {
      librarySavingRef.current = false
      if (!libraryConflictRef.current && (libraryQueuedSaveRef.current || capturedVersion !== libraryChangeVersionRef.current)) {
        libraryQueuedSaveRef.current = false
        if (librarySaveTimerRef.current) clearTimeout(librarySaveTimerRef.current)
        librarySaveTimerRef.current = setTimeout(() => { void persistPersonalLibrary() }, 500)
      }
    }
  }, [applyLibraryComposition])

  useEffect(() => {
    if (isOffline || phase !== 'ready' || !editorAPI || !libraryMetadataReady || typeof window === 'undefined') return
    const importID = readWhiteboardPublicLibraryImportID(window.location.search)
    const personalLibrary = personalLibraryRef.current
    if (!importID || !personalLibrary) return
    const processingKey = `${boardID}:${importID}:${publicLibraryImportRetryKey}`
    if (publicLibraryImportProcessingRef.current === processingKey) return

    const controller = new AbortController()
    publicLibraryImportControllerRef.current?.abort()
    publicLibraryImportControllerRef.current = controller
    publicLibraryImportProcessingRef.current = processingKey
    publicLibraryImportActiveRef.current = true
    libraryLoadControllerRef.current?.abort()
    libraryLoadGenerationRef.current += 1
    if (librarySaveTimerRef.current) {
      clearTimeout(librarySaveTimerRef.current)
      librarySaveTimerRef.current = null
    }
    setPublicLibraryImporting(true)
    setPublicLibraryImportError(null)
    setPublicLibraryImportRetryable(true)

    void (async () => {
      try {
        await consumeWhiteboardPublicLibraryImport({
          boardID,
          importID,
          libraryID: personalLibrary.id,
          load: async () => {
            const response = await getWhiteboardPublicLibraryImport(boardID, importID, controller.signal)
            if (!response.success || !response.data?.import) {
              const retryable = !response.status || ![401, 403, 404, 410, 422].includes(response.status)
              throw new PublicLibraryImportError(
                response.error || 'No se pudo recuperar la biblioteca validada por Clarin.',
                retryable,
              )
            }
            if (response.data.import.status === 'failed' || response.data.import.status === 'expired') {
              throw new PublicLibraryImportError(
                response.data.import.status === 'expired'
                  ? 'La solicitud de importación venció. Vuelve a explorar el catálogo desde la pizarra.'
                  : 'Clarin rechazó esta importación. Vuelve a explorar el catálogo y elige otra biblioteca.',
                false,
              )
            }
            return response.data.import
          },
          mergeAndPersist: async libraryJSON => {
            if (controller.signal.aborted) throw whiteboardAbortError()
            const source = new Blob([JSON.stringify(libraryJSON)], { type: 'application/json' })
            const importedItems = await loadLibraryFromBlob(source, 'unpublished')
            if (controller.signal.aborted) throw whiteboardAbortError()
            const merged = mergeLibraryItems(personalLibraryItemsRef.current, importedItems) as LibraryItems
            if (getLibraryItemsHash(merged) !== getLibraryItemsHash(personalLibraryItemsRef.current)) {
              personalLibraryItemsRef.current = merged
              libraryChangeVersionRef.current += 1
              libraryDirtyRef.current = true
              libraryConflictRef.current = false
              await applyLibraryComposition(merged)
              setLibrarySaveState('pending')
            }

            const deadline = Date.now() + 20_000
            while (librarySavingRef.current && Date.now() < deadline && !controller.signal.aborted) {
              await new Promise(resolve => window.setTimeout(resolve, 50))
            }
            if (controller.signal.aborted) throw whiteboardAbortError()
            if (librarySavingRef.current) throw new Error('Mi biblioteca sigue ocupada. Espera un momento y vuelve a intentar la importación.')
            const libraryVersion = await persistPersonalLibrary(true)
            if (libraryVersion === null) {
              throw new Error('Clarin no pudo confirmar el guardado de la biblioteca importada. Revisa el aviso y vuelve a intentarlo.')
            }
            return { libraryVersion }
          },
          complete: async input => {
            const acknowledged = await acknowledgeWhiteboardPublicLibraryImportAfterConflict<{
              success: boolean
              status?: number
              error?: string
              data?: { import?: unknown }
            }>({
              operationID: input.operationID,
              libraryVersion: input.libraryVersion,
              complete: value => completeWhiteboardPublicLibraryImport(
                boardID,
                importID,
                value,
                controller.signal,
              ),
              reconcileLibraryVersion: async () => {
                if (controller.signal.aborted) throw whiteboardAbortError()
                const canonicalResponse = await getWhiteboardLibrary(personalLibrary.id, controller.signal)
                if (!canonicalResponse.success || !canonicalResponse.data?.library) {
                  throw new PublicLibraryImportError(
                    canonicalResponse.error || 'Mi biblioteca cambió y no se pudo recuperar su versión actual.',
                    true,
                  )
                }
                if (controller.signal.aborted) throw whiteboardAbortError()

                const canonical = canonicalResponse.data.library
                const canonicalItems = restoredWhiteboardLibraryItems(canonical.library_json)
                const reconciled = reconcileWhiteboardLibraryConflict(
                  canonicalItems,
                  personalLibraryItemsRef.current,
                ) as LibraryItems
                const needsPersistence = getLibraryItemsHash(reconciled) !== getLibraryItemsHash(canonicalItems)

                personalLibraryRef.current = canonical
                personalLibraryItemsRef.current = reconciled
                libraryConflictRef.current = false
                await applyLibraryComposition(reconciled)
                if (!needsPersistence) {
                  libraryDirtyRef.current = false
                  setLibrarySaveState('saved')
                  setLibraryError(null)
                  return canonical.version
                }

                libraryChangeVersionRef.current += 1
                libraryDirtyRef.current = true
                setLibrarySaveState('pending')
                const reconciledVersion = await persistPersonalLibrary(true)
                if (reconciledVersion === null) {
                  throw new PublicLibraryImportError(
                    'Mi biblioteca volvió a cambiar durante la conciliación. Clarin conservó los elementos importados para que puedas reintentar.',
                    true,
                  )
                }
                return reconciledVersion
              },
            })
            const response = acknowledged.response
            if (!response.success || !response.data?.import) {
              const retryable = !response.status || ![401, 403, 404, 410, 422].includes(response.status)
              throw new PublicLibraryImportError(
                response.error || 'La biblioteca se guardó, pero no se pudo confirmar la importación.',
                retryable,
              )
            }
          },
        })
        if (controller.signal.aborted || !mountedRef.current) return
        const cleanPath = stripWhiteboardPublicLibraryImportFromPath(
          window.location.pathname,
          window.location.search,
          window.location.hash,
        )
        window.history.replaceState(window.history.state, '', cleanPath)
        setPublicLibraryImportError(null)
        openElementLibrary()
      } catch (importError) {
        if (controller.signal.aborted || !mountedRef.current) return
        setPublicLibraryImportError(importError instanceof Error
          ? importError.message
          : 'No se pudo incorporar la biblioteca pública.')
        setPublicLibraryImportRetryable(
          !(importError instanceof PublicLibraryImportError) || importError.retryable,
        )
      } finally {
        const ownsImport = publicLibraryImportControllerRef.current === controller
        if (publicLibraryImportProcessingRef.current === processingKey) {
          publicLibraryImportProcessingRef.current = null
        }
        if (ownsImport) {
          publicLibraryImportControllerRef.current = null
          publicLibraryImportActiveRef.current = false
        }
        if (ownsImport && !controller.signal.aborted && mountedRef.current) setPublicLibraryImporting(false)
      }
    })()

    return () => {
      controller.abort()
      if (publicLibraryImportProcessingRef.current === processingKey) {
        publicLibraryImportProcessingRef.current = null
      }
      if (publicLibraryImportControllerRef.current === controller) {
        publicLibraryImportControllerRef.current = null
        publicLibraryImportActiveRef.current = false
        if (mountedRef.current) setPublicLibraryImporting(false)
      }
    }
  }, [
    applyLibraryComposition,
    boardID,
    editorAPI,
    libraryMetadataReady,
    isOffline,
    openElementLibrary,
    persistPersonalLibrary,
    phase,
    publicLibraryImportRetryKey,
  ])

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
    if (publicLibraryImportActiveRef.current) {
      setLibraryError('Espera a que termine la importación pública antes de recargar las bibliotecas.')
      return
    }
    libraryLoadControllerRef.current?.abort()
    libraryAssetsControllerRef.current?.abort()
    libraryAssetsControllerRef.current = null
    libraryAssetsPromiseRef.current = null
    libraryAssetsLoadedRef.current = false
    setLibraryMetadataReady(false)
    const controller = new AbortController()
    libraryLoadControllerRef.current = controller
    const generation = ++libraryLoadGenerationRef.current
    setLibraryError(null)
    try {
      let actor = currentActorRef.current
      if (!actor) {
        const actorResponse = await getWhiteboardCurrentActor(controller.signal)
        const actorID = actorResponse.data?.user?.id
        if (!actorResponse.success || !actorID) {
          throw new Error(actorResponse.error || 'No se pudo identificar tu biblioteca privada.')
        }
        actor = { id: actorID, isAdmin: Boolean(actorResponse.data?.user?.is_admin) }
        currentActorRef.current = actor
        setCurrentUserID(actor.id)
      }
      const loaded = await fetchLibraries(actor.id, actor.isAdmin, controller.signal)
      if (controller.signal.aborted || generation !== libraryLoadGenerationRef.current || !mountedRef.current) return
      const hadLocalChanges = libraryDirtyRef.current
      const personalItems = hadLocalChanges
        ? reconcileWhiteboardLibraryConflict(loaded.personalItems, personalLibraryItemsRef.current) as LibraryItems
        : loaded.personalItems
      personalLibraryRef.current = loaded.personal
      catalogLibraryItemsRef.current = loaded.catalogItems
      libraryAssetEntriesRef.current = loaded.assetEntries
      libraryAssetsLoadedRef.current = loaded.assetEntries.every(entry => referencedWhiteboardFileIDs(whiteboardLibraryElements(entry.items)).length === 0)
      setLibraryCatalogs(loaded.catalogSummaries)
      setLibraryMetadataReady(true)
      await applyLibraryComposition(personalItems, loaded.catalogItems)
      publicLibraryStartCleanupRef.current?.()
      publicLibraryStartCleanupRef.current = board?.archived_at
        ? null
        : installWhiteboardPublicLibraryStartPath(boardID, loaded.personal.id)
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
      if (libraryOpen) void loadLibraryAssets()
    } catch (loadError) {
      if (controller.signal.aborted || generation !== libraryLoadGenerationRef.current || !mountedRef.current) return
      setLibrarySaveState('error')
      setLibraryError(loadError instanceof Error ? loadError.message : 'No se pudieron recargar las bibliotecas.')
    } finally {
      if (libraryLoadControllerRef.current === controller) libraryLoadControllerRef.current = null
    }
  }, [applyLibraryComposition, board?.archived_at, boardID, fetchLibraries, libraryOpen, loadLibraryAssets])

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
    assetUploadControllerRef.current?.abort()
    const controller = new AbortController()
    assetUploadControllerRef.current = controller
    assetSavingRef.current = true
    setSaveState('preparing-assets')
    try {
      const initialPlan = planWhiteboardAssetPersistence(
        elements,
        files as unknown as Record<string, unknown>,
        persistedFileIDsRef.current,
      )
      const referencedFileIDs = new Set(initialPlan.referencedFileIDs)
      const referencedFiles = Object.fromEntries(Object.entries(files).filter(([fileID]) => referencedFileIDs.has(fileID)))
      const safeFiles = await rasterizeWhiteboardFiles(referencedFiles as unknown as Record<string, unknown>) as unknown as BinaryFiles
      if (controller.signal.aborted) throw whiteboardAbortError()
      const plan = planWhiteboardAssetPersistence(
        elements,
        safeFiles as unknown as Record<string, unknown>,
        persistedFileIDsRef.current,
      )
      if (plan.missingFileIDs.length > 0) {
        throw new Error('Una imagen todavía no terminó de prepararse. Tus cambios siguen en el lienzo; reintenta el guardado.')
      }
      if (plan.uploadFileIDs.length > 0) {
        setSaveState('uploading-assets')
        await mapWhiteboardConcurrently(plan.uploadFileIDs, 4, async fileID => {
          const file = safeFiles[fileID] as unknown as WhiteboardBinaryFile
          const blob = dataURLToBlob(file.dataURL)
          const response = await uploadWhiteboardAsset(
            boardID,
            fileID,
            blob,
            `${fileID}.${extensionForMimeType(blob.type)}`,
            controller.signal,
          )
          if (controller.signal.aborted) throw whiteboardAbortError()
          if (!response.success || !response.data?.asset) {
            throw new Error(response.error || 'No se pudo guardar una imagen de la pizarra.')
          }
          persistedFileIDsRef.current.add(fileID)
        }, controller.signal)
      }
      if (Object.keys(safeFiles).length > 0) editorAPIRef.current?.addFiles(Object.values(safeFiles) as BinaryFileData[])
      return snapshotWhiteboardFiles({ ...files, ...safeFiles }) as unknown as BinaryFiles
    } finally {
      if (assetUploadControllerRef.current === controller) assetUploadControllerRef.current = null
      assetSavingRef.current = false
    }
  }, [boardID])

  const hydrateReferencedAssets = useCallback((elements: readonly unknown[]) => {
    for (const fileID of referencedWhiteboardFileIDs(elements)) persistedFileIDsRef.current.add(fileID)
    const api = editorAPIRef.current
    requestAssetHydration(elements, api ? getVisibleSceneBounds(api.getAppState()) : null)
  }, [requestAssetHydration])

  useEffect(() => {
    if (phase !== 'ready' || !editorAPI || !initialData) return
    hydrateReferencedAssets(initialData.elements)
  }, [editorAPI, hydrateReferencedAssets, initialData, phase])

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
      const appState = mergeWhiteboardSessionAppState(
        currentAppState as unknown as Record<string, unknown>,
        reconciled.appState,
      ) as unknown as AppState
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
    if (reason === 'autosave' && pendingSaveRef.current?.automaticRetryBlockReason) return
    if (reason !== 'autosave' && pendingSaveRef.current) {
      pendingSaveRef.current.automaticFailures = 0
      pendingSaveRef.current.automaticRetryBlockReason = null
    }
    if (!networkOrLocal) {
      setSaveState('offline')
      return
    }
    if (savingRef.current) {
      queuedSaveRef.current = true
      return
    }
    const initialScene = latestSceneRef.current
    if (!initialScene) return
    let scene: LatestScene = initialScene
    savingRef.current = true
    queuedSaveRef.current = false
    let capturedVersion = pendingSaveRef.current?.capturedVersion ?? changeVersionRef.current
    if (pendingSaveRef.current) setSaveState('saving')
    setError(null)
    try {
      let pending = pendingSaveRef.current
      if (!pending) {
        const files = await uploadPendingFiles(scene.files, scene.elements)
        const currentScene = latestSceneRef.current || scene
        scene = {
          ...currentScene,
          files: snapshotWhiteboardFiles({
            ...(currentScene.files as unknown as Record<string, unknown>),
            ...(files as unknown as Record<string, unknown>),
          }) as unknown as BinaryFiles,
        }
        latestSceneRef.current = scene
        capturedVersion = changeVersionRef.current
        setSaveState('saving')
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
          automaticRetryBlockReason: null,
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
        const attempt = await runWhiteboardWrite({
          browserOnline: navigator.onLine,
          runtimeOffline: isOffline,
          write: () => saveWhiteboard(boardID, pending.payload),
        })
        if (!attempt.attempted) {
          setSaveState('offline')
          return
        }
        const response = attempt.result
        if (!response.success || !response.data?.result.scene) {
          pending.automaticFailures += 1
          const failureAction = whiteboardSaveFailureAction(response.status, pending.automaticFailures)
          if (failureAction === 'conflict') {
            pending.automaticRetryBlockReason = 'conflict'
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
          pending.automaticRetryBlockReason = failureAction === 'retry' ? null : failureAction
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
      setSaveState(networkOrLocal ? 'error' : 'offline')
      setError(saveError instanceof Error ? saveError.message : 'No se pudo guardar la pizarra.')
    } finally {
      savingRef.current = false
      const retryUnacknowledged = Boolean(
        pendingSaveRef.current
        && !pendingSaveRef.current.automaticRetryBlockReason
        && dirtyRef.current
        && networkOrLocal,
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
  }, [applyCanonicalWriteConfirmation, boardID, canEdit, diagnoseWhiteboardWriteNotFound, isOffline, networkOrLocal, reconcileWhiteboardWriteConflict, scheduleThumbnail, uploadPendingFiles])

  const onChange = useCallback((elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    const openSidebar = appState.openSidebar as { name?: string } | null
    if (openSidebar?.name === 'library') void loadLibraryAssets()
    const previous = latestSceneRef.current
    const snapshottedElements = elements.map(element => ({ ...element })) as readonly ExcalidrawElement[]
    const snapshottedFiles = snapshotWhiteboardFiles(files as unknown as Record<string, unknown>) as unknown as BinaryFiles
    latestSceneRef.current = { elements: snapshottedElements, appState, files: snapshottedFiles }
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
    const retryBlocked = Boolean(pendingSaveRef.current?.automaticRetryBlockReason)
    setSaveState(!networkOrLocal ? 'offline' : retryBlocked ? 'error' : 'pending')
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    if (!retryBlocked) autosaveTimerRef.current = setTimeout(() => { void flushSave('autosave') }, WHITEBOARD_AUTOSAVE_DELAY_MS)
  }, [canEdit, flushSave, loadLibraryAssets, networkOrLocal])

  const applySceneRecord = useCallback((record: WhiteboardSceneRecord, preserveLocalChanges = false) => {
    const api = editorAPIRef.current
    const scene = restoreClarinWhiteboardScene(record.scene)
    for (const fileID of referencedWhiteboardFileIDs(scene.elements)) persistedFileIDsRef.current.add(fileID)
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
    const appState = currentAppState
      ? mergeWhiteboardSessionAppState(
        currentAppState as unknown as Record<string, unknown>,
        reconciled?.appState || scene.appState,
      ) as unknown as AppState
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
        // Keep an immutable pending write across reconnect sync. Reusing its
        // operation_id lets the backend return the canonical idempotent result
        // when the prior acknowledgement was the only thing that was lost.
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
    // Collaborators are ephemeral and excluded by
    // hasWhiteboardDocumentMutation(). Do not hold the document-wide
    // suppression window here: a user stroke can land in the same animation
    // frame as a presence update and must still become dirty/autosaved.
    api.updateScene({
      collaborators: excalidrawWhiteboardCollaborators(next, presentation.getSelfActorID()),
      captureUpdate: CaptureUpdateAction.NEVER,
    })
  }, [presentation.getSelfActorID])

  const handleRealtimeIssue = useCallback((issue: WhiteboardRealtimeIssue | null) => {
    setRealtimeIssue(issue)
    if (!issue || issue.kind === 'authorization_unavailable') return
    if (issue.kind === 'access_revoked') {
      setError('Tu acceso a esta pizarra fue revocado.')
      setPhase('error')
      return
    }
    setPermissionNotice(issue.message)
    if (sessionLogoutStartedRef.current) return
    sessionLogoutStartedRef.current = true
    void logoutFromBrowser('expired')
  }, [])

  const refreshMetadataForPermissionChange = useCallback(async () => {
    permissionRefreshControllerRef.current?.abort()
    const controller = new AbortController()
    permissionRefreshControllerRef.current = controller
    const generation = ++permissionRefreshGenerationRef.current
    setPermissionRevalidating(true)
    const response = await loadWhiteboardMetadata(boardID, controller.signal)
    if (controller.signal.aborted || generation !== permissionRefreshGenerationRef.current || !mountedRef.current) return
    setPermissionRevalidating(false)
    if (!response.success || !response.data?.whiteboard) {
      if (response.status === 403 || response.status === 404) {
        setRealtimeIssue({ kind: 'access_revoked', message: 'Tu acceso a esta pizarra fue revocado.', retryable: false })
        setError('Tu acceso a esta pizarra fue revocado.')
        setPhase('error')
        return
      }
      setRealtimeIssue({ kind: 'authorization_unavailable', message: 'No pudimos revalidar tu acceso.', retryable: true })
      setError('No pudimos revalidar tu acceso. Por seguridad ocultamos el lienzo hasta que vuelvas a intentarlo.')
      setPhase('error')
      return
    }
    const rawMetadata = response.data.whiteboard
    const canonicalWorkName = hostContext === 'work' ? canonicalNameRef.current?.trim() : ''
    const metadata = canonicalWorkName ? { ...rawMetadata, name: canonicalWorkName } : rawMetadata
    const nextAccess = whiteboardEditorAccess(metadata.effective_access, metadata.archived_at)
    const feedback = whiteboardPermissionChangeFeedback({
      canEdit: nextAccess.canEdit,
      hasPendingChanges: dirtyRef.current || Boolean(pendingSaveRef.current),
      online: navigator.onLine,
    })
    setBoard(metadata)
    setPermissionNotice(feedback.notice)
    if (feedback.saveState) setSaveState(feedback.saveState)
    setRealtimeIssue(null)
  }, [boardID, hostContext])

  useEffect(() => {
    if (phase !== 'ready' || historicalWorkView || isOffline) {
      if (isOffline) {
        setRealtimeConnection('closed')
        setRealtimeHasOpened(false)
        collaboratorsRef.current = new Map()
      }
      return
    }
    let hasOpened = false
    const room = connectWhiteboardRoom({
      whiteboardID: boardID,
      audience: 'member',
      getSequence: () => sequenceRef.current,
      getTicket: () => requestWhiteboardCollabTicket(boardID, board?.account_id),
      onIssue: handleRealtimeIssue,
      onEvent: event => {
        const handledByPresentation = presentation.handleRealtimeEvent(event)
        if (event.event === 'room.ready') {
          // room.ready establishes the canonical self actor synchronously.
          // Reproject any presence snapshot that arrived first so Excalidraw
          // can mark the own avatar without waiting for another presence event.
          applyCollaboratorEvent(event)
          return
        }
			if (handledByPresentation) return
        if (event.event === 'presence.snapshot' || event.event === 'presence.update' || event.event === 'cursor.update') {
          applyCollaboratorEvent(event)
          return
        }
        if (event.event === 'comment.changed') {
          if (WHITEBOARD_COMMENTS_UI_ENABLED && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
            commentsRef.current?.applyRealtimeEvent(event.data as WhiteboardCommentChangedEvent)
          } else if (WHITEBOARD_COMMENTS_UI_ENABLED) {
            void commentsRef.current?.reload()
          }
          return
        }
        if (event.event === 'access.revoked') {
          if (event.code === 'work_access_changed') {
            void refreshMetadataForPermissionChange()
            return
          }
          handleRealtimeIssue({
            kind: 'access_revoked',
            message: 'Tu acceso a esta pizarra fue revocado.',
            retryable: false,
          })
          return
        }
        if (event.event === 'error') {
          if (event.code === 'permission_changed') {
            const immediateLevel = whiteboardRealtimeAccessLevel(event.data)
            if (immediateLevel) {
              setBoard(current => current ? {
                ...current,
                effective_access: whiteboardEffectiveAccessAtLevel(current.effective_access, immediateLevel),
              } : current)
              const feedback = whiteboardPermissionChangeFeedback({
                canEdit: immediateLevel === 'edit' || immediateLevel === 'manage',
                hasPendingChanges: dirtyRef.current || Boolean(pendingSaveRef.current),
                online: navigator.onLine,
              })
              setPermissionNotice(feedback.notice)
              if (feedback.saveState) setSaveState(feedback.saveState)
            }
            void refreshMetadataForPermissionChange()
            return
          }
          if (event.code === 'session_expired' || event.code === 'authorization_unavailable' || event.code === 'presence_unavailable') return
          // Correlated operation errors reject sendPatch() and are recovered by
          // the idempotent REST fallback before any user-facing failure state.
          if (!event.operation_id) setError(event.error || 'La colaboración en tiempo real encontró un error.')
          return
        }
        if (event.event === 'sync.required') {
          const recovery = whiteboardRealtimeSyncRecoveryPlan('member')
          // Keep the recovery contract complete even while the comments UI is
          // feature-hidden. A mounted provider reloads immediately; when the
          // capability is hidden the optional ref is simply absent.
          if (recovery.reloadComments) void commentsRef.current?.reload()
          if (recovery.reloadScene) void reloadCanonicalForRealtime(event, true)
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
            editor_version: '0.18.1-clarin.7',
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
			presentation.handleConnectionChange(state)
        setRealtimeConnection(state)
        if (state === 'open') {
          setRealtimeHasOpened(true)
          const connection = reconcileWhiteboardConnectionOpen(hasOpened)
          if (WHITEBOARD_COMMENTS_UI_ENABLED && connection.reloadComments) void commentsRef.current?.reload()
          const pending = pendingSaveRef.current
          if (pending) {
            const retryState = whiteboardSaveRetryStateAfterReconnect({
              previouslyOpened: connection.reloadComments,
              automaticFailures: pending.automaticFailures,
              automaticRetryBlockReason: pending.automaticRetryBlockReason,
            })
            if (retryState.shouldRetry) {
              pending.automaticFailures = retryState.automaticFailures
              pending.automaticRetryBlockReason = retryState.automaticRetryBlockReason
              setSaveState('pending')
            }
          }
          hasOpened = connection.hasOpened
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
          if (api) {
            api.updateScene({ collaborators: new Map(), captureUpdate: CaptureUpdateAction.NEVER })
          }
        }
      },
    })
    roomRef.current = room
    return () => {
      if (roomRef.current === room) roomRef.current = null
      room.close()
    }
  }, [applyCollaboratorEvent, applySceneRecord, board?.account_id, boardID, flushSave, handleRealtimeIssue, historicalWorkView, hydrateReferencedAssets, isOffline, phase, presentation.handleConnectionChange, presentation.handleRealtimeEvent, refreshMetadataForPermissionChange, reloadCanonicalForRealtime])

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
    if (!board || isWorkOrigin || !canEdit || titleSaving) return
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

  const openImageExport = useCallback(() => {
    const api = editorAPIRef.current
    if (!api) return
    api.updateScene({
      appState: whiteboardImageExportDialogAppState(),
      captureUpdate: CaptureUpdateAction.NEVER,
    })
  }, [])

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
      persistedFileIDsRef.current = new Set()
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

  const prepareToLeave = useCallback(async () => {
    if (navigationInProgressRef.current) return false
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
      assetSaving: assetSavingRef.current,
      libraryDirty: libraryDirtyRef.current,
      librarySaving: librarySavingRef.current,
      commentSaving: commentsRef.current?.hasPendingMutations() || false,
      commentDirty: commentsRef.current?.hasUnsavedDrafts() || false,
      flushAttempted,
    })
    const waitForActiveWrites = async () => {
      const deadline = Date.now() + 15_000
      while ((savingRef.current || assetSavingRef.current || librarySavingRef.current || commentsRef.current?.hasPendingMutations()) && Date.now() < deadline) {
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
        commentsPending: commentsRef.current?.hasPendingMutations() || false,
        commentsDirty: commentsRef.current?.hasUnsavedDrafts() || false,
      })
      const action = durableWritesCoverClick ? 'leave' : whiteboardNavigationAction(state())
      if (action !== 'leave') {
        const discard = window.confirm('Clarin no pudo confirmar todos los cambios. ¿Salir y descartar únicamente lo que siga pendiente?')
        if (!discard) return false
      }
      return true
    } finally {
      navigationInProgressRef.current = false
    }
  }, [flushSave, persistPersonalLibrary])

  const prepareForForcedClose = useCallback(async () => {
    const requiredSceneVersion = dirtyRef.current || pendingSaveRef.current || savingRef.current
      ? changeVersionRef.current
      : null
    const requiredLibraryVersion = libraryDirtyRef.current || librarySavingRef.current
      ? libraryChangeVersionRef.current
      : null
    if (requiredSceneVersion === null
      && requiredLibraryVersion === null
      && !assetSavingRef.current
      && !commentsRef.current?.hasPendingMutations()
      && !commentsRef.current?.hasUnsavedDrafts()) return true

    const attempt = (async () => {
      try {
        if (dirtyRef.current || pendingSaveRef.current) await flushSave('manual')
        if (libraryDirtyRef.current) await persistPersonalLibrary(true)
        const deadline = Date.now() + 900
        while ((savingRef.current || assetSavingRef.current || librarySavingRef.current || commentsRef.current?.hasPendingMutations()) && Date.now() < deadline) {
          await new Promise(resolve => window.setTimeout(resolve, 40))
        }
        return whiteboardNavigationWritesCovered({
          requiredSceneVersion,
          savedSceneVersion: lastSavedChangeVersionRef.current,
          requiredLibraryVersion,
          savedLibraryVersion: lastSavedLibraryChangeVersionRef.current,
          commentsPending: commentsRef.current?.hasPendingMutations() || false,
          commentsDirty: commentsRef.current?.hasUnsavedDrafts() || false,
        })
      } catch {
        return false
      }
    })()
    let timeout: number | null = null
    try {
      return await Promise.race([
        attempt,
        new Promise<boolean>(resolve => { timeout = window.setTimeout(() => resolve(false), 1_200) }),
      ])
    } finally {
      if (timeout !== null) window.clearTimeout(timeout)
    }
  }, [flushSave, persistPersonalLibrary])

  const requestLeave = useCallback((options?: WhiteboardLeaveGuardOptions) => (
    options?.forced ? prepareForForcedClose() : prepareToLeave()
  ), [prepareForForcedClose, prepareToLeave])

  useImperativeHandle(forwardedRef, () => ({ requestLeave }), [requestLeave])
  useEffect(() => {
    onLeaveGuardReady?.(requestLeave)
    return () => onLeaveGuardReady?.(null)
  }, [onLeaveGuardReady, requestLeave])

  const openHistory = useCallback(async () => {
    if (!await prepareToLeave()) return
    setHistoryOpen(true)
  }, [prepareToLeave])

  const navigateFromWhiteboard = useCallback(async (
    href: string,
    publicLibraryID: string | null = null,
  ) => {
    if (!await prepareToLeave()) return
    if (publicLibraryID) {
      const response = await startWhiteboardPublicLibraryImport(boardID, publicLibraryID)
      const navigation = response.success && response.data?.success !== false
        ? validateWhiteboardPublicLibraryNavigationPath(response.data?.navigation_path, boardID)
        : null
      if (!navigation) {
        setLibraryError(response.error || 'Clarin no pudo autorizar la exploración de bibliotecas. Inténtalo de nuevo.')
        return
      }
      if (hostContext === 'work') {
        try {
          rememberWhiteboardPublicLibraryWorkReturn(
            boardID,
            `${window.location.pathname}${window.location.search}`,
            window.sessionStorage,
          )
        } catch {
          // The callback remains safe and returns to the Pizarras editor when
          // browser storage is unavailable.
        }
      }
      clearFocusModeBeforeNavigation()
      window.location.assign(navigation.path)
      return
    }
    clearFocusModeBeforeNavigation()
    if (onExit && href === returnHref) {
      onExit()
      return
    }
    router.push(href)
  }, [boardID, clearFocusModeBeforeNavigation, hostContext, onExit, prepareToLeave, returnHref, router])

  const requestBackFromWhiteboard = useCallback(() => {
    if (focusModeActive) {
      exitFocusMode()
      return
    }
    void navigateFromWhiteboard(returnHref)
  }, [exitFocusMode, focusModeActive, navigateFromWhiteboard, returnHref])

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
      const href = `${destination.pathname}${destination.search}${destination.hash}`
      const publicLibraryAnchor = anchor.classList.contains('library-menu-browse-button')
      const publicLibraryID = publicLibraryAnchor && !board?.archived_at
        ? personalLibraryRef.current?.id || null
        : null
      if (publicLibraryAnchor && !isWhiteboardPublicLibraryStartPath(href, boardID, publicLibraryID)) {
        setLibraryError('No se pudo iniciar la exploración de bibliotecas. Recarga las bibliotecas e inténtalo de nuevo.')
        return
      }
      void navigateFromWhiteboard(href, publicLibraryID)
    }
    document.addEventListener('click', guardInternalNavigation, true)
    return () => document.removeEventListener('click', guardInternalNavigation, true)
  }, [board?.archived_at, boardID, navigateFromWhiteboard, phase])

  const editorMenu = useMemo(() => <MainMenu>
    <MainMenu.Group title="Pizarra Clarin">
      <MainMenu.Item icon={<ArrowLeft className="h-4 w-4" />} onSelect={requestBackFromWhiteboard}>{backActionLabel}</MainMenu.Item>
      {canEdit && <MainMenu.Item icon={<Save className="h-4 w-4" />} shortcut="Ctrl+S" onSelect={() => void flushSave('manual')}>Guardar ahora</MainMenu.Item>}
      {canEdit && <MainMenu.Item icon={<FileUp className="h-4 w-4" />} onSelect={() => importInputRef.current?.click()}>Importar archivo</MainMenu.Item>}
    </MainMenu.Group>
    <MainMenu.Separator />
    <MainMenu.Group title="Exportar copia">
      <MainMenu.Item icon={<FileJson className="h-4 w-4" />} onSelect={exportJSON}>Archivo editable</MainMenu.Item>
      <MainMenu.DefaultItems.SaveAsImage />
    </MainMenu.Group>
    <MainMenu.Separator />
    <MainMenu.Group title="Bibliotecas internas">
      <MainMenu.Item icon={<LibraryBig className="h-4 w-4" />} onSelect={openClarinLibraries}>Administrar Mi biblioteca</MainMenu.Item>
    </MainMenu.Group>
    {(canManageAccess || board?.effective_access?.can_view) && <><MainMenu.Separator /><MainMenu.Group title="Colaboración">
      {canManageAccess && <MainMenu.Item icon={<Share2 className="h-4 w-4" />} onSelect={openWhiteboardShare}>Compartir desde Clarin</MainMenu.Item>}
      <MainMenu.Item icon={<History className="h-4 w-4" />} onSelect={() => { void openHistory() }}>Historial de Clarin</MainMenu.Item>
    </MainMenu.Group></>}
  </MainMenu>, [backActionLabel, board?.effective_access?.can_view, canEdit, canManageAccess, flushSave, openClarinLibraries, openHistory, openWhiteboardShare, requestBackFromWhiteboard])

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

  useEffect(() => {
    if (!WHITEBOARD_COMMENTS_UI_ENABLED || phase !== 'ready' || !canComment || !editorAccess.viewModeEnabled) return
    const host = canvasHostRef.current
    if (!host) return
    const captureCommentPlacement = (event: PointerEvent) => {
      consumeWhiteboardViewModeCommentPointer(
        event,
        (clientX, clientY) => commentsRef.current?.captureViewModePlacement(clientX, clientY) || false,
      )
    }
    host.addEventListener('pointerdown', captureCommentPlacement, true)
    return () => host.removeEventListener('pointerdown', captureCommentPlacement, true)
  }, [canComment, editorAccess.viewModeEnabled, phase])

  if (phase === 'loading') return <div className="flex h-full min-h-0 items-center justify-center bg-slate-50"><div className="flex flex-col items-center gap-3 text-sm font-bold text-slate-500"><Loader2 className="h-7 w-7 animate-spin text-emerald-600" />Abriendo pizarra…</div></div>

  if (phase === 'error' || !board || !initialData) return <div className="flex h-full min-h-0 items-center justify-center bg-slate-50 p-5"><div className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-sm"><ShieldAlert className="mx-auto h-9 w-9 text-rose-500" /><h1 className="mt-4 text-xl font-black text-slate-900">No se pudo abrir la pizarra</h1><p className="mt-2 text-sm leading-6 text-slate-500">{error}</p><div className="mt-5 flex flex-wrap justify-center gap-2"><button type="button" onClick={() => void navigateFromWhiteboard(returnHref)} className="min-h-11 rounded-xl border border-slate-200 px-4 text-sm font-bold text-slate-600">Volver</button><button type="button" onClick={() => void load()} className="flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white"><RefreshCw className="h-4 w-4" />Reintentar</button></div></div></div>

  const realtimeNotice = whiteboardRealtimeConnectionNotice({
    connection: realtimeConnection,
    hasOpened: realtimeHasOpened,
    issue: realtimeIssue,
  })
  const canvasNoticeSource = error
    ? 'error'
    : publicLibraryImportError
      ? 'public-error'
      : publicLibraryImporting
        ? 'public-loading'
          : libraryError
          ? 'library-error'
          : permissionNotice
            ? 'permission'
            : historicalWorkView
            ? 'historical'
            : realtimeNotice
              ? 'realtime'
          : board.archived_at
            ? 'archived'
            : libraryAssetsLoading
              ? 'library-loading'
              : fontPreloadMessage
                ? 'fonts'
              : assetHydrationMessage
                ? 'assets'
                : null
  const canvasNoticeMessage = canvasNoticeSource === 'public-loading'
    ? 'Clarin está validando y guardando la biblioteca seleccionada…'
    : canvasNoticeSource === 'archived'
      ? 'Esta pizarra está en la Papelera y se abre en modo lectura.'
      : canvasNoticeSource === 'historical'
        ? 'La ubicación está archivada. Esta pizarra se conserva como histórico de solo lectura.'
      : canvasNoticeSource === 'library-loading'
        ? 'Cargando imágenes de la biblioteca…'
        : canvasNoticeSource === 'permission'
          ? permissionNotice
          : canvasNoticeSource === 'realtime'
            ? realtimeNotice?.message || null
        : canvasNoticeSource === 'fonts'
          ? fontPreloadMessage
        : canvasNoticeSource === 'assets'
          ? assetHydrationMessage
          : error || publicLibraryImportError || libraryError
  const canvasNoticeIsError = canvasNoticeSource === 'error'
    || canvasNoticeSource === 'public-error'
    || canvasNoticeSource === 'library-error'
    || (canvasNoticeSource === 'fonts' && fontPreloadProgress.phase === 'error')
    || (canvasNoticeSource === 'assets' && assetHydrationProgress.phase === 'error')
  const canvasNoticeIsWarning = canvasNoticeSource === 'permission'
    || (canvasNoticeSource === 'realtime' && Boolean(realtimeNotice?.warning))
    || canvasNoticeSource === 'archived'
    || canvasNoticeSource === 'historical'
    || librarySaveState === 'conflict'
  const canvasNoticeIsLoading = canvasNoticeSource === 'public-loading'
    || canvasNoticeSource === 'library-loading'
    || (canvasNoticeSource === 'fonts' && (fontPreloadProgress.phase === 'idle' || fontPreloadProgress.phase === 'loading' || fontPreloadProgress.phase === 'offline'))
    || (canvasNoticeSource === 'assets' && assetHydrationProgress.phase === 'loading')
    || (canvasNoticeSource === 'realtime' && Boolean(realtimeNotice?.busy))
  const canvasNoticeHasActions = canvasNoticeSource === 'public-error'
    || canvasNoticeSource === 'library-error'
    || (canvasNoticeSource === 'fonts' && fontPreloadProgress.phase === 'error')
    || (canvasNoticeSource === 'assets' && assetHydrationProgress.phase === 'error')
    || canvasNoticeSource === 'realtime'

  return <div
    ref={editorShellRef}
    data-whiteboard-layout={editorLayout}
    data-whiteboard-focus-mode={focusModeActive ? 'true' : 'false'}
    role="region"
    aria-label={focusModeActive ? 'Pizarra maximizada' : 'Editor de pizarra'}
    style={focusModeActive ? { zIndex: WHITEBOARD_OVERLAY_LAYERS.focusSurface } : undefined}
    className={`whiteboard-editor-shell flex h-full min-h-0 flex-col overflow-hidden bg-slate-100${focusModeActive ? ' app-viewport fixed whiteboard-editor-shell--focused' : ''}`}
  >
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{focusModeAnnouncement}</span>
    <input ref={importInputRef} type="file" accept=".excalidraw,.json,application/json" className="hidden" onChange={importScene} />
    <input ref={libraryImportInputRef} type="file" accept=".excalidrawlib,application/json" className="hidden" onChange={importLibrary} />

    <div
      ref={canvasHostRef}
      className="relative min-h-0 flex-1 bg-white"
    >
      <WhiteboardCommentsCapability
        enabled={WHITEBOARD_COMMENTS_UI_ENABLED}
        commentsRef={commentsRef}
        boardID={boardID}
        currentUserID={currentUserID}
        canComment={canComment}
        disabledReason={board.archived_at
          ? 'Esta pizarra está en la Papelera; sus comentarios son de solo lectura.'
          : 'Puedes leer los comentarios, pero necesitas permiso de comentario para participar.'}
        editorAPI={editorAPI}
        onFocusAnchor={focusCommentAnchor}
      >
        <Excalidraw
        initialData={initialData}
        excalidrawAPI={api => {
          editorAPIRef.current = api
          setEditorAPI(current => current === api ? current : api)
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
        isCollaborating={!isOffline}
        viewModeEnabled={editorAccess.viewModeEnabled}
        autoFocus
        renderTopRightUI={(_isMobile, appState) => editorLayout !== 'wide' ? null : <div className="whiteboard-integrated-actions flex items-center gap-2">
          <WhiteboardEditorActionBar
            ref={moreButtonRef}
            editorAPI={editorAPI}
            openSidebar={appState.openSidebar}
            showShare={showShareInToolbar}
            canManageAccess={canManageAccess}
            canEdit={canEdit}
            saveState={saveState}
            moreOpen={moreOpen}
            onShare={openWhiteboardShare}
            onRetrySave={() => saveState === 'conflict' ? void reloadCanonical() : void flushSave('manual')}
            onToggleMore={toggleMoreMenu}
			presentation={{
			  controlState: presentation.controlState,
			  state: presentation.state,
			  onStart: () => { if (requireOnline('Iniciar una presentación colaborativa')) void presentation.start() },
			  onStop: () => { void presentation.stop() },
			}}
          />
        </div>}
        aiEnabled={false}
        mermaidEnabled
        validateEmbeddable={false}
        renderEmbeddable={renderBlockedWhiteboardEmbeddable}
        onLinkOpen={(element, event) => {
          event.preventDefault()
          const link = sanitizeWhiteboardExternalLink(element.link)
          if (link && requireOnline('Abrir un enlace externo')) window.open(link, '_blank', 'noopener,noreferrer')
        }}
        showDeprecatedFonts={WHITEBOARD_SHOW_DEPRECATED_OFFICIAL_FONTS}
        enableRichText
        UIOptions={{
          canvasActions: whiteboardEditorCanvasActions(true),
          tools: { image: canEdit },
        }}
      >
        {editorMenu}
        {WHITEBOARD_COMMENTS_UI_ENABLED ? <WhiteboardCommentsSidebar /> : <WhiteboardLibrarySidebar />}
        <DefaultSidebar.Trigger
          style={{ display: 'none' }}
          tab="library"
          title="Biblioteca"
          icon={<LibraryBig className="h-5 w-5" />}
        >Biblioteca</DefaultSidebar.Trigger>
        </Excalidraw>
        {WHITEBOARD_COMMENTS_UI_ENABLED && <WhiteboardCommentPins containerRef={canvasHostRef} />}
        {editorLayout !== 'wide' && <div className={`whiteboard-mobile-actions absolute right-2 top-2 z-30${stackToolbarBelowTools ? ' whiteboard-mobile-actions--stacked' : ''}`}>
          <WhiteboardEditorActionBar
            ref={moreButtonRef}
            editorAPI={editorAPI}
            showShare={showShareInToolbar}
            canManageAccess={canManageAccess}
            canEdit={canEdit}
            saveState={saveState}
            moreOpen={moreOpen}
            onShare={openWhiteboardShare}
            onRetrySave={() => saveState === 'conflict' ? void reloadCanonical() : void flushSave('manual')}
            onToggleMore={toggleMoreMenu}
			presentation={{
			  controlState: presentation.controlState,
			  state: presentation.state,
			  onStart: () => { if (requireOnline('Iniciar una presentación colaborativa')) void presentation.start() },
			  onStop: () => { void presentation.stop() },
			}}
          />
        </div>}
      </WhiteboardCommentsCapability>
	  {permissionRevalidating && <div data-whiteboard-permission-revalidating className="absolute inset-0 z-[70] flex items-center justify-center bg-slate-950/70 p-5 backdrop-blur-sm" role="status" aria-live="assertive"><div className="flex max-w-sm items-center gap-3 rounded-2xl border border-white/20 bg-slate-900 px-5 py-4 text-sm font-bold text-white shadow-2xl"><Loader2 className="h-5 w-5 shrink-0 animate-spin text-emerald-400" /><span>Verificando tu acceso a esta pizarra…</span></div></div>}
	  <WhiteboardPresentationOverlay
		state={presentation.state}
		showInvitation={presentation.showInvitation}
		onAccept={presentation.acceptInvitation}
		onDecline={presentation.declineInvitation}
		onLeave={presentation.leaveFollow}
	  />
      {showIntegratedTitle && <div className="whiteboard-integrated-title absolute left-16 top-2 z-30 flex h-11 min-w-0 items-center gap-1">
        <button type="button" onClick={requestBackFromWhiteboard} aria-label={backActionLabel} title={backActionLabel} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><ArrowLeft className="h-5 w-5" /></button>
        <span className="mx-1 h-8 w-px shrink-0 bg-slate-200" />
		<label className="min-w-0"><span className="sr-only">Nombre de la pizarra</span><span className="block text-[9px] font-black uppercase tracking-[.14em] text-emerald-600">{isWorkOrigin ? 'Clarin Work · Pizarra' : 'Pizarras Clarin'}</span><span className="flex items-center gap-1"><input value={titleDraft} onChange={event => setTitleDraft(event.target.value)} onBlur={() => { if (!isWorkOrigin) void saveTitle() }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setTitleDraft(board.name); event.currentTarget.blur() } }} readOnly={isWorkOrigin || !canEdit} maxLength={200} aria-label="Nombre de la pizarra" title={isWorkOrigin ? 'Renombra esta vista desde el menú de su pestaña en Work.' : undefined} className="h-6 min-w-0 w-full truncate border-0 bg-transparent p-0 text-sm font-black text-slate-900 outline-none read-only:cursor-default" />{titleSaving && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" />}</span></label>
      </div>}
      {canvasNoticeSource && (
        <div data-whiteboard-realtime-status={canvasNoticeSource === 'realtime' ? realtimeConnection : undefined} style={{ pointerEvents: canvasNoticeHasActions ? 'auto' : 'none' }} className={`whiteboard-canvas-notice absolute left-1/2 top-[4.25rem] z-40 flex w-[min(92%,52rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold shadow-lg ${canvasNoticeIsError ? 'border-rose-200 bg-rose-50 text-rose-800' : canvasNoticeIsWarning ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-sky-200 bg-sky-50 text-sky-800'}`} role={canvasNoticeIsError ? 'alert' : 'status'} aria-live="polite">
          <span className="min-w-0 flex-1">{canvasNoticeMessage}</span>
          {canvasNoticeIsLoading && <Loader2 className="h-4 w-4 shrink-0 animate-spin" />}
          {canvasNoticeSource === 'public-error' && publicLibraryImportRetryable && <button type="button" onClick={() => setPublicLibraryImportRetryKey(current => current + 1)} className="min-h-9 rounded-lg bg-white px-3 font-black shadow-sm">Reintentar importación</button>}
          {canvasNoticeSource === 'public-error' && <button type="button" onClick={discardPublicLibraryImport} className="min-h-9 rounded-lg border border-current/20 bg-transparent px-3 font-black">{publicLibraryImportRetryable ? 'Cancelar' : 'Descartar solicitud'}</button>}
          {canvasNoticeSource === 'library-error' && <button type="button" onClick={openClarinLibraries} className="min-h-9 rounded-lg bg-white px-3 font-black shadow-sm">Revisar biblioteca</button>}
          {canvasNoticeSource === 'fonts' && fontPreloadProgress.phase === 'error' && <button type="button" onClick={retryFontPreload} className="min-h-9 rounded-lg bg-white px-3 font-black shadow-sm">Reintentar fuentes</button>}
          {canvasNoticeSource === 'assets' && assetHydrationProgress.phase === 'error' && <button type="button" onClick={retryAssetHydration} className="min-h-9 rounded-lg bg-white px-3 font-black shadow-sm">Reintentar imágenes</button>}
          {canvasNoticeSource === 'realtime' && <button type="button" onClick={() => roomRef.current?.retryNow()} className="min-h-9 rounded-lg bg-white px-3 font-black shadow-sm">Reintentar ahora</button>}
        </div>
      )}
      {!canEdit && <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-xs font-bold text-slate-600 shadow-lg">{WHITEBOARD_COMMENTS_UI_ENABLED && canComment ? 'Lectura y comentarios' : 'Solo lectura'}</div>}
    </div>

    {moreOpen && typeof document !== 'undefined' && createPortal(<div id="whiteboard-more-menu" role="menu" aria-label="Más acciones de Pizarras" style={{ top: moreMenuPosition.top, right: moreMenuPosition.right, zIndex: WHITEBOARD_OVERLAY_LAYERS.focusPopover }} className="whiteboard-more-menu fixed w-[min(21rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 shadow-2xl">
      <div className="border-b border-slate-100 px-3 py-2.5">
        <div className="text-[10px] font-black uppercase tracking-[.14em] text-emerald-600">Pizarras Clarin</div>
        <div className="mt-0.5 truncate text-sm font-black text-slate-900" title={board.name}>{board.name}</div>
        {thumbnailWarning && <button type="button" onClick={retryThumbnail} className="mt-2 flex min-h-9 w-full items-center gap-2 rounded-lg bg-amber-50 px-2.5 text-left text-xs font-bold text-amber-800"><RefreshCw className="h-3.5 w-3.5 shrink-0" />Miniatura pendiente · Reintentar</button>}
      </div>
      <div className="grid gap-1 py-1">
        {!showIntegratedTitle && !focusModeActive && <button autoFocus type="button" role="menuitem" onClick={() => { setMoreOpen(false); requestBackFromWhiteboard() }} className="whiteboard-more-item"><ArrowLeft className="h-4 w-4" />{backLabel}</button>}
        <WhiteboardFocusModeMenuItem
          active={focusModeActive}
          autoFocus={showIntegratedTitle || focusModeActive}
          onToggle={() => {
            setMoreOpen(false)
            if (focusModeActive) exitFocusMode()
            else enterFocusMode(moreButtonRef.current)
          }}
        />
        <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); openClarinLibraries() }} className="whiteboard-more-item"><LibraryBig className="h-4 w-4" />Administrar bibliotecas</button>
        {canManageAccess && !showShareInToolbar && <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); openWhiteboardShare() }} className="whiteboard-more-item"><Share2 className="h-4 w-4" />Compartir</button>}
        <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); void openHistory() }} className="whiteboard-more-item"><History className="h-4 w-4" />Historial</button>
        {canEdit && <button type="button" role="menuitem" disabled={whiteboardSaveIsBusy(saveState) || saveState === 'saved'} onClick={() => { setMoreOpen(false); void flushSave('manual') }} className="whiteboard-more-item disabled:opacity-40"><Save className="h-4 w-4" />Guardar ahora</button>}
      </div>
      <div className="grid gap-1 border-t border-slate-100 pt-1">
        {canEdit && <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); importInputRef.current?.click() }} className="whiteboard-more-item"><FileUp className="h-4 w-4" />Importar archivo</button>}
        <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); exportJSON() }} className="whiteboard-more-item"><FileJson className="h-4 w-4" />Exportar editable</button>
        <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); openImageExport() }} className="whiteboard-more-item"><FileImage className="h-4 w-4" />Exportar imagen…</button>
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
})

export default WhiteboardEditor
