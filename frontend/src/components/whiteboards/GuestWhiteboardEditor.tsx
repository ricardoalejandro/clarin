'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Download, Loader2, LockKeyhole, RefreshCw, Save, ShieldAlert } from 'lucide-react'
import {
  CaptureUpdateAction,
  Excalidraw,
  getVisibleSceneBounds,
  MainMenu,
  reconcileElements,
  serializeAsJSON,
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import {
  buildWhiteboardRealtimePatch,
  buildWhiteboardSceneWritePlan,
  buildWhiteboardGuestBootstrap,
  createWhiteboardOperationID,
  hasWhiteboardDocumentMutation,
  mergeWhiteboardAcknowledgedElements,
  mergeWhiteboardFileRecords,
  mergeWhiteboardSessionAppState,
  planWhiteboardAssetPersistence,
  reconcileWhiteboardCollaborators,
  reconcileWhiteboardCanonicalAck,
  retainWhiteboardPendingSave,
  sanitizeWhiteboardAppState,
  sanitizeWhiteboardExternalLink,
  sanitizeWhiteboardFilesForPersistence,
  snapshotWhiteboardFiles,
  shouldApplyWhiteboardRealtimeEvent,
  isWhiteboardSceneSequence,
  shouldRetryWhiteboardDirtySave,
  WHITEBOARD_AUTOSAVE_DELAY_MS,
  WHITEBOARD_SHOW_DEPRECATED_OFFICIAL_FONTS,
  whiteboardEditorCanvasActions,
  whiteboardSaveFailureAction,
  whiteboardSaveRetryStateAfterReconnect,
  whiteboardSaveRetryDelay,
  whiteboardGuestScenePath,
  whiteboardSceneRootExtensions,
  whiteboardSceneSaveMethod,
  type WhiteboardCollaboratorState,
  type WhiteboardRealtimeEvent,
  type WhiteboardSavePayload,
  type WhiteboardSaveRetryBlockReason,
  type WhiteboardSceneRecord,
  type WhiteboardScenePatch,
} from '@/lib/whiteboards'
import {
  buildExcalidrawWhiteboardSavePayload,
  restoreClarinWhiteboardScene,
} from '@/lib/whiteboardExcalidrawAdapter'
import {
  connectWhiteboardRoom,
  downloadWhiteboardGuestAsset,
  listWhiteboardGuestAssets,
  requestWhiteboardGuestCollabTicket,
  uploadWhiteboardGuestAsset,
  type WhiteboardRealtimeRoom,
  type WhiteboardRoomConnectionState,
} from '@/lib/whiteboardsApi'
import {
  whiteboardGuestAccessAtLevel,
  whiteboardPermissionChangeFeedback,
  whiteboardRealtimeAccessLevel,
  whiteboardRealtimeConnectionNotice,
  type WhiteboardRealtimeIssue,
} from '@/lib/whiteboardRealtimeConnection'
import {
  dataURLToBlob,
  rasterizeWhiteboardFiles,
  referencedWhiteboardFileIDs,
  type WhiteboardBinaryFile,
} from '@/lib/whiteboardMedia'
import { mapWhiteboardConcurrently, whiteboardAbortError } from '@/lib/whiteboardAsync'
import { whiteboardEditorAssetBase } from '@/lib/whiteboardEditorAssets'
import { excalidrawWhiteboardCollaborators } from '@/lib/whiteboardPresence'
import { renderBlockedWhiteboardEmbeddable } from '@/lib/whiteboardEmbeds'
import { useWhiteboardPresentation } from '@/hooks/useWhiteboardPresentation'
import {
  useWhiteboardAssetHydration,
  whiteboardAssetHydrationMessage,
} from '@/hooks/useWhiteboardAssetHydration'
import {
  useWhiteboardFontPreload,
  whiteboardFontPreloadFirstPassComplete,
  whiteboardFontPreloadMessage,
} from '@/hooks/useWhiteboardFontPreload'
import { WhiteboardPresentationButton, WhiteboardPresentationOverlay } from './WhiteboardPresentationControls'

interface GuestSession {
  id: string
  display_name: string
  access_level: 'view' | 'edit'
  expires_at: string
}

interface GuestSceneResponse {
  success?: boolean
  error?: string
  session: GuestSession
  scene: WhiteboardSceneRecord
  allow_export: boolean
}

interface GuestLatestScene {
  elements: readonly ExcalidrawElement[]
  appState: AppState
  files: BinaryFiles
}

interface PendingGuestWhiteboardSave {
  operationID: string
  payload: WhiteboardSavePayload
  realtimePatch: WhiteboardScenePatch | null
  capturedVersion: number
  acknowledgedElements: readonly unknown[]
  automaticFailures: number
  automaticRetryBlockReason: WhiteboardSaveRetryBlockReason
}

async function guestRequest<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'include',
  })
  const data = await response.json().catch(() => ({ error: `Error ${response.status}` })) as T & { error?: string }
  return { ok: response.ok, status: response.status, data }
}

function downloadEditable(source: string) {
  const url = URL.createObjectURL(new Blob([source], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'pizarra-compartida.excalidraw'
  link.rel = 'noopener'
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function extensionForMimeType(mimeType: string) {
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  return 'gif'
}

function guestWhiteboardSaveIsBusy(state: 'saved' | 'pending' | 'preparing-assets' | 'uploading-assets' | 'saving' | 'error') {
  return state === 'preparing-assets' || state === 'uploading-assets' || state === 'saving'
}

export default function GuestWhiteboardEditor({ shareLinkID }: { shareLinkID: string }) {
  const initializedRef = useRef(false)
  const secretRef = useRef('')
  const editorAPIRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const roomRef = useRef<WhiteboardRealtimeRoom | null>(null)
  const canonicalSyncControllerRef = useRef<AbortController | null>(null)
  const canonicalSyncGenerationRef = useRef(0)
  const canonicalSyncAppliedSequenceRef = useRef(-1)
  const canonicalSyncLoadingSequenceRef = useRef(-1)
  const latestRef = useRef<GuestLatestScene | null>(null)
  const sequenceRef = useRef(0)
  const lastOperationIDRef = useRef<string | null>(null)
  const acknowledgedElementsRef = useRef<readonly unknown[]>([])
  const acknowledgedAppStateRef = useRef<Record<string, unknown>>({})
  const sceneRootExtensionsRef = useRef<Record<string, unknown>>({})
  const sceneFileMetadataRef = useRef<Record<string, unknown>>({})
  const persistedFileIDsRef = useRef(new Set<string>())
  const assetUploadControllerRef = useRef<AbortController | null>(null)
  const assetSavingRef = useRef(false)
  const collaboratorsRef = useRef(new Map<string, WhiteboardCollaboratorState>())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savingRef = useRef(false)
  const queuedSaveRef = useRef(false)
  const pendingSaveRef = useRef<PendingGuestWhiteboardSave | null>(null)
  const dirtyRef = useRef(false)
  const changeVersionRef = useRef(0)
  const suppressRef = useRef(true)
  const transientSceneSuppressionRef = useRef(0)
  const mountedRef = useRef(true)

  const [phase, setPhase] = useState<'checking' | 'join' | 'ready' | 'error'>('checking')
  const [session, setSession] = useState<GuestSession | null>(null)
  const [boardID, setBoardID] = useState<string | null>(null)
  const [initialData, setInitialData] = useState<{ elements: readonly ExcalidrawElement[]; appState: Partial<AppState>; files: BinaryFiles } | null>(null)
  const [allowExport, setAllowExport] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [joining, setJoining] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'preparing-assets' | 'uploading-assets' | 'saving' | 'error'>('saved')
  const [error, setError] = useState<string | null>(null)
	const [permissionNotice, setPermissionNotice] = useState<string | null>(null)
	const [editorAPI, setEditorAPI] = useState<ExcalidrawImperativeAPI | null>(null)
  const [realtimeConnection, setRealtimeConnection] = useState<WhiteboardRoomConnectionState>('connecting')
  const [realtimeHasOpened, setRealtimeHasOpened] = useState(false)
  const [realtimeIssue, setRealtimeIssue] = useState<WhiteboardRealtimeIssue | null>(null)

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
		canPresent: session?.access_level === 'edit',
		runWithTransientSceneSuppressed,
	})

  const onHydratedGuestFile = useCallback((file: BinaryFileData) => {
    runWithTransientSceneSuppressed(() => {
      editorAPIRef.current?.addFiles([file])
    })
    if (latestRef.current) latestRef.current = {
      ...latestRef.current,
      files: { ...latestRef.current.files, [file.id]: file } as BinaryFiles,
    }
  }, [runWithTransientSceneSuppressed])

  const {
    progress: fontPreloadProgress,
    retry: retryFontPreload,
  } = useWhiteboardFontPreload(
    `guest:${shareLinkID}:${session?.id || 'pending'}`,
    editorAPI,
  )
  const fontPreloadFirstPassComplete = whiteboardFontPreloadFirstPassComplete(fontPreloadProgress)
  const fontPreloadMessage = whiteboardFontPreloadMessage(fontPreloadProgress)

  const {
    progress: assetHydrationProgress,
    request: requestAssetHydration,
    retry: retryAssetHydration,
  } = useWhiteboardAssetHydration({
    ownerKey: `guest:${shareLinkID}:${session?.id || 'pending'}`,
    enabled: phase === 'ready' && Boolean(editorAPI) && fontPreloadFirstPassComplete,
    listAssets: async (fileIDs, signal) => {
      const response = await listWhiteboardGuestAssets(shareLinkID, fileIDs, signal)
      return {
        assets: response.success ? response.data?.assets || [] : [],
        error: response.success ? undefined : response.error || 'No se pudieron cargar las imágenes compartidas.',
      }
    },
    downloadAsset: async (asset, signal) => {
      const response = await downloadWhiteboardGuestAsset(shareLinkID, asset.id, signal)
      return {
        blob: response.success ? response.blob : undefined,
        error: response.success ? undefined : response.error || 'No se pudo descargar una imagen compartida.',
      }
    },
    onFile: onHydratedGuestFile,
    onPersistedFileIDs: fileIDs => {
      for (const fileID of fileIDs) persistedFileIDsRef.current.add(fileID)
    },
  })

  const assetHydrationMessage = whiteboardAssetHydrationMessage(assetHydrationProgress)

  useEffect(() => {
    mountedRef.current = true
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current && !savingRef.current && !assetSavingRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      mountedRef.current = false
      assetUploadControllerRef.current?.abort()
      canonicalSyncControllerRef.current?.abort()
      canonicalSyncGenerationRef.current += 1
      if (timerRef.current) clearTimeout(timerRef.current)
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [])

  useEffect(() => {
    const blockNativeHelp = (event: KeyboardEvent) => {
      const target = event.target
      const isWritable = target instanceof HTMLElement
        && (target.matches('input, textarea, select') || target.isContentEditable)
      if (isWritable || (event.key !== '?' && !(event.key === '/' && event.shiftKey))) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    document.addEventListener('keydown', blockNativeHelp, true)
    return () => document.removeEventListener('keydown', blockNativeHelp, true)
  }, [])

  const applyResponse = useCallback(async (payload: GuestSceneResponse, signal?: AbortSignal) => {
    canonicalSyncControllerRef.current?.abort()
    canonicalSyncAppliedSequenceRef.current = -1
    canonicalSyncLoadingSequenceRef.current = -1
    const scene = restoreClarinWhiteboardScene(payload.scene.scene)
    sceneRootExtensionsRef.current = whiteboardSceneRootExtensions(scene)
    sceneFileMetadataRef.current = sanitizeWhiteboardFilesForPersistence(scene.files)
    persistedFileIDsRef.current = new Set(referencedWhiteboardFileIDs(scene.elements))
    if (signal?.aborted || !mountedRef.current) return
    const files = {} as BinaryFiles
    sequenceRef.current = payload.scene.sequence
    acknowledgedElementsRef.current = [...scene.elements]
    acknowledgedAppStateRef.current = sanitizeWhiteboardAppState(scene.appState)
    latestRef.current = {
      elements: scene.elements as readonly ExcalidrawElement[],
      appState: scene.appState as unknown as AppState,
      files,
    }
    suppressRef.current = true
    dirtyRef.current = false
    changeVersionRef.current = 0
    setSession(payload.session)
    setBoardID(payload.scene.board_id)
    setAllowExport(payload.allow_export)
    setInitialData({ elements: scene.elements as readonly ExcalidrawElement[], appState: scene.appState as Partial<AppState>, files })
    setSaveState('saved')
    setError(null)
    setPermissionNotice(null)
    setRealtimeConnection('connecting')
    setRealtimeHasOpened(false)
    setRealtimeIssue(null)
    setPhase('ready')
  }, [])

  const resume = useCallback(async () => {
    setPhase('checking')
    setError(null)
    const bootstrap = buildWhiteboardGuestBootstrap(shareLinkID, Boolean(secretRef.current))
    if (bootstrap.kind === 'exchange') {
      setPhase('join')
      return
    }
    const response = await guestRequest<GuestSceneResponse>(bootstrap.path)
    if (response.ok && response.data.scene && response.data.session) {
      await applyResponse(response.data)
      return
    }
    if (secretRef.current) {
      setPhase('join')
      return
    }
    setError('Esta sesión ya no está disponible. Abre de nuevo el enlace original que te compartieron.')
    setPhase('error')
  }, [applyResponse, shareLinkID])

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true
    window.EXCALIDRAW_ASSET_PATH = whiteboardEditorAssetBase(window.location.origin)
    secretRef.current = window.location.hash.length > 1 ? window.location.hash.slice(1) : ''
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
    }
    void resume()
  }, [resume])

  useEffect(() => {
    if (phase !== 'ready') return
    const frame = requestAnimationFrame(() => { suppressRef.current = false })
    return () => cancelAnimationFrame(frame)
  }, [phase, initialData])

  const join = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!displayName.trim() || joining || !secretRef.current) return
    setJoining(true)
    setError(null)
    const response = await guestRequest<GuestSceneResponse>(`/api/public/whiteboard-links/${encodeURIComponent(shareLinkID)}/session`, {
      method: 'POST',
      body: JSON.stringify({ secret: secretRef.current, display_name: displayName.trim(), password }),
    })
    if (!response.ok || !response.data.scene || !response.data.session) {
      setJoining(false)
      setError(response.status === 401 ? 'La contraseña no es válida.' : response.data.error || 'El enlace ya no está disponible.')
      return
    }
    secretRef.current = ''
    setPassword('')
    await applyResponse(response.data)
    setJoining(false)
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
          const response = await uploadWhiteboardGuestAsset(
            shareLinkID,
            fileID,
            blob,
            `${fileID}.${extensionForMimeType(blob.type)}`,
            controller.signal,
          )
          if (controller.signal.aborted) throw whiteboardAbortError()
          if (!response.success || !response.data?.asset) throw new Error(response.error || 'No se pudo guardar una imagen compartida.')
          persistedFileIDsRef.current.add(fileID)
        }, controller.signal)
      }
      if (Object.keys(safeFiles).length > 0) editorAPIRef.current?.addFiles(Object.values(safeFiles) as BinaryFileData[])
      return snapshotWhiteboardFiles({ ...files, ...safeFiles }) as unknown as BinaryFiles
    } finally {
      if (assetUploadControllerRef.current === controller) assetUploadControllerRef.current = null
      assetSavingRef.current = false
    }
  }, [shareLinkID])

  const hydrateReferencedAssets = useCallback((elements: readonly unknown[]) => {
    for (const fileID of referencedWhiteboardFileIDs(elements)) persistedFileIDsRef.current.add(fileID)
    const api = editorAPIRef.current
    requestAssetHydration(elements, api ? getVisibleSceneBounds(api.getAppState()) : null)
  }, [requestAssetHydration])

  useEffect(() => {
    if (phase !== 'ready' || !editorAPI || !initialData) return
    hydrateReferencedAssets(initialData.elements)
  }, [editorAPI, hydrateReferencedAssets, initialData, phase])

  const applyCanonicalWriteConfirmation = useCallback((
    document: WhiteboardSceneRecord['scene'],
    capturedElements: readonly unknown[],
    capturedAppState: Record<string, unknown>,
  ) => {
    const canonical = restoreClarinWhiteboardScene(document)
    const latest = latestRef.current
    const api = editorAPIRef.current
    if (latest) {
      const currentAppState = api?.getAppState() || latest.appState
      const reconciled = reconcileWhiteboardCanonicalAck({
        canonicalElements: canonical.elements,
        capturedElements,
        currentElements: api?.getSceneElementsIncludingDeleted() || latest.elements,
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
        latest.files as unknown as Record<string, unknown>,
        canonical.files,
      ) as unknown as BinaryFiles
      suppressRef.current = true
      api?.updateScene({ elements, appState, captureUpdate: CaptureUpdateAction.NEVER })
      latestRef.current = { elements, appState, files }
      requestAnimationFrame(() => { suppressRef.current = false })
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
    const response = await guestRequest<GuestSceneResponse>(whiteboardGuestScenePath(shareLinkID))
    if (!response.ok || !response.data.scene) return false
    const record = response.data.scene
    const confirmed = applyCanonicalWriteConfirmation(
      record.scene,
      acknowledgedElementsRef.current,
      acknowledgedAppStateRef.current,
    )
    sequenceRef.current = record.sequence
    acknowledgedElementsRef.current = confirmed.elements
    acknowledgedAppStateRef.current = confirmed.appState
    dirtyRef.current = true
    return true
  }, [applyCanonicalWriteConfirmation, shareLinkID])

  const save = useCallback(async (reason: 'autosave' | 'manual' = 'autosave') => {
    if (reason === 'autosave' && pendingSaveRef.current?.automaticRetryBlockReason) return
    if (reason !== 'autosave' && pendingSaveRef.current) {
      pendingSaveRef.current.automaticFailures = 0
      pendingSaveRef.current.automaticRetryBlockReason = null
    }
    if (savingRef.current) {
      queuedSaveRef.current = true
      return
    }
    if (!dirtyRef.current || session?.access_level !== 'edit' || !latestRef.current) return
    savingRef.current = true
    queuedSaveRef.current = false
    let capturedVersion = pendingSaveRef.current?.capturedVersion ?? changeVersionRef.current
    let current = latestRef.current
    if (pendingSaveRef.current) setSaveState('saving')
    setError(null)
    try {
      let pending = pendingSaveRef.current
      if (!pending) {
        const files = await uploadPendingFiles(current.files, current.elements)
        const latest = latestRef.current || current
        current = {
          ...latest,
          files: snapshotWhiteboardFiles({
            ...(latest.files as unknown as Record<string, unknown>),
            ...(files as unknown as Record<string, unknown>),
          }) as unknown as BinaryFiles,
        }
        latestRef.current = current
        capturedVersion = changeVersionRef.current
        setSaveState('saving')
        const operationID = createWhiteboardOperationID()
        const writePlan = buildWhiteboardSceneWritePlan(current.elements, acknowledgedElementsRef.current)
        const canPatch = reason === 'autosave' && writePlan.kind === 'patch'
        pending = retainWhiteboardPendingSave(pending, () => ({
          operationID,
          capturedVersion,
          payload: buildExcalidrawWhiteboardSavePayload({
            sceneSequence: sequenceRef.current,
            operationID,
            reason,
            elements: current.elements,
            appState: current.appState as unknown as Record<string, unknown>,
            files: mergeWhiteboardFileRecords(current.files as unknown as Record<string, unknown>, sceneFileMetadataRef.current),
            rootExtensions: sceneRootExtensionsRef.current,
            includePatch: canPatch,
            patchElements: writePlan.elements,
          }),
          realtimePatch: canPatch ? buildWhiteboardRealtimePatch({
            sceneSequence: sequenceRef.current,
            operationID,
            elements: writePlan.elements,
            appState: current.appState as unknown as Record<string, unknown>,
          }) : null,
          acknowledgedElements: canPatch
            ? mergeWhiteboardAcknowledgedElements(acknowledgedElementsRef.current, writePlan.elements)
            : [...current.elements],
          automaticFailures: 0,
          automaticRetryBlockReason: null,
        }))
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
          // Preserve the operation and immediately retry it through Clarin REST.
        }
      }
      let nextSequence: number
      let nextAcknowledgedElements: readonly unknown[] = pending.acknowledgedElements
      let nextAcknowledgedAppState = sanitizeWhiteboardAppState(pending.payload.scene.appState)
      if (acknowledgement) {
        if (typeof acknowledgement.sequence !== 'number') throw new Error('Clarin no confirmó la secuencia guardada.')
        nextSequence = acknowledgement.sequence
        if (acknowledgement.scene) {
          const confirmed = applyCanonicalWriteConfirmation(
            acknowledgement.scene,
            pending.acknowledgedElements,
            pending.payload.scene.appState,
          )
          nextAcknowledgedElements = confirmed.elements
          nextAcknowledgedAppState = confirmed.appState
        }
      } else {
        const response = await guestRequest<{ success?: boolean; error?: string; result?: { scene: WhiteboardSceneRecord } }>(whiteboardGuestScenePath(shareLinkID), {
          method: whiteboardSceneSaveMethod(pending.payload),
          body: JSON.stringify(pending.payload),
        })
        if (!response.ok || !response.data.result?.scene) {
          pending.automaticFailures += 1
          const action = whiteboardSaveFailureAction(response.status, pending.automaticFailures)
          pending.automaticRetryBlockReason = action === 'retry' ? null : action
          if (action === 'conflict') {
            if (await reconcileWhiteboardWriteConflict()) {
              pendingSaveRef.current = null
              queuedSaveRef.current = true
              setSaveState('pending')
              setError('Otra sesión guardó antes. Clarin concilió la versión canónica con tus cambios y volverá a guardarlos.')
              return
            }
            throw new Error('La pizarra cambió en otra sesión. Tus cambios siguen en pantalla; recarga para reconciliarlos.')
          }
          if (response.status === 410) throw new Error('El enlace compartido dejó de estar disponible. Tus cambios siguen en pantalla y no se marcarán como guardados.')
          throw new Error(response.data.error || 'No se pudieron guardar los cambios en Clarin.')
        }
        nextSequence = response.data.result.scene.sequence
        const confirmed = applyCanonicalWriteConfirmation(
          response.data.result.scene.scene,
          pending.acknowledgedElements,
          pending.payload.scene.appState,
        )
        nextAcknowledgedElements = confirmed.elements
        nextAcknowledgedAppState = confirmed.appState
      }
      nextSequence = Math.max(sequenceRef.current, nextSequence)
      sequenceRef.current = nextSequence
      acknowledgedElementsRef.current = nextAcknowledgedElements
      acknowledgedAppStateRef.current = nextAcknowledgedAppState
      if (pendingSaveRef.current === pending) pendingSaveRef.current = null
      const unchanged = capturedVersion === changeVersionRef.current
      dirtyRef.current = !unchanged
      setSaveState(unchanged ? 'saved' : 'pending')
      setError(null)
    } catch (saveError) {
      if (!mountedRef.current) return
      dirtyRef.current = true
      setSaveState('error')
      setError(saveError instanceof Error ? saveError.message : 'No se pudieron guardar los cambios.')
    } finally {
      savingRef.current = false
      const retryUnacknowledged = Boolean(
        pendingSaveRef.current
        && !pendingSaveRef.current.automaticRetryBlockReason
        && dirtyRef.current
        && navigator.onLine,
      )
      if (queuedSaveRef.current || capturedVersion !== changeVersionRef.current || retryUnacknowledged) {
        queuedSaveRef.current = false
        if (timerRef.current) clearTimeout(timerRef.current)
        const delay = retryUnacknowledged && pendingSaveRef.current
          ? whiteboardSaveRetryDelay(pendingSaveRef.current.automaticFailures)
          : 250
        timerRef.current = setTimeout(() => { void save('autosave') }, delay)
      }
    }
  }, [applyCanonicalWriteConfirmation, reconcileWhiteboardWriteConflict, session?.access_level, shareLinkID, uploadPendingFiles])

  const onChange = useCallback((elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    const previous = latestRef.current
    const snapshottedElements = elements.map(element => ({ ...element })) as readonly ExcalidrawElement[]
    const snapshottedFiles = snapshotWhiteboardFiles(files as unknown as Record<string, unknown>) as unknown as BinaryFiles
    latestRef.current = { elements: snapshottedElements, appState, files: snapshottedFiles }
    if (suppressRef.current || transientSceneSuppressionRef.current > 0 || session?.access_level !== 'edit') return
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
    setSaveState(retryBlocked ? 'error' : 'pending')
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!retryBlocked) timerRef.current = setTimeout(() => { void save('autosave') }, WHITEBOARD_AUTOSAVE_DELAY_MS)
  }, [save, session?.access_level])

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
      const response = await guestRequest<GuestSceneResponse>(whiteboardGuestScenePath(shareLinkID), { signal: controller.signal })
      if (controller.signal.aborted || generation !== canonicalSyncGenerationRef.current || !mountedRef.current) return
      if (!response.ok || !response.data.scene) {
        throw new Error(response.data.error || 'No se pudo recargar la escena compartida por REST.')
      }
      const record = response.data.scene
      if (record.sequence < requestedSequence) {
        throw new Error('La escena compartida todavía no alcanzó la secuencia solicitada. Clarin volverá a sincronizarla.')
      }
      const canonical = restoreClarinWhiteboardScene(record.scene)
      const api = editorAPIRef.current
      const preserveLocalChanges = dirtyRef.current || Boolean(pendingSaveRef.current)
      const currentAppState = api?.getAppState() || latestRef.current?.appState
      const reconciled = preserveLocalChanges && api && currentAppState
        ? reconcileWhiteboardCanonicalAck({
          canonicalElements: canonical.elements,
          capturedElements: acknowledgedElementsRef.current,
          currentElements: api.getSceneElementsIncludingDeleted(),
          canonicalAppState: canonical.appState,
          capturedAppState: acknowledgedAppStateRef.current,
          currentAppState: currentAppState as unknown as Record<string, unknown>,
        })
        : null
      const elements = reconciled && api && currentAppState
        ? reconcileElements(api.getSceneElementsIncludingDeleted(), reconciled.elements as never, currentAppState)
        : canonical.elements as readonly ExcalidrawElement[]
      const appState = currentAppState
        ? mergeWhiteboardSessionAppState(
          currentAppState as unknown as Record<string, unknown>,
          reconciled?.appState || canonical.appState,
        ) as unknown as AppState
        : canonical.appState as unknown as AppState
      sceneRootExtensionsRef.current = whiteboardSceneRootExtensions(canonical)
      sceneFileMetadataRef.current = sanitizeWhiteboardFilesForPersistence(canonical.files)
      acknowledgedElementsRef.current = [...canonical.elements]
      acknowledgedAppStateRef.current = sanitizeWhiteboardAppState(canonical.appState)
      sequenceRef.current = record.sequence
      suppressRef.current = true
      api?.updateScene({
        elements,
        appState,
        captureUpdate: CaptureUpdateAction.NEVER,
      })
      latestRef.current = {
        elements,
        appState,
        files: mergeWhiteboardFileRecords(
          latestRef.current?.files as unknown as Record<string, unknown> | undefined,
          canonical.files,
        ) as unknown as BinaryFiles,
      }
      const feedback = whiteboardPermissionChangeFeedback({
        canEdit: response.data.session.access_level === 'edit',
        hasPendingChanges: preserveLocalChanges,
        online: navigator.onLine,
      })
      setSession(response.data.session)
      setAllowExport(response.data.allow_export)
      if (!preserveLocalChanges) dirtyRef.current = false
      setPermissionNotice(feedback.notice)
      setSaveState(feedback.saveState || (preserveLocalChanges ? 'pending' : 'saved'))
      setError(null)
      requestAnimationFrame(() => { suppressRef.current = false })
      void hydrateReferencedAssets(elements)
      canonicalSyncAppliedSequenceRef.current = Math.max(requestedSequence, record.sequence)
      if (preserveLocalChanges && response.data.session.access_level === 'edit') {
        // A reconnect sync must not replace an unacknowledged operation with a
        // new one. The existing payload remains safe to retry idempotently and
        // will be rebased through the normal conflict path when required.
        dirtyRef.current = true
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => { void save('autosave') }, savingRef.current ? 1_000 : 250)
      }
    } catch (syncError) {
      if (!controller.signal.aborted && generation === canonicalSyncGenerationRef.current && mountedRef.current) {
        setError(syncError instanceof Error ? syncError.message : 'No se pudo sincronizar la escena compartida.')
      }
    } finally {
      if (canonicalSyncControllerRef.current === controller) canonicalSyncControllerRef.current = null
      if (generation === canonicalSyncGenerationRef.current) canonicalSyncLoadingSequenceRef.current = -1
    }
  }, [hydrateReferencedAssets, save, shareLinkID])

  const applyCollaboratorEvent = useCallback((event: WhiteboardRealtimeEvent) => {
    const next = reconcileWhiteboardCollaborators(collaboratorsRef.current, event)
    collaboratorsRef.current = next
    const api = editorAPIRef.current
    if (!api) return
    // Presence is session-only state. Suppressing every scene change until the
    // next frame can swallow a real guest edit that overlaps this update.
    api.updateScene({
      collaborators: excalidrawWhiteboardCollaborators(next, presentation.getSelfActorID()),
      captureUpdate: CaptureUpdateAction.NEVER,
    })
  }, [presentation.getSelfActorID])

  const handleRealtimeIssue = useCallback((issue: WhiteboardRealtimeIssue | null) => {
    setRealtimeIssue(issue)
    if (!issue || issue.kind === 'authorization_unavailable') return
    setError(issue.kind === 'access_revoked' ? issue.message : 'Esta sesión compartida expiró.')
    setPhase('error')
  }, [])

  useEffect(() => {
    if (phase !== 'ready' || !boardID) return
    let hasOpened = false
    const room = connectWhiteboardRoom({
      whiteboardID: boardID,
      audience: 'guest',
      getSequence: () => sequenceRef.current,
      getTicket: () => requestWhiteboardGuestCollabTicket(shareLinkID),
      onIssue: handleRealtimeIssue,
      onEvent: realtime => {
        const handledByPresentation = presentation.handleRealtimeEvent(realtime)
        if (realtime.event === 'room.ready') {
          applyCollaboratorEvent(realtime)
          return
        }
		if (handledByPresentation) return
        if (realtime.event === 'presence.snapshot' || realtime.event === 'presence.update' || realtime.event === 'cursor.update') {
          applyCollaboratorEvent(realtime)
          return
        }
        if (realtime.event === 'access.revoked') {
          handleRealtimeIssue({
            kind: 'access_revoked',
            message: 'Esta sesión compartida fue revocada.',
            retryable: false,
          })
          return
        }
        if (realtime.event === 'error') {
          if (realtime.code === 'permission_changed') {
            const immediateLevel = whiteboardRealtimeAccessLevel(realtime.data)
            if (immediateLevel) {
              const immediateGuestAccess = whiteboardGuestAccessAtLevel(immediateLevel)
              setSession(current => current ? { ...current, access_level: immediateGuestAccess } : current)
              const feedback = whiteboardPermissionChangeFeedback({
                canEdit: immediateGuestAccess === 'edit',
                hasPendingChanges: dirtyRef.current || Boolean(pendingSaveRef.current),
                online: navigator.onLine,
              })
              setPermissionNotice(feedback.notice)
              if (feedback.saveState) setSaveState(feedback.saveState)
            }
            void reloadCanonicalForRealtime(realtime, true)
            return
          }
          if (realtime.code === 'session_expired' || realtime.code === 'authorization_unavailable' || realtime.code === 'presence_unavailable') return
          if (!realtime.operation_id) setError(realtime.error || 'La colaboración en tiempo real encontró un error.')
          return
        }
        if (realtime.event === 'sync.required') {
          void reloadCanonicalForRealtime(realtime, true)
          return
        }
        if (realtime.event === 'ack') {
          if (!realtime.operation_id && isWhiteboardSceneSequence(realtime.sequence)) {
            sequenceRef.current = Math.max(sequenceRef.current, realtime.sequence)
            if (shouldRetryWhiteboardDirtySave({ dirty: dirtyRef.current, saving: savingRef.current, online: navigator.onLine, canEdit: session?.access_level === 'edit' })) {
              if (timerRef.current) clearTimeout(timerRef.current)
              timerRef.current = setTimeout(() => { void save('autosave') }, 250)
            }
          }
          return
        }
        if (!isWhiteboardSceneSequence(realtime.sequence)) {
          void reloadCanonicalForRealtime(realtime, true)
          return
        }
        if (!shouldApplyWhiteboardRealtimeEvent({
          currentSceneSequence: sequenceRef.current,
          localOperationID: lastOperationIDRef.current,
          event: { sequence: realtime.sequence, operation_id: realtime.operation_id },
        })) return
        const api = editorAPIRef.current
        if (!api) return
        if (realtime.scene) {
          const scene = restoreClarinWhiteboardScene(realtime.scene)
          sceneRootExtensionsRef.current = whiteboardSceneRootExtensions(scene)
          sceneFileMetadataRef.current = sanitizeWhiteboardFilesForPersistence(scene.files)
          const currentAppState = api.getAppState()
          const elements = dirtyRef.current
            ? reconcileElements(api.getSceneElementsIncludingDeleted(), scene.elements as never, currentAppState)
            : scene.elements as readonly ExcalidrawElement[]
          const appState = mergeWhiteboardSessionAppState(
            currentAppState as unknown as Record<string, unknown>,
            scene.appState,
          ) as unknown as AppState
          acknowledgedElementsRef.current = [...scene.elements]
          acknowledgedAppStateRef.current = sanitizeWhiteboardAppState(scene.appState)
          suppressRef.current = true
          api.updateScene({ elements, appState, captureUpdate: CaptureUpdateAction.NEVER })
          sequenceRef.current = realtime.sequence
          latestRef.current = {
            elements,
            appState,
            files: mergeWhiteboardFileRecords(api.getFiles() as unknown as Record<string, unknown>, scene.files) as unknown as BinaryFiles,
          }
          setSaveState(dirtyRef.current ? 'pending' : 'saved')
          requestAnimationFrame(() => { suppressRef.current = false })
          void hydrateReferencedAssets(scene.elements)
          if (dirtyRef.current && !savingRef.current) {
            if (timerRef.current) clearTimeout(timerRef.current)
            timerRef.current = setTimeout(() => { void save('autosave') }, 250)
          }
          return
        }
        if (realtime.event === 'scene.patch' && realtime.elements) {
          const appState = api.getAppState()
          const elements = reconcileElements(api.getSceneElementsIncludingDeleted(), realtime.elements as never, appState)
          acknowledgedElementsRef.current = mergeWhiteboardAcknowledgedElements(acknowledgedElementsRef.current, realtime.elements)
          acknowledgedAppStateRef.current = {
            ...acknowledgedAppStateRef.current,
            ...sanitizeWhiteboardAppState(realtime.app_state || {}),
          }
          suppressRef.current = true
          api.updateScene({ elements, appState: realtime.app_state as unknown as AppState, captureUpdate: CaptureUpdateAction.NEVER })
          sequenceRef.current = realtime.sequence
          latestRef.current = { elements, appState: { ...appState, ...(realtime.app_state || {}) }, files: api.getFiles() } as GuestLatestScene
          requestAnimationFrame(() => { suppressRef.current = false })
          void hydrateReferencedAssets(elements)
        }
      },
      onConnectionChange: state => {
			presentation.handleConnectionChange(state)
        setRealtimeConnection(state)
        if (state === 'open') {
          setRealtimeHasOpened(true)
          const pending = pendingSaveRef.current
          if (pending) {
            const retryState = whiteboardSaveRetryStateAfterReconnect({
              previouslyOpened: hasOpened,
              automaticFailures: pending.automaticFailures,
              automaticRetryBlockReason: pending.automaticRetryBlockReason,
            })
            if (retryState.shouldRetry) {
              pending.automaticFailures = retryState.automaticFailures
              pending.automaticRetryBlockReason = retryState.automaticRetryBlockReason
              setSaveState('pending')
            }
          }
          hasOpened = true
          if (shouldRetryWhiteboardDirtySave({ dirty: dirtyRef.current, saving: savingRef.current, online: navigator.onLine, canEdit: session?.access_level === 'edit' })) {
            if (timerRef.current) clearTimeout(timerRef.current)
            timerRef.current = setTimeout(() => { void save('autosave') }, 250)
          }
          return
        }
        if (state === 'closed') {
          if (dirtyRef.current) setSaveState('pending')
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
  }, [applyCollaboratorEvent, boardID, handleRealtimeIssue, hydrateReferencedAssets, phase, presentation.handleConnectionChange, presentation.handleRealtimeEvent, reloadCanonicalForRealtime, save, shareLinkID])

  const exportJSON = () => {
    if (!allowExport || !latestRef.current) return
    const scene = latestRef.current
    const serialized = JSON.parse(serializeAsJSON(scene.elements, scene.appState, scene.files, 'local')) as Record<string, unknown>
    serialized.files = mergeWhiteboardFileRecords(
      serialized.files && typeof serialized.files === 'object' ? serialized.files as Record<string, unknown> : {},
      sceneFileMetadataRef.current,
    )
    downloadEditable(JSON.stringify({ ...sceneRootExtensionsRef.current, ...serialized }))
  }

  if (phase === 'checking') return <div className="flex min-h-screen items-center justify-center bg-slate-50"><Loader2 className="h-7 w-7 animate-spin text-emerald-600" /><span className="sr-only">Comprobando enlace</span></div>

  if (phase === 'join') return <main className="flex min-h-screen items-center justify-center bg-slate-950 p-4"><form onSubmit={join} className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900 p-6 shadow-2xl"><span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-300"><LockKeyhole className="h-6 w-6" /></span><p className="mt-5 text-[10px] font-black uppercase tracking-[.16em] text-emerald-400">Pizarras Clarin</p><h1 className="mt-1 text-2xl font-black text-white">Abrir pizarra compartida</h1><p className="mt-2 text-sm leading-6 text-slate-400">Identifícate para crear una sesión temporal dentro de Clarin.</p><label className="mt-5 block text-xs font-bold text-slate-300">Tu nombre<input autoFocus value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={120} className="dark-input mt-2 h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-white caret-slate-100 outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10" /></label><label className="mt-3 block text-xs font-bold text-slate-300">Contraseña, si fue configurada<input type="password" value={password} onChange={event => setPassword(event.target.value)} className="dark-input mt-2 h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-white caret-slate-100 outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10" /></label>{error && <p className="mt-3 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p>}<button type="submit" disabled={!displayName.trim() || joining} className="mt-5 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 text-sm font-black text-slate-950 disabled:opacity-40">{joining && <Loader2 className="h-4 w-4 animate-spin" />}Entrar</button></form></main>

  if (phase === 'error' || !session || !initialData) return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4"><div className="max-w-md rounded-3xl border border-slate-200 bg-white p-6 text-center"><ShieldAlert className="mx-auto h-9 w-9 text-rose-500" /><h1 className="mt-4 text-xl font-black text-slate-900">Sesión no disponible</h1><p className="mt-2 text-sm text-slate-500">{error}</p><button type="button" onClick={() => void resume()} className="mx-auto mt-5 flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white"><RefreshCw className="h-4 w-4" />Volver a intentar</button></div></main>

  const realtimeNotice = whiteboardRealtimeConnectionNotice({
    connection: realtimeConnection,
    hasOpened: realtimeHasOpened,
    issue: realtimeIssue,
  })
  const guestNoticeSource = error
    ? 'error'
    : permissionNotice
      ? 'permission'
      : realtimeNotice
        ? 'realtime'
      : fontPreloadMessage
        ? 'fonts'
        : assetHydrationMessage
          ? 'assets'
          : null
  const guestNoticeMessage = guestNoticeSource === 'realtime'
    ? realtimeNotice?.message || null
    : guestNoticeSource === 'permission'
      ? permissionNotice
    : guestNoticeSource === 'fonts'
      ? fontPreloadMessage
      : guestNoticeSource === 'assets'
        ? assetHydrationMessage
        : error
  const guestNoticeIsError = guestNoticeSource === 'error'
    || (guestNoticeSource === 'fonts' && fontPreloadProgress.phase === 'error')
    || (guestNoticeSource === 'assets' && assetHydrationProgress.phase === 'error')
  const guestNoticeIsWarning = guestNoticeSource === 'permission'
    || (guestNoticeSource === 'realtime' && Boolean(realtimeNotice?.warning))
  const guestNoticeIsLoading = (guestNoticeSource === 'realtime' && Boolean(realtimeNotice?.busy))
    || (guestNoticeSource === 'fonts' && (fontPreloadProgress.phase === 'idle' || fontPreloadProgress.phase === 'loading' || fontPreloadProgress.phase === 'offline'))
    || (guestNoticeSource === 'assets' && assetHydrationProgress.phase === 'loading')

  return <main className="whiteboard-editor-shell flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-white">
    <header className="flex h-[58px] shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3"><div className="min-w-0 flex-1"><p className="text-[9px] font-black uppercase tracking-[.15em] text-emerald-600">Pizarras Clarin</p><h1 className="truncate text-sm font-black text-slate-900">Pizarra compartida</h1></div><span className="hidden text-xs font-semibold text-slate-500 sm:block">{session.display_name} · {session.access_level === 'edit' ? 'Puede editar' : 'Solo lectura'}</span>{guestWhiteboardSaveIsBusy(saveState) ? <Loader2 className="h-4 w-4 animate-spin text-sky-600" aria-label={saveState === 'preparing-assets' ? 'Preparando imágenes' : saveState === 'uploading-assets' ? 'Subiendo imágenes' : 'Guardando en Clarin'} /> : saveState === 'saved' ? <Check className="h-4 w-4 text-emerald-600" aria-label="Guardado en Clarin" /> : null}<WhiteboardPresentationButton controlState={presentation.controlState} state={presentation.state} canPresent={session.access_level === 'edit'} onStart={() => { void presentation.start() }} onStop={() => { void presentation.stop() }} />{session.access_level === 'edit' && <button type="button" onClick={() => void save('manual')} disabled={saveState === 'saved' || guestWhiteboardSaveIsBusy(saveState)} className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-white disabled:opacity-35" aria-label="Guardar ahora"><Save className="h-4 w-4" /></button>}{allowExport && <button type="button" onClick={exportJSON} className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-600" aria-label="Exportar copia editable"><Download className="h-4 w-4" /></button>}</header>
    {guestNoticeMessage && (
      <div data-whiteboard-realtime-status={guestNoticeSource === 'realtime' ? realtimeConnection : undefined} className={`flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs font-semibold ${guestNoticeIsError ? 'border-rose-200 bg-rose-50 text-rose-800' : guestNoticeIsWarning ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-sky-200 bg-sky-50 text-sky-800'}`} role={guestNoticeIsError ? 'alert' : 'status'} aria-live="polite">
        <span className="min-w-0 flex-1">{guestNoticeMessage}</span>
        {guestNoticeIsLoading && <Loader2 className="h-4 w-4 shrink-0 animate-spin" />}
        {guestNoticeSource === 'error' && session.access_level === 'edit' && <button type="button" onClick={() => void save('manual')} className="min-h-9 rounded-lg bg-white px-3 font-black">Reintentar guardado</button>}
        {guestNoticeSource === 'fonts' && fontPreloadProgress.phase === 'error' && <button type="button" onClick={retryFontPreload} className="min-h-9 rounded-lg bg-white px-3 font-black">Reintentar fuentes</button>}
        {guestNoticeSource === 'assets' && assetHydrationProgress.phase === 'error' && <button type="button" onClick={retryAssetHydration} className="min-h-9 rounded-lg bg-white px-3 font-black">Reintentar imágenes</button>}
        {guestNoticeSource === 'realtime' && <button type="button" onClick={() => roomRef.current?.retryNow()} className="min-h-9 rounded-lg bg-white px-3 font-black">Reintentar ahora</button>}
        {guestNoticeSource === 'error' && <button type="button" onClick={() => window.location.reload()} className="min-h-9 rounded-lg bg-white px-3 font-black">Recargar</button>}
      </div>
    )}
    <div className="relative min-h-0 flex-1">
      <Excalidraw
        excalidrawAPI={api => {
          editorAPIRef.current = api
          setEditorAPI(current => current === api ? current : api)
          requestAnimationFrame(() => {
            if (mountedRef.current && editorAPIRef.current === api) suppressRef.current = false
          })
        }}
        initialData={initialData}
        onChange={onChange}
        onPointerUpdate={({ pointer, button }) => { roomRef.current?.sendCursor({ pointer, button }) }}
        langCode="es-ES"
        viewModeEnabled={session.access_level !== 'edit'}
        isCollaborating
        aiEnabled={false}
        enableRichText
        showDeprecatedFonts={WHITEBOARD_SHOW_DEPRECATED_OFFICIAL_FONTS}
        validateEmbeddable={false}
        renderEmbeddable={renderBlockedWhiteboardEmbeddable}
        onLinkOpen={(element, event) => {
          event.preventDefault()
          const link = sanitizeWhiteboardExternalLink(element.link)
          if (link) window.open(link, '_blank', 'noopener,noreferrer')
        }}
        UIOptions={{ canvasActions: whiteboardEditorCanvasActions(allowExport), tools: { image: session.access_level === 'edit' } }}
      >
        <MainMenu><MainMenu.Group title="Pizarra compartida">{allowExport && <><MainMenu.Item icon={<Download className="h-4 w-4" />} onSelect={exportJSON}>Exportar copia editable</MainMenu.Item><MainMenu.DefaultItems.SaveAsImage /></>}</MainMenu.Group></MainMenu>
      </Excalidraw>
      <WhiteboardPresentationOverlay state={presentation.state} showInvitation={presentation.showInvitation} onAccept={presentation.acceptInvitation} onDecline={presentation.declineInvitation} onLeave={presentation.leaveFollow} />
    </div>
  </main>
}
