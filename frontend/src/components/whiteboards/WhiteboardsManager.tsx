'use client'

import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useRouter } from 'next/navigation'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core'
import {
  Archive,
  ArrowRight,
  Check,
  Clock3,
  BriefcaseBusiness,
  Copy,
  FileUp,
  Folder,
  FolderArchive,
  FolderOpen,
  FolderPlus,
  Grid2X2,
  GripVertical,
  Home,
  Inbox,
  LayoutTemplate,
  List,
  Loader2,
  Menu,
  MoreHorizontal,
  Move,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
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
  parseWhiteboardViewMode,
  reconcileWhiteboardScopeCapability,
  whiteboardDuplicateName,
  whiteboardManagerLayout,
  whiteboardPurgeEligibleAt,
  whiteboardSceneRootExtensions,
  WHITEBOARD_MANAGER_VIEW_STORAGE_KEY,
  type WhiteboardFolder as WhiteboardFolderModel,
  type WhiteboardScope,
  type WhiteboardSummary,
  type WhiteboardViewMode,
} from '@/lib/whiteboards'
import { dataURLToBlob, rasterizeWhiteboardFiles, type WhiteboardBinaryFile } from '@/lib/whiteboardMedia'
import {
  activeWhiteboardFolders,
  archivedWhiteboardFolders,
  buildWhiteboardFolderPlacementPlan,
  buildWhiteboardMoveInput,
  optimisticWhiteboardMove,
  optimisticWhiteboardFolderCounts,
  optimisticWhiteboardFolderPlacement,
  settleWhiteboardFolderRelocation,
  settleWhiteboardMove,
  whiteboardFolderDestinationError,
  whiteboardMoveDestinationOptions,
  type WhiteboardFolderDestination,
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
import OperationalDragOverlay from '@/components/drag-interaction/OperationalDragOverlay'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'
import { useWhiteboardDialogFocus } from './useWhiteboardDialogFocus'
import WhiteboardSettingsPanel, { type WhiteboardSettingsTarget } from './WhiteboardSettingsPanel'
import WhiteboardShareDialog from './WhiteboardShareDialog'
import {
  duplicateTaskLocationView,
  loadTaskLocationView,
} from '@/lib/taskLocationViewsApi'
import { subscribeWebSocket } from '@/lib/api'
import {
  redactWhiteboardHubSnapshot,
  WHITEBOARD_HUB_REVALIDATION_INTERVAL_MS,
  whiteboardHubRealtimeDecision,
} from '@/lib/whiteboardHubRealtime'

const SCOPE_ITEMS: Array<{ id: WhiteboardScope; label: string; icon: typeof Inbox }> = [
  { id: 'mine', label: 'Mis pizarras', icon: Inbox },
  { id: 'recent', label: 'Recientes', icon: Clock3 },
  { id: 'shared', label: 'Compartidas conmigo', icon: Share2 },
  { id: 'work', label: 'Clarin Work', icon: BriefcaseBusiness },
  { id: 'trash', label: 'Papelera', icon: Trash2 },
]

type DialogKind = 'board' | 'folder' | null
type WhiteboardMenuAction = 'settings' | 'move' | 'duplicate' | 'archive' | 'restore' | 'purge'

interface WhiteboardFolderStructuralDestination {
  parentID: string | null
  beforeFolderID: string | null
  label: string
}

const WHITEBOARD_ROOT_DROP_ID = 'whiteboard-folder:root'
const WHITEBOARD_FOLDER_DRAG_PREFIX = 'whiteboard-folder-drag:'
const WHITEBOARD_FOLDER_BEFORE_PREFIX = 'whiteboard-folder-before:'

function whiteboardFolderDropID(folderID: string) {
  return `whiteboard-folder:${folderID}`
}

function whiteboardFolderDragID(folderID: string) {
  return `${WHITEBOARD_FOLDER_DRAG_PREFIX}${folderID}`
}

function whiteboardFolderIDFromDragID(value: string) {
  return value.startsWith(WHITEBOARD_FOLDER_DRAG_PREFIX) ? value.slice(WHITEBOARD_FOLDER_DRAG_PREFIX.length) : ''
}

function whiteboardFolderBeforeDropID(folderID: string) {
  return `${WHITEBOARD_FOLDER_BEFORE_PREFIX}${folderID}`
}

function whiteboardIDFromDragID(value: string) {
  return value.startsWith('whiteboard:') ? value.slice('whiteboard:'.length) : ''
}

function whiteboardDestinationFromDropID(value: string, folders: readonly WhiteboardFolderModel[]): WhiteboardFolderDestination | null {
  if (value === WHITEBOARD_ROOT_DROP_ID) return { id: null, name: null }
  if (!value.startsWith('whiteboard-folder:')) return null
  const id = value.slice('whiteboard-folder:'.length)
  const folder = folders.find(item => item.id === id && !item.archived_at)
  return folder ? { id: folder.id, name: folder.name } : null
}

function whiteboardFolderStructuralDestinationFromDropID(
  value: string,
  folders: readonly WhiteboardFolderModel[],
): WhiteboardFolderStructuralDestination | null {
  if (value === WHITEBOARD_ROOT_DROP_ID) return { parentID: null, beforeFolderID: null, label: 'Nivel principal' }
  if (value.startsWith(WHITEBOARD_FOLDER_BEFORE_PREFIX)) {
    const folder = folders.find(item => item.id === value.slice(WHITEBOARD_FOLDER_BEFORE_PREFIX.length) && !item.archived_at)
    return folder ? { parentID: folder.parent_id || null, beforeFolderID: folder.id, label: `Antes de ${folder.name}` } : null
  }
  if (value.startsWith('whiteboard-folder:')) {
    const folder = folders.find(item => item.id === value.slice('whiteboard-folder:'.length) && !item.archived_at)
    return folder ? { parentID: folder.id, beforeFolderID: null, label: `Dentro de ${folder.name}` } : null
  }
  return null
}

const whiteboardFolderCollisionDetection: CollisionDetection = args => {
  if (args.pointerCoordinates) return pointerWithin(args)
  const initial = args.active.rect.current.initial
  if (initial
    && Math.abs(args.collisionRect.left - initial.left) < 1
    && Math.abs(args.collisionRect.top - initial.top) < 1) return []
  return rectIntersection(args)
}

const whiteboardFolderKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const direction = event.code === 'ArrowDown' || event.code === 'ArrowRight'
    ? 1
    : event.code === 'ArrowUp' || event.code === 'ArrowLeft'
      ? -1
      : null
  if (!direction) return undefined

  const destinations: Array<{ id: string; top: number; left: number; centerX: number; centerY: number }> = []
  context.droppableContainers.getEnabled().forEach(container => {
    const kind = container.data.current?.type
    if (kind !== 'whiteboard-folder' && kind !== 'whiteboard-folder-root' && kind !== 'whiteboard-folder-before') return
    const rect = context.droppableRects.get(container.id)
    if (!rect) return
    destinations.push({
      id: String(container.id),
      top: rect.top,
      left: rect.left,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
    })
  })
  destinations.sort((first, second) => first.top - second.top || first.left - second.left)
  if (!destinations.length) return undefined

  const sourceFolderID = context.active?.data.current?.sourceFolderID as string | null | undefined
  const sourceDropID = sourceFolderID ? whiteboardFolderDropID(sourceFolderID) : WHITEBOARD_ROOT_DROP_ID
  const atOrigin = Boolean(context.collisionRect && context.draggingNodeRect
    && Math.abs(context.collisionRect.left - context.draggingNodeRect.left) < 1
    && Math.abs(context.collisionRect.top - context.draggingNodeRect.top) < 1)
  const currentDropID = !atOrigin && context.over ? String(context.over.id) : sourceDropID
  const currentIndex = destinations.findIndex(destination => destination.id === currentDropID)
  const nextIndex = currentIndex < 0
    ? direction > 0 ? 0 : destinations.length - 1
    : Math.max(0, Math.min(destinations.length - 1, currentIndex + direction))
  const destination = destinations[nextIndex]
  if (!destination) return undefined
  event.preventDefault()
  return {
    x: destination.centerX - (context.collisionRect?.width || 0) / 2,
    y: destination.centerY - (context.collisionRect?.height || 0) / 2,
  }
}

function WhiteboardFolderDropTarget({
  folder,
  depth,
  active,
  folders,
  draggingBoard,
  draggingFolder,
  canManage,
  busy,
  onSelect,
  onSettings,
}: {
  folder: WhiteboardFolderModel
  depth: number
  active: boolean
  folders: readonly WhiteboardFolderModel[]
  draggingBoard: boolean
  draggingFolder: WhiteboardFolderModel | null
  canManage: boolean
  busy: boolean
  onSelect: () => void
  onSettings: () => void
}) {
  const insideError = draggingFolder ? whiteboardFolderDestinationError(draggingFolder, folders, folder.id) : null
  const beforeError = draggingFolder ? whiteboardFolderDestinationError(draggingFolder, folders, folder.parent_id || null) : null
  const insideDrop = useDroppable({
    id: whiteboardFolderDropID(folder.id),
    data: { type: 'whiteboard-folder', folderID: folder.id },
    disabled: (!draggingBoard && !draggingFolder) || Boolean(insideError),
  })
  const beforeDrop = useDroppable({
    id: whiteboardFolderBeforeDropID(folder.id),
    data: { type: 'whiteboard-folder-before', folderID: folder.id },
    disabled: !draggingFolder || Boolean(beforeError),
  })
  const drag = useDraggable({
    id: whiteboardFolderDragID(folder.id),
    data: { type: 'whiteboard-folder-drag', folderID: folder.id },
    disabled: !canManage || busy || Boolean(draggingBoard),
  })
  const isOver = insideDrop.isOver
  return <div style={{ marginLeft: `${depth * 14}px` }}>
    <div ref={beforeDrop.setNodeRef} data-whiteboard-folder-before={folder.id} aria-hidden={!draggingFolder} className={`mx-2 rounded-full transition-[height,background-color,box-shadow] duration-150 motion-reduce:transition-none ${draggingFolder ? beforeDrop.isOver ? 'my-1 h-2 bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.14)]' : 'h-1 bg-transparent' : 'h-0'}`} />
    <div
      ref={node => { insideDrop.setNodeRef(node); drag.setNodeRef(node) }}
      data-whiteboard-folder-drop={folder.id}
      style={{ opacity: drag.isDragging ? 0.32 : 1 }}
      className={`group flex min-h-11 w-full items-center rounded-xl border text-sm transition-[transform,opacity,background-color,border-color,box-shadow,color] duration-150 motion-reduce:transition-none ${isOver ? 'scale-[1.02] border-emerald-400 bg-emerald-50 font-bold text-emerald-800 shadow-lg ring-2 ring-emerald-100' : active ? 'border-slate-900 bg-slate-900 font-bold text-white' : draggingBoard || draggingFolder ? 'border-emerald-100 bg-white font-medium text-slate-700 shadow-sm' : 'border-transparent font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}
    >
      {canManage && <button ref={drag.setActivatorNodeRef} type="button" disabled={busy || Boolean(draggingBoard)} {...drag.attributes} {...drag.listeners} aria-label={`Mover carpeta ${folder.name}`} className={`flex h-11 w-9 shrink-0 touch-none items-center justify-center rounded-l-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 disabled:opacity-30 [@media(pointer:fine)]:cursor-grab ${active ? 'text-slate-300 hover:text-white' : 'text-slate-300 hover:text-emerald-700'}`}><GripVertical className="h-4 w-4" /></button>}
      <button type="button" onClick={onSelect} aria-current={active ? 'page' : undefined} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500">
        {isOver || active ? <FolderOpen className={`h-4 w-4 shrink-0 ${active && !isOver ? 'text-emerald-300' : 'text-emerald-600'}`} /> : <Folder className="h-4 w-4 shrink-0 text-slate-400" />}
        <span className="min-w-0 flex-1 truncate">{isOver ? draggingFolder ? `Mover dentro de ${folder.name}` : `Mover a ${folder.name}` : folder.name}</span>
        {typeof folder.whiteboard_count === 'number' && <span className={`text-[10px] tabular-nums ${active && !isOver ? 'text-slate-300' : 'text-slate-400'}`}>{folder.whiteboard_count}</span>}
      </button>
      {canManage && <button type="button" disabled={busy} onClick={onSettings} aria-label={`Configurar carpeta ${folder.name}`} className={`flex h-11 w-9 shrink-0 items-center justify-center rounded-r-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 disabled:opacity-30 ${active ? 'text-slate-300 hover:bg-white/10 hover:text-white' : 'text-slate-300 hover:bg-slate-100 hover:text-slate-700'}`}><Settings2 className="h-4 w-4" /></button>}
    </div>
  </div>
}

function WhiteboardRootDropTarget({ active, draggingBoard, draggingFolder }: { active: boolean; draggingBoard: boolean; draggingFolder: boolean }) {
  const { isOver, setNodeRef } = useDroppable({
    id: WHITEBOARD_ROOT_DROP_ID,
    data: { type: 'whiteboard-folder-root' },
    disabled: !draggingBoard && !draggingFolder,
  })
  return <div
    ref={setNodeRef}
    data-whiteboard-root-drop
    aria-label={draggingBoard || draggingFolder ? 'Destino Sin carpeta' : undefined}
    className={`mb-2 flex min-h-11 items-center gap-2 rounded-xl border px-3 text-sm transition-[transform,background-color,border-color,box-shadow,color] duration-150 motion-reduce:transition-none ${isOver || active ? 'scale-[1.02] border-emerald-400 bg-emerald-50 font-bold text-emerald-800 shadow-lg ring-2 ring-emerald-100' : draggingBoard || draggingFolder ? 'border-dashed border-emerald-200 bg-emerald-50/40 font-bold text-emerald-700' : 'border-transparent bg-slate-50/70 font-medium text-slate-500'}`}
  >
    <Home className={`h-4 w-4 shrink-0 ${draggingBoard || draggingFolder ? 'text-emerald-600' : 'text-slate-400'}`} /><span className="min-w-0 flex-1 truncate">{isOver || active ? draggingFolder ? 'Mover al nivel principal' : 'Soltar en Sin carpeta' : 'Sin carpeta'}</span>{!draggingBoard && !draggingFolder && <span className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Raíz</span>}
  </div>
}

function WhiteboardActionsMenu({
  whiteboard,
  busy,
  canMove,
  canConfigure,
  canDuplicate,
  canManage,
  canPurge,
  purgeReady,
  purgeEligibleAt,
  onAction,
}: {
  whiteboard: WhiteboardSummary
  busy: boolean
  canMove: boolean
  canConfigure: boolean
  canDuplicate: boolean
  canManage: boolean
  canPurge: boolean
  purgeReady: boolean
  purgeEligibleAt: string | null
  onAction: (action: WhiteboardMenuAction) => void
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0, width: 224 })
  const archived = Boolean(whiteboard.archived_at)
  const hasActions = archived
    ? canManage || canPurge
    : canConfigure || canMove || canDuplicate || canManage

  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }, [])

  useEffect(() => {
    if (!open) return
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(224, window.innerWidth - 24)
      const estimatedHeight = menuRef.current?.offsetHeight || 224
      const below = rect.bottom + 8
      const top = below + estimatedHeight <= window.innerHeight - 12
        ? below
        : Math.max(12, rect.top - estimatedHeight - 8)
      const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))
      setPosition({ top, left, width })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true }))
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  const choose = (action: WhiteboardMenuAction) => {
    close(false)
    onAction(action)
  }

  if (!hasActions) return null

  return <>
    <button ref={triggerRef} type="button" disabled={busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40" aria-label={`Más acciones de ${whiteboard.name}`}><MoreHorizontal className="h-4 w-4" /></button>
    {open && typeof document !== 'undefined' && createPortal(<>
      <button type="button" aria-label="Cerrar acciones de pizarra" onMouseDown={() => close()} className="fixed inset-0 cursor-default" style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.workspacePopover - 1 }} />
      <div ref={menuRef} role="menu" aria-label={`Acciones de ${whiteboard.name}`} style={{ ...position, zIndex: OPERATIONAL_OVERLAY_LAYERS.workspacePopover }} onKeyDown={event => {
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        if (event.key === 'Escape') { event.preventDefault(); close() }
        else if (event.key === 'ArrowDown') { event.preventDefault(); items[(current + 1 + items.length) % items.length]?.focus() }
        else if (event.key === 'ArrowUp') { event.preventDefault(); items[(current - 1 + items.length) % items.length]?.focus() }
        else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus() }
        else if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus() }
        else if (event.key === 'Tab') close(false)
      }} className="fixed rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-900/15 outline-none">
        {!archived && canConfigure && <button type="button" role="menuitem" onClick={() => choose('settings')} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-700 hover:bg-emerald-50 hover:text-emerald-800"><Settings2 className="h-4 w-4 text-emerald-600" />Configurar</button>}
        {!archived && canMove && <button type="button" role="menuitem" onClick={() => choose('move')} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-600 hover:bg-emerald-50 hover:text-emerald-800"><Folder className="h-4 w-4 text-emerald-600" />Cambiar carpeta</button>}
        {!archived && canDuplicate && <button type="button" role="menuitem" onClick={() => choose('duplicate')} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-600 hover:bg-slate-50"><Copy className="h-4 w-4 text-slate-400" />Duplicar</button>}
        {!archived && canManage && <button type="button" role="menuitem" onClick={() => choose('archive')} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-600 hover:bg-slate-50"><Archive className="h-4 w-4 text-slate-400" />Mover a Papelera</button>}
        {archived && canManage && <button type="button" role="menuitem" onClick={() => choose('restore')} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-emerald-700 hover:bg-emerald-50"><RotateCcw className="h-4 w-4" />Restaurar</button>}
        {archived && canPurge && <button type="button" role="menuitem" disabled={!purgeReady} onClick={() => choose('purge')} title={purgeReady ? 'Eliminar definitivamente' : purgeEligibilityLabel(purgeEligibleAt)} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-35"><Trash2 className="h-4 w-4" />Eliminar definitivamente</button>}
      </div>
    </>, document.body)}
  </>
}

function apiFailureMessage(status: number | undefined, fallback?: string) {
  if (status === 403) return 'No tienes permiso para realizar esta acción en la cuenta activa.'
  if (status === 404) return fallback || 'El recurso ya no está disponible o dejó de ser visible para tu cuenta.'
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
  onMove,
  purgeEligibleAt,
  canPurge,
  canDuplicate,
  canMove,
  canDrag,
  onMenuAction,
}: {
  whiteboard: WhiteboardSummary
  view: WhiteboardViewMode
  busy: boolean
  onOpen: () => void
  onMove: () => void
  purgeEligibleAt: string | null
  canPurge: boolean
  canDuplicate: boolean
  canMove: boolean
  canDrag: boolean
  onMenuAction: (action: WhiteboardMenuAction) => void
}) {
  const archived = Boolean(whiteboard.archived_at)
  const isWork = whiteboard.origin === 'work' && Boolean(whiteboard.work_location)
  const canOpenWorkLocation = isWork && !archived && whiteboard.work_location?.lifecycle !== 'trash'
  const workLocationHref = canOpenWorkLocation && whiteboard.work_location?.task_view_id
    ? `/dashboard/tasks?work_view=${encodeURIComponent(whiteboard.work_location.task_view_id)}`
    : null
  const canManage = Boolean(whiteboard.effective_access.can_delete || whiteboard.effective_access.can_manage_access)
  const canConfigure = !isWork && whiteboard.effective_access.can_manage_access
  const workBreadcrumb = whiteboard.work_location?.breadcrumb?.map(item => item.name).filter(Boolean).join(' / ')
    || whiteboard.work_location?.scope_name
    || 'Ubicación autorizada'
  const workLocationAriaLabel = `Abrir ubicación en Work · ${whiteboard.name} · ${workBreadcrumb}`
  const secondaryLabel = archived
    ? purgeEligibilityLabel(purgeEligibleAt)
    : isWork
      ? `Clarin Work · ${workBreadcrumb}`
      : `${whiteboard.folder_name || 'Sin carpeta'} · ${whiteboard.updated_by_name || whiteboard.owner_name || 'Cuenta'}`
  const purgeReady = Boolean(purgeEligibleAt && Date.parse(purgeEligibleAt) <= Date.now())
  const drag = useDraggable({
    id: `whiteboard:${whiteboard.id}`,
    data: { type: 'whiteboard', whiteboardID: whiteboard.id, sourceFolderID: whiteboard.folder_id || null },
    disabled: archived || !canDrag || busy,
  })
  const articleStyle: CSSProperties = {
    opacity: drag.isDragging ? 0.32 : 1,
  }
  const dragHandle = !archived && canMove && <button
    ref={drag.setActivatorNodeRef}
    type="button"
    disabled={busy || !canDrag}
    {...drag.attributes}
    {...drag.listeners}
    className="flex h-11 w-11 shrink-0 touch-none items-center justify-center rounded-xl text-slate-400 transition hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:fine)]:cursor-grab"
    aria-label={canDrag ? `Arrastrar ${whiteboard.name} a una carpeta` : `No hay otra carpeta disponible para ${whiteboard.name}`}
    title={canDrag ? 'Arrastrar a una carpeta' : 'Crea una carpeta para habilitar el arrastre'}
  ><GripVertical className="h-4 w-4" /></button>
  if (view === 'list') {
    return (
      <article ref={drag.setNodeRef} data-whiteboard-id={whiteboard.id} style={articleStyle} className="group flex min-w-0 items-center gap-2 border-b border-slate-100 bg-white px-3 py-2.5 transition-[opacity,background-color] hover:bg-slate-50 sm:px-4">
        {dragHandle}
        <button type="button" onClick={onOpen} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-emerald-700 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label={`Abrir ${whiteboard.name}`}>
          <Network className="h-5 w-5" />
        </button>
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
          <span className="block truncate text-sm font-bold text-slate-800">{whiteboard.name}</span>
          <span className="mt-0.5 block truncate text-xs text-slate-400">{secondaryLabel}</span>
        </button>
        {isWork && <span className="hidden rounded-full bg-violet-50 px-2 py-1 text-[10px] font-bold text-violet-700 sm:inline">Clarin Work</span>}
        {whiteboard.shared && <span className="hidden rounded-full bg-sky-50 px-2 py-1 text-[10px] font-bold text-sky-700 sm:inline">Compartida</span>}
        <span className="hidden w-28 text-right text-xs text-slate-400 md:block">{formatWhiteboardUpdatedAt(whiteboard.updated_at)}</span>
        {!archived && canMove && <button type="button" disabled={busy} onClick={onMove} className="hidden min-h-9 max-w-44 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40 sm:flex" aria-label={`Cambiar carpeta de ${whiteboard.name}`}><Folder className="h-3.5 w-3.5" /><span className="truncate">{whiteboard.folder_name || 'Sin carpeta'}</span></button>}
        {workLocationHref && <a href={workLocationHref} aria-label={workLocationAriaLabel} aria-disabled={busy} onClick={event => { if (busy) event.preventDefault() }} className={`hidden min-h-9 items-center gap-1.5 rounded-xl border border-violet-100 bg-violet-50 px-3 text-xs font-bold text-violet-700 hover:bg-violet-100 lg:flex ${busy ? 'pointer-events-none opacity-40' : ''}`}><BriefcaseBusiness className="h-3.5 w-3.5" />Abrir ubicación</a>}
        <WhiteboardActionsMenu whiteboard={whiteboard} busy={busy} canMove={canMove} canConfigure={canConfigure} canDuplicate={canDuplicate} canManage={canManage} canPurge={canPurge} purgeReady={purgeReady} purgeEligibleAt={purgeEligibleAt} onAction={onMenuAction} />
        <button type="button" onClick={onOpen} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-white hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label={`Abrir ${whiteboard.name}`}>
          <ArrowRight className="h-4 w-4" />
        </button>
      </article>
    )
  }

  if (view === 'compact') {
    return <article ref={drag.setNodeRef} data-whiteboard-id={whiteboard.id} style={articleStyle} className="group flex min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition-[opacity,transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-emerald-200 hover:shadow-md motion-reduce:transform-none motion-reduce:transition-none">
      <button type="button" onClick={onOpen} className="relative flex w-[38%] min-w-[104px] max-w-[152px] shrink-0 items-center justify-center overflow-hidden border-r border-slate-100 bg-slate-50 text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500" aria-label={`Abrir ${whiteboard.name}`}>
        {whiteboard.thumbnail_url ? <img src={whiteboard.thumbnail_url} alt="" className="absolute inset-0 h-full w-full object-cover" /> : <Network className="h-7 w-7" />}
        {isWork && <span className="absolute right-2 top-2 rounded-full border border-violet-100 bg-white/95 px-2 py-1 text-[9px] font-bold text-violet-700 shadow-sm">Clarin Work</span>}
      </button>
      <div className="flex min-w-0 flex-1 flex-col p-3">
        <div className="flex min-w-0 items-start gap-1">
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
            <span className="line-clamp-2 text-sm font-black leading-5 text-slate-800">{whiteboard.name}</span>
          </button>
          {dragHandle}
          <WhiteboardActionsMenu whiteboard={whiteboard} busy={busy} canMove={canMove} canConfigure={canConfigure} canDuplicate={canDuplicate} canManage={canManage} canPurge={canPurge} purgeReady={purgeReady} purgeEligibleAt={purgeEligibleAt} onAction={onMenuAction} />
        </div>
        <p className="mt-1 truncate text-[11px] text-slate-400">{isWork && !archived ? workBreadcrumb : archived ? purgeEligibilityLabel(purgeEligibleAt) : `${formatWhiteboardUpdatedAt(whiteboard.updated_at)} · ${whiteboard.updated_by_name || whiteboard.owner_name || 'Cuenta'}`}</p>
        <div className="mt-auto flex min-w-0 items-center gap-2 pt-2">
          {workLocationHref ? <a href={workLocationHref} aria-label={workLocationAriaLabel} aria-disabled={busy} onClick={event => { if (busy) event.preventDefault() }} className={`flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-xl bg-violet-50 px-2.5 text-left text-xs font-bold text-violet-700 hover:bg-violet-100 ${busy ? 'pointer-events-none opacity-40' : ''}`}><BriefcaseBusiness className="h-3.5 w-3.5 shrink-0" /><span className="truncate">Abrir ubicación en Work</span></a> : isWork ? <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400">Ubicación original · {workBreadcrumb}</span> : !archived && canMove ? <button type="button" disabled={busy} onClick={onMove} className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded-xl bg-slate-50 px-2.5 text-left text-xs font-bold text-slate-600 hover:bg-emerald-50 hover:text-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40" aria-label={`Cambiar carpeta de ${whiteboard.name}. Carpeta actual: ${whiteboard.folder_name || 'Sin carpeta'}`}><Folder className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{whiteboard.folder_name || 'Sin carpeta'}</span></button> : <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400">{whiteboard.folder_name || 'Sin carpeta'}</span>}
          {whiteboard.shared && <span className="shrink-0 rounded-full bg-sky-50 px-2 py-1 text-[10px] font-bold text-sky-700">Compartida</span>}
        </div>
      </div>
    </article>
  }

  return (
    <article ref={drag.setNodeRef} data-whiteboard-id={whiteboard.id} style={articleStyle} className="group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-emerald-200 hover:shadow-lg motion-reduce:transform-none motion-reduce:transition-none">
      <button type="button" onClick={onOpen} className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden border-b border-slate-100 bg-slate-50 text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500">
        {whiteboard.thumbnail_url
          ? <img src={whiteboard.thumbnail_url} alt="" className="h-full w-full object-cover" />
          : <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-100 bg-white shadow-sm"><Network className="h-7 w-7" /></span>}
        {isWork ? <span className="absolute right-2 top-2 rounded-full border border-violet-100 bg-white/95 px-2 py-1 text-[10px] font-bold text-violet-700 shadow-sm">Clarin Work</span> : whiteboard.shared && <span className="absolute right-2 top-2 rounded-full border border-sky-100 bg-white/95 px-2 py-1 text-[10px] font-bold text-sky-700 shadow-sm">Compartida</span>}
      </button>
      <div className="p-3">
        <div className="flex min-w-0 items-start gap-2">
          {dragHandle}
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
            <span className="block truncate text-sm font-black text-slate-800">{whiteboard.name}</span>
            <span className="mt-1 block truncate text-[11px] text-slate-400">{isWork && !archived ? workBreadcrumb : archived ? purgeEligibilityLabel(purgeEligibleAt) : formatWhiteboardUpdatedAt(whiteboard.updated_at)}</span>
          </button>
          <WhiteboardActionsMenu whiteboard={whiteboard} busy={busy} canMove={canMove} canConfigure={canConfigure} canDuplicate={canDuplicate} canManage={canManage} canPurge={canPurge} purgeReady={purgeReady} purgeEligibleAt={purgeEligibleAt} onAction={onMenuAction} />
        </div>
        {workLocationHref ? <a href={workLocationHref} aria-label={workLocationAriaLabel} aria-disabled={busy} onClick={event => { if (busy) event.preventDefault() }} className={`mt-2 flex min-h-9 w-full items-center gap-2 rounded-xl bg-violet-50 px-3 text-left text-xs font-bold text-violet-700 hover:bg-violet-100 ${busy ? 'pointer-events-none opacity-40' : ''}`}><BriefcaseBusiness className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">Abrir ubicación en Work</span><ArrowRight className="h-3.5 w-3.5 shrink-0 text-violet-300" /></a> : isWork ? <p className="mt-2 truncate rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-500">Ubicación original · {workBreadcrumb}</p> : !archived && canMove && <button type="button" disabled={busy} onClick={onMove} className="mt-2 flex min-h-9 w-full items-center gap-2 rounded-xl bg-slate-50 px-3 text-left text-xs font-bold text-slate-600 hover:bg-emerald-50 hover:text-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40" aria-label={`Cambiar carpeta de ${whiteboard.name}. Carpeta actual: ${whiteboard.folder_name || 'Sin carpeta'}`}><Folder className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">{whiteboard.folder_name || 'Sin carpeta'}</span><ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-300" /></button>}
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
  const canonicalFolderAbortRef = useRef<AbortController | null>(null)
  const canonicalRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const canonicalRefreshAuthoritySensitiveRef = useRef(false)
  const indexReadyRef = useRef(false)
  const mountedRef = useRef(false)
  const navigationWasOpenRef = useRef(false)
  const [containerWidth, setContainerWidth] = useState(1280)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [showArchivedFolders, setShowArchivedFolders] = useState(false)
  const [scope, setScope] = useState<WhiteboardScope>('mine')
  const [folderID, setFolderID] = useState<string | null>(null)
  const [folders, setFolders] = useState<WhiteboardFolderModel[]>([])
  const [whiteboards, setWhiteboards] = useState<WhiteboardSummary[]>([])
  const [rawSearch, setRawSearch] = useState('')
  const [settledSearch, setSettledSearch] = useDebouncedValue(rawSearch, SEARCH_DEBOUNCE_MS)
  const [view, setView] = useState<WhiteboardViewMode>('compact')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [counts, setCounts] = useState<Partial<Record<WhiteboardScope, number>>>({})
  const [capabilities, setCapabilities] = useState({ can_create: false, can_create_folder: false })
  const [workWhiteboardsEnabled, setWorkWhiteboardsEnabled] = useState(false)
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [draftName, setDraftName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [busyID, setBusyID] = useState<string | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<WhiteboardSummary | null>(null)
  const [moveTarget, setMoveTarget] = useState<WhiteboardSummary | null>(null)
  const [moveFolderID, setMoveFolderID] = useState('')
  const [moveRawSearch, setMoveRawSearch] = useState('')
  const [moveSettledSearch, setMoveSettledSearch] = useDebouncedValue(moveRawSearch, SEARCH_DEBOUNCE_MS)
  const [activeDrag, setActiveDrag] = useState<WhiteboardSummary | null>(null)
  const [activeFolderDrag, setActiveFolderDrag] = useState<WhiteboardFolderModel | null>(null)
  const [dragSourceWidth, setDragSourceWidth] = useState<number | undefined>()
  const [overDestination, setOverDestination] = useState<WhiteboardFolderDestination | null>(null)
  const [overFolderDestination, setOverFolderDestination] = useState<WhiteboardFolderStructuralDestination | null>(null)
  const [dragAnnouncement, setDragAnnouncement] = useState('')
  const [folderArchiveTarget, setFolderArchiveTarget] = useState<WhiteboardFolderModel | null>(null)
  const [folderBusyID, setFolderBusyID] = useState<string | null>(null)
  const [purgeTarget, setPurgeTarget] = useState<WhiteboardSummary | null>(null)
  const [purgeConfirmation, setPurgeConfirmation] = useState('')
  const [trashPolicy, setTrashPolicy] = useState<WhiteboardTrashPolicy | null>(null)
  const [retentionDraft, setRetentionDraft] = useState('30')
  const [policySaving, setPolicySaving] = useState(false)
  const [purgeEligibilityOverrides, setPurgeEligibilityOverrides] = useState<Record<string, string>>({})
  const [settingsTarget, setSettingsTarget] = useState<WhiteboardSettingsTarget | null>(null)
  const [shareTarget, setShareTarget] = useState<WhiteboardSummary | null>(null)
  const createNameInputRef = useRef<HTMLInputElement>(null)
  const whiteboardsRef = useRef(whiteboards)
  const indexQueryRef = useRef({ scope, folderID, settledSearch, nextCursor })
  whiteboardsRef.current = whiteboards
  indexQueryRef.current = { scope, folderID, settledSearch, nextCursor }

  const dragSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 520, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: whiteboardFolderKeyboardCoordinates }),
  )

  const layout = whiteboardManagerLayout(containerWidth - (settingsTarget && containerWidth >= 760 ? 400 : 0))
  const searchPending = rawSearch !== settledSearch
  const moveSearchPending = moveRawSearch !== moveSettledSearch
  const activeFolders = useMemo(() => activeWhiteboardFolders(folders), [folders])
  const archivedFolders = useMemo(() => archivedWhiteboardFolders(folders), [folders])
  const selectedFolder = activeFolders.find(folder => folder.id === folderID) || null
  const folderRows = useMemo(() => flattenWhiteboardFolders(activeFolders), [activeFolders])
  const moveDestinationOptions = useMemo(
    () => whiteboardMoveDestinationOptions(activeFolders, moveSettledSearch),
    [activeFolders, moveSettledSearch],
  )
  const visibleWhiteboards = useMemo(() => filterWhiteboards(whiteboards, settledSearch), [settledSearch, whiteboards])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    try {
      setView(parseWhiteboardViewMode(window.localStorage.getItem(WHITEBOARD_MANAGER_VIEW_STORAGE_KEY)))
    } catch {
      setView('compact')
    }
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

  const loadIndex = useCallback(async (append = false, authoritySensitive = false) => {
    const query = { ...indexQueryRef.current }
    const queryFingerprint = `${query.scope}\u0000${query.folderID || ''}\u0000${query.settledSearch}`
    if (!append) {
      listAbortRef.current?.abort()
      listAbortRef.current = new AbortController()
    } else if (!listAbortRef.current) {
      listAbortRef.current = new AbortController()
    }
    const generation = ++listGenerationRef.current
    if (append) setLoadingMore(true)
    else if (whiteboardsRef.current.length) setRefreshing(true)
    else setPhase('loading')
    setError(null)
    const response = await listWhiteboards({
      scope: query.scope,
      folderID: query.folderID,
      search: query.settledSearch,
      cursor: append ? query.nextCursor : null,
      signal: listAbortRef.current?.signal,
    })
    const currentQuery = indexQueryRef.current
    const currentFingerprint = `${currentQuery.scope}\u0000${currentQuery.folderID || ''}\u0000${currentQuery.settledSearch}`
    if (!mountedRef.current || generation !== listGenerationRef.current || queryFingerprint !== currentFingerprint) return 'stale' as const
    setLoadingMore(false)
    setRefreshing(false)
    if (!response.success) {
      if (response.error === 'Solicitud cancelada') return 'stale' as const
      indexReadyRef.current = true
      const failClosed = authoritySensitive && (response.status === 401 || response.status === 403 || response.status === 404)
      if (failClosed) {
        // Authority revalidation is fail-closed: retaining the previous cards,
        // breadcrumbs or counters would leak a snapshot after revocation.
        setWhiteboards([])
        setFolders([])
        setCounts({})
        setNextCursor(null)
        setCapabilities({ can_create: false, can_create_folder: false })
      }
      setError(apiFailureMessage(response.status, response.error))
      if (!whiteboardsRef.current.length || failClosed) setPhase('error')
      return failClosed ? 'forbidden' as const : 'error' as const
    }
    indexReadyRef.current = true
    const workEnabled = response.data?.work_whiteboard_views_enabled === true
    setWorkWhiteboardsEnabled(workEnabled)
    if (!workEnabled && query.scope === 'work') {
      setWhiteboards([])
      setNextCursor(null)
      setCounts(response.data?.counts || {})
      setScope(reconcileWhiteboardScopeCapability(query.scope, workEnabled))
      setFolderID(null)
      setPhase('loading')
      return 'success' as const
    }
    const incoming = response.data?.whiteboards || []
    setWhiteboards(current => append
      ? [...current, ...incoming.filter(board => !current.some(item => item.id === board.id))]
      : incoming)
    setNextCursor(response.data?.next_cursor || null)
    setCounts(response.data?.counts || {})
    setCapabilities(response.data?.permissions || { can_create: false, can_create_folder: false })
    setPhase('ready')
    return 'success' as const
  }, [])

  const refreshCanonicalHubSnapshot = useCallback(async (authoritySensitive = false) => {
    canonicalFolderAbortRef.current?.abort()
    const controller = new AbortController()
    canonicalFolderAbortRef.current = controller
    const [indexOutcome] = await Promise.all([
      loadIndex(false, authoritySensitive),
      loadFolders(controller.signal),
    ])
    // The folder request may have won the race against a module revocation.
    // Clear it again after both requests settle so no protected label can be
    // reintroduced by an earlier in-flight response.
    if (authoritySensitive && indexOutcome === 'forbidden' && mountedRef.current) setFolders([])
  }, [loadFolders, loadIndex])

  const scheduleCanonicalHubRefresh = useCallback((authoritySensitive = false, delay = 80) => {
    canonicalRefreshAuthoritySensitiveRef.current ||= authoritySensitive
    if (canonicalRefreshTimerRef.current) return
    canonicalRefreshTimerRef.current = setTimeout(() => {
      canonicalRefreshTimerRef.current = null
      const sensitive = canonicalRefreshAuthoritySensitiveRef.current
      canonicalRefreshAuthoritySensitiveRef.current = false
      if (!mountedRef.current || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return
      void refreshCanonicalHubSnapshot(sensitive)
    }, delay)
  }, [refreshCanonicalHubSnapshot])

  useEffect(() => {
    const controller = new AbortController()
    void loadFolders(controller.signal)
    return () => controller.abort()
  }, [loadFolders])

  useEffect(() => {
    void loadIndex(false)
    return () => listAbortRef.current?.abort()
  }, [folderID, loadIndex, scope, settledSearch])

  useEffect(() => {
    const applyRedaction = (redaction: Parameters<typeof redactWhiteboardHubSnapshot>[1]) => {
      const redacted = redactWhiteboardHubSnapshot(whiteboardsRef.current, redaction)
      const visibleIDs = new Set(redacted.map(board => board.id))
      whiteboardsRef.current = redacted
      setWhiteboards(redacted)
      setCounts({})
      setArchiveTarget(current => current && visibleIDs.has(current.id) ? current : null)
      setMoveTarget(current => current && visibleIDs.has(current.id) ? current : null)
      setPurgeTarget(current => current && visibleIDs.has(current.id) ? current : null)
      setSettingsTarget(current => current?.kind !== 'board' || visibleIDs.has(current.value.id) ? current : null)
      setShareTarget(current => current && visibleIDs.has(current.id) ? current : null)
      setActiveDrag(null)
      setOverDestination(null)
    }
    const reconcileRealtime = (raw: unknown) => {
      const decision = whiteboardHubRealtimeDecision(raw)
      if (!decision.refresh) return
      if (decision.redaction) applyRedaction(decision.redaction)
      scheduleCanonicalHubRefresh(decision.authoritySensitive)
    }
    const revalidateVisibleSnapshot = () => {
      if (!indexReadyRef.current || document.visibilityState === 'hidden') return
      scheduleCanonicalHubRefresh(true, 0)
    }
    const failClosedUnexpectedDisconnect = () => {
      // A disconnected general socket cannot prove that Work access stayed
      // valid. Standalone cards remain usable, but inherited Work labels and
      // every derived counter disappear until reconnect revalidates them.
      applyRedaction({ kind: 'all_work' })
      setError('Se interrumpió la actualización en tiempo real. Las pizarras de Work se volverán a mostrar cuando Clarin revalide tu acceso.')
    }
    const unsubscribe = subscribeWebSocket(reconcileRealtime, revalidateVisibleSnapshot, failClosedUnexpectedDisconnect)
    window.addEventListener('focus', revalidateVisibleSnapshot)
    document.addEventListener('visibilitychange', revalidateVisibleSnapshot)
    const interval = window.setInterval(revalidateVisibleSnapshot, WHITEBOARD_HUB_REVALIDATION_INTERVAL_MS)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', revalidateVisibleSnapshot)
      document.removeEventListener('visibilitychange', revalidateVisibleSnapshot)
      window.clearInterval(interval)
      if (canonicalRefreshTimerRef.current) {
        clearTimeout(canonicalRefreshTimerRef.current)
        canonicalRefreshTimerRef.current = null
      }
      canonicalFolderAbortRef.current?.abort()
    }
  }, [scheduleCanonicalHubRefresh])

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
  const chooseView = (nextView: WhiteboardViewMode) => {
    setView(nextView)
    try {
      window.localStorage.setItem(WHITEBOARD_MANAGER_VIEW_STORAGE_KEY, nextView)
    } catch {
      // Storage can be blocked by browser policy; the in-memory choice still works.
    }
  }
  const selectScope = (nextScope: WhiteboardScope) => {
    if (busyID) return
    setScope(nextScope)
    setFolderID(null)
    closeNavigation()
  }
  const selectFolder = (nextFolderID: string) => {
    if (busyID) return
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
    if (!response.success) {
      setBusyID(null)
      setError(apiFailureMessage(response.status, response.error))
      return
    }
    setWhiteboards(current => current.filter(board => board.id !== target.id))
    setArchiveTarget(null)
    await refreshCanonicalHubSnapshot(true)
    if (mountedRef.current) setBusyID(null)
  }

  const handleRestore = async (whiteboard: WhiteboardSummary) => {
    if (busyID) return
    setBusyID(whiteboard.id)
    const response = await restoreWhiteboard(whiteboard.id, whiteboard.version)
    if (!response.success) {
      setBusyID(null)
      setError(apiFailureMessage(response.status, response.error))
      return
    }
    setWhiteboards(current => current.filter(board => board.id !== whiteboard.id))
    await refreshCanonicalHubSnapshot(true)
    if (mountedRef.current) setBusyID(null)
  }

  const handleDuplicate = async (whiteboard: WhiteboardSummary) => {
    const contextual = whiteboard.origin === 'work' && Boolean(whiteboard.work_location?.task_view_id)
    if (busyID || (!contextual && !capabilities.can_create) || whiteboard.archived_at) return
    setBusyID(whiteboard.id)
    setError(null)
    if (contextual) {
      const location = await loadTaskLocationView(whiteboard.work_location!.task_view_id)
      if (!location.success || !location.data?.location_view) {
        setBusyID(null)
        setError(apiFailureMessage(location.status, location.error || 'No se pudo resolver la ubicación de Work.'))
        return
      }
      const duplicated = await duplicateTaskLocationView(location.data.location_view, whiteboardDuplicateName(whiteboard.name))
      setBusyID(null)
      if (!duplicated.success || !duplicated.data?.location_view) {
        setError(apiFailureMessage(duplicated.status, duplicated.error || 'No se pudo duplicar la pizarra en Work.'))
        return
      }
      router.push(`/dashboard/tasks?work_view=${encodeURIComponent(duplicated.data.location_view.id)}`)
      return
    }
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
    if (whiteboard.origin === 'work') {
      setError('La ubicación de esta pizarra se administra desde Clarin Work y no puede cambiarse a una carpeta de Pizarras.')
      return
    }
    if (busyID || refreshing || loadingMore || searchPending || whiteboard.archived_at || !whiteboard.effective_access.can_edit) return
    setError(null)
    setMoveTarget(whiteboard)
    setMoveFolderID(whiteboard.folder_id || '')
    setMoveRawSearch('')
    setMoveSettledSearch('')
  }

  const moveWhiteboard = async (candidate: WhiteboardSummary, destination: WhiteboardFolderDestination) => {
    if (busyID) return
    const target = whiteboards.find(item => item.id === candidate.id) || candidate
    if (target.origin === 'work') {
      setError('Las pizarras de Work permanecen vinculadas a su Lista o Carpeta original.')
      return
    }
    if ((target.folder_id || null) === destination.id) {
      setMoveTarget(current => current?.id === target.id ? null : current)
      setDragAnnouncement(`${target.name} ya está en ${destination.name || 'Sin carpeta'}.`)
      return
    }
    if (destination.id && !activeFolders.some(folder => folder.id === destination.id)) {
      setError('La carpeta de destino ya no está disponible. Se actualizó el árbol para que elijas otra.')
      await loadFolders()
      return
    }

    const boardSnapshot = whiteboards
    const folderSnapshot = folders
    const optimistic = optimisticWhiteboardMove(target, destination)
    listAbortRef.current?.abort()
    listGenerationRef.current += 1
    setBusyID(target.id)
    setError(null)
    setDragAnnouncement(`Moviendo ${target.name} a ${destination.name || 'Sin carpeta'}…`)
    setWhiteboards(current => {
      const moved = current.map(item => item.id === target.id ? optimistic : item)
      return folderID && destination.id !== folderID
        ? moved.filter(item => item.id !== target.id)
        : moved
    })
    setFolders(current => optimisticWhiteboardFolderCounts(current, target.folder_id || null, destination.id))
    const response = await updateWhiteboard(target.id, buildWhiteboardMoveInput(target, destination))
    if (!response.success || !response.data?.whiteboard) {
      const failure = apiFailureMessage(response.status, response.error || 'No se pudo mover la pizarra. Se restauró su carpeta anterior.')
      setWhiteboards(boardSnapshot)
      setFolders(folderSnapshot)
      setMoveTarget(current => current?.id === target.id ? null : current)
      await Promise.all([loadIndex(false), loadFolders()])
      if (mountedRef.current) {
        setBusyID(null)
        setError(failure)
        setDragAnnouncement(`No se pudo mover ${target.name}; se restauró su ubicación anterior.`)
      }
      return
    }

    setWhiteboards(current => settleWhiteboardMove(current, target, response.data!.whiteboard, destination, folderID))
    setMoveTarget(current => current?.id === target.id ? null : current)
    await Promise.all([loadIndex(false), loadFolders()])
    if (mountedRef.current) {
      setBusyID(null)
      setDragAnnouncement(`${target.name} se movió a ${destination.name || 'Sin carpeta'}.`)
    }
  }

  const confirmMove = (event: React.FormEvent) => {
    event.preventDefault()
    if (!moveTarget || busyID) return
    const destinationFolder = activeFolders.find(folder => folder.id === moveFolderID) || null
    if (moveFolderID && !destinationFolder) {
      setError('La carpeta de destino ya no está disponible. Se actualizó el árbol para que elijas otra.')
      setMoveFolderID(moveTarget.folder_id || '')
      void loadFolders()
      return
    }
    void moveWhiteboard(moveTarget, { id: destinationFolder?.id || null, name: destinationFolder?.name || null })
  }

  const moveFolder = async (target: WhiteboardFolderModel, destination: WhiteboardFolderStructuralDestination) => {
    let plan
    try {
      plan = buildWhiteboardFolderPlacementPlan(
        target,
        activeFolders,
        destination.parentID,
        destination.beforeFolderID,
      )
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : 'No se puede mover la carpeta a ese destino.')
      return
    }
    if (!plan.changed) {
      setDragAnnouncement(`${target.name} ya ocupa esa posición; no se hizo ningún cambio.`)
      return
    }
    const snapshot = folders
    setFolders(current => optimisticWhiteboardFolderPlacement(
      current,
      target.id,
      destination.parentID,
      destination.beforeFolderID,
    ))
    setFolderBusyID(target.id)
    setError(null)
    const response = await updateWhiteboardFolder(target.id, plan.input)
    setFolderBusyID(null)
    if (!response.success || !response.data?.folder) {
      setFolders(snapshot)
      const failure = apiFailureMessage(response.status, response.error || 'No se pudo mover la carpeta. Se restauró su ubicación anterior.')
      if (response.status === 409) await loadFolders()
      setError(failure)
      setDragAnnouncement(`No se pudo mover ${target.name}; se restauró su ubicación anterior.`)
      return
    }
    const canonicalFolders = response.data.affected_folders?.length
      ? response.data.affected_folders
      : [response.data.folder]
    setFolders(current => settleWhiteboardFolderRelocation(current, canonicalFolders))
    setDragAnnouncement(`${target.name} se movió a ${destination.label}.`)
  }

  const resetDragVisuals = () => {
    setActiveDrag(null)
    setActiveFolderDrag(null)
    setDragSourceWidth(undefined)
    setOverDestination(null)
    setOverFolderDestination(null)
    if (layout === 'narrow') setNavigationOpen(navigationWasOpenRef.current)
  }

  const handleDragStart = (event: DragStartEvent) => {
    const draggedFolderID = whiteboardFolderIDFromDragID(String(event.active.id))
    if (draggedFolderID) {
      const folder = activeFolders.find(item => item.id === draggedFolderID)
      if (!folder || folderBusyID || busyID || refreshing || loadingMore || searchPending || !capabilities.can_create_folder) return
      navigationWasOpenRef.current = navigationOpen
      if (layout === 'narrow') setNavigationOpen(true)
      setActiveFolderDrag(folder)
      setActiveDrag(null)
      setDragSourceWidth(event.active.rect.current.initial?.width)
      setOverDestination(null)
      setOverFolderDestination(null)
      setDragAnnouncement('')
      return
    }
    const boardID = whiteboardIDFromDragID(String(event.active.id))
    const target = whiteboards.find(item => item.id === boardID)
    if (!target || target.origin === 'work' || target.archived_at || !target.effective_access.can_edit || busyID || refreshing || loadingMore || searchPending) return
    navigationWasOpenRef.current = navigationOpen
    if (layout === 'narrow') setNavigationOpen(true)
    setActiveDrag(target)
    setDragSourceWidth(event.active.rect.current.initial?.width)
    setOverDestination(null)
    setDragAnnouncement('')
  }

  const handleDragOver = (event: DragOverEvent) => {
    if (activeFolderDrag || whiteboardFolderIDFromDragID(String(event.active.id))) {
      const destination = event.over
        ? whiteboardFolderStructuralDestinationFromDropID(String(event.over.id), activeFolders)
        : null
      setOverFolderDestination(current => current?.parentID === destination?.parentID && current?.beforeFolderID === destination?.beforeFolderID ? current : destination)
      return
    }
    const destination = event.over
      ? whiteboardDestinationFromDropID(String(event.over.id), activeFolders)
      : null
    setOverDestination(current => current?.id === destination?.id ? current : destination)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const draggedFolderID = whiteboardFolderIDFromDragID(String(event.active.id))
    if (draggedFolderID) {
      const target = activeFolders.find(item => item.id === draggedFolderID) || activeFolderDrag
      const destination = event.over
        ? whiteboardFolderStructuralDestinationFromDropID(String(event.over.id), activeFolders)
        : null
      resetDragVisuals()
      if (target && destination) void moveFolder(target, destination)
      return
    }
    const target = whiteboards.find(item => item.id === whiteboardIDFromDragID(String(event.active.id))) || activeDrag
    const destination = event.over
      ? whiteboardDestinationFromDropID(String(event.over.id), activeFolders)
      : null
    resetDragVisuals()
    if (!target || !destination) return
    if ((target.folder_id || null) === destination.id) {
      return
    }
    void moveWhiteboard(target, destination)
  }

  const handleDragCancel = (_event: DragCancelEvent) => {
    resetDragVisuals()
  }

  const handleWhiteboardMenuAction = (whiteboard: WhiteboardSummary, action: WhiteboardMenuAction) => {
    if (action === 'settings') {
      if (whiteboard.origin === 'work') {
        setError('El acceso y la ubicación de esta pizarra se administran desde Clarin Work.')
        return
      }
      setError(null)
      setSettingsTarget({ kind: 'board', value: whiteboard })
    } else if (action === 'move') openMove(whiteboard)
    else if (action === 'duplicate') void handleDuplicate(whiteboard)
    else if (action === 'archive') setArchiveTarget(whiteboard)
    else if (action === 'restore') void handleRestore(whiteboard)
    else {
      setPurgeTarget(whiteboard)
      setPurgeConfirmation('')
    }
  }

  const saveFolderSettings = async (
    target: WhiteboardFolderModel,
    input: Parameters<typeof updateWhiteboardFolder>[1],
  ) => {
    const snapshot = folders
    const placement = input.placement
    if (placement) {
      setFolders(current => optimisticWhiteboardFolderPlacement(
        current,
        target.id,
        placement.parent_id,
        placement.before_folder_id,
      ).map(folder => folder.id === target.id ? { ...folder, name: input.name, description: input.description || '' } : folder))
    }
    setFolderBusyID(target.id)
    setError(null)
    const response = await updateWhiteboardFolder(target.id, input)
    setFolderBusyID(null)
    if (!response.success || !response.data?.folder) {
      setFolders(snapshot)
      if (response.status === 409) await loadFolders()
      return { success: false, error: apiFailureMessage(response.status, response.error || 'No se pudo guardar la carpeta. Se restauró su estado anterior.') }
    }
    const canonicalFolders = response.data.affected_folders?.length
      ? response.data.affected_folders
      : [response.data.folder]
    setFolders(current => settleWhiteboardFolderRelocation(current, canonicalFolders))
    setWhiteboards(current => current.map(board => board.folder_id === target.id
      ? { ...board, folder_name: response.data!.folder.name }
      : board))
    return { success: true }
  }

  const saveBoardSettings = async (
    target: WhiteboardSummary,
    input: Parameters<typeof updateWhiteboard>[1],
  ) => {
    const boardsSnapshot = whiteboards
    const foldersSnapshot = folders
    const destination = activeFolders.find(folder => folder.id === input.folder_id) || null
    setWhiteboards(current => current.map(board => board.id === target.id ? {
      ...board,
      name: input.name,
      description: input.description || '',
      folder_id: destination?.id || null,
      folder_name: destination?.name || null,
    } : board))
    setFolders(current => optimisticWhiteboardFolderCounts(current, target.folder_id || null, destination?.id || null))
    setBusyID(target.id)
    setError(null)
    const response = await updateWhiteboard(target.id, input)
    setBusyID(null)
    if (!response.success || !response.data?.whiteboard) {
      setWhiteboards(boardsSnapshot)
      setFolders(foldersSnapshot)
      if (response.status === 409) await Promise.all([loadIndex(false), loadFolders()])
      return { success: false, error: apiFailureMessage(response.status, response.error || 'No se pudo guardar la pizarra. Se restauró su configuración anterior.') }
    }
    const canonical = response.data.whiteboard
    setWhiteboards(current => current.map(board => board.id === target.id ? {
      ...board,
      ...canonical,
      folder_name: destination?.name || null,
      owner_name: canonical.owner_name || board.owner_name,
      updated_by_name: canonical.updated_by_name || board.updated_by_name,
    } : board))
    void loadFolders()
    return { success: true }
  }

  const confirmArchiveFolder = async () => {
    if (!folderArchiveTarget || folderBusyID) return
    const target = folderArchiveTarget
    setFolderBusyID(target.id)
    setError(null)
    const response = await archiveWhiteboardFolder(target.id, target.version)
    if (!response.success) {
      setFolderBusyID(null)
      setError(apiFailureMessage(response.status, response.error || 'No se pudo archivar la carpeta.'))
      return
    }
    setFolderArchiveTarget(null)
    if (folderID === target.id) {
      setFolderID(null)
      setScope('mine')
    }
    await refreshCanonicalHubSnapshot(true)
    if (mountedRef.current) setFolderBusyID(null)
  }

  const handleRestoreFolder = async (folder: WhiteboardFolderModel) => {
    if (folderBusyID) return
    setFolderBusyID(folder.id)
    setError(null)
    const response = await restoreWhiteboardFolder(folder.id, folder.version)
    if (!response.success || !response.data?.folder) {
      setFolderBusyID(null)
      setError(apiFailureMessage(response.status, response.error || 'No se pudo restaurar la carpeta.'))
      return
    }
    const canonical = response.data.folder
    setFolders(current => current.map(item => item.id === canonical.id ? canonical : item))
    await refreshCanonicalHubSnapshot(true)
    if (mountedRef.current) setFolderBusyID(null)
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
    if (!response.success) {
      setBusyID(null)
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
    await refreshCanonicalHubSnapshot(true)
    if (mountedRef.current) setBusyID(null)
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

  const visibleScopeItems = workWhiteboardsEnabled ? SCOPE_ITEMS : SCOPE_ITEMS.filter(item => item.id !== 'work')
  const scopeLabel = selectedFolder?.name || visibleScopeItems.find(item => item.id === scope)?.label || 'Pizarras'
  const collectionClassName = view === 'grid'
    ? `grid gap-3 p-3 sm:p-4 ${layout === 'wide' ? 'grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4' : layout === 'compact' ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-2'}`
    : view === 'compact'
      ? 'grid gap-3 p-3 sm:p-4'
      : 'm-3 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm sm:m-4'
  const collectionStyle = view === 'compact'
    ? { gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))' }
    : undefined
  const navigation = (
    <aside className={`flex h-full min-h-0 flex-col border-r border-slate-200 bg-white ${layout === 'compact' ? 'w-[220px]' : 'w-[248px]'}`}>
      <div className="flex h-[58px] shrink-0 items-center gap-3 border-b border-slate-100 px-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white"><Network className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-black text-slate-900">Pizarras Clarin</p><p className="text-[9px] font-bold uppercase tracking-[.14em] text-emerald-600">Espacio visual</p></div>
        {layout === 'narrow' && <button type="button" onClick={closeNavigation} aria-label="Cerrar navegación" className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>}
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-3" aria-label="Vistas y carpetas de Pizarras">
        <div className="space-y-1">
          {visibleScopeItems.map(item => {
            const active = scope === item.id && !folderID
              return <button key={item.id} type="button" disabled={Boolean(busyID)} onClick={() => selectScope(item.id)} aria-current={active ? 'page' : undefined} className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-55 ${active ? 'bg-emerald-50 text-emerald-800' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}>
              <item.icon className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{item.label}</span>{typeof counts[item.id] === 'number' && <span className="text-[10px] tabular-nums text-slate-400">{counts[item.id]}</span>}
            </button>
          })}
        </div>
        <div className="mb-2 mt-5 flex items-center justify-between px-2">
          <p className="text-[10px] font-black uppercase tracking-[.14em] text-slate-400">Carpetas</p>
          <button type="button" onClick={() => openCreate('folder')} disabled={!capabilities.can_create_folder || Boolean(activeDrag || activeFolderDrag) || Boolean(busyID || folderBusyID)} aria-label={folderID ? 'Crear subcarpeta' : 'Crear carpeta'} title={!capabilities.can_create_folder ? 'El backend no concedió permiso para crear carpetas.' : undefined} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-35"><FolderPlus className="h-4 w-4" /></button>
        </div>
        <WhiteboardRootDropTarget active={(overDestination !== null && overDestination.id === null) || Boolean(overFolderDestination && overFolderDestination.parentID === null && overFolderDestination.beforeFolderID === null)} draggingBoard={Boolean(activeDrag)} draggingFolder={Boolean(activeFolderDrag)} />
        {folderRows.length ? <div className="space-y-1">{folderRows.map(({ folder, depth }) => {
          const active = folder.id === folderID
          return <WhiteboardFolderDropTarget key={folder.id} folder={folder} depth={depth} active={active} folders={activeFolders} draggingBoard={Boolean(activeDrag)} draggingFolder={activeFolderDrag} canManage={capabilities.can_create_folder} busy={Boolean(folderBusyID || busyID)} onSelect={() => selectFolder(folder.id)} onSettings={() => { setError(null); setSettingsTarget({ kind: 'folder', value: folder }) }} />
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
    <DndContext
      sensors={busyID || folderBusyID ? [] : dragSensors}
      collisionDetection={whiteboardFolderCollisionDetection}
      autoScroll
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      accessibility={{
        screenReaderInstructions: {
          draggable: 'Para mover una pizarra o carpeta, pulsa Espacio o Enter. Usa las flechas para elegir un destino. Pulsa Espacio o Enter para confirmar, o Escape para cancelar.',
        },
        announcements: {
        onDragStart: ({ active: item }) => {
          const folder = activeFolders.find(candidate => candidate.id === whiteboardFolderIDFromDragID(String(item.id)))
          if (folder) return `Has recogido la carpeta ${folder.name}.`
          const board = whiteboards.find(candidate => candidate.id === whiteboardIDFromDragID(String(item.id)))
          return board ? `Has recogido la pizarra ${board.name}.` : 'Has iniciado el movimiento de una pizarra.'
        },
        onDragOver: ({ over }) => {
          if (activeFolderDrag) {
            const destination = over ? whiteboardFolderStructuralDestinationFromDropID(String(over.id), activeFolders) : null
            return destination ? `Destino ${destination.label}.` : 'Fuera de una posición de destino.'
          }
          const destination = over ? whiteboardDestinationFromDropID(String(over.id), activeFolders) : null
          return destination ? `Destino ${destination.name || 'Sin carpeta'}.` : 'Fuera de una carpeta de destino.'
        },
        onDragEnd: ({ active: item, over }) => {
          const folder = activeFolders.find(candidate => candidate.id === whiteboardFolderIDFromDragID(String(item.id)))
          if (folder) {
            const destination = over ? whiteboardFolderStructuralDestinationFromDropID(String(over.id), activeFolders) : null
            return destination ? `${folder.name} se soltó en ${destination.label}. Guardando el cambio.` : 'Movimiento de carpeta cancelado sin cambios.'
          }
          const board = whiteboards.find(candidate => candidate.id === whiteboardIDFromDragID(String(item.id)))
          const destination = over ? whiteboardDestinationFromDropID(String(over.id), activeFolders) : null
          if (!board || !destination) return 'Movimiento cancelado sin cambios.'
          if ((board.folder_id || null) === destination.id) return `${board.name} ya estaba en ${destination.name || 'Sin carpeta'}; no se hizo ningún cambio.`
          return `${board.name} se soltó en ${destination.name || 'Sin carpeta'}. Guardando el cambio.`
        },
        onDragCancel: () => 'Movimiento cancelado sin cambios.',
      } }}
    >
    <div ref={rootRef} className="relative flex h-full min-h-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <p className="sr-only" aria-live="polite" aria-atomic="true">{dragAnnouncement}</p>
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
            {selectedFolder && capabilities.can_create_folder && <button type="button" onClick={() => { setError(null); setSettingsTarget({ kind: 'folder', value: selectedFolder }) }} disabled={Boolean(folderBusyID || busyID)} aria-label={`Configurar carpeta ${selectedFolder.name}`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-35"><Settings2 className="h-4 w-4" /></button>}
            <button type="button" onClick={() => void loadIndex(false)} disabled={refreshing || Boolean(busyID)} aria-label="Actualizar pizarras" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /></button>
            <button type="button" onClick={() => importInputRef.current?.click()} disabled={scope === 'work' || !capabilities.can_create || submitting || Boolean(busyID)} title={scope === 'work' ? 'Añade pizarras contextuales desde una Lista o Carpeta de Work.' : undefined} className="hidden min-h-11 items-center gap-2 rounded-xl border border-slate-200 px-3 text-sm font-bold text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-35 sm:flex"><FileUp className="h-4 w-4" />Importar</button>
            <input ref={importInputRef} type="file" accept=".excalidraw,.json,application/json" className="hidden" onChange={handleImport} />
            <button type="button" onClick={() => openCreate('board')} disabled={scope === 'work' || !capabilities.can_create || Boolean(busyID)} title={scope === 'work' ? 'Añade una pizarra desde + Vista dentro de Work.' : !capabilities.can_create ? 'El backend no concedió permiso para crear pizarras.' : undefined} className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-3 text-sm font-black text-white shadow-sm hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-35"><Plus className="h-4 w-4" /><span className={layout === 'narrow' ? 'sr-only' : ''}>Nueva pizarra</span></button>
          </div>
          <div className="mt-3 flex min-w-0 items-center gap-2">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Buscar pizarras</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input value={rawSearch} disabled={Boolean(busyID)} onChange={event => { const value = event.target.value; setRawSearch(value); if (!value) setSettledSearch('') }} placeholder="Buscar por nombre, ubicación o propietario…" className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-10 text-sm text-slate-800 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:opacity-55" />
              {searchPending && <Loader2 className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-600" aria-label="Actualizando búsqueda" />}
              {!searchPending && rawSearch && <button type="button" onClick={() => { setRawSearch(''); setSettledSearch('') }} aria-label="Limpiar búsqueda" className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>}
            </label>
            <div className="flex rounded-xl border border-slate-200 bg-white p-1" role="group" aria-label="Vista de pizarras">
              <button type="button" onClick={() => chooseView('grid')} aria-pressed={view === 'grid'} aria-label="Vista de cuadrícula" title="Cuadrícula" className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${view === 'grid' ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'}`}><Grid2X2 className="h-4 w-4" /></button>
              <button type="button" onClick={() => chooseView('compact')} aria-pressed={view === 'compact'} aria-label="Vista compacta" title="Compacta" className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${view === 'compact' ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'}`}><LayoutTemplate className="h-4 w-4" /></button>
              <button type="button" onClick={() => chooseView('list')} aria-pressed={view === 'list'} aria-label="Vista de lista" title="Lista" className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${view === 'list' ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'}`}><List className="h-4 w-4" /></button>
            </div>
          </div>
          {scope === 'trash' && trashPolicy && <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="min-w-0 flex-1"><p className="text-xs font-black text-slate-700">Retención de Papelera</p><p className="mt-0.5 text-[10px] leading-4 text-slate-500">La eliminación definitiva sólo se habilita al cumplir {trashPolicy.retention_days} días desde el archivado.</p></div>
            {trashPolicy.can_manage && <><label className="flex items-center gap-2 text-xs font-bold text-slate-600"><span>Días</span><input type="number" min={7} max={365} value={retentionDraft} onChange={event => setRetentionDraft(event.target.value)} className="h-10 w-24 rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100" /></label><button type="button" onClick={() => void saveTrashPolicy()} disabled={policySaving || retentionDraft === String(trashPolicy.retention_days)} className="flex min-h-10 items-center gap-2 rounded-xl bg-slate-900 px-3 text-xs font-black text-white disabled:opacity-35">{policySaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Guardar política</button></>}
          </div>}
          {error && phase !== 'error' && <div className="mt-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert"><span className="min-w-0 flex-1">{error}</span><button type="button" onClick={() => setError(null)} aria-label="Cerrar error" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-rose-100"><X className="h-4 w-4" /></button></div>}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/60">
          {phase === 'loading' && <div className={collectionClassName} style={collectionStyle} aria-label="Cargando pizarras">{Array.from({ length: 8 }).map((_, index) => <div key={index} className={`${view === 'list' ? 'h-16 border-b last:border-b-0' : view === 'compact' ? 'h-32 rounded-2xl border' : 'aspect-[4/3] rounded-2xl border'} animate-pulse border-slate-200 bg-white`} />)}</div>}
          {phase === 'error' && <div className="flex h-full min-h-80 flex-col items-center justify-center px-6 text-center"><span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-rose-100 bg-white text-rose-600 shadow-sm"><Network className="h-7 w-7" /></span><h2 className="mt-4 text-lg font-black text-slate-900">No se pudieron abrir las Pizarras</h2><p className="mt-2 max-w-md text-sm leading-6 text-slate-500">{error}</p><button type="button" onClick={() => void loadIndex(false)} className="mt-5 flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-bold text-white hover:bg-slate-800"><RefreshCw className="h-4 w-4" />Reintentar</button></div>}
          {phase === 'ready' && visibleWhiteboards.length === 0 && <div className="flex h-full min-h-80 flex-col items-center justify-center px-6 text-center"><span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-400 shadow-sm">{settledSearch ? <Search className="h-7 w-7" /> : scope === 'work' ? <BriefcaseBusiness className="h-7 w-7" /> : selectedFolder ? <FolderOpen className="h-7 w-7" /> : <Network className="h-7 w-7" />}</span><h2 className="mt-4 text-lg font-black text-slate-900">{settledSearch ? 'No hay coincidencias' : scope === 'trash' ? 'La Papelera está vacía' : scope === 'work' ? 'Aún no hay pizarras de Work' : 'Este espacio está vacío'}</h2><p className="mt-2 max-w-md text-sm leading-6 text-slate-500">{settledSearch ? 'Prueba otra búsqueda o limpia el texto.' : scope === 'trash' ? 'Las pizarras que muevas a la Papelera aparecerán aquí y se podrán restaurar.' : scope === 'work' ? 'Añádelas con + Vista dentro de una Lista o Carpeta; aquí aparecerá el mismo documento canónico.' : 'Crea una pizarra para empezar a trabajar visualmente dentro de la cuenta.'}</p>{!settledSearch && scope === 'work' && <button type="button" onClick={() => router.push('/dashboard/tasks')} className="mt-5 flex min-h-11 items-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-black text-white hover:bg-violet-700"><BriefcaseBusiness className="h-4 w-4" />Abrir Clarin Work</button>}{!settledSearch && scope !== 'trash' && scope !== 'work' && <button type="button" disabled={!capabilities.can_create || Boolean(busyID)} onClick={() => openCreate('board')} className="mt-5 flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-black text-white hover:bg-emerald-700 disabled:opacity-35"><Plus className="h-4 w-4" />Nueva pizarra</button>}</div>}
          {phase === 'ready' && visibleWhiteboards.length > 0 && <div className={collectionClassName} style={collectionStyle}>
            {visibleWhiteboards.map(whiteboard => <WhiteboardCard
              key={whiteboard.id}
              whiteboard={whiteboard}
              view={view}
              busy={Boolean(busyID) || refreshing || loadingMore || searchPending}
              onOpen={() => router.push(`/dashboard/whiteboards/${whiteboard.id}`)}
              onMove={() => openMove(whiteboard)}
              onMenuAction={action => handleWhiteboardMenuAction(whiteboard, action)}
              purgeEligibleAt={purgeEligibilityOverrides[whiteboard.id] || whiteboardPurgeEligibleAt(whiteboard.archived_at, trashPolicy?.retention_days || 0)}
              canPurge={Boolean(trashPolicy?.can_manage) && (whiteboard.origin !== 'work' || Boolean(whiteboard.effective_access.can_delete))}
              canDuplicate={whiteboard.origin === 'work' ? Boolean(whiteboard.effective_access.can_delete) : capabilities.can_create}
              canMove={whiteboard.origin !== 'work' && whiteboard.effective_access.can_edit}
              canDrag={whiteboard.origin !== 'work' && whiteboard.effective_access.can_edit && (Boolean(whiteboard.folder_id) || activeFolders.some(folder => folder.id !== whiteboard.folder_id))}
            />)}
          </div>}
          {phase === 'ready' && nextCursor && <div className="flex justify-center px-4 pb-6"><button type="button" onClick={() => void loadIndex(true)} disabled={loadingMore || Boolean(busyID)} className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-600 shadow-sm hover:bg-slate-50 disabled:opacity-50">{loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}Cargar más</button></div>}
        </div>
      </section>

      {settingsTarget && <WhiteboardSettingsPanel
        target={settingsTarget}
        folders={activeFolders}
        layout={layout}
        canCreateBoard={capabilities.can_create}
        canManageFolders={capabilities.can_create_folder}
        onClose={() => setSettingsTarget(null)}
        onSaveFolder={saveFolderSettings}
        onSaveBoard={saveBoardSettings}
        onOpenBoard={board => router.push(`/dashboard/whiteboards/${board.id}`)}
        onShareBoard={board => setShareTarget(board)}
        onDuplicateBoard={board => { setSettingsTarget(null); void handleDuplicate(board) }}
        onArchiveBoard={board => { setSettingsTarget(null); setArchiveTarget(board) }}
        onCreateSubfolder={folder => { setSettingsTarget(null); setFolderID(folder.id); setScope('all'); openCreate('folder') }}
        onArchiveFolder={folder => { setSettingsTarget(null); setFolderArchiveTarget(folder) }}
      />}

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
          <fieldset>
            <legend className="text-xs font-black uppercase tracking-[.12em] text-slate-500">Carpeta de destino</legend>
            <label className="relative mt-2 block">
              <span className="sr-only">Buscar carpeta de destino</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input autoFocus value={moveRawSearch} onChange={event => { const value = event.target.value; setMoveRawSearch(value); if (!value) setMoveSettledSearch('') }} placeholder="Buscar carpeta…" className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-10 text-sm text-slate-800 outline-none focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-100" />
              {moveSearchPending && <Loader2 className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-600" aria-label="Buscando carpetas" />}
              {!moveSearchPending && moveRawSearch && <button type="button" onClick={() => { setMoveRawSearch(''); setMoveSettledSearch('') }} aria-label="Limpiar búsqueda de carpetas" className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>}
            </label>
            <div className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-1" aria-label="Carpetas de destino">
              {moveDestinationOptions.map(option => {
                const value = option.id || ''
                const selected = moveFolderID === value
                const current = (moveTarget.folder_id || '') === value
                const Icon = option.id ? Folder : Home
                return <label key={option.id || 'root'} className={`relative flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 outline-none transition-colors focus-within:ring-2 focus-within:ring-emerald-500 ${selected ? 'bg-white text-emerald-900 shadow-sm ring-1 ring-emerald-200' : 'text-slate-600 hover:bg-white hover:text-slate-900'}`}>
                  <input type="radio" name="whiteboard-folder-destination" value={value} checked={selected} disabled={Boolean(busyID)} onChange={() => { setMoveFolderID(value); setError(null) }} className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" />
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${selected ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}><Icon className="h-4 w-4" /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{option.label}</span><span className="mt-0.5 block truncate text-[10px] text-slate-400">{option.path}</span></span>
                  {current && <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[9px] font-black uppercase tracking-wide text-slate-500">Actual</span>}
                  {selected && <Check className="h-4 w-4 shrink-0 text-emerald-600" />}
                </label>
              })}
              {!moveDestinationOptions.length && <div className="px-3 py-6 text-center"><Search className="mx-auto h-5 w-5 text-slate-300" /><p className="mt-2 text-xs font-bold text-slate-500">No hay carpetas que coincidan</p><button type="button" onClick={() => { setMoveRawSearch(''); setMoveSettledSearch('') }} className="mt-2 min-h-9 rounded-xl px-3 text-xs font-black text-emerald-700 hover:bg-emerald-50">Limpiar búsqueda</button></div>}
            </div>
          </fieldset>
          {activeFolders.length === 0 && <div className="mt-3 flex items-center gap-3 rounded-2xl border border-emerald-100 bg-emerald-50/70 p-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-emerald-700"><FolderPlus className="h-4 w-4" /></span><p className="min-w-0 flex-1 text-xs leading-5 text-emerald-900">Aún no hay carpetas. Puedes dejarla en <strong>Sin carpeta</strong> o crear la primera.</p>{capabilities.can_create_folder && <button type="button" disabled={Boolean(busyID)} onClick={() => { setMoveTarget(null); openCreate('folder') }} className="min-h-10 shrink-0 rounded-xl bg-white px-3 text-xs font-black text-emerald-800 shadow-sm hover:bg-emerald-100">Crear carpeta</button>}</div>}
          {error && <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{error}</p>}
          <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={Boolean(busyID)} onClick={() => setMoveTarget(null)} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">Cancelar</button><button type="submit" disabled={Boolean(busyID) || (moveTarget.folder_id || '') === moveFolderID} className="flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-black text-white hover:bg-emerald-700 disabled:opacity-35">{busyID ? <Loader2 className="h-4 w-4 animate-spin" /> : <Move className="h-4 w-4" />}Mover</button></div>
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
      {shareTarget && <WhiteboardShareDialog boardID={shareTarget.id} onClose={() => setShareTarget(null)} />}
    </div>
    {typeof document !== 'undefined' && createPortal(<DragOverlay dropAnimation={{ duration: 180, easing: 'ease-out' }} style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.dragOverlay }}>
      {activeDrag || activeFolderDrag ? <OperationalDragOverlay
        label={(activeDrag || activeFolderDrag)!.name}
        count={1}
        singular={activeFolderDrag ? 'carpeta' : 'pizarra'}
        plural={activeFolderDrag ? 'carpetas' : 'pizarras'}
        destination={activeFolderDrag ? overFolderDestination?.label : overDestination ? overDestination.name || 'Sin carpeta' : undefined}
        sourceWidth={dragSourceWidth}
        idleLabel={activeFolderDrag ? 'Suelta dentro de una carpeta, antes de otra o en el nivel principal' : 'Suelta sobre una carpeta o Sin carpeta'}
        ariaLabel={`${activeFolderDrag ? 'Carpeta' : 'Pizarra'} ${(activeDrag || activeFolderDrag)!.name} seleccionada para mover`}
      /> : null}
    </DragOverlay>, document.body)}
    </DndContext>
  )
}
