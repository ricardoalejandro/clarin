'use client'

import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useRouter } from 'next/navigation'
import {
  Archive,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpToLine,
  Check,
  Clock3,
  Copy,
  FileUp,
  Folder,
  FolderArchive,
  FolderOpen,
  FolderPlus,
  Grid2X2,
  Inbox,
  List,
  Loader2,
  Menu,
  Move,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
  Trash2,
  X,
} from 'lucide-react'
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/lib/useDebouncedValue'
import {
  createWhiteboardOperationID,
  filterWhiteboards,
  flattenWhiteboardFolders,
  formatWhiteboardUpdatedAt,
  validateWhiteboardImport,
  whiteboardDuplicateName,
  whiteboardManagerLayout,
  whiteboardPurgeEligibleAt,
  whiteboardSceneRootExtensions,
  type WhiteboardFolder as WhiteboardFolderModel,
  type WhiteboardScope,
  type WhiteboardSummary,
  type WhiteboardViewMode,
} from '@/lib/whiteboards'
import { dataURLToBlob, rasterizeWhiteboardFiles, type WhiteboardBinaryFile } from '@/lib/whiteboardMedia'
import {
  activeWhiteboardFolders,
  archivedWhiteboardFolders,
  buildWhiteboardFolderRelocationPlan,
  buildWhiteboardFolderRenameInput,
  buildWhiteboardMoveInput,
  optimisticWhiteboardMove,
  settleWhiteboardFolderRelocation,
  settleWhiteboardMove,
  whiteboardFolderDestinationOptions,
  type WhiteboardFolderPlacement,
} from '@/lib/whiteboardFolders'
import {
  archiveWhiteboardFolder,
  archiveWhiteboard,
  createWhiteboard,
  createWhiteboardFolder,
  duplicateWhiteboard,
  listWhiteboardFolders,
  listWhiteboards,
  getWhiteboardTrashPolicy,
  purgeWhiteboard,
  restoreWhiteboard,
  restoreWhiteboardFolder,
  saveWhiteboard,
  updateWhiteboard,
  updateWhiteboardFolder,
  updateWhiteboardTrashPolicy,
  uploadWhiteboardAsset,
  type WhiteboardTrashPolicy,
} from '@/lib/whiteboardsApi'
import { useWhiteboardDialogFocus } from './useWhiteboardDialogFocus'

const SCOPE_ITEMS: Array<{ id: WhiteboardScope; label: string; icon: typeof Inbox }> = [
  { id: 'mine', label: 'Mis pizarras', icon: Inbox },
  { id: 'recent', label: 'Recientes', icon: Clock3 },
  { id: 'shared', label: 'Compartidas conmigo', icon: Share2 },
  { id: 'trash', label: 'Papelera', icon: Trash2 },
]

type DialogKind = 'board' | 'folder' | null

function apiFailureMessage(status: number | undefined, fallback?: string) {
  if (status === 403) return 'No tienes permiso para realizar esta acción en la cuenta activa.'
  if (status === 404) return 'El servicio interno de Pizarras todavía no está disponible.'
  if (status === 409) return fallback || 'El recurso cambió mientras trabajabas. Actualiza la lista e inténtalo de nuevo.'
  return fallback || 'No se pudo completar la operación.'
}

function purgeEligibilityLabel(value: string | null) {
  if (!value) return 'Fecha de eliminación no disponible'
  return `Eliminación definitiva desde ${new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(new Date(value))}`
}

function OperationalDialog({
  title,
  description,
  onClose,
  children,
  initialFocusRef,
}: {
  title: string
  description: string
  onClose: () => void
  children: React.ReactNode
  initialFocusRef?: RefObject<HTMLElement>
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useWhiteboardDialogFocus(dialogRef, onClose, initialFocusRef)

  return createPortal(
    <div className="fixed inset-0 z-[260] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="whiteboard-dialog-title" aria-describedby="whiteboard-dialog-description" className="w-full max-w-md rounded-3xl border border-slate-200 bg-white shadow-2xl outline-none">
        <div className="flex items-start gap-4 border-b border-slate-100 px-5 py-5">
          <div className="min-w-0 flex-1">
            <h2 id="whiteboard-dialog-title" className="text-lg font-black text-slate-900">{title}</h2>
            <p id="whiteboard-dialog-description" className="mt-1 text-sm leading-5 text-slate-500">{description}</p>
          </div>
          <button type="button" data-whiteboard-dialog-close onClick={onClose} aria-label="Cerrar" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

function WhiteboardCard({
  whiteboard,
  view,
  busy,
  onOpen,
  onArchive,
  onDuplicate,
  onMove,
  onRestore,
  onPurge,
  purgeEligibleAt,
  canPurge,
  canDuplicate,
  canMove,
}: {
  whiteboard: WhiteboardSummary
  view: WhiteboardViewMode
  busy: boolean
  onOpen: () => void
  onArchive: () => void
  onDuplicate: () => void
  onMove: () => void
  onRestore: () => void
  onPurge: () => void
  purgeEligibleAt: string | null
  canPurge: boolean
  canDuplicate: boolean
  canMove: boolean
}) {
  const archived = Boolean(whiteboard.archived_at)
  const canManage = whiteboard.effective_access.can_manage_access
  const purgeReady = Boolean(purgeEligibleAt && Date.parse(purgeEligibleAt) <= Date.now())
  if (view === 'list') {
    return (
      <article className="group flex min-w-0 items-center gap-3 border-b border-slate-100 bg-white px-3 py-3 transition-colors hover:bg-slate-50 sm:px-4">
        <button type="button" onClick={onOpen} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-emerald-700 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label={`Abrir ${whiteboard.name}`}>
          <Network className="h-5 w-5" />
        </button>
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
          <span className="block truncate text-sm font-bold text-slate-800">{whiteboard.name}</span>
          <span className="mt-0.5 block truncate text-xs text-slate-400">{archived ? purgeEligibilityLabel(purgeEligibleAt) : `${whiteboard.folder_name || 'Sin carpeta'} · ${whiteboard.updated_by_name || whiteboard.owner_name || 'Cuenta'}`}</span>
        </button>
        {whiteboard.shared && <span className="hidden rounded-full bg-sky-50 px-2 py-1 text-[10px] font-bold text-sky-700 sm:inline">Compartida</span>}
        <span className="hidden w-28 text-right text-xs text-slate-400 md:block">{formatWhiteboardUpdatedAt(whiteboard.updated_at)}</span>
        {!archived && canMove && <button type="button" disabled={busy} onClick={onMove} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-white hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40" aria-label={`Mover ${whiteboard.name} a otra carpeta`}><Move className="h-4 w-4" /></button>}
        {!archived && canDuplicate && <button type="button" disabled={busy} onClick={onDuplicate} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-white hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40" aria-label={`Duplicar ${whiteboard.name}`}><Copy className="h-4 w-4" /></button>}
        {canManage && <button type="button" disabled={busy} onClick={archived ? onRestore : onArchive} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-white hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40" aria-label={archived ? `Restaurar ${whiteboard.name}` : `Mover ${whiteboard.name} a la Papelera`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : archived ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
        </button>}
        {archived && canPurge && <button type="button" disabled={busy || !purgeReady} onClick={onPurge} title={purgeReady ? 'Eliminar definitivamente' : purgeEligibilityLabel(purgeEligibleAt)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-rose-600 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:cursor-not-allowed disabled:opacity-30" aria-label={`Eliminar definitivamente ${whiteboard.name}`}><Trash2 className="h-4 w-4" /></button>}
        <button type="button" onClick={onOpen} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-white hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label={`Editar ${whiteboard.name}`}>
          <ArrowRight className="h-4 w-4" />
        </button>
      </article>
    )
  }

  return (
    <article className="group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-emerald-200 hover:shadow-lg motion-reduce:transform-none motion-reduce:transition-none">
      <button type="button" onClick={onOpen} className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden border-b border-slate-100 bg-slate-50 text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500">
        {whiteboard.thumbnail_url
          ? <img src={whiteboard.thumbnail_url} alt="" className="h-full w-full object-cover" />
          : <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-100 bg-white shadow-sm"><Network className="h-7 w-7" /></span>}
        {whiteboard.shared && <span className="absolute right-2 top-2 rounded-full border border-sky-100 bg-white/95 px-2 py-1 text-[10px] font-bold text-sky-700 shadow-sm">Compartida</span>}
      </button>
      <div className="flex min-w-0 items-start gap-2 p-3">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
          <span className="block truncate text-sm font-black text-slate-800">{whiteboard.name}</span>
          <span className="mt-1 block truncate text-[11px] text-slate-400">{archived ? purgeEligibilityLabel(purgeEligibleAt) : `${whiteboard.folder_name || 'Sin carpeta'} · ${formatWhiteboardUpdatedAt(whiteboard.updated_at)}`}</span>
        </button>
        {!archived && canMove && <button type="button" disabled={busy} onClick={onMove} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40" aria-label={`Mover ${whiteboard.name} a otra carpeta`}><Move className="h-4 w-4" /></button>}
        {!archived && canDuplicate && <button type="button" disabled={busy} onClick={onDuplicate} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40" aria-label={`Duplicar ${whiteboard.name}`}><Copy className="h-4 w-4" /></button>}
        {canManage && <button type="button" disabled={busy} onClick={archived ? onRestore : onArchive} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40" aria-label={archived ? `Restaurar ${whiteboard.name}` : `Mover ${whiteboard.name} a la Papelera`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : archived ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
        </button>}
        {archived && canPurge && <button type="button" disabled={busy || !purgeReady} onClick={onPurge} title={purgeReady ? 'Eliminar definitivamente' : purgeEligibilityLabel(purgeEligibleAt)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-rose-600 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:cursor-not-allowed disabled:opacity-30" aria-label={`Eliminar definitivamente ${whiteboard.name}`}><Trash2 className="h-4 w-4" /></button>}
      </div>
    </article>
  )
}

export default function WhiteboardsManager() {
  const router = useRouter()
  const rootRef = useRef<HTMLDivElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const listAbortRef = useRef<AbortController | null>(null)
  const listGenerationRef = useRef(0)
  const folderGenerationRef = useRef(0)
  const mountedRef = useRef(false)
  const [containerWidth, setContainerWidth] = useState(1280)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [showArchivedFolders, setShowArchivedFolders] = useState(false)
  const [scope, setScope] = useState<WhiteboardScope>('mine')
  const [folderID, setFolderID] = useState<string | null>(null)
  const [folders, setFolders] = useState<WhiteboardFolderModel[]>([])
  const [whiteboards, setWhiteboards] = useState<WhiteboardSummary[]>([])
  const [rawSearch, setRawSearch] = useState('')
  const [settledSearch, setSettledSearch] = useDebouncedValue(rawSearch, SEARCH_DEBOUNCE_MS)
  const [view, setView] = useState<WhiteboardViewMode>('grid')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [counts, setCounts] = useState<Partial<Record<WhiteboardScope, number>>>({})
  const [capabilities, setCapabilities] = useState({ can_create: false, can_create_folder: false })
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [draftName, setDraftName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [busyID, setBusyID] = useState<string | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<WhiteboardSummary | null>(null)
  const [moveTarget, setMoveTarget] = useState<WhiteboardSummary | null>(null)
  const [moveFolderID, setMoveFolderID] = useState('')
  const [folderRenameTarget, setFolderRenameTarget] = useState<WhiteboardFolderModel | null>(null)
  const [folderRelocationTarget, setFolderRelocationTarget] = useState<WhiteboardFolderModel | null>(null)
  const [folderParentDraft, setFolderParentDraft] = useState('')
  const [folderPlacementDraft, setFolderPlacementDraft] = useState<WhiteboardFolderPlacement>('first')
  const [folderArchiveTarget, setFolderArchiveTarget] = useState<WhiteboardFolderModel | null>(null)
  const [folderNameDraft, setFolderNameDraft] = useState('')
  const [folderBusyID, setFolderBusyID] = useState<string | null>(null)
  const [purgeTarget, setPurgeTarget] = useState<WhiteboardSummary | null>(null)
  const [purgeConfirmation, setPurgeConfirmation] = useState('')
  const [trashPolicy, setTrashPolicy] = useState<WhiteboardTrashPolicy | null>(null)
  const [retentionDraft, setRetentionDraft] = useState('30')
  const [policySaving, setPolicySaving] = useState(false)
  const [purgeEligibilityOverrides, setPurgeEligibilityOverrides] = useState<Record<string, string>>({})
  const createNameInputRef = useRef<HTMLInputElement>(null)

  const layout = whiteboardManagerLayout(containerWidth)
  const searchPending = rawSearch !== settledSearch
  const activeFolders = useMemo(() => activeWhiteboardFolders(folders), [folders])
  const archivedFolders = useMemo(() => archivedWhiteboardFolders(folders), [folders])
  const selectedFolder = activeFolders.find(folder => folder.id === folderID) || null
  const folderRows = useMemo(() => flattenWhiteboardFolders(activeFolders), [activeFolders])
  const folderDestinationOptions = useMemo(() => folderRelocationTarget
    ? whiteboardFolderDestinationOptions(activeFolders, folderRelocationTarget)
    : [], [activeFolders, folderRelocationTarget])
  const folderRelocationState = useMemo(() => {
    if (!folderRelocationTarget) return { plan: null, error: null }
    try {
      return {
        plan: buildWhiteboardFolderRelocationPlan(
          folderRelocationTarget,
          activeFolders,
          folderParentDraft || null,
          folderPlacementDraft,
        ),
        error: null,
      }
    } catch (relocationError) {
      return {
        plan: null,
        error: relocationError instanceof Error ? relocationError.message : 'No se puede usar ese destino.',
      }
    }
  }, [activeFolders, folderParentDraft, folderPlacementDraft, folderRelocationTarget])
  const visibleWhiteboards = useMemo(() => filterWhiteboards(whiteboards, settledSearch), [settledSearch, whiteboards])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    const update = () => setContainerWidth(element.getBoundingClientRect().width)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const loadFolders = useCallback(async (signal?: AbortSignal) => {
    const generation = ++folderGenerationRef.current
    const response = await listWhiteboardFolders({ signal, includeArchived: true })
    if (signal?.aborted || !mountedRef.current || generation !== folderGenerationRef.current) return
    if (response.success) setFolders(response.data?.folders || [])
  }, [])

  const loadIndex = useCallback(async (append = false) => {
    if (!append) {
      listAbortRef.current?.abort()
      listAbortRef.current = new AbortController()
    }
    const generation = ++listGenerationRef.current
    if (append) setLoadingMore(true)
    else if (whiteboards.length) setRefreshing(true)
    else setPhase('loading')
    setError(null)
    const response = await listWhiteboards({
      scope,
      folderID,
      search: settledSearch,
      cursor: append ? nextCursor : null,
      signal: listAbortRef.current?.signal,
    })
    if (generation !== listGenerationRef.current) return
    setLoadingMore(false)
    setRefreshing(false)
    if (!response.success) {
      if (response.error === 'Solicitud cancelada') return
      setError(apiFailureMessage(response.status, response.error))
      if (!whiteboards.length) setPhase('error')
      return
    }
    const incoming = response.data?.whiteboards || []
    setWhiteboards(current => append
      ? [...current, ...incoming.filter(board => !current.some(item => item.id === board.id))]
      : incoming)
    setNextCursor(response.data?.next_cursor || null)
    setCounts(response.data?.counts || {})
    setCapabilities(response.data?.permissions || { can_create: false, can_create_folder: false })
    setPhase('ready')
  }, [folderID, nextCursor, scope, settledSearch, whiteboards.length])

  useEffect(() => {
    const controller = new AbortController()
    void loadFolders(controller.signal)
    return () => controller.abort()
  }, [loadFolders])

  useEffect(() => {
    void loadIndex(false)
    return () => listAbortRef.current?.abort()
  }, [folderID, scope, settledSearch]) // loadIndex also captures pagination state; query ownership stays explicit.

  useEffect(() => {
    if (scope !== 'trash') return
    const controller = new AbortController()
    void getWhiteboardTrashPolicy(controller.signal).then(response => {
      if (controller.signal.aborted) return
      if (!response.success || !response.data) {
        setError(apiFailureMessage(response.status, response.error || 'No se pudo cargar la política de Papelera.'))
        return
      }
      setTrashPolicy(response.data)
      setRetentionDraft(String(response.data.retention_days))
    })
    return () => controller.abort()
  }, [scope])

  const closeNavigation = () => setNavigationOpen(false)
  const selectScope = (nextScope: WhiteboardScope) => {
    setScope(nextScope)
    setFolderID(null)
    closeNavigation()
  }
  const selectFolder = (nextFolderID: string) => {
    setScope('all')
    setFolderID(nextFolderID)
    closeNavigation()
  }

  const openCreate = (kind: Exclude<DialogKind, null>) => {
    setDraftName('')
    setError(null)
    setDialog(kind)
  }

  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    const name = draftName.trim()
    if (!name || submitting) return
    setSubmitting(true)
    setError(null)
    if (dialog === 'folder') {
      const response = await createWhiteboardFolder({ name, parent_id: folderID })
      setSubmitting(false)
      if (!response.success || !response.data?.folder) {
        setError(apiFailureMessage(response.status, response.error))
        return
      }
      setFolders(current => [...current, response.data!.folder])
      setDialog(null)
      return
    }
    const response = await createWhiteboard({ name, folder_id: folderID })
    setSubmitting(false)
    if (!response.success || !response.data?.whiteboard) {
      setError(apiFailureMessage(response.status, response.error))
      return
    }
    setDialog(null)
    router.push(`/dashboard/whiteboards/${response.data.whiteboard.id}`)
  }

  const confirmArchive = async () => {
    if (!archiveTarget || busyID) return
    const target = archiveTarget
    setBusyID(target.id)
    setError(null)
    const response = await archiveWhiteboard(target.id, target.version)
    setBusyID(null)
    if (!response.success) {
      setError(apiFailureMessage(response.status, response.error))
      return
    }
    setWhiteboards(current => current.filter(board => board.id !== target.id))
    setArchiveTarget(null)
    void loadFolders()
  }

  const handleRestore = async (whiteboard: WhiteboardSummary) => {
    if (busyID) return
    setBusyID(whiteboard.id)
    const response = await restoreWhiteboard(whiteboard.id, whiteboard.version)
    setBusyID(null)
    if (!response.success) {
      setError(apiFailureMessage(response.status, response.error))
      return
    }
    setWhiteboards(current => current.filter(board => board.id !== whiteboard.id))
    void loadFolders()
  }

  const handleDuplicate = async (whiteboard: WhiteboardSummary) => {
    if (busyID || !capabilities.can_create || whiteboard.archived_at) return
    setBusyID(whiteboard.id)
    setError(null)
    const response = await duplicateWhiteboard(whiteboard.id, {
      name: whiteboardDuplicateName(whiteboard.name),
      folder_id: whiteboard.folder_id || null,
    })
    setBusyID(null)
    if (!response.success || !response.data?.whiteboard) {
      setError(apiFailureMessage(response.status, response.error || 'No se pudo duplicar la pizarra.'))
      return
    }
    router.push(`/dashboard/whiteboards/${response.data.whiteboard.id}`)
  }

  const openMove = (whiteboard: WhiteboardSummary) => {
    setError(null)
    setMoveTarget(whiteboard)
    setMoveFolderID(whiteboard.folder_id || '')
  }

  const confirmMove = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!moveTarget || busyID) return
    const target = moveTarget
    const destinationFolder = activeFolders.find(folder => folder.id === moveFolderID) || null
    const destination = { id: destinationFolder?.id || null, name: destinationFolder?.name || null }
    if ((target.folder_id || null) === destination.id) {
      setMoveTarget(null)
      return
    }
    const optimistic = optimisticWhiteboardMove(target, destination)
    setBusyID(target.id)
    setError(null)
    setWhiteboards(current => current.map(item => item.id === target.id ? optimistic : item))
    const response = await updateWhiteboard(target.id, buildWhiteboardMoveInput(target, destination))
    setBusyID(null)
    if (!response.success || !response.data?.whiteboard) {
      setWhiteboards(current => settleWhiteboardMove(current, target, null, folderID))
      setError(apiFailureMessage(response.status, response.error || 'No se pudo mover la pizarra. Se restauró su carpeta anterior.'))
      return
    }
    setWhiteboards(current => settleWhiteboardMove(current, target, response.data!.whiteboard, folderID))
    setMoveTarget(null)
    void loadFolders()
  }

  const openRenameFolder = (folder: WhiteboardFolderModel) => {
    setError(null)
    setFolderRenameTarget(folder)
    setFolderNameDraft(folder.name)
  }

  const openRelocateFolder = (folder: WhiteboardFolderModel) => {
    setError(null)
    setFolderRelocationTarget(folder)
    setFolderParentDraft(folder.parent_id || '')
    setFolderPlacementDraft('first')
  }

  const confirmRelocateFolder = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!folderRelocationTarget || !folderRelocationState.plan?.changed || folderBusyID) return
    const target = folderRelocationTarget
    setFolderBusyID(target.id)
    setError(null)
    const response = await updateWhiteboardFolder(target.id, folderRelocationState.plan.input)
    setFolderBusyID(null)
    if (!response.success || !response.data?.folder) {
      setFolders(current => settleWhiteboardFolderRelocation(current, null))
      if (response.status === 409) {
        setFolderRelocationTarget(null)
        await loadFolders()
        setError(apiFailureMessage(response.status, response.error || 'La jerarquía cambió. Se actualizó el árbol; vuelve a abrir la carpeta para reintentarlo.'))
        return
      }
      setError(apiFailureMessage(response.status, response.error || 'No se pudo organizar la carpeta. No se aplicó ningún cambio.'))
      return
    }
    setFolders(current => settleWhiteboardFolderRelocation(current, response.data!.folder))
    setFolderRelocationTarget(null)
  }

  const confirmRenameFolder = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!folderRenameTarget || folderBusyID || !folderNameDraft.trim()) return
    const target = folderRenameTarget
    setFolderBusyID(target.id)
    setError(null)
    const response = await updateWhiteboardFolder(target.id, buildWhiteboardFolderRenameInput(target, folderNameDraft))
    setFolderBusyID(null)
    if (!response.success || !response.data?.folder) {
      setError(apiFailureMessage(response.status, response.error || 'No se pudo renombrar la carpeta.'))
      return
    }
    const canonical = response.data.folder
    setFolders(current => current.map(folder => folder.id === canonical.id ? canonical : folder))
    setWhiteboards(current => current.map(board => board.folder_id === canonical.id ? { ...board, folder_name: canonical.name } : board))
    setFolderRenameTarget(null)
  }

  const confirmArchiveFolder = async () => {
    if (!folderArchiveTarget || folderBusyID) return
    const target = folderArchiveTarget
    setFolderBusyID(target.id)
    setError(null)
    const response = await archiveWhiteboardFolder(target.id, target.version)
    setFolderBusyID(null)
    if (!response.success) {
      setError(apiFailureMessage(response.status, response.error || 'No se pudo archivar la carpeta.'))
      return
    }
    setFolderArchiveTarget(null)
    if (folderID === target.id) {
      setFolderID(null)
      setScope('mine')
    }
    await loadFolders()
  }

  const handleRestoreFolder = async (folder: WhiteboardFolderModel) => {
    if (folderBusyID) return
    setFolderBusyID(folder.id)
    setError(null)
    const response = await restoreWhiteboardFolder(folder.id, folder.version)
    setFolderBusyID(null)
    if (!response.success || !response.data?.folder) {
      setError(apiFailureMessage(response.status, response.error || 'No se pudo restaurar la carpeta.'))
      return
    }
    const canonical = response.data.folder
    setFolders(current => current.map(item => item.id === canonical.id ? canonical : item))
  }

  const saveTrashPolicy = async () => {
    if (!trashPolicy?.can_manage || policySaving) return
    const days = Number(retentionDraft)
    if (!Number.isInteger(days) || days < 7 || days > 365) {
      setError('La retención de Papelera debe estar entre 7 y 365 días.')
      return
    }
    setPolicySaving(true)
    setError(null)
    const response = await updateWhiteboardTrashPolicy(days)
    setPolicySaving(false)
    if (!response.success || !response.data) {
      setError(apiFailureMessage(response.status, response.error))
      return
    }
    setTrashPolicy(response.data)
    setRetentionDraft(String(response.data.retention_days))
  }

  const confirmPurge = async () => {
    if (!purgeTarget || !trashPolicy?.can_manage || busyID || purgeConfirmation !== purgeTarget.name) return
    const target = purgeTarget
    setBusyID(target.id)
    setError(null)
    const response = await purgeWhiteboard(target.id, purgeConfirmation, createWhiteboardOperationID())
    setBusyID(null)
    if (!response.success) {
      const nextEligibleAt = response.data?.next_eligible_at
      if (response.status === 409 && nextEligibleAt) {
        setPurgeEligibilityOverrides(current => ({ ...current, [target.id]: nextEligibleAt }))
        setError(`La retención todavía no terminó. ${purgeEligibilityLabel(nextEligibleAt)}.`)
      } else {
        setError(apiFailureMessage(response.status, response.error))
      }
      setPurgeTarget(null)
      setPurgeConfirmation('')
      return
    }
    setWhiteboards(current => current.filter(board => board.id !== target.id))
    setPurgeTarget(null)
    setPurgeConfirmation('')
    void loadFolders()
  }

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const validationError = validateWhiteboardImport(file)
    if (validationError) {
      setError(validationError)
      return
    }
    setSubmitting(true)
    setError(null)
    let createdBoard: WhiteboardSummary | null = null
    try {
      const source = JSON.parse(await file.text()) as Record<string, unknown>
      const nestedScene = source.scene && typeof source.scene === 'object' ? source.scene as Record<string, unknown> : source
      if (!Array.isArray(nestedScene.elements)) throw new Error('El archivo no contiene una escena compatible.')
      const {
        buildExcalidrawWhiteboardImportPlan,
        restoreClarinWhiteboardScene,
      } = await import('@/lib/whiteboardExcalidrawAdapter')
      const restoredScene = restoreClarinWhiteboardScene(nestedScene)
      const files = await rasterizeWhiteboardFiles(
        restoredScene.files,
      )
      const plan = buildExcalidrawWhiteboardImportPlan({
        name: String(source.name || file.name.replace(/\.(?:excalidraw|json)$/i, '') || 'Pizarra importada'),
        folderID,
        operationID: createWhiteboardOperationID(),
        elements: restoredScene.elements,
        appState: restoredScene.appState,
        files: restoredScene.files,
        rootExtensions: whiteboardSceneRootExtensions(restoredScene),
      })
      const response = await createWhiteboard(plan.create)
      if (!response.success || !response.data?.whiteboard) throw new Error(apiFailureMessage(response.status, response.error))
      createdBoard = response.data.whiteboard
      for (const [fileID, rawFile] of Object.entries(files)) {
        const binary = rawFile as Partial<WhiteboardBinaryFile>
        if (!binary.dataURL || typeof binary.dataURL !== 'string') continue
        const blob = dataURLToBlob(binary.dataURL)
        const extension = blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'gif'
        const upload = await uploadWhiteboardAsset(createdBoard.id, fileID, blob, `${fileID}.${extension}`)
        if (!upload.success) throw new Error(`No se pudo guardar uno de los recursos: ${upload.error || 'error de almacenamiento'}`)
      }
      const committed = await saveWhiteboard(createdBoard.id, plan.snapshot)
      if (!committed.success || !committed.data?.result.scene) throw new Error(apiFailureMessage(committed.status, committed.error || 'No se pudo confirmar la escena importada.'))
      router.push(`/dashboard/whiteboards/${createdBoard.id}`)
    } catch (importError) {
      const message = importError instanceof Error ? importError.message : 'No se pudo importar la pizarra.'
      if (createdBoard) {
        const archived = await archiveWhiteboard(createdBoard.id, createdBoard.version)
        setError(archived.success
          ? `${message} La pizarra vacía se movió a la Papelera.`
          : `${message} La pizarra quedó creada sin importar; muévela a la Papelera manualmente.`)
      } else {
        setError(message)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const scopeLabel = selectedFolder?.name || SCOPE_ITEMS.find(item => item.id === scope)?.label || 'Pizarras'
  const navigation = (
    <aside className={`flex h-full min-h-0 flex-col border-r border-slate-200 bg-white ${layout === 'compact' ? 'w-[220px]' : 'w-[248px]'}`}>
      <div className="flex h-[58px] shrink-0 items-center gap-3 border-b border-slate-100 px-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white"><Network className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-black text-slate-900">Pizarras Clarin</p><p className="text-[9px] font-bold uppercase tracking-[.14em] text-emerald-600">Espacio visual</p></div>
        {layout === 'narrow' && <button type="button" onClick={closeNavigation} aria-label="Cerrar navegación" className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>}
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-3" aria-label="Vistas y carpetas de Pizarras">
        <div className="space-y-1">
          {SCOPE_ITEMS.map(item => {
            const active = scope === item.id && !folderID
            return <button key={item.id} type="button" onClick={() => selectScope(item.id)} aria-current={active ? 'page' : undefined} className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${active ? 'bg-emerald-50 text-emerald-800' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}>
              <item.icon className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{item.label}</span>{typeof counts[item.id] === 'number' && <span className="text-[10px] tabular-nums text-slate-400">{counts[item.id]}</span>}
            </button>
          })}
        </div>
        <div className="mb-2 mt-5 flex items-center justify-between px-2">
          <p className="text-[10px] font-black uppercase tracking-[.14em] text-slate-400">Carpetas</p>
          <button type="button" onClick={() => openCreate('folder')} disabled={!capabilities.can_create_folder} aria-label={folderID ? 'Crear subcarpeta' : 'Crear carpeta'} title={!capabilities.can_create_folder ? 'El backend no concedió permiso para crear carpetas.' : undefined} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-35"><FolderPlus className="h-4 w-4" /></button>
        </div>
        {folderRows.length ? <div className="space-y-1">{folderRows.map(({ folder, depth }) => {
          const active = folder.id === folderID
          return <button key={folder.id} type="button" onClick={() => selectFolder(folder.id)} aria-current={active ? 'page' : undefined} className={`flex min-h-11 w-full items-center gap-2 rounded-xl pr-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${active ? 'bg-slate-900 font-bold text-white' : 'font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`} style={{ paddingLeft: `${12 + depth * 14}px` }}>
            {active ? <FolderOpen className="h-4 w-4 shrink-0 text-emerald-300" /> : <Folder className="h-4 w-4 shrink-0 text-slate-400" />}<span className="min-w-0 flex-1 truncate">{folder.name}</span>{typeof folder.whiteboard_count === 'number' && <span className={`text-[10px] tabular-nums ${active ? 'text-slate-300' : 'text-slate-400'}`}>{folder.whiteboard_count}</span>}
          </button>
        })}</div> : <p className="px-3 py-4 text-xs leading-5 text-slate-400">Crea carpetas para organizar el trabajo de la cuenta.</p>}
        {archivedFolders.length > 0 && <div className="mt-4 border-t border-slate-100 pt-3">
          <button type="button" onClick={() => setShowArchivedFolders(current => !current)} aria-expanded={showArchivedFolders} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-xs font-bold text-slate-500 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
            <FolderArchive className="h-4 w-4" /><span className="min-w-0 flex-1">Carpetas archivadas</span><span className="tabular-nums text-slate-400">{archivedFolders.length}</span>
          </button>
          {showArchivedFolders && <div className="mt-1 space-y-1">{archivedFolders.map(folder => <div key={folder.id} className="flex min-h-11 items-center gap-2 rounded-xl bg-slate-50 px-2 pl-3 text-xs text-slate-500">
            <FolderArchive className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{folder.name}</span><button type="button" disabled={Boolean(folderBusyID)} onClick={() => void handleRestoreFolder(folder)} aria-label={`Restaurar carpeta ${folder.name}`} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-white hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-35">{folderBusyID === folder.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}</button>
          </div>)}</div>}
        </div>}
      </nav>
    </aside>
  )

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {layout !== 'narrow' && navigation}
      {layout === 'narrow' && navigationOpen && <>
        <button type="button" aria-label="Cerrar navegación" onClick={closeNavigation} className="absolute inset-0 z-40 bg-slate-950/35 backdrop-blur-[1px]" />
        <div className="absolute inset-y-0 left-0 z-50 shadow-2xl">{navigation}</div>
      </>}

      <section className="flex min-w-0 flex-1 flex-col" aria-labelledby="whiteboards-title">
        <header className="shrink-0 border-b border-slate-200 bg-white px-3 py-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            {layout === 'narrow' && <button type="button" onClick={() => setNavigationOpen(true)} aria-label="Abrir navegación de Pizarras" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><Menu className="h-5 w-5" /></button>}
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase tracking-[.13em] text-emerald-600">Pizarras Clarin</p>
              <h1 id="whiteboards-title" className="truncate text-lg font-black text-slate-900">{scopeLabel}</h1>
            </div>
            {selectedFolder && capabilities.can_create_folder && <>
              <button type="button" onClick={() => openRelocateFolder(selectedFolder)} disabled={Boolean(folderBusyID)} aria-label={`Organizar carpeta ${selectedFolder.name}`} title="Mover o reordenar carpeta" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-35"><Move className="h-4 w-4" /></button>
              <button type="button" onClick={() => openRenameFolder(selectedFolder)} disabled={Boolean(folderBusyID)} aria-label={`Renombrar carpeta ${selectedFolder.name}`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-35"><Pencil className="h-4 w-4" /></button>
              <button type="button" onClick={() => { setError(null); setFolderArchiveTarget(selectedFolder) }} disabled={Boolean(folderBusyID)} aria-label={`Archivar carpeta ${selectedFolder.name}`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-35"><FolderArchive className="h-4 w-4" /></button>
            </>}
            <button type="button" onClick={() => void loadIndex(false)} disabled={refreshing} aria-label="Actualizar pizarras" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /></button>
            <button type="button" onClick={() => importInputRef.current?.click()} disabled={!capabilities.can_create || submitting} className="hidden min-h-11 items-center gap-2 rounded-xl border border-slate-200 px-3 text-sm font-bold text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-35 sm:flex"><FileUp className="h-4 w-4" />Importar</button>
            <input ref={importInputRef} type="file" accept=".excalidraw,.json,application/json" className="hidden" onChange={handleImport} />
            <button type="button" onClick={() => openCreate('board')} disabled={!capabilities.can_create} title={!capabilities.can_create ? 'El backend no concedió permiso para crear pizarras.' : undefined} className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-3 text-sm font-black text-white shadow-sm hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-35"><Plus className="h-4 w-4" /><span className={layout === 'narrow' ? 'sr-only' : ''}>Nueva pizarra</span></button>
          </div>
          <div className="mt-3 flex min-w-0 items-center gap-2">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Buscar pizarras</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input value={rawSearch} onChange={event => { const value = event.target.value; setRawSearch(value); if (!value) setSettledSearch('') }} placeholder="Buscar por nombre, carpeta o propietario…" className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-10 text-sm text-slate-800 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-100" />
              {searchPending && <Loader2 className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-600" aria-label="Actualizando búsqueda" />}
              {!searchPending && rawSearch && <button type="button" onClick={() => { setRawSearch(''); setSettledSearch('') }} aria-label="Limpiar búsqueda" className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>}
            </label>
            <div className="flex rounded-xl border border-slate-200 bg-white p-1" role="group" aria-label="Vista de pizarras">
              <button type="button" onClick={() => setView('grid')} aria-pressed={view === 'grid'} aria-label="Vista de cuadrícula" className={`flex h-9 w-9 items-center justify-center rounded-lg ${view === 'grid' ? 'bg-slate-900 text-white' : 'text-slate-400 hover:bg-slate-100'}`}><Grid2X2 className="h-4 w-4" /></button>
              <button type="button" onClick={() => setView('list')} aria-pressed={view === 'list'} aria-label="Vista de lista" className={`flex h-9 w-9 items-center justify-center rounded-lg ${view === 'list' ? 'bg-slate-900 text-white' : 'text-slate-400 hover:bg-slate-100'}`}><List className="h-4 w-4" /></button>
            </div>
          </div>
          {scope === 'trash' && trashPolicy && <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="min-w-0 flex-1"><p className="text-xs font-black text-slate-700">Retención de Papelera</p><p className="mt-0.5 text-[10px] leading-4 text-slate-500">La eliminación definitiva sólo se habilita al cumplir {trashPolicy.retention_days} días desde el archivado.</p></div>
            {trashPolicy.can_manage && <><label className="flex items-center gap-2 text-xs font-bold text-slate-600"><span>Días</span><input type="number" min={7} max={365} value={retentionDraft} onChange={event => setRetentionDraft(event.target.value)} className="h-10 w-24 rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100" /></label><button type="button" onClick={() => void saveTrashPolicy()} disabled={policySaving || retentionDraft === String(trashPolicy.retention_days)} className="flex min-h-10 items-center gap-2 rounded-xl bg-slate-900 px-3 text-xs font-black text-white disabled:opacity-35">{policySaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Guardar política</button></>}
          </div>}
          {error && phase !== 'error' && <div className="mt-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert"><span className="min-w-0 flex-1">{error}</span><button type="button" onClick={() => setError(null)} aria-label="Cerrar error" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-rose-100"><X className="h-4 w-4" /></button></div>}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/60">
          {phase === 'loading' && <div className={`grid gap-3 p-4 ${layout === 'wide' ? 'grid-cols-3 xl:grid-cols-4' : layout === 'compact' ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-2'}`} aria-label="Cargando pizarras">{Array.from({ length: 8 }).map((_, index) => <div key={index} className="aspect-[4/3] animate-pulse rounded-2xl border border-slate-200 bg-white" />)}</div>}
          {phase === 'error' && <div className="flex h-full min-h-80 flex-col items-center justify-center px-6 text-center"><span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-rose-100 bg-white text-rose-600 shadow-sm"><Network className="h-7 w-7" /></span><h2 className="mt-4 text-lg font-black text-slate-900">No se pudieron abrir las Pizarras</h2><p className="mt-2 max-w-md text-sm leading-6 text-slate-500">{error}</p><button type="button" onClick={() => void loadIndex(false)} className="mt-5 flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white hover:bg-slate-800"><RefreshCw className="h-4 w-4" />Reintentar</button></div>}
          {phase === 'ready' && visibleWhiteboards.length === 0 && <div className="flex h-full min-h-80 flex-col items-center justify-center px-6 text-center"><span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-400 shadow-sm">{settledSearch ? <Search className="h-7 w-7" /> : selectedFolder ? <FolderOpen className="h-7 w-7" /> : <Network className="h-7 w-7" />}</span><h2 className="mt-4 text-lg font-black text-slate-900">{settledSearch ? 'No hay coincidencias' : scope === 'trash' ? 'La Papelera está vacía' : 'Este espacio está vacío'}</h2><p className="mt-2 max-w-md text-sm leading-6 text-slate-500">{settledSearch ? 'Prueba otra búsqueda o limpia el texto.' : scope === 'trash' ? 'Las pizarras que muevas a la Papelera aparecerán aquí y se podrán restaurar.' : 'Crea una pizarra para empezar a trabajar visualmente dentro de la cuenta.'}</p>{!settledSearch && scope !== 'trash' && <button type="button" disabled={!capabilities.can_create} onClick={() => openCreate('board')} className="mt-5 flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-black text-white hover:bg-emerald-700 disabled:opacity-35"><Plus className="h-4 w-4" />Nueva pizarra</button>}</div>}
          {phase === 'ready' && visibleWhiteboards.length > 0 && <div className={view === 'grid' ? `grid gap-3 p-3 sm:p-4 ${layout === 'wide' ? 'grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4' : layout === 'compact' ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-2'}` : 'm-3 overflow-hidden rounded-2xl border border-slate-200 bg-white sm:m-4'}>
            {visibleWhiteboards.map(whiteboard => <WhiteboardCard
              key={whiteboard.id}
              whiteboard={whiteboard}
              view={view}
              busy={busyID === whiteboard.id}
              onOpen={() => router.push(`/dashboard/whiteboards/${whiteboard.id}`)}
              onDuplicate={() => void handleDuplicate(whiteboard)}
              onMove={() => openMove(whiteboard)}
              onArchive={() => setArchiveTarget(whiteboard)}
              onRestore={() => void handleRestore(whiteboard)}
              onPurge={() => { setPurgeTarget(whiteboard); setPurgeConfirmation('') }}
              purgeEligibleAt={purgeEligibilityOverrides[whiteboard.id] || whiteboardPurgeEligibleAt(whiteboard.archived_at, trashPolicy?.retention_days || 0)}
              canPurge={Boolean(trashPolicy?.can_manage)}
              canDuplicate={capabilities.can_create}
              canMove={whiteboard.effective_access.can_edit}
            />)}
          </div>}
          {phase === 'ready' && nextCursor && <div className="flex justify-center px-4 pb-6"><button type="button" onClick={() => void loadIndex(true)} disabled={loadingMore} className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-600 shadow-sm hover:bg-slate-50 disabled:opacity-50">{loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}Cargar más</button></div>}
        </div>
      </section>

      {dialog && <OperationalDialog title={dialog === 'board' ? 'Nueva pizarra' : folderID ? 'Nueva subcarpeta' : 'Nueva carpeta'} description={dialog === 'board' ? `Se guardará ${selectedFolder ? `en ${selectedFolder.name}` : 'sin carpeta'} dentro de la cuenta activa.` : folderID ? `Quedará dentro de ${selectedFolder?.name || 'la carpeta seleccionada'}.` : 'La carpeta será visible según los permisos de la cuenta.'} onClose={() => { if (!submitting) setDialog(null) }} initialFocusRef={createNameInputRef}>
        <form onSubmit={submitCreate} className="p-5">
          <label className="block text-xs font-black uppercase tracking-[.12em] text-slate-500">Nombre</label>
          <input ref={createNameInputRef} value={draftName} onChange={event => setDraftName(event.target.value)} maxLength={120} placeholder={dialog === 'board' ? 'Ej. Flujo de atención' : 'Ej. Operaciones'} className="mt-2 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm text-slate-800 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100" />
          {error && <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{error}</p>}
          <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={submitting} onClick={() => setDialog(null)} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">Cancelar</button><button type="submit" disabled={!draftName.trim() || submitting} className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-black text-white hover:bg-emerald-700 disabled:opacity-40">{submitting && <Loader2 className="h-4 w-4 animate-spin" />}Crear</button></div>
        </form>
      </OperationalDialog>}

      {moveTarget && <OperationalDialog title="Mover pizarra" description={`Elige la carpeta interna para “${moveTarget.name}”. El cambio se guarda con control de versión.`} onClose={() => { if (!busyID) setMoveTarget(null) }}>
        <form onSubmit={confirmMove} className="p-5">
          <label className="block text-xs font-black uppercase tracking-[.12em] text-slate-500">Carpeta de destino<select autoFocus value={moveFolderID} onChange={event => setMoveFolderID(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"><option value="">Sin carpeta</option>{folderRows.map(({ folder, depth }) => <option key={folder.id} value={folder.id}>{`${'— '.repeat(depth)}${folder.name}`}</option>)}</select></label>
          {error && <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{error}</p>}
          <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={Boolean(busyID)} onClick={() => setMoveTarget(null)} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">Cancelar</button><button type="submit" disabled={Boolean(busyID) || (moveTarget.folder_id || '') === moveFolderID} className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-black text-white hover:bg-emerald-700 disabled:opacity-35">{busyID ? <Loader2 className="h-4 w-4 animate-spin" /> : <Move className="h-4 w-4" />}Mover</button></div>
        </form>
      </OperationalDialog>}

      {folderRenameTarget && <OperationalDialog title="Renombrar carpeta" description="El nombre se actualiza dentro de la cuenta activa sin cambiar su contenido." onClose={() => { if (!folderBusyID) setFolderRenameTarget(null) }}>
        <form onSubmit={confirmRenameFolder} className="p-5">
          <label className="block text-xs font-black uppercase tracking-[.12em] text-slate-500">Nombre<input autoFocus value={folderNameDraft} onChange={event => setFolderNameDraft(event.target.value)} maxLength={120} className="mt-2 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm text-slate-800 outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100" /></label>
          {error && <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{error}</p>}
          <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={Boolean(folderBusyID)} onClick={() => setFolderRenameTarget(null)} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">Cancelar</button><button type="submit" disabled={Boolean(folderBusyID) || !folderNameDraft.trim() || folderNameDraft.trim() === folderRenameTarget.name} className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-black text-white hover:bg-emerald-700 disabled:opacity-35">{folderBusyID ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}Guardar</button></div>
        </form>
      </OperationalDialog>}

      {folderRelocationTarget && <OperationalDialog title="Organizar carpeta" description={`Elige dónde debe quedar “${folderRelocationTarget.name}”. Sus subcarpetas y pizarras se moverán con ella; los permisos no cambian.`} onClose={() => { if (!folderBusyID) setFolderRelocationTarget(null) }}>
        <form onSubmit={confirmRelocateFolder} className="p-5">
          <fieldset>
            <legend className="text-xs font-black uppercase tracking-[.12em] text-slate-500">Carpeta superior</legend>
            <div className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-1" aria-label="Carpeta superior de destino">
              {folderDestinationOptions.map(option => {
                const value = option.id || ''
                const selected = folderParentDraft === value
                return <label
                  key={option.id || 'root'}
                  className={`relative flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm outline-none transition-colors focus-within:ring-2 focus-within:ring-emerald-500 ${selected ? 'bg-white font-bold text-emerald-800 shadow-sm ring-1 ring-emerald-200' : option.disabled ? 'cursor-not-allowed text-slate-300' : 'cursor-pointer font-medium text-slate-600 hover:bg-white hover:text-slate-900'}`}
                  title={option.reason}
                >
                  <input
                    type="radio"
                    name="whiteboard-folder-parent"
                    value={value}
                    checked={selected}
                    autoFocus={selected}
                    disabled={option.disabled || Boolean(folderBusyID)}
                    onChange={() => { setFolderParentDraft(value); setError(null) }}
                    aria-label={`${option.label}${option.reason ? `. No disponible: ${option.reason}` : ''}`}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                  />
                  <Folder className={`h-4 w-4 shrink-0 ${selected ? 'text-emerald-600' : 'text-slate-400'}`} />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {selected && <Check className="h-4 w-4 shrink-0 text-emerald-600" />}
                </label>
              })}
            </div>
          </fieldset>
          <fieldset className="mt-4">
            <legend className="text-xs font-black uppercase tracking-[.12em] text-slate-500">Posición entre carpetas del mismo nivel</legend>
            <div className="mt-2 grid grid-cols-2 gap-2" aria-label="Posición de la carpeta">
              {([['first', 'Primera', ArrowUpToLine], ['last', 'Última', ArrowDownToLine]] as const).map(([placement, label, Icon]) => <label key={placement} className={`relative flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border px-3 text-sm font-bold focus-within:ring-2 focus-within:ring-emerald-500 ${folderPlacementDraft === placement ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                <input type="radio" name="whiteboard-folder-placement" value={placement} checked={folderPlacementDraft === placement} disabled={Boolean(folderBusyID)} onChange={() => { setFolderPlacementDraft(placement); setError(null) }} className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" />
                <Icon className="h-4 w-4" />{label}
              </label>)}
            </div>
          </fieldset>
          {folderRelocationState.error && <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">{folderRelocationState.error}</p>}
          {!folderRelocationState.error && folderRelocationState.plan && <p className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-5 text-slate-600">{folderRelocationState.plan.changed ? `Se guardará como ${folderPlacementDraft === 'first' ? 'la primera' : 'la última'} carpeta dentro de ${folderDestinationOptions.find(option => (option.id || '') === folderParentDraft)?.label || 'la raíz'}.` : 'La carpeta ya ocupa esa posición.'}</p>}
          {error && <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{error}</p>}
          <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={Boolean(folderBusyID)} onClick={() => setFolderRelocationTarget(null)} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">Cancelar</button><button type="submit" disabled={Boolean(folderBusyID) || !folderRelocationState.plan?.changed} className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-black text-white hover:bg-emerald-700 disabled:opacity-35">{folderBusyID ? <Loader2 className="h-4 w-4 animate-spin" /> : <Move className="h-4 w-4" />}Confirmar organización</button></div>
        </form>
      </OperationalDialog>}

      {folderArchiveTarget && <OperationalDialog title="Archivar carpeta" description={`“${folderArchiveTarget.name}” sólo se archivará si no contiene subcarpetas ni pizarras activas.`} onClose={() => { if (!folderBusyID) setFolderArchiveTarget(null) }}>
        <div className="p-5"><p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm leading-5 text-amber-900">El contenido nunca se elimina para forzar el archivado. Si la carpeta no está vacía, Clarin mantendrá todo intacto y mostrará el motivo.</p>{error && <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{error}</p>}<div className="mt-5 flex justify-end gap-2"><button type="button" disabled={Boolean(folderBusyID)} onClick={() => setFolderArchiveTarget(null)} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">Cancelar</button><button type="button" disabled={Boolean(folderBusyID)} onClick={() => void confirmArchiveFolder()} className="flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-black text-white hover:bg-slate-800 disabled:opacity-40">{folderBusyID ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderArchive className="h-4 w-4" />}Archivar si está vacía</button></div></div>
      </OperationalDialog>}

      {archiveTarget && <OperationalDialog title="Mover a la Papelera" description={`“${archiveTarget.name}” dejará de aparecer en las vistas activas, pero podrá restaurarse desde Papelera.`} onClose={() => { if (!busyID) setArchiveTarget(null) }}>
        <div className="p-5"><div className="flex justify-end gap-2"><button type="button" disabled={Boolean(busyID)} onClick={() => setArchiveTarget(null)} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">Cancelar</button><button type="button" disabled={Boolean(busyID)} onClick={() => void confirmArchive()} className="flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-black text-white hover:bg-slate-800 disabled:opacity-40">{busyID ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}Mover a la Papelera</button></div></div>
      </OperationalDialog>}

      {purgeTarget && <OperationalDialog title="Eliminar pizarra definitivamente" description="Esta acción elimina la pizarra y programa la limpieza segura de revisiones y recursos sin referencias. No se puede deshacer." onClose={() => { if (!busyID) { setPurgeTarget(null); setPurgeConfirmation('') } }}>
        <div className="p-5">
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-sm leading-5 text-rose-800">Escribe exactamente <strong>{purgeTarget.name}</strong> para confirmar.</p>
          <label className="mt-4 block text-xs font-black uppercase tracking-[.12em] text-slate-500">Nombre de la pizarra<input autoFocus value={purgeConfirmation} onChange={event => setPurgeConfirmation(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm text-slate-800 outline-none focus:border-rose-400 focus:ring-4 focus:ring-rose-100" /></label>
          <p className="mt-2 text-xs text-slate-400">{purgeEligibilityLabel(purgeEligibilityOverrides[purgeTarget.id] || whiteboardPurgeEligibleAt(purgeTarget.archived_at, trashPolicy?.retention_days || 0))}</p>
          <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={Boolean(busyID)} onClick={() => { setPurgeTarget(null); setPurgeConfirmation('') }} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">Cancelar</button><button type="button" disabled={Boolean(busyID) || purgeConfirmation !== purgeTarget.name} onClick={() => void confirmPurge()} className="flex min-h-11 items-center gap-2 rounded-xl bg-rose-600 px-4 text-sm font-black text-white hover:bg-rose-700 disabled:opacity-35">{busyID ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Eliminar definitivamente</button></div>
        </div>
      </OperationalDialog>}
    </div>
  )
}
