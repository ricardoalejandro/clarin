'use client'

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  CornerDownRight,
  Loader2,
  LibraryBig,
  MapPin,
  MessageCircle,
  MousePointerClick,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import {
  DefaultSidebar,
  Sidebar,
  getCommonBounds,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import {
  WHITEBOARD_COMMENT_BODY_MAX_LENGTH,
  EMPTY_WHITEBOARD_COMMENT_COUNTS,
  createWhiteboardCommentDraft,
  createWhiteboardCommentOperationID,
  createWhiteboardElementCommentAnchor,
  createWhiteboardPointCommentAnchor,
  insertWhiteboardCommentEmoji,
  isWhiteboardCommentDraftDirty,
  isWhiteboardCommentPinVisible,
  nextWhiteboardCommentThreadIndex,
  normalizeWhiteboardCommentCounts,
  projectWhiteboardCommentAnchorToViewport,
  reconcileWhiteboardCommentMarkers,
  reconcileWhiteboardCommentThreadCollection,
  reconcileWhiteboardThreadCommentPage,
  resolveWhiteboardCommentAnchor,
  updateWhiteboardCommentDraftBody,
  validateWhiteboardCommentBody,
  visibleWhiteboardCommentThreads,
  whiteboardCommentMarkerFromThread,
  whiteboardCommentThreadCount,
  whiteboardCommentInitials,
  type WhiteboardComment,
  type WhiteboardCommentAnchor,
  type WhiteboardCommentChangedEvent,
  type WhiteboardCommentCounts,
  type WhiteboardCommentDraft,
  type WhiteboardCommentMarker,
  type WhiteboardCommentResolvedAnchor,
  type WhiteboardCommentStatusFilter,
  type WhiteboardCommentThread,
  type WhiteboardCommentThreadCollection,
  type WhiteboardCommentThreadStatus,
} from '@/lib/whiteboardComments'
import {
  createWhiteboardCommentThread,
  deleteWhiteboardComment,
  getWhiteboardCommentThread,
  listWhiteboardCommentMarkers,
  listWhiteboardCommentThreads,
  listWhiteboardThreadComments,
  replyToWhiteboardCommentThread,
  updateWhiteboardComment,
  updateWhiteboardCommentThreadStatus,
} from '@/lib/whiteboardCommentsApi'

const WHITEBOARD_COMMENTS_TAB = 'comments'
const WHITEBOARD_LIBRARY_TAB = 'library'
const WHITEBOARD_COMMENT_EMOJIS = ['👍', '❤️', '😀', '🎉', '👀'] as const

export type WhiteboardSidebarTab = typeof WHITEBOARD_LIBRARY_TAB | typeof WHITEBOARD_COMMENTS_TAB

interface WhiteboardOpenSidebar {
  name: string
  tab?: string
}

export function whiteboardSidebarIsActive(
  openSidebar: WhiteboardOpenSidebar | null,
  tab: WhiteboardSidebarTab,
) {
  return openSidebar?.name === 'default'
    && (openSidebar.tab || WHITEBOARD_LIBRARY_TAB) === tab
}

export function whiteboardSidebarToggle(
  tab: WhiteboardSidebarTab,
  openSidebar: WhiteboardOpenSidebar | null,
) {
  return {
    name: 'default' as const,
    tab,
    force: !whiteboardSidebarIsActive(openSidebar, tab),
  }
}

export function whiteboardSidebarKeyboardToggle(input: {
  key: string
  repeat: boolean
  tab: WhiteboardSidebarTab
  openSidebar: WhiteboardOpenSidebar | null
}) {
  if (input.repeat || ![' ', 'Spacebar', 'Enter'].includes(input.key)) return null
  return whiteboardSidebarToggle(input.tab, input.openSidebar)
}

type WhiteboardCommentsPhase = 'loading' | 'ready' | 'error'

export interface WhiteboardCommentFocusTarget {
  threadID: string
  elementID: string | null
  sceneX: number
  sceneY: number
  orphaned: boolean
}

export interface WhiteboardCommentsProviderHandle {
  reload: () => Promise<void>
  applyRealtimeEvent: (event: WhiteboardCommentChangedEvent) => void
  captureViewModePlacement: (clientX: number, clientY: number) => boolean
  getSummary: () => WhiteboardCommentCounts
  hasPendingMutations: () => boolean
  hasUnsavedDrafts: () => boolean
  hasUnsavedWork: () => boolean
}

export interface WhiteboardCommentsProviderProps {
  boardID: string
  currentUserID?: string | null
  canComment: boolean
  disabledReason?: string | null
  editorAPI: ExcalidrawImperativeAPI | null
  realtimeEvent?: WhiteboardCommentChangedEvent | null
  realtimeThread?: WhiteboardCommentThread | null
  refreshKey?: string | number | null
  onFocusAnchor?: (target: WhiteboardCommentFocusTarget) => void
  onSummaryChange?: (summary: WhiteboardCommentCounts) => void
  children: ReactNode
}

interface WhiteboardCommentMutationResult {
  success: boolean
  error?: string
}

interface WhiteboardCommentThreadMutationJournalEntry {
  revision: number
  thread: WhiteboardCommentThread
  previousStatus: WhiteboardCommentThreadStatus | null
  inventoryChanged: boolean
}

interface WhiteboardCommentMarkerMutationJournalEntry {
  revision: number
  status: WhiteboardCommentThreadStatus
  version: number
  marker: WhiteboardCommentMarker | null
}

interface WhiteboardCommentsContextValue {
  boardID: string
  currentUserID: string | null
  canComment: boolean
  disabledReason: string | null
  editorAPI: ExcalidrawImperativeAPI | null
  phase: WhiteboardCommentsPhase
  error: string | null
  mutationError: string | null
  collection: WhiteboardCommentThreadCollection
  markers: readonly WhiteboardCommentMarker[]
  filter: WhiteboardCommentStatusFilter
  activeThreadID: string | null
  focusRequestVersion: number
  activeComposerKey: string | null
  drafts: Readonly<Record<string, WhiteboardCommentDraft>>
  draftAnchor: WhiteboardCommentAnchor | null
  placing: boolean
  pendingKeys: ReadonlySet<string>
  loadingThreadIDs: ReadonlySet<string>
  setFilter: (filter: WhiteboardCommentStatusFilter) => void
  setMutationError: (error: string | null) => void
  reload: () => Promise<void>
  loadMore: () => Promise<void>
  beginThread: () => void
  cancelThread: () => void
  createThread: (body: string, operationID: string) => Promise<WhiteboardCommentMutationResult>
  reply: (threadID: string, body: string, operationID: string) => Promise<WhiteboardCommentMutationResult>
  edit: (threadID: string, commentID: string, body: string, operationID: string, expectedVersion: number) => Promise<WhiteboardCommentMutationResult>
  remove: (threadID: string, comment: WhiteboardComment) => Promise<WhiteboardCommentMutationResult>
  changeStatus: (thread: WhiteboardCommentThread, status: WhiteboardCommentThreadStatus) => Promise<WhiteboardCommentMutationResult>
  loadThreadComments: (thread: WhiteboardCommentThread) => Promise<void>
  focusThread: (thread: WhiteboardCommentThread) => void
  focusMarker: (marker: WhiteboardCommentMarker) => void
  openDraft: (input: {
    key: string
    kind: 'create' | 'reply' | 'edit'
    initialBody?: string
    threadID?: string | null
    commentID?: string | null
    baseVersion?: number | null
  }) => void
  updateDraftBody: (key: string, body: string) => void
  setDraftState: (key: string, patch: Partial<Pick<WhiteboardCommentDraft, 'pending' | 'error'>>) => void
  closeDraft: (key: string, discard: boolean) => void
}

const WhiteboardCommentsContext = createContext<WhiteboardCommentsContextValue | null>(null)

function useWhiteboardComments() {
  const value = useContext(WhiteboardCommentsContext)
  if (!value) throw new Error('WhiteboardComments components require WhiteboardCommentsProvider.')
  return value
}

function commentErrorMessage(status?: number, fallback?: string) {
  if (status === 403) return 'No tienes permiso para comentar en esta pizarra.'
  if (status === 404) return 'El comentario ya no está disponible.'
  if (status === 409) return 'El comentario cambió en otra sesión. Recarga los comentarios y vuelve a intentarlo.'
  if (status === 410) return 'La pizarra está en la Papelera y sus comentarios son de solo lectura.'
  return fallback || 'No se pudo completar la operación de comentarios.'
}

function elementBounds(element: ExcalidrawElement) {
  const [minX, minY, maxX, maxY] = getCommonBounds([element])
  return { minX, minY, maxX, maxY }
}

function anchorForThread(
  thread: Pick<WhiteboardCommentThread, 'id' | 'element_id' | 'anchor_x' | 'anchor_y' | 'anchor_ratio_x' | 'anchor_ratio_y'>,
  editorAPI: ExcalidrawImperativeAPI | null,
) {
  const element = thread.element_id
    ? editorAPI?.getSceneElements().find(candidate => candidate.id === thread.element_id) || null
    : null
  return {
    anchor: resolveWhiteboardCommentAnchor(thread, element ? elementBounds(element) : null),
    element,
  }
}

export const WhiteboardCommentsProvider = forwardRef<WhiteboardCommentsProviderHandle, WhiteboardCommentsProviderProps>(
  function WhiteboardCommentsProvider({
    boardID,
    currentUserID = null,
    canComment,
    disabledReason = null,
    editorAPI,
    realtimeEvent,
    realtimeThread,
    refreshKey,
    onFocusAnchor,
    onSummaryChange,
    children,
  }, ref) {
    const [phase, setPhase] = useState<WhiteboardCommentsPhase>('loading')
    const [error, setError] = useState<string | null>(null)
    const [mutationError, setMutationError] = useState<string | null>(null)
    const [collection, setCollection] = useState<WhiteboardCommentThreadCollection>({
      threads: [],
      nextCursor: null,
      counts: EMPTY_WHITEBOARD_COMMENT_COUNTS,
    })
    const [markers, setMarkers] = useState<WhiteboardCommentMarker[]>([])
    const [filter, setFilter] = useState<WhiteboardCommentStatusFilter>('open')
    const [activeThreadID, setActiveThreadID] = useState<string | null>(null)
    const [focusRequestVersion, setFocusRequestVersion] = useState(0)
    const [activeComposerKey, setActiveComposerKey] = useState<string | null>(null)
    const [drafts, setDrafts] = useState<Record<string, WhiteboardCommentDraft>>({})
    const draftsRef = useRef(drafts)
    draftsRef.current = drafts
    const [draftAnchor, setDraftAnchor] = useState<WhiteboardCommentAnchor | null>(null)
    const [placing, setPlacing] = useState(false)
    const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set())
    const [loadingThreadIDs, setLoadingThreadIDs] = useState<Set<string>>(() => new Set())
    const loadControllerRef = useRef<AbortController | null>(null)
    const markerLoadControllerRef = useRef<AbortController | null>(null)
    const focusThreadControllerRef = useRef<AbortController | null>(null)
    const draftThreadHydrationControllersRef = useRef(new Map<string, AbortController>())
    const loadGenerationRef = useRef(0)
    const loadPageRef = useRef<(
      cursor: string | null,
      replace: boolean,
      requestedFilter: WhiteboardCommentStatusFilter,
    ) => Promise<void>>(async () => {})
    const hydrateDraftThreadsRef = useRef<(threadIDs: readonly string[]) => void>(() => {})
    const collectionRevisionRef = useRef(0)
    const threadMutationRevisionRef = useRef(0)
    const threadMutationJournalRef = useRef<WhiteboardCommentThreadMutationJournalEntry[]>([])
    const markerMutationRevisionRef = useRef(0)
    const markerMutationJournalRef = useRef(new Map<string, WhiteboardCommentMarkerMutationJournalEntry>())
    const collectionRef = useRef(collection)
    collectionRef.current = collection
    const filterRef = useRef(filter)
    filterRef.current = filter
    const summaryRef = useRef(collection.counts)
    summaryRef.current = collection.counts
    const boardIDRef = useRef(boardID)
    boardIDRef.current = boardID
    const editorAPIRef = useRef(editorAPI)
    editorAPIRef.current = editorAPI
    const mountedRef = useRef(true)
    const placingRef = useRef(false)
    const placementSessionRef = useRef(0)
    const sidebarReopenFrameRef = useRef<number | null>(null)
    const pendingPlacementSidebarReopenRef = useRef(false)
    const statusOperationIDsRef = useRef(new Map<string, string>())
    const knownThreadStatusRef = useRef(new Map<string, WhiteboardCommentThreadStatus>())
    const knownThreadVersionRef = useRef(new Map<string, number>())
    const protectedCreatedThreadsRef = useRef(new Map<string, number>())
    const pendingKeysRef = useRef(new Set<string>())
    const threadLoadControllersRef = useRef(new Map<string, AbortController>())
    const refreshKeyRef = useRef(refreshKey)
    const captureViewModePlacementRef = useRef<(clientX: number, clientY: number) => boolean>(() => false)

    const setPlacementActive = useCallback((active: boolean) => {
      // Pointer capture is imperative and can run before passive effects in
      // Firefox. Keep the ref and rendered state atomic from the caller's
      // point of view so the visible placement prompt always accepts input.
      placingRef.current = active
      setPlacing(active)
    }, [])

    const recordThreadMutation = useCallback((input: {
      thread: WhiteboardCommentThread
      previousStatus: WhiteboardCommentThreadStatus | null
      inventoryChanged: boolean
    }) => {
      const revision = ++threadMutationRevisionRef.current
      threadMutationJournalRef.current.push({ revision, ...input })
      return revision
    }, [])

    const recordMarkerMutation = useCallback((thread: WhiteboardCommentThread) => {
      const revision = ++markerMutationRevisionRef.current
      markerMutationJournalRef.current.set(thread.id, {
        revision,
        status: thread.status,
        version: thread.version,
        marker: thread.status === 'open' ? whiteboardCommentMarkerFromThread(thread) : null,
      })
    }, [])

    const invalidatePlacementSession = useCallback(() => {
      placementSessionRef.current += 1
      pendingPlacementSidebarReopenRef.current = false
      if (sidebarReopenFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarReopenFrameRef.current)
        sidebarReopenFrameRef.current = null
      }
    }, [])

    useEffect(() => {
      mountedRef.current = true
      return () => {
        mountedRef.current = false
        invalidatePlacementSession()
        loadControllerRef.current?.abort()
        markerLoadControllerRef.current?.abort()
        focusThreadControllerRef.current?.abort()
        draftThreadHydrationControllersRef.current.forEach(controller => controller.abort())
        draftThreadHydrationControllersRef.current.clear()
        threadLoadControllersRef.current.forEach(controller => controller.abort())
        threadLoadControllersRef.current.clear()
      }
    }, [invalidatePlacementSession])

    // Excalidraw unmounts an undocked sidebar when the canvas receives the
    // placement gesture. Reopen Comments from the committed draft state and
    // through the latest imperative API. The API identity can legitimately
    // change while Excalidraw reconciles that same pointer event. Its outside
    // click close can also commit one frame after our draft, so verify the
    // requested tab for a few frames instead of treating the first toggle as
    // authoritative.
    useEffect(() => {
      if (!pendingPlacementSidebarReopenRef.current
        || !draftAnchor
        || activeComposerKey !== `create:${boardID}`) return
      const placementSession = placementSessionRef.current
      const ensureCommentsSidebar = (checksRemaining: number) => {
        sidebarReopenFrameRef.current = null
        if (!mountedRef.current
          || boardIDRef.current !== boardID
          || placementSessionRef.current !== placementSession
          || !pendingPlacementSidebarReopenRef.current) return
        const currentEditorAPI = editorAPIRef.current
        if (currentEditorAPI
          && !whiteboardSidebarIsActive(currentEditorAPI.getAppState().openSidebar, WHITEBOARD_COMMENTS_TAB)) {
          currentEditorAPI.toggleSidebar({ name: 'default', tab: WHITEBOARD_COMMENTS_TAB, force: true })
          if (checksRemaining > 0) {
            sidebarReopenFrameRef.current = window.requestAnimationFrame(() => ensureCommentsSidebar(checksRemaining - 1))
          }
          return
        }
        if (checksRemaining > 1) {
          sidebarReopenFrameRef.current = window.requestAnimationFrame(() => ensureCommentsSidebar(checksRemaining - 1))
          return
        }
        // A temporarily missing API remains pending so an identity update can
        // retry this effect. With a live API, the last frame is the canonical
        // ownership check for the sidebar.
        if (currentEditorAPI) pendingPlacementSidebarReopenRef.current = false
      }
      sidebarReopenFrameRef.current = window.requestAnimationFrame(() => ensureCommentsSidebar(3))
      return () => {
        if (sidebarReopenFrameRef.current !== null) {
          window.cancelAnimationFrame(sidebarReopenFrameRef.current)
          sidebarReopenFrameRef.current = null
        }
      }
    }, [activeComposerKey, boardID, draftAnchor, editorAPI])

    const loadPage = useCallback(async (
      cursor: string | null,
      replace: boolean,
      requestedFilter: WhiteboardCommentStatusFilter,
    ) => {
      if (replace) loadControllerRef.current?.abort()
      const controller = new AbortController()
      if (replace) loadControllerRef.current = controller
      const generation = replace ? ++loadGenerationRef.current : loadGenerationRef.current
      const startingThreadMutationRevision = threadMutationRevisionRef.current
      if (replace) {
        // A new canonical snapshot supersedes mutations that happened before
        // the request. Only writes racing this request need to be replayed.
        threadMutationJournalRef.current = threadMutationJournalRef.current
          .filter(entry => entry.revision > startingThreadMutationRevision)
        setPhase('loading')
        setError(null)
      }
      const response = await listWhiteboardCommentThreads({
        boardID,
        status: requestedFilter,
        cursor,
        signal: controller.signal,
      })
      if (controller.signal.aborted || !mountedRef.current || generation !== loadGenerationRef.current) return
      if (!response.success || !response.data) {
        setError(commentErrorMessage(response.status, response.error))
        setPhase('error')
        return
      }
      for (const thread of response.data.threads || []) {
        const knownVersion = knownThreadVersionRef.current.get(thread.id) || 0
        if (thread.version >= knownVersion) {
          knownThreadStatusRef.current.set(thread.id, thread.status)
          knownThreadVersionRef.current.set(thread.id, thread.version)
        }
        const protectedVersion = protectedCreatedThreadsRef.current.get(thread.id)
        if (protectedVersion !== undefined && thread.version >= protectedVersion) {
          protectedCreatedThreadsRef.current.delete(thread.id)
        }
      }
      const endingThreadMutationRevision = threadMutationRevisionRef.current
      const concurrentMutations = replace
        ? threadMutationJournalRef.current.filter(entry => entry.revision > startingThreadMutationRevision
          && entry.revision <= endingThreadMutationRevision)
        : []
      const incoming = response.data?.threads || []
      const incomingByID = new Map(incoming.map(thread => [thread.id, thread]))
      const mutationsByID = new Map<string, WhiteboardCommentThreadMutationJournalEntry>()
      for (const mutation of concurrentMutations) {
        const currentMutation = mutationsByID.get(mutation.thread.id)
        if (!currentMutation) {
          mutationsByID.set(mutation.thread.id, mutation)
          continue
        }
        mutationsByID.set(mutation.thread.id, {
          ...mutation,
          previousStatus: currentMutation.previousStatus,
          inventoryChanged: currentMutation.inventoryChanged || mutation.inventoryChanged,
        })
      }
      const needsCanonicalFollowup = Array.from(mutationsByID.values()).some(mutation => {
        const canonical = incomingByID.get(mutation.thread.id)
        return mutation.inventoryChanged && (!canonical || canonical.version < mutation.thread.version)
      })
      const missingDraftThreadIDs = replace
        ? Array.from(new Set(Object.values(draftsRef.current)
          .map(draft => draft.threadID)
          .filter((threadID): threadID is string => Boolean(threadID))))
          .filter(threadID => !incomingByID.has(threadID))
        : []
      setCollection(current => {
        if (!replace) {
          return reconcileWhiteboardCommentThreadCollection({
            current,
            incoming,
            mode: 'append',
            nextCursor: response.data?.next_cursor || null,
            counts: normalizeWhiteboardCommentCounts(response.data?.counts, current.counts),
          })
        }

        const draftThreadIDs = new Set(Object.values(draftsRef.current)
          .map(draft => draft.threadID)
          .filter((threadID): threadID is string => Boolean(threadID)))
        const protectedThreads = current.threads.filter(thread => {
          if (!protectedCreatedThreadsRef.current.has(thread.id) && !draftThreadIDs.has(thread.id)) return false
          const canonical = incomingByID.get(thread.id)
          return !canonical || canonical.version < thread.version
        })
        let next = reconcileWhiteboardCommentThreadCollection({
          current,
          incoming,
          mode: 'replace',
          nextCursor: response.data?.next_cursor || null,
          counts: normalizeWhiteboardCommentCounts(response.data?.counts, current.counts),
        })
        if (protectedThreads.length > 0) {
          next = reconcileWhiteboardCommentThreadCollection({
            current: next,
            incoming: protectedThreads,
            mode: 'upsert',
          })
        }
        let preserveCurrentCounts = protectedThreads.some(thread => protectedCreatedThreadsRef.current.has(thread.id))
        for (const mutation of Array.from(mutationsByID.values())) {
          const canonical = incomingByID.get(mutation.thread.id)
          if (canonical && canonical.version >= mutation.thread.version) continue
          preserveCurrentCounts ||= mutation.inventoryChanged
          const visible = requestedFilter === 'all' || mutation.thread.status === requestedFilter
          if (!visible) {
            next = { ...next, threads: next.threads.filter(thread => thread.id !== mutation.thread.id) }
            continue
          }
          next = reconcileWhiteboardCommentThreadCollection({
            current: next,
            incoming: [mutation.thread],
            mode: 'upsert',
          })
        }
        return preserveCurrentCounts ? { ...next, counts: current.counts } : next
      })
      if (replace) {
        threadMutationJournalRef.current = threadMutationJournalRef.current
          .filter(entry => entry.revision > endingThreadMutationRevision)
      }
      setPhase('ready')
      setError(null)
      if (replace && loadControllerRef.current === controller) loadControllerRef.current = null
      if (replace && needsCanonicalFollowup) {
        queueMicrotask(() => {
          if (!mountedRef.current || boardIDRef.current !== boardID) return
          void loadPageRef.current(null, true, filterRef.current)
        })
      }
      if (replace && missingDraftThreadIDs.length > 0) {
        queueMicrotask(() => {
          if (!mountedRef.current || boardIDRef.current !== boardID) return
          hydrateDraftThreadsRef.current(missingDraftThreadIDs)
        })
      }
    }, [boardID])
    loadPageRef.current = loadPage

    const loadMarkers = useCallback(async () => {
      markerLoadControllerRef.current?.abort()
      const controller = new AbortController()
      markerLoadControllerRef.current = controller
      const startingMarkerMutationRevision = markerMutationRevisionRef.current
      const incoming: WhiteboardCommentMarker[] = []
      const seenCursors = new Set<string>()
      let cursor: string | null = null
      try {
        do {
          const response = await listWhiteboardCommentMarkers({
            boardID,
            cursor,
            limit: 200,
            signal: controller.signal,
          })
          if (controller.signal.aborted || boardIDRef.current !== boardID) return
          if (!response.success || !response.data) return
          for (const marker of response.data.markers || []) {
            const knownVersion = knownThreadVersionRef.current.get(marker.id) || 0
            const knownStatus = knownThreadStatusRef.current.get(marker.id)
            if (knownVersion > marker.version || (knownVersion === marker.version && knownStatus === 'resolved')) continue
            incoming.push(marker)
            knownThreadStatusRef.current.set(marker.id, 'open')
            knownThreadVersionRef.current.set(marker.id, marker.version)
          }
          const nextCursor = response.data.next_cursor || null
          if (!nextCursor || seenCursors.has(nextCursor)) {
            cursor = null
          } else {
            seenCursors.add(nextCursor)
            cursor = nextCursor
          }
        } while (cursor)
        if (controller.signal.aborted || boardIDRef.current !== boardID) return
        const endingMarkerMutationRevision = markerMutationRevisionRef.current
        const canonicalIncoming = incoming.filter(marker => {
          const knownVersion = knownThreadVersionRef.current.get(marker.id) || 0
          const knownStatus = knownThreadStatusRef.current.get(marker.id)
          return knownVersion <= marker.version
            && !(knownVersion === marker.version && knownStatus === 'resolved')
        })
        const canonicalByID = new Map(canonicalIncoming.map(marker => [marker.id, marker]))
        setMarkers(current => {
          let next = reconcileWhiteboardCommentMarkers({ current, incoming: canonicalIncoming, mode: 'replace' })
          for (const [threadID, mutation] of Array.from(markerMutationJournalRef.current.entries())) {
            if (mutation.revision > endingMarkerMutationRevision) continue
            const canonical = canonicalByID.get(threadID)
            if (canonical && canonical.version >= mutation.version) {
              markerMutationJournalRef.current.delete(threadID)
              continue
            }
            const knownVersion = knownThreadVersionRef.current.get(threadID) || 0
            const knownStatus = knownThreadStatusRef.current.get(threadID)
            if (knownVersion > mutation.version
              || (knownVersion === mutation.version && knownStatus && knownStatus !== mutation.status)) {
              markerMutationJournalRef.current.delete(threadID)
              continue
            }
            const concurrent = mutation.revision > startingMarkerMutationRevision
            const protectedCreation = protectedCreatedThreadsRef.current.has(threadID)
            if (mutation.status === 'resolved') {
              next = reconcileWhiteboardCommentMarkers({
                current: next,
                incoming: [],
                mode: 'upsert',
                removeIDs: [threadID],
              })
              markerMutationJournalRef.current.delete(threadID)
            } else if (mutation.marker && (concurrent || protectedCreation)) {
              next = reconcileWhiteboardCommentMarkers({
                current: next,
                incoming: [mutation.marker],
                mode: 'upsert',
              })
            } else {
              markerMutationJournalRef.current.delete(threadID)
            }
          }
          const canonicalOpenIDs = new Set(next.map(marker => marker.id))
          for (const [threadID, status] of Array.from(knownThreadStatusRef.current.entries())) {
            if (status === 'open' && !canonicalOpenIDs.has(threadID)) {
              knownThreadStatusRef.current.set(threadID, 'resolved')
            }
          }
          return next
        })
      } catch (loadError) {
        if (!controller.signal.aborted) {
          console.warn('No se pudieron reconciliar los marcadores de comentarios.', loadError)
        }
      } finally {
        if (markerLoadControllerRef.current === controller) markerLoadControllerRef.current = null
      }
    }, [boardID])

    const reload = useCallback(async () => {
      await Promise.all([loadPage(null, true, filterRef.current), loadMarkers()])
    }, [loadMarkers, loadPage])

    const loadMore = useCallback(async () => {
      if (!collection.nextCursor || phase === 'loading') return
      await loadPage(collection.nextCursor, false, filter)
    }, [collection.nextCursor, filter, loadPage, phase])

    useEffect(() => {
      invalidatePlacementSession()
      setCollection({ threads: [], nextCursor: null, counts: EMPTY_WHITEBOARD_COMMENT_COUNTS })
      setMarkers([])
      setFilter('open')
      setActiveThreadID(null)
      setActiveComposerKey(null)
      setDrafts({})
      setDraftAnchor(null)
      setPlacementActive(false)
      setMutationError(null)
      pendingKeysRef.current.clear()
      threadLoadControllersRef.current.forEach(controller => controller.abort())
      threadLoadControllersRef.current.clear()
      draftThreadHydrationControllersRef.current.forEach(controller => controller.abort())
      draftThreadHydrationControllersRef.current.clear()
      setLoadingThreadIDs(new Set())
      setPendingKeys(new Set())
      statusOperationIDsRef.current.clear()
      knownThreadStatusRef.current.clear()
      knownThreadVersionRef.current.clear()
      protectedCreatedThreadsRef.current.clear()
      threadMutationRevisionRef.current += 1
      threadMutationJournalRef.current = []
      markerMutationRevisionRef.current += 1
      markerMutationJournalRef.current.clear()
      collectionRevisionRef.current += 1
    }, [boardID, invalidatePlacementSession, setPlacementActive])

    useEffect(() => {
      void loadPage(null, true, filter)
      return () => loadControllerRef.current?.abort()
    }, [boardID, filter, loadPage])

    useEffect(() => {
      void loadMarkers()
      return () => markerLoadControllerRef.current?.abort()
    }, [boardID, loadMarkers])

    const upsertThread = useCallback((
      thread: WhiteboardCommentThread,
      countUnknownAsCreated = false,
      reconcileInventoryCounts = true,
    ) => {
      if (thread.board_id !== boardIDRef.current) return
      const knownVersion = knownThreadVersionRef.current.get(thread.id) || 0
      if (thread.version < knownVersion) return
      collectionRevisionRef.current += 1
      const previousStatus = knownThreadStatusRef.current.get(thread.id)
      recordThreadMutation({
        thread,
        previousStatus: previousStatus || null,
        inventoryChanged: reconcileInventoryCounts && (
          (!previousStatus && countUnknownAsCreated)
          || Boolean(previousStatus && previousStatus !== thread.status)
        ),
      })
      recordMarkerMutation(thread)
      knownThreadStatusRef.current.set(thread.id, thread.status)
      knownThreadVersionRef.current.set(thread.id, Math.max(thread.version, knownThreadVersionRef.current.get(thread.id) || 0))
      setCollection(current => {
        let counts = current.counts
        if (reconcileInventoryCounts && !previousStatus && countUnknownAsCreated) {
          counts = normalizeWhiteboardCommentCounts({
            ...counts,
            [thread.status]: counts[thread.status] + 1,
            all: counts.all + 1,
          }, counts)
        } else if (reconcileInventoryCounts && previousStatus && previousStatus !== thread.status) {
          counts = normalizeWhiteboardCommentCounts({
            ...counts,
            [previousStatus]: Math.max(0, counts[previousStatus] - 1),
            [thread.status]: counts[thread.status] + 1,
          }, counts)
        }
        const visible = filterRef.current === 'all' || thread.status === filterRef.current
        if (!visible) {
          return {
            ...current,
            counts,
            threads: current.threads.filter(candidate => candidate.id !== thread.id),
          }
        }
        return reconcileWhiteboardCommentThreadCollection({
          current,
          incoming: [thread],
          mode: 'upsert',
          counts,
        })
      })
      setMarkers(current => thread.status === 'open'
        ? reconcileWhiteboardCommentMarkers({
          current,
          incoming: [whiteboardCommentMarkerFromThread(thread)],
          mode: 'upsert',
        })
        : reconcileWhiteboardCommentMarkers({ current, incoming: [], mode: 'upsert', removeIDs: [thread.id] }))
    }, [recordMarkerMutation, recordThreadMutation])

    const hydrateDraftThreads = useCallback((threadIDs: readonly string[]) => {
      for (const threadID of threadIDs) {
        if (draftThreadHydrationControllersRef.current.has(threadID)) continue
        const controller = new AbortController()
        draftThreadHydrationControllersRef.current.set(threadID, controller)
        void getWhiteboardCommentThread({ boardID, threadID, signal: controller.signal })
          .then(response => {
            if (controller.signal.aborted || boardIDRef.current !== boardID) return
            if (!response.success || !response.data?.thread) {
              if (response.status === 404) {
                setCollection(current => ({
                  ...current,
                  threads: current.threads.filter(thread => thread.id !== threadID),
                }))
                setMarkers(current => reconcileWhiteboardCommentMarkers({
                  current,
                  incoming: [],
                  mode: 'upsert',
                  removeIDs: [threadID],
                }))
                setMutationError('El hilo del borrador ya no está disponible. El texto se conservó para que puedas copiarlo.')
              }
              return
            }
            // Counts already came from the canonical filtered snapshot. This
            // hydration only restores the exact thread/version owning a draft.
            upsertThread(response.data.thread, false, false)
          })
          .catch(loadError => {
            if (!controller.signal.aborted) {
              console.warn('No se pudo reconciliar el hilo que conserva un borrador.', loadError)
            }
          })
          .finally(() => {
            if (draftThreadHydrationControllersRef.current.get(threadID) === controller) {
              draftThreadHydrationControllersRef.current.delete(threadID)
            }
          })
      }
    }, [boardID, upsertThread])
    hydrateDraftThreadsRef.current = hydrateDraftThreads

    const applyRealtimeEvent = useCallback((event: WhiteboardCommentChangedEvent) => {
      if (!event || (event.board_id && event.board_id !== boardID)) return
      if (event.action === 'refresh' || !event.thread) {
        void reload()
        return
      }
      const wasKnown = knownThreadStatusRef.current.has(event.thread.id)
      const knownVersion = knownThreadVersionRef.current.get(event.thread.id) || 0
      const hasVersionGap = knownVersion > 0 && event.thread.version > knownVersion + 1
      const created = event.action === 'comment.thread_created'
        || event.action === 'created'
        || event.action === 'thread.created'
        || event.action === 'create'
      upsertThread(event.thread, created)
      if ((!wasKnown && !created) || hasVersionGap) void reload()
    }, [boardID, reload, upsertThread])

    const hasPendingMutations = useCallback(() => pendingKeysRef.current.size > 0, [])
    const hasUnsavedDrafts = useCallback(
      () => Object.values(draftsRef.current).some(isWhiteboardCommentDraftDirty),
      [],
    )
    const hasUnsavedWork = useCallback(
      () => pendingKeysRef.current.size > 0
        || Object.values(draftsRef.current).some(isWhiteboardCommentDraftDirty),
      [],
    )
    const getSummary = useCallback(() => summaryRef.current, [])

    useEffect(() => {
      onSummaryChange?.(collection.counts)
    }, [collection.counts, onSummaryChange])

    useEffect(() => {
      if (realtimeEvent) applyRealtimeEvent(realtimeEvent)
    }, [applyRealtimeEvent, realtimeEvent])

    useEffect(() => {
      if (!realtimeThread) return
      const wasKnown = knownThreadStatusRef.current.has(realtimeThread.id)
      upsertThread(realtimeThread)
      if (!wasKnown) void reload()
    }, [realtimeThread, reload, upsertThread])

    useEffect(() => {
      if (refreshKey === null || refreshKey === undefined) return
      if (refreshKeyRef.current === refreshKey) return
      refreshKeyRef.current = refreshKey
      void reload()
    }, [refreshKey, reload])

    useImperativeHandle(ref, () => ({
      reload,
      applyRealtimeEvent,
      captureViewModePlacement: (clientX, clientY) => captureViewModePlacementRef.current(clientX, clientY),
      getSummary,
      hasPendingMutations,
      hasUnsavedDrafts,
      hasUnsavedWork,
    }), [applyRealtimeEvent, getSummary, hasPendingMutations, hasUnsavedDrafts, hasUnsavedWork, reload])

    const startPending = useCallback((key: string) => {
      if (pendingKeysRef.current.has(key)) return false
      pendingKeysRef.current.add(key)
      setPendingKeys(new Set(pendingKeysRef.current))
      return true
    }, [])

    const finishPending = useCallback((key: string) => {
      if (!pendingKeysRef.current.delete(key)) return
      setPendingKeys(new Set(pendingKeysRef.current))
    }, [])

    const openDraft = useCallback((input: {
      key: string
      kind: 'create' | 'reply' | 'edit'
      initialBody?: string
      threadID?: string | null
      commentID?: string | null
      baseVersion?: number | null
    }) => {
      setDrafts(current => current[input.key] ? current : {
        ...current,
        [input.key]: createWhiteboardCommentDraft({
          ...input,
          operationID: createWhiteboardCommentOperationID(),
        }),
      })
      setActiveComposerKey(input.key)
    }, [])

    const updateDraftBody = useCallback((key: string, body: string) => {
      setDrafts(current => {
        const draft = current[key]
        if (!draft) return current
        const updated = updateWhiteboardCommentDraftBody(draft, body, createWhiteboardCommentOperationID())
        return updated === draft ? current : { ...current, [key]: updated }
      })
    }, [])

    const setDraftState = useCallback((key: string, patch: Partial<Pick<WhiteboardCommentDraft, 'pending' | 'error'>>) => {
      setDrafts(current => current[key] ? { ...current, [key]: { ...current[key], ...patch } } : current)
    }, [])

    const closeDraft = useCallback((key: string, discard: boolean) => {
      if (discard) {
        setDrafts(current => {
          if (!current[key]) return current
          const next = { ...current }
          delete next[key]
          return next
        })
      }
      setActiveComposerKey(current => current === key ? null : current)
    }, [])

    const handleMutationFailure = useCallback(async (
      status: number | undefined,
      responseError: string | undefined,
      expectedBoardID: string,
      surface: 'global' | 'draft' = 'global',
    ): Promise<WhiteboardCommentMutationResult> => {
      const message = commentErrorMessage(status, responseError)
      if (status === 409) await reload()
      if (boardIDRef.current !== expectedBoardID) return { success: false }
      // Composer-backed mutations render their returned error beside the
      // preserved draft. Mirroring it in the panel-level alert would announce
      // the same conflict twice and makes the operational surface noisy.
      if (surface === 'global') setMutationError(message)
      return { success: false, error: message }
    }, [reload])

    const loadThreadComments = useCallback(async (thread: WhiteboardCommentThread) => {
      if (!thread.comments_has_more || threadLoadControllersRef.current.has(thread.id)) return
      const controller = new AbortController()
      const requestedCursor = thread.comments_next_cursor || null
      threadLoadControllersRef.current.set(thread.id, controller)
      setLoadingThreadIDs(current => new Set(current).add(thread.id))
      try {
        const response = await listWhiteboardThreadComments({
          boardID,
          threadID: thread.id,
          cursor: requestedCursor,
          limit: 100,
          signal: controller.signal,
        })
        if (controller.signal.aborted || boardIDRef.current !== boardID) return
        if (!response.success || !response.data) {
          setMutationError(commentErrorMessage(response.status, response.error))
          return
        }
        collectionRevisionRef.current += 1
        setCollection(current => ({
          ...current,
          threads: current.threads.map(candidate => {
            if (candidate.id !== thread.id) return candidate
            const reconciled = reconcileWhiteboardThreadCommentPage({
              thread: candidate,
              comments: response.data?.comments || [],
              requestedCursor,
              nextCursor: response.data?.next_cursor || null,
            })
            if (reconciled !== candidate) {
              recordThreadMutation({
                thread: reconciled,
                previousStatus: candidate.status,
                inventoryChanged: false,
              })
            }
            return reconciled
          }),
        }))
      } finally {
        if (threadLoadControllersRef.current.get(thread.id) === controller) {
          threadLoadControllersRef.current.delete(thread.id)
          setLoadingThreadIDs(current => {
            const next = new Set(current)
            next.delete(thread.id)
            return next
          })
        }
      }
    }, [boardID, recordThreadMutation])

    const beginThread = useCallback(() => {
      if (!canComment) {
        setMutationError(disabledReason || 'Necesitas permiso para comentar.')
        return
      }
      invalidatePlacementSession()
      setFilter('open')
      setMutationError(null)
      const appState = editorAPI?.getAppState()
      const selectedIDs = appState?.selectedElementIds || {}
      const selected = editorAPI?.getSceneElements().find(element => selectedIDs[element.id])
      if (selected) {
        setDraftAnchor(createWhiteboardElementCommentAnchor({
          elementID: selected.id,
          bounds: elementBounds(selected),
        }))
        openDraft({ key: `create:${boardID}`, kind: 'create' })
        setPlacementActive(false)
        return
      }
      if (!editorAPI) {
        setMutationError('El lienzo todavía no está listo. Inténtalo de nuevo.')
        return
      }
      setDraftAnchor(null)
      setPlacementActive(true)
      editorAPI.setActiveTool({ type: 'selection' })
    }, [boardID, canComment, disabledReason, editorAPI, invalidatePlacementSession, openDraft, setPlacementActive])

    const cancelThread = useCallback(() => {
      invalidatePlacementSession()
      setDraftAnchor(null)
      setPlacementActive(false)
      setMutationError(null)
      closeDraft(`create:${boardID}`, true)
      editorAPI?.resetCursor()
    }, [boardID, closeDraft, editorAPI, invalidatePlacementSession, setPlacementActive])

    const commitPlacement = useCallback((input: {
      clientX: number
      clientY: number
      hit: ExcalidrawElement | null
    }) => {
      if (!placingRef.current) return false
      const currentEditorAPI = editorAPIRef.current
      if (!currentEditorAPI) return false
      // Arm the reopen before any React setter. Excalidraw may flush a
      // discrete pointer update synchronously while invoking subscribers.
      pendingPlacementSidebarReopenRef.current = true
      const appState = currentEditorAPI.getAppState()
      const scenePoint = viewportCoordsToSceneCoords(
        { clientX: input.clientX, clientY: input.clientY },
        {
          zoom: appState.zoom,
          offsetLeft: appState.offsetLeft,
          offsetTop: appState.offsetTop,
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
        },
      )
      setDraftAnchor(input.hit
        ? createWhiteboardElementCommentAnchor({
          elementID: input.hit.id,
          bounds: elementBounds(input.hit),
          sceneX: scenePoint.x,
          sceneY: scenePoint.y,
        })
        : createWhiteboardPointCommentAnchor(scenePoint.x, scenePoint.y))
      openDraft({ key: `create:${boardID}`, kind: 'create' })
      setPlacementActive(false)
      currentEditorAPI.resetCursor()
      return true
    }, [boardID, openDraft, setPlacementActive])
    captureViewModePlacementRef.current = (clientX, clientY) => commitPlacement({ clientX, clientY, hit: null })

    useEffect(() => {
      if (!editorAPI || !placing) return
      editorAPI.setCursor('crosshair')
      const unsubscribe = editorAPI.onPointerDown((_activeTool, pointerDownState, event) => {
        if (!placingRef.current || event.button !== 0) return
        if (!commitPlacement({
          clientX: event.clientX,
          clientY: event.clientY,
          hit: pointerDownState.hit.element,
        })) return
        event.preventDefault()
        event.stopPropagation()
      })
      return () => {
        unsubscribe()
        editorAPI.resetCursor()
      }
    }, [commitPlacement, editorAPI, placing])

    const createThread = useCallback(async (body: string, operationID: string) => {
      if (!canComment || !draftAnchor) return { success: false, error: disabledReason || 'No se puede crear este comentario.' }
      const key = `create:${operationID}`
      if (!startPending(key)) return { success: false, error: 'El comentario ya se está guardando.' }
      setMutationError(null)
      try {
        const response = await createWhiteboardCommentThread({ boardID, operationID, anchor: draftAnchor, body })
        if (boardIDRef.current !== boardID) return { success: false }
        if (!response.success || !response.data?.thread) {
          return handleMutationFailure(response.status, response.error, boardID, 'draft')
        }
        protectedCreatedThreadsRef.current.set(response.data.thread.id, response.data.thread.version)
        upsertThread(response.data.thread, true)
        setFilter('open')
        setActiveThreadID(response.data.thread.id)
        setActiveComposerKey(null)
        closeDraft(`create:${boardID}`, true)
        setDraftAnchor(null)
        setPlacementActive(false)
        editorAPI?.toggleSidebar({ name: 'default', tab: WHITEBOARD_COMMENTS_TAB, force: true })
        const { anchor, element } = anchorForThread(response.data.thread, editorAPI)
        if (onFocusAnchor) {
          onFocusAnchor({
            threadID: response.data.thread.id,
            elementID: anchor.elementID,
            sceneX: anchor.sceneX,
            sceneY: anchor.sceneY,
            orphaned: anchor.orphaned,
          })
        } else if (element) {
          editorAPI?.scrollToContent(element, { animate: true, duration: 200, fitToContent: true })
        }
        return { success: true }
      } finally {
        finishPending(key)
      }
    }, [boardID, canComment, closeDraft, disabledReason, draftAnchor, editorAPI, finishPending, handleMutationFailure, onFocusAnchor, setPlacementActive, startPending, upsertThread])

    const reply = useCallback(async (threadID: string, body: string, operationID: string) => {
      if (!canComment) return { success: false, error: disabledReason || 'Necesitas permiso para responder.' }
      const key = `reply:${threadID}:${operationID}`
      if (!startPending(key)) return { success: false, error: 'La respuesta ya se está guardando.' }
      setMutationError(null)
      try {
        const response = await replyToWhiteboardCommentThread({ boardID, threadID, operationID, body })
        if (boardIDRef.current !== boardID) return { success: false }
        if (!response.success || !response.data?.thread) {
          return handleMutationFailure(response.status, response.error, boardID, 'draft')
        }
        upsertThread(response.data.thread)
        closeDraft(`reply:${threadID}`, true)
        return { success: true }
      } finally {
        finishPending(key)
      }
    }, [boardID, canComment, closeDraft, disabledReason, finishPending, handleMutationFailure, startPending, upsertThread])

    const edit = useCallback(async (
      threadID: string,
      commentID: string,
      body: string,
      operationID: string,
      expectedVersion: number,
    ) => {
      if (!canComment || !currentUserID) return { success: false, error: 'Solo puedes editar tus propios comentarios.' }
      const draftKey = `edit:${commentID}`
      const draft = draftsRef.current[draftKey]
      if (!draft || draft.commentID !== commentID || draft.threadID !== threadID || draft.baseVersion !== expectedVersion) {
        return { success: false, error: 'El borrador de edición ya no coincide con este comentario.' }
      }
      const key = `edit:${commentID}:${operationID}`
      if (!startPending(key)) return { success: false, error: 'El comentario ya se está guardando.' }
      setMutationError(null)
      try {
        const response = await updateWhiteboardComment({
          boardID,
          threadID,
          commentID,
          operationID,
          expectedVersion,
          body,
        })
        if (boardIDRef.current !== boardID) return { success: false }
        if (!response.success || !response.data?.thread) {
          return handleMutationFailure(response.status, response.error, boardID, 'draft')
        }
        upsertThread(response.data.thread)
        closeDraft(draftKey, true)
        return { success: true }
      } finally {
        finishPending(key)
      }
    }, [boardID, canComment, closeDraft, currentUserID, finishPending, handleMutationFailure, startPending, upsertThread])

    const remove = useCallback(async (threadID: string, comment: WhiteboardComment) => {
      if (!canComment || !currentUserID || comment.author_id !== currentUserID) {
        return { success: false, error: 'Solo puedes eliminar tus propios comentarios.' }
      }
      const operationKey = `delete:${comment.id}:${comment.version}`
      const operationID = statusOperationIDsRef.current.get(operationKey) || createWhiteboardCommentOperationID()
      statusOperationIDsRef.current.set(operationKey, operationID)
      if (!startPending(operationKey)) return { success: false, error: 'El comentario ya se está eliminando.' }
      setMutationError(null)
      try {
        const response = await deleteWhiteboardComment({
          boardID,
          threadID,
          commentID: comment.id,
          operationID,
          expectedVersion: comment.version,
        })
        if (boardIDRef.current !== boardID) return { success: false }
        if (!response.success || !response.data?.thread) {
          return handleMutationFailure(response.status, response.error, boardID)
        }
        statusOperationIDsRef.current.delete(operationKey)
        upsertThread(response.data.thread)
        return { success: true }
      } finally {
        finishPending(operationKey)
      }
    }, [boardID, canComment, currentUserID, finishPending, handleMutationFailure, startPending, upsertThread])

    const changeStatus = useCallback(async (thread: WhiteboardCommentThread, status: WhiteboardCommentThreadStatus) => {
      if (!canComment) return { success: false, error: disabledReason || 'Necesitas permiso para cambiar el estado.' }
      const operationKey = `status:${thread.id}:${thread.version}:${status}`
      const operationID = statusOperationIDsRef.current.get(operationKey) || createWhiteboardCommentOperationID()
      statusOperationIDsRef.current.set(operationKey, operationID)
      if (!startPending(operationKey)) return { success: false, error: 'El estado ya se está guardando.' }
      setMutationError(null)
      try {
        const response = await updateWhiteboardCommentThreadStatus({
          boardID,
          threadID: thread.id,
          operationID,
          expectedVersion: thread.version,
          status,
        })
        if (boardIDRef.current !== boardID) return { success: false }
        if (!response.success || !response.data?.thread) {
          return handleMutationFailure(response.status, response.error, boardID)
        }
        statusOperationIDsRef.current.delete(operationKey)
        upsertThread(response.data.thread)
        return { success: true }
      } finally {
        finishPending(operationKey)
      }
    }, [boardID, canComment, disabledReason, finishPending, handleMutationFailure, startPending, upsertThread])

    const focusAnchor = useCallback((target: Pick<WhiteboardCommentThread, 'id' | 'element_id' | 'anchor_x' | 'anchor_y' | 'anchor_ratio_x' | 'anchor_ratio_y'>) => {
      const { anchor, element } = anchorForThread(target, editorAPI)
      setActiveThreadID(target.id)
      // A pin may target the thread that is already active. Keep a separate
      // request version so reopening Comments still scrolls and restores
      // keyboard focus even when React legitimately elides the same-ID update.
      setFocusRequestVersion(current => current + 1)
      editorAPI?.toggleSidebar({ name: 'default', tab: WHITEBOARD_COMMENTS_TAB, force: true })
      if (onFocusAnchor) {
        onFocusAnchor({
          threadID: target.id,
          elementID: anchor.elementID,
          sceneX: anchor.sceneX,
          sceneY: anchor.sceneY,
          orphaned: anchor.orphaned,
        })
      } else if (element) {
        editorAPI?.scrollToContent(element, { animate: true, duration: 200, fitToContent: true })
      }
    }, [editorAPI, onFocusAnchor])

    const focusThread = useCallback((thread: WhiteboardCommentThread) => {
      focusAnchor(thread)
    }, [focusAnchor])

    const focusMarker = useCallback((marker: WhiteboardCommentMarker) => {
      setFilter('open')
      focusAnchor(marker)
      const existing = collectionRef.current.threads.find(thread => thread.id === marker.id)
      if (existing) return
      focusThreadControllerRef.current?.abort()
      const controller = new AbortController()
      focusThreadControllerRef.current = controller
      void getWhiteboardCommentThread({ boardID, threadID: marker.id, signal: controller.signal })
        .then(response => {
          if (controller.signal.aborted || boardIDRef.current !== boardID) return
          if (!response.success || !response.data?.thread) {
            setMutationError(commentErrorMessage(response.status, response.error))
            if (response.status === 404) void loadMarkers()
            return
          }
          upsertThread(response.data.thread)
          setActiveThreadID(response.data.thread.id)
        })
        .catch(loadError => {
          if (!controller.signal.aborted) {
            setMutationError('No se pudo abrir este hilo. Inténtalo de nuevo.')
            console.warn('No se pudo cargar el hilo seleccionado.', loadError)
          }
        })
        .finally(() => {
          if (focusThreadControllerRef.current === controller) focusThreadControllerRef.current = null
        })
    }, [boardID, focusAnchor, loadMarkers, upsertThread])

    const value = useMemo<WhiteboardCommentsContextValue>(() => ({
      boardID,
      currentUserID,
      canComment,
      disabledReason,
      editorAPI,
      phase,
      error,
      mutationError,
      collection,
      markers,
      filter,
      activeThreadID,
      focusRequestVersion,
      activeComposerKey,
      drafts,
      draftAnchor,
      placing,
      pendingKeys,
      loadingThreadIDs,
      setFilter,
      setMutationError,
      reload,
      loadMore,
      beginThread,
      cancelThread,
      createThread,
      reply,
      edit,
      remove,
      changeStatus,
      loadThreadComments,
      focusThread,
      focusMarker,
      openDraft,
      updateDraftBody,
      setDraftState,
      closeDraft,
    }), [
      activeComposerKey,
      activeThreadID,
      focusRequestVersion,
      beginThread,
      boardID,
      canComment,
      cancelThread,
      changeStatus,
      collection,
      createThread,
      currentUserID,
      disabledReason,
      draftAnchor,
      drafts,
      edit,
      editorAPI,
      error,
      filter,
      focusThread,
      focusMarker,
      loadMore,
      loadThreadComments,
      loadingThreadIDs,
      mutationError,
      markers,
      pendingKeys,
      phase,
      placing,
      reload,
      remove,
      reply,
      closeDraft,
      openDraft,
      setDraftState,
      updateDraftBody,
    ])

    return <WhiteboardCommentsContext.Provider value={value}>{children}</WhiteboardCommentsContext.Provider>
  },
)

function WhiteboardCommentComposer({
  draftKey,
  placeholder,
  submitLabel,
  autoFocus = false,
  onCancel,
  onSubmit,
}: {
  draftKey: string
  placeholder: string
  submitLabel: string
  autoFocus?: boolean
  onCancel?: () => void
  onSubmit: (body: string, operationID: string) => Promise<WhiteboardCommentMutationResult>
}) {
  const { drafts, updateDraftBody, setDraftState } = useWhiteboardComments()
  const draft = drafts[draftKey]
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pendingRef = useRef(false)
  const errorID = useId()
  const body = draft?.body || ''
  const pending = Boolean(draft?.pending)
  const error = draft?.error || null
  const validation = validateWhiteboardCommentBody(body)

  const changeBody = useCallback((value: string) => {
    if (pendingRef.current) return
    updateDraftBody(draftKey, value)
  }, [draftKey, updateDraftBody])

  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  const submit = useCallback(async () => {
    if (!draft || pendingRef.current) return
    const next = validateWhiteboardCommentBody(body)
    if (!next.valid) {
      setDraftState(draftKey, { error: next.error })
      return
    }
    pendingRef.current = true
    setDraftState(draftKey, { pending: true, error: null })
    try {
      const result = await onSubmit(next.body, draft.operationID)
      if (!result.success) {
        setDraftState(draftKey, { error: result.error || 'No se pudo guardar el comentario.' })
        return
      }
    } finally {
      pendingRef.current = false
      setDraftState(draftKey, { pending: false })
    }
  }, [body, draft, draftKey, onSubmit, setDraftState])

  const addEmoji = useCallback((emoji: string) => {
    const textarea = textareaRef.current
    const inserted = insertWhiteboardCommentEmoji(body, emoji, textarea?.selectionStart ?? null, textarea?.selectionEnd ?? null)
    changeBody(inserted.value)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(inserted.caret, inserted.caret)
    })
  }, [body, changeBody])

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!pendingRef.current && (event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      void submit()
    }
    if (!pendingRef.current && event.key === 'Escape' && onCancel) {
      event.preventDefault()
      onCancel()
    }
  }, [onCancel, submit])

  const characterCount = Array.from(body).length
  if (!draft) return null
  return <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
    <textarea
      ref={textareaRef}
      value={body}
      onChange={event => changeBody(event.target.value)}
      onKeyDown={onKeyDown}
      autoFocus={autoFocus}
      disabled={pending}
      rows={3}
      placeholder={placeholder}
      aria-invalid={Boolean(error)}
      aria-describedby={error ? errorID : undefined}
      className="min-h-24 w-full resize-y rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-5 text-slate-800 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-2 focus:ring-emerald-100 disabled:cursor-wait disabled:opacity-70"
    />
    <div className="mt-2 flex flex-wrap items-center gap-1" aria-label="Añadir emoji">
      {WHITEBOARD_COMMENT_EMOJIS.map(emoji => <button
        key={emoji}
        type="button"
        onClick={() => addEmoji(emoji)}
        disabled={pending}
        className="flex h-11 w-11 items-center justify-center rounded-xl text-base hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50"
        aria-label={`Añadir ${emoji}`}
      >{emoji}</button>)}
      <span className={`ml-auto text-[11px] font-semibold ${characterCount > WHITEBOARD_COMMENT_BODY_MAX_LENGTH ? 'text-rose-600' : 'text-slate-400'}`}>{characterCount.toLocaleString('es')} / {WHITEBOARD_COMMENT_BODY_MAX_LENGTH.toLocaleString('es')}</span>
    </div>
    {error && <p id={errorID} role="alert" className="mt-2 text-xs font-semibold text-rose-600">{error}</p>}
    <div className="mt-3 flex items-center justify-end gap-2">
      {onCancel && <button type="button" onClick={onCancel} disabled={pending} className="min-h-11 rounded-xl px-3 text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-50">Cancelar</button>}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={pending || !validation.valid}
        className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-3 text-xs font-black text-white shadow-sm hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
      >{pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{submitLabel}</button>
    </div>
  </div>
}

function formatWhiteboardCommentDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Fecha desconocida'
  return new Intl.DateTimeFormat('es', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function WhiteboardCommentEntry({
  threadID,
  comment,
  mutable,
}: {
  threadID: string
  comment: WhiteboardComment
  mutable: boolean
}) {
  const { currentUserID, canComment, activeComposerKey, drafts, edit, remove, openDraft, closeDraft } = useWhiteboardComments()
  const draftKey = `edit:${comment.id}`
  const editing = activeComposerKey === draftKey
  const editDraft = drafts[draftKey]
  const own = Boolean(currentUserID && comment.author_id === currentUserID)
  const deleted = Boolean(comment.deleted_at)

  if (editing && mutable && !deleted) return <WhiteboardCommentComposer
    draftKey={draftKey}
    placeholder="Edita tu comentario"
    submitLabel="Guardar"
    autoFocus
    onCancel={() => closeDraft(draftKey, true)}
    onSubmit={async (body, operationID) => {
      if (!editDraft || editDraft.baseVersion === null) {
        return { success: false, error: 'No se pudo recuperar la versión inicial de la edición.' }
      }
      return edit(threadID, comment.id, body, operationID, editDraft.baseVersion)
    }}
  />

  return <div className="group/comment flex gap-2.5 py-2.5">
    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-black text-slate-600">
      {whiteboardCommentInitials(comment.author_name)}
    </span>
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-xs font-black text-slate-700">{comment.author_name || 'Miembro de la cuenta'}</span>
        <time dateTime={comment.created_at} className="shrink-0 text-[10px] font-semibold text-slate-400">{formatWhiteboardCommentDate(comment.created_at)}</time>
        {comment.updated_at !== comment.created_at && !deleted && <span className="text-[10px] text-slate-400">editado</span>}
      </div>
      {deleted
        ? <p className="mt-1 text-xs italic text-slate-400">Comentario eliminado</p>
        : <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5 text-slate-700">{comment.body}</p>}
      {own && canComment && mutable && !deleted && <div className="mt-1 flex items-center gap-1 opacity-100 sm:opacity-0 sm:transition sm:group-hover/comment:opacity-100 sm:group-focus-within/comment:opacity-100">
        <button type="button" onClick={() => openDraft({
          key: draftKey,
          kind: 'edit',
          initialBody: comment.body,
          threadID,
          commentID: comment.id,
          baseVersion: comment.version,
        })} className="inline-flex min-h-11 items-center gap-1 rounded-xl px-2 text-[11px] font-bold text-slate-500 hover:bg-slate-100 hover:text-slate-700 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><Pencil className="h-3.5 w-3.5" />Editar</button>
        <button type="button" onClick={() => {
          if (window.confirm('¿Eliminar este comentario? Las respuestas del hilo se conservarán.')) void remove(threadID, comment)
        }} className="inline-flex min-h-11 items-center gap-1 rounded-xl px-2 text-[11px] font-bold text-slate-500 hover:bg-rose-50 hover:text-rose-700 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"><Trash2 className="h-3.5 w-3.5" />Eliminar</button>
      </div>}
    </div>
  </div>
}

function WhiteboardCommentThreadCard({
  thread,
  index,
  itemCount,
  registerThreadButton,
  focusThreadAt,
}: {
  thread: WhiteboardCommentThread
  index: number
  itemCount: number
  registerThreadButton: (threadID: string, index: number, node: HTMLButtonElement | null) => void
  focusThreadAt: (index: number) => void
}) {
  const {
    activeThreadID,
    activeComposerKey,
    canComment,
    pendingKeys,
    loadingThreadIDs,
    focusThread,
    reply,
    changeStatus,
    loadThreadComments,
    openDraft,
    closeDraft,
  } = useWhiteboardComments()
  const replyDraftKey = `reply:${thread.id}`
  const replying = activeComposerKey === replyDraftKey
  const comments = useMemo(() => [...thread.comments].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)), [thread.comments])
  const pendingStatus = Array.from(pendingKeys).some(key => key.startsWith(`status:${thread.id}:`))
  const loadingComments = loadingThreadIDs.has(thread.id)
  const resolved = thread.status === 'resolved'
  const commentCount = whiteboardCommentThreadCount(thread)

  const moveListFocus = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const target = nextWhiteboardCommentThreadIndex({ currentIndex: index, itemCount, key: event.key })
    focusThreadAt(target)
  }

  return <article
    className={`rounded-2xl border bg-white p-3 shadow-sm transition ${activeThreadID === thread.id ? 'border-emerald-300 ring-2 ring-emerald-100' : 'border-slate-200'}`}
    aria-label={`Hilo de ${thread.created_by_name || 'un miembro'}`}
  >
    <div className="flex items-start gap-2">
      <button
        ref={node => registerThreadButton(thread.id, index, node)}
        type="button"
        data-comment-thread-index={index}
        onClick={() => focusThread(thread)}
        onKeyDown={moveListFocus}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        aria-label="Centrar este comentario en la pizarra"
      >
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${resolved ? 'bg-slate-100 text-slate-500' : 'bg-emerald-50 text-emerald-700'}`}><MapPin className="h-4 w-4" /></span>
        <span className="min-w-0">
          <span className="block truncate text-xs font-black text-slate-700">{thread.element_id ? 'Comentario sobre una figura' : 'Comentario en el lienzo'}</span>
          <span className="block text-[10px] font-semibold text-slate-400">{commentCount} {commentCount === 1 ? 'mensaje' : 'mensajes'}</span>
        </span>
      </button>
      {canComment && <button
        type="button"
        disabled={pendingStatus}
        onClick={() => void changeStatus(thread, resolved ? 'open' : 'resolved')}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50"
        aria-label={resolved ? 'Reabrir hilo' : 'Resolver hilo'}
        title={resolved ? 'Reabrir hilo' : 'Resolver hilo'}
      >{pendingStatus ? <Loader2 className="h-4 w-4 animate-spin" /> : resolved ? <RotateCcw className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}</button>}
    </div>
    {resolved && <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-slate-500"><Check className="h-3 w-3" />Resuelto</div>}
    <div className="mt-2 divide-y divide-slate-100">
      {comments.map(comment => <WhiteboardCommentEntry key={comment.id} threadID={thread.id} comment={comment} mutable={!resolved} />)}
    </div>
    {thread.comments_has_more && <button
      type="button"
      disabled={loadingComments}
      onClick={() => void loadThreadComments(thread)}
      className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50 text-xs font-black text-slate-600 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-wait disabled:opacity-60"
    >{loadingComments ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}Cargar {Math.max(0, commentCount - comments.length)} {commentCount - comments.length === 1 ? 'mensaje restante' : 'mensajes restantes'}</button>}
    {canComment && !resolved && (replying
      ? <div className="mt-2"><WhiteboardCommentComposer
        draftKey={replyDraftKey}
        placeholder="Escribe una respuesta"
        submitLabel="Responder"
        autoFocus
        onCancel={() => closeDraft(replyDraftKey, true)}
        onSubmit={(body, operationID) => reply(thread.id, body, operationID)}
      /></div>
      : <button type="button" onClick={() => openDraft({ key: replyDraftKey, kind: 'reply', threadID: thread.id })} className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 text-xs font-black text-slate-600 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><CornerDownRight className="h-4 w-4" />Responder</button>)}
  </article>
}

export function WhiteboardCommentsPanel() {
  const {
    boardID,
    canComment,
    disabledReason,
    phase,
    error,
    mutationError,
    collection,
    filter,
    activeThreadID,
    focusRequestVersion,
    draftAnchor,
    placing,
    setFilter,
    setMutationError,
    reload,
    loadMore,
    beginThread,
    cancelThread,
    createThread,
  } = useWhiteboardComments()
  const focusButtonsRef = useRef(new Map<number, HTMLButtonElement>())
  const threadButtonsRef = useRef(new Map<string, HTMLButtonElement>())
  const visibleThreads = visibleWhiteboardCommentThreads(collection.threads, filter)
  const counts = collection.counts

  const registerThreadButton = useCallback((threadID: string, index: number, node: HTMLButtonElement | null) => {
    if (node) {
      focusButtonsRef.current.set(index, node)
      threadButtonsRef.current.set(threadID, node)
    } else {
      focusButtonsRef.current.delete(index)
      threadButtonsRef.current.delete(threadID)
    }
  }, [])
  const focusThreadAt = useCallback((index: number) => {
    focusButtonsRef.current.get(index)?.focus()
  }, [])

  useEffect(() => {
    if (!activeThreadID) return
    const frame = window.requestAnimationFrame(() => {
      const button = threadButtonsRef.current.get(activeThreadID)
      button?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
      button?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeThreadID, collection.threads, filter, focusRequestVersion])

  return <section className="flex h-full min-h-0 flex-col bg-slate-50 text-slate-900" aria-label="Comentarios de la pizarra">
    <div className="shrink-0 border-b border-slate-200 bg-white px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-black text-slate-900">Comentarios</h2>
          <p className="mt-0.5 text-[11px] leading-4 text-slate-500">Conversaciones ancladas a figuras o puntos del lienzo.</p>
        </div>
        <button
          type="button"
          onClick={beginThread}
          disabled={!canComment || placing || Boolean(draftAnchor)}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl bg-emerald-600 px-3 text-xs font-black text-white shadow-sm hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
        ><Plus className="h-4 w-4" />Añadir</button>
      </div>
      {!canComment && <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-800">{disabledReason || 'Puedes leer los comentarios, pero necesitas permiso de comentario para participar.'}</div>}
      <div className="mt-3 grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Filtrar comentarios">
        {(['open', 'resolved', 'all'] as const).map(status => {
          const label = status === 'open' ? 'Abiertos' : status === 'resolved' ? 'Resueltos' : 'Todos'
          return <button
            key={status}
            type="button"
            role="tab"
            aria-selected={filter === status}
            onClick={() => setFilter(status)}
            className={`min-h-11 rounded-xl px-1 text-[11px] font-black transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${filter === status ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >{label} <span className="tabular-nums text-[10px] text-slate-400">{counts[status]}</span></button>
        })}
      </div>
    </div>

    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      {placing && <div className="mb-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-900" role="status">
        <div className="flex gap-2"><MousePointerClick className="mt-0.5 h-5 w-5 shrink-0" /><div><p className="text-xs font-black">Elige el punto del comentario</p><p className="mt-1 text-xs leading-5 text-emerald-800">Haz clic en una figura para vincularlo o en un espacio libre del lienzo.</p></div></div>
        <button type="button" onClick={cancelThread} className="mt-2 inline-flex min-h-11 items-center gap-1 rounded-xl px-3 text-xs font-black hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><X className="h-4 w-4" />Cancelar</button>
      </div>}

      {draftAnchor && <div className="mb-3">
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800"><MapPin className="h-4 w-4" />{draftAnchor.element_id ? 'Anclado a la figura seleccionada' : 'Anclado al punto elegido'}</div>
        <WhiteboardCommentComposer
          draftKey={`create:${boardID}`}
          placeholder="Escribe el primer comentario del hilo"
          submitLabel="Publicar"
          autoFocus
          onCancel={cancelThread}
          onSubmit={createThread}
        />
      </div>}

      {mutationError && <div role="alert" className="mb-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold leading-5 text-rose-800"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 flex-1">{mutationError}</span><button type="button" onClick={() => void reload()} className="min-h-11 shrink-0 rounded-xl bg-white px-2 font-black shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500">Recargar comentarios</button><button type="button" onClick={() => setMutationError(null)} aria-label="Cerrar error" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"><X className="h-4 w-4" /></button></div>}

      {phase === 'loading' && collection.threads.length === 0 && <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center text-xs font-bold text-slate-500" role="status"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" />Cargando comentarios…</div>}

      {phase === 'error' && collection.threads.length === 0 && <div className="flex min-h-48 flex-col items-center justify-center rounded-2xl border border-rose-200 bg-white p-5 text-center"><AlertCircle className="h-7 w-7 text-rose-500" /><p className="mt-3 text-sm font-black text-slate-800">No se pudieron abrir los comentarios</p><p className="mt-1 text-xs leading-5 text-slate-500">{error}</p><button type="button" onClick={() => void reload()} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-xs font-black text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"><RefreshCw className="h-4 w-4" />Reintentar</button></div>}

      {phase === 'error' && collection.threads.length > 0 && <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-semibold leading-5 text-amber-800" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 flex-1">{error}</span><button type="button" onClick={() => void reload()} className="min-h-11 shrink-0 rounded-xl bg-white px-2 font-black shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">Reintentar</button></div>}

      {phase === 'ready' && visibleThreads.length === 0 && !draftAnchor && !placing && <div className="flex min-h-56 flex-col items-center justify-center px-5 text-center"><span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400"><MessageCircle className="h-6 w-6" /></span><p className="mt-3 text-sm font-black text-slate-700">{filter === 'resolved' ? 'No hay hilos resueltos' : filter === 'open' ? 'No hay comentarios abiertos' : 'Aún no hay comentarios'}</p><p className="mt-1 text-xs leading-5 text-slate-500">{canComment ? 'Selecciona una figura o fija un punto para iniciar una conversación.' : 'Cuando un miembro comente, el hilo aparecerá aquí.'}</p>{canComment && filter !== 'resolved' && <button type="button" onClick={beginThread} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-xs font-black text-slate-700 shadow-sm hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><Plus className="h-4 w-4" />Crear comentario</button>}</div>}

      {visibleThreads.length > 0 && <div className="space-y-3" role="list" aria-label="Hilos de comentarios">
        {visibleThreads.map((thread, index) => <div role="listitem" key={thread.id}><WhiteboardCommentThreadCard thread={thread} index={index} itemCount={visibleThreads.length} registerThreadButton={registerThreadButton} focusThreadAt={focusThreadAt} /></div>)}
      </div>}

      {collection.nextCursor && <button type="button" onClick={() => void loadMore()} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-xs font-black text-slate-600 hover:border-emerald-200 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><RefreshCw className="h-4 w-4" />Cargar comentarios anteriores</button>}
    </div>
  </section>
}

export function WhiteboardSidebarActions({
  editorAPI,
  openSidebar,
}: {
  editorAPI: ExcalidrawImperativeAPI | null
  openSidebar?: WhiteboardOpenSidebar | null
}) {
  const { collection } = useWhiteboardComments()
  const [observedOpenSidebar, setObservedOpenSidebar] = useState<WhiteboardOpenSidebar | null>(
    () => editorAPI?.getAppState().openSidebar || null,
  )
  const openCount = collection.counts.open
  const title = openCount > 0 ? `Comentarios · ${openCount} abiertos` : 'Comentarios'
  const commentIcon = <span className="relative flex h-5 w-5 items-center justify-center"><MessageCircle className="h-5 w-5" />{openCount > 0 && <span aria-hidden="true" className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full bg-emerald-600 px-1 text-center text-[9px] font-black leading-4 text-white">{openCount > 99 ? '99+' : openCount}</span>}</span>
  const currentOpenSidebar = openSidebar === undefined ? observedOpenSidebar : openSidebar

  useEffect(() => {
    if (openSidebar !== undefined || !editorAPI) return
    setObservedOpenSidebar(editorAPI.getAppState().openSidebar)
    return editorAPI.onChange((_elements, appState) => setObservedOpenSidebar(appState.openSidebar))
  }, [editorAPI, openSidebar])

  const toggle = useCallback((tab: WhiteboardSidebarTab) => {
    if (!editorAPI) return
    editorAPI.toggleSidebar(whiteboardSidebarToggle(tab, editorAPI.getAppState().openSidebar))
  }, [editorAPI])

  useEffect(() => {
    if (!editorAPI || typeof window === 'undefined') return
    const handleKeyboardToggle = (event: KeyboardEvent) => {
      const target = event.target
      if (!(target instanceof HTMLButtonElement) || !target.closest('.whiteboard-editor-shell')) return
      const tab = target.dataset.whiteboardSidebarTab
      if (tab !== WHITEBOARD_LIBRARY_TAB && tab !== WHITEBOARD_COMMENTS_TAB) return
      const toggle = whiteboardSidebarKeyboardToggle({
        key: event.key,
        repeat: event.repeat,
        tab,
        openSidebar: editorAPI.getAppState().openSidebar,
      })
      if (!toggle) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      editorAPI.toggleSidebar(toggle)
    }
    // Excalidraw owns global canvas shortcuts. Capture at window scope so
    // native sidebar buttons keep Space/Enter before the canvas shortcuts.
    window.addEventListener('keydown', handleKeyboardToggle, true)
    return () => window.removeEventListener('keydown', handleKeyboardToggle, true)
  }, [editorAPI])

  return <div className="whiteboard-sidebar-actions flex items-center gap-2" role="group" aria-label="Paneles de Pizarras">
    {([
      { tab: WHITEBOARD_LIBRARY_TAB, label: 'Biblioteca', icon: <LibraryBig className="h-5 w-5" /> },
      { tab: WHITEBOARD_COMMENTS_TAB, label: title, icon: commentIcon },
    ] as const).map(action => {
      const active = whiteboardSidebarIsActive(currentOpenSidebar, action.tab)
      return <button
        key={action.tab}
        type="button"
        data-whiteboard-sidebar-action={action.tab}
        data-whiteboard-sidebar-tab={action.tab}
        onClick={() => toggle(action.tab)}
        disabled={!editorAPI}
        aria-label={action.label}
        title={action.label}
        aria-pressed={active}
        className={`whiteboard-integrated-action whiteboard-sidebar-action${active ? ' whiteboard-sidebar-action--active' : ''}`}
      >{action.icon}</button>
    })}
  </div>
}

export function WhiteboardCommentsSidebar() {
  const { collection } = useWhiteboardComments()
  const openCount = collection.counts.open
  const title = openCount > 0 ? `Comentarios · ${openCount} abiertos` : 'Comentarios'
  const icon = <span className="relative flex h-5 w-5 items-center justify-center"><MessageCircle className="h-5 w-5" />{openCount > 0 && <span aria-hidden="true" className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full bg-emerald-600 px-1 text-center text-[9px] font-black leading-4 text-white">{openCount > 99 ? '99+' : openCount}</span>}</span>

  return <>
    <DefaultSidebar className="clarin-whiteboard-comments-sidebar">
      <DefaultSidebar.TabTriggers>
        <Sidebar.TabTrigger tab={WHITEBOARD_LIBRARY_TAB} data-whiteboard-sidebar-internal="library" aria-label="Biblioteca" title="Biblioteca"><LibraryBig className="h-5 w-5" /><span className="sr-only">Biblioteca</span></Sidebar.TabTrigger>
        <Sidebar.TabTrigger tab={WHITEBOARD_COMMENTS_TAB} data-whiteboard-sidebar-internal="comments" aria-label={title} title={title}>{icon}<span className="sr-only">{title}</span></Sidebar.TabTrigger>
      </DefaultSidebar.TabTriggers>
      <Sidebar.Tab tab={WHITEBOARD_COMMENTS_TAB} className="min-h-0 overflow-hidden"><WhiteboardCommentsPanel /></Sidebar.Tab>
    </DefaultSidebar>
  </>
}

interface PinLayout {
  left: number
  top: number
  width: number
  height: number
}

export function WhiteboardCommentPins({ containerRef }: { containerRef?: RefObject<HTMLElement | null> } = {}) {
  const { editorAPI, markers, activeThreadID, focusMarker } = useWhiteboardComments()
  const markerRef = useRef<HTMLSpanElement>(null)
  const [layout, setLayout] = useState<PinLayout>({ left: 0, top: 0, width: 0, height: 0 })
  const [, setSceneRevision] = useState(0)

  useEffect(() => {
    const container = containerRef?.current || markerRef.current?.parentElement
    if (!container) return
    const updateLayout = () => {
      const rect = container.getBoundingClientRect()
      setLayout(current => {
        const next = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        return current.left === next.left && current.top === next.top && current.width === next.width && current.height === next.height ? current : next
      })
      setSceneRevision(current => current + 1)
    }
    updateLayout()
    const observer = new ResizeObserver(updateLayout)
    observer.observe(container)
    window.addEventListener('resize', updateLayout)
    window.addEventListener('scroll', updateLayout, true)
    const unsubscribeChange = editorAPI?.onChange(() => setSceneRevision(current => current + 1))
    const unsubscribeScroll = editorAPI?.onScrollChange(() => setSceneRevision(current => current + 1))
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateLayout)
      window.removeEventListener('scroll', updateLayout, true)
      unsubscribeChange?.()
      unsubscribeScroll?.()
    }
  }, [containerRef, editorAPI])

  const appState = editorAPI?.getAppState()
  const elements = editorAPI?.getSceneElements() || []
  const elementsByID = new Map(elements.map(element => [element.id, element]))
  const pins = <div
    className="pointer-events-none absolute inset-0 z-[3] overflow-hidden"
    aria-label="Pines de comentarios"
  >
    {appState && layout.width > 0 && markers.map((marker, index) => {
      const element = marker.element_id ? elementsByID.get(marker.element_id) || null : null
      const anchor: WhiteboardCommentResolvedAnchor = resolveWhiteboardCommentAnchor(marker, element ? elementBounds(element) : null)
      const viewport = projectWhiteboardCommentAnchorToViewport(anchor, {
        zoom: appState.zoom.value,
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        offsetLeft: appState.offsetLeft,
        offsetTop: appState.offsetTop,
      })
      if (!isWhiteboardCommentPinVisible({
        point: viewport,
        containerLeft: layout.left,
        containerTop: layout.top,
        containerWidth: layout.width,
        containerHeight: layout.height,
      })) return null
      const x = viewport.x - layout.left
      const y = viewport.y - layout.top
      const messageCount = Math.max(0, Math.trunc(marker.comment_count))
      return <button
        key={marker.id}
        type="button"
        onClick={() => focusMarker(marker)}
        data-whiteboard-comment-pin={marker.id}
        style={{ left: x, top: y }}
        className={`pointer-events-auto absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 ${activeThreadID === marker.id ? 'z-20' : 'z-10'}`}
        aria-label={`Abrir comentario ${index + 1}, ${messageCount} ${messageCount === 1 ? 'mensaje' : 'mensajes'}${anchor.orphaned ? ', figura eliminada' : ''}`}
      ><span className={`flex h-7 min-w-7 items-center justify-center rounded-full border-2 px-1 text-[11px] font-black shadow-lg transition ${activeThreadID === marker.id ? 'scale-110 border-emerald-700 bg-emerald-600 text-white' : 'border-white bg-slate-800 text-white hover:scale-105 hover:bg-emerald-600'}`}>{index + 1}</span></button>
    })}
  </div>
  return <><span ref={markerRef} aria-hidden="true" className="pointer-events-none absolute inset-0" />{pins}</>
}
