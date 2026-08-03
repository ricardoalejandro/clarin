'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  closestCenter, DndContext, DragCancelEvent, DragEndEvent, DragOverlay, DragOverEvent,
  DragStartEvent, KeyboardSensor, MeasuringStrategy, PointerSensor, TouchSensor,
  pointerWithin, rectIntersection, useDroppable, useSensor, useSensors,
  type CollisionDetection,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AlertCircle, Check, ChevronRight, FolderOpen, GripVertical, Info, Loader2, LockKeyhole, MoreHorizontal, RotateCcw, Undo2 } from 'lucide-react'
import { apiPut } from '@/lib/api'
import type { TaskFolder, TaskList } from '@/types/task'
import { TaskAppearanceDialog, TaskContainerIcon } from './TaskContainerAppearance'
import { ensureExpandedFolder, folderAutoExpandedForScope, normalizeExpandedFolders, toggleExpandedFolder } from './taskWorkspaceState'
import type { TaskExternalDropTarget } from './taskDropTargets'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import { hierarchyCountTooltip, hierarchyItemOpenCount } from './taskHierarchyCounts'
import type { TaskFolderChildrenState, TaskHierarchyLoadPhase } from './taskHierarchyLazy'
import type { TaskAccountUser } from './TaskEditorModal'

type HierarchyScope = { type: 'all' | 'shared' | 'trash' } | { type: 'environment' | 'folder' | 'list'; id: string }
type ContainerID = `container:${string}` | 'root'
type OrderedLists = Record<string, TaskList[]>
type AppearanceTarget = { type: 'list'; item: TaskList } | { type: 'folder'; item: TaskFolder }

interface Props {
  folders: TaskFolder[]
  rootLists: TaskList[]
  scope: HierarchyScope
  collapsed: boolean
  onSelect: (scope: HierarchyScope) => void
  onChanged: () => Promise<void> | void
  onError: (message: string) => void
  onOperation?: (operationID: string, active: boolean) => void
  taskDropTarget?: TaskExternalDropTarget | null
  taskDragActive?: boolean
  hierarchyPhase?: TaskHierarchyLoadPhase
  hierarchyError?: string
  hasMoreFolders?: boolean
  hasMoreRootLists?: boolean
  loadingMoreFolders?: boolean
  loadingMoreRootLists?: boolean
  folderChildrenState?: Record<string, TaskFolderChildrenState>
  onRetryHierarchy?: () => void
  onLoadMoreFolders?: () => void
  onLoadMoreRootLists?: () => void
  onExpandFolder?: (folderID: string) => void
  onRetryFolderLists?: (folderID: string) => void
  onLoadMoreFolderLists?: (folderID: string) => void
  users?: TaskAccountUser[]
}

interface PendingMove {
  list: TaskList
  containerID: ContainerID
  beforeListID?: string
  snapshot: OrderedLists
}

const containerFor = (folderID?: string): ContainerID => folderID ? `container:${folderID}` : 'root'
const folderIDFromContainer = (containerID: ContainerID) => containerID === 'root' ? null : containerID.slice('container:'.length)
const listItemID = (id: string) => `list:${id}`
const folderItemID = (id: string) => `folder:${id}`
const listIDFromItem = (id: string) => id.startsWith('list:') ? id.slice(5) : ''
const folderIDFromItem = (id: string) => id.startsWith('folder:') ? id.slice(7) : ''
export const taskHierarchyCanReceiveTasks = (item: TaskList | TaskFolder) => item.permissions?.can_edit === true
export const taskHierarchyCanManageStructure = (item: TaskList | TaskFolder) => item.permissions?.can_delete === true

function buildOrderedLists(folders: TaskFolder[], rootLists: TaskList[]): OrderedLists {
  return Object.fromEntries([
    ['root', rootLists.filter(item => !item.is_default).sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))],
    ...folders.map(folder => [containerFor(folder.id), [...folder.lists].filter(item => !item.is_default).sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))]),
  ])
}

function sameOrder(left: OrderedLists, right: OrderedLists) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return Array.from(keys).every(key => {
    const a = (left[key] || []).map(item => item.id)
    const b = (right[key] || []).map(item => item.id)
    return a.length === b.length && a.every((id, index) => id === b[index])
  })
}

function findContainer(ordered: OrderedLists, listID: string) {
  return Object.keys(ordered).find(key => ordered[key].some(item => item.id === listID)) as ContainerID | undefined
}

function movePreview(ordered: OrderedLists, listID: string, destination: ContainerID, beforeListID?: string) {
  const source = findContainer(ordered, listID)
  if (!source) return ordered
  const moving = ordered[source].find(item => item.id === listID)
  if (!moving) return ordered
  const next: OrderedLists = { ...ordered, [source]: ordered[source].filter(item => item.id !== listID) }
  const destinationItems = source === destination ? next[source] : [...(ordered[destination] || [])]
  const targetIndex = beforeListID ? destinationItems.findIndex(item => item.id === beforeListID) : -1
  const insertAt = targetIndex >= 0 ? targetIndex : destinationItems.length
  next[destination] = [...destinationItems.slice(0, insertAt), moving, ...destinationItems.slice(insertAt)]
  return sameOrder(ordered, next) ? ordered : next
}

function SortableListRow({ list, containerID, active, selected, taskDropActive, onSelect, onEdit }: {
  list: TaskList; containerID: ContainerID; active: boolean; selected: boolean; taskDropActive: boolean; onSelect: () => void; onEdit: () => void
}) {
  const canManage = taskHierarchyCanManageStructure(list)
  const canReceiveTasks = taskHierarchyCanReceiveTasks(list)
  const sortable = useSortable({ id: listItemID(list.id), disabled: !canManage, data: { type: 'list', listID: list.id, containerID, canManage } })
  const dropActive = canReceiveTasks && taskDropActive
  return <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} data-task-hierarchy-list={list.id} data-task-drop-list={canReceiveTasks ? list.id : undefined} data-task-drop-label={canReceiveTasks ? list.name : undefined} data-task-drop-color={canReceiveTasks ? list.color : undefined}>
    <div data-task-drop-highlight={dropActive || undefined} className={`group relative flex items-center rounded-lg transition-all duration-150 ${active ? 'opacity-30' : ''} ${dropActive ? 'z-10 scale-[1.02] bg-emerald-50 text-emerald-800 shadow-[0_8px_22px_rgba(16,185,129,0.18)] ring-2 ring-emerald-400' : selected ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50'}`}>
    <button type="button" onClick={onSelect} title={hierarchyCountTooltip(list)} className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-xs ${selected ? 'font-semibold' : ''}`}><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md" style={{ color: list.color, backgroundColor: `${list.color}16` }}><TaskContainerIcon value={list.icon} className="h-3 w-3" /></span><span className="min-w-0 flex-1 truncate">{list.name}</span><span aria-label={`${list.open_task_count || 0} tareas abiertas`} className="text-[9px] text-slate-400">{list.open_task_count || 0}</span></button>
    {dropActive && <span className="pointer-events-none absolute right-1 top-full z-20 mt-1 whitespace-nowrap rounded-full bg-emerald-700 px-2 py-1 text-[9px] font-black text-white shadow-lg">Soltar en {list.name}</span>}
    {canManage && <button type="button" onClick={onEdit} aria-label={`Personalizar ${list.name}`} title="Personalizar lista" className="flex h-7 w-7 items-center justify-center rounded-md text-slate-300 opacity-0 hover:bg-white hover:text-slate-600 focus:opacity-100 group-hover:opacity-100"><MoreHorizontal className="h-3.5 w-3.5" /></button>}
    {canManage && <button type="button" ref={sortable.setActivatorNodeRef} {...sortable.attributes} {...sortable.listeners} aria-label={`Mover ${list.name}`} title={`Arrastrar ${list.name}`} className="mr-0.5 flex h-7 w-7 cursor-grab items-center justify-center rounded-md text-slate-300 opacity-0 hover:bg-white hover:text-slate-600 focus:opacity-100 active:cursor-grabbing group-hover:opacity-100"><GripVertical className="h-3.5 w-3.5" /></button>}
    </div>
  </div>
}

function DefaultListRow({ list, selected, taskDropActive, onSelect, onEdit }: { list: TaskList; selected: boolean; taskDropActive: boolean; onSelect: () => void; onEdit: () => void }) {
  const canManage = taskHierarchyCanManageStructure(list)
  const canReceiveTasks = taskHierarchyCanReceiveTasks(list)
  const dropActive = canReceiveTasks && taskDropActive
  return <div data-task-default-list data-task-drop-list={canReceiveTasks ? list.id : undefined} data-task-drop-label={canReceiveTasks ? list.name : undefined} data-task-drop-color={canReceiveTasks ? list.color : undefined} data-task-drop-highlight={dropActive || undefined} className={`group relative flex items-center rounded-xl transition-all duration-150 ${dropActive ? 'z-10 scale-[1.02] bg-emerald-50 text-emerald-800 shadow-[0_8px_22px_rgba(16,185,129,0.18)] ring-2 ring-emerald-400' : selected ? 'bg-emerald-50 text-emerald-700' : 'text-slate-600 hover:bg-slate-50'}`}><button type="button" onClick={onSelect} title={hierarchyCountTooltip(list)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-xs font-semibold"><span className="flex h-6 w-6 items-center justify-center rounded-lg" style={{ color: list.color, backgroundColor: `${list.color}16` }}><TaskContainerIcon value={list.icon || 'inbox'} className="h-3.5 w-3.5" /></span><span className="min-w-0 flex-1 truncate">{list.name}</span><span aria-label={`${list.open_task_count || 0} tareas abiertas`} className="text-[9px] text-slate-400">{list.open_task_count || 0}</span></button>{dropActive && <span className="pointer-events-none absolute right-1 top-full z-20 mt-1 whitespace-nowrap rounded-full bg-emerald-700 px-2 py-1 text-[9px] font-black text-white shadow-lg">Soltar en {list.name}</span>}{canManage && <button type="button" onClick={onEdit} aria-label={`Personalizar ${list.name}`} className="flex h-7 w-7 items-center justify-center rounded-md text-slate-300 opacity-0 hover:bg-white hover:text-slate-600 focus:opacity-100 group-hover:opacity-100"><MoreHorizontal className="h-3.5 w-3.5" /></button>}<span title="La Bandeja general permanece fija en la raíz" className="mr-1 flex h-7 w-7 items-center justify-center text-slate-300"><LockKeyhole className="h-3 w-3" /></span></div>
}

function ListDropContainer({ id, active, children, label, disabled = false }: { id: ContainerID; active: boolean; children: React.ReactNode; label: string; disabled?: boolean }) {
  const droppable = useDroppable({ id, disabled, data: { type: 'container', containerID: id, canManage: !disabled } })
  return <div ref={droppable.setNodeRef} data-task-hierarchy-container={id} aria-label={label} className={`rounded-xl transition-all duration-200 ${active || droppable.isOver ? 'bg-emerald-50/80 ring-2 ring-inset ring-emerald-300' : ''}`}>{children}</div>
}

function ListGroup({ items, containerID, activeListID, scope, taskDropTarget, onSelect, onEdit, highlighted }: {
  items: TaskList[]; containerID: ContainerID; activeListID: string; scope: HierarchyScope; taskDropTarget?: TaskExternalDropTarget | null; onSelect: Props['onSelect']; onEdit: (list: TaskList) => void; highlighted: boolean
}) {
  return <SortableContext items={items.map(item => listItemID(item.id))} strategy={verticalListSortingStrategy}><div>{highlighted && <div data-task-hierarchy-placeholder className="mb-1 flex h-8 animate-pulse items-center justify-center rounded-lg border border-dashed border-emerald-300 bg-emerald-50 text-[10px] font-semibold text-emerald-600">Soltar aquí</div>}{items.map(list => <SortableListRow key={list.id} list={list} containerID={containerID} active={activeListID === list.id} selected={scope.type === 'list' && scope.id === list.id} taskDropActive={taskDropTarget?.type === 'list' && taskDropTarget.id === list.id} onSelect={() => onSelect({ type: 'list', id: list.id })} onEdit={() => onEdit(list)} />)}</div></SortableContext>
}

function SortableFolderBlock({ folder, items, activeFolderID, activeListID, highlighted, taskDropTarget, expanded, scope, childrenState, onSelect, onToggle, onRetryChildren, onLoadMoreChildren, onEditFolder, onEditList }: {
  folder: TaskFolder; items: TaskList[]; activeFolderID: string; activeListID: string; highlighted: boolean; taskDropTarget?: TaskExternalDropTarget | null; expanded: boolean; scope: HierarchyScope; childrenState?: TaskFolderChildrenState; onSelect: Props['onSelect']; onToggle: () => void; onRetryChildren: () => void; onLoadMoreChildren: () => void; onEditFolder: () => void; onEditList: (list: TaskList) => void
}) {
  const canManage = taskHierarchyCanManageStructure(folder)
  const canReceiveTasks = taskHierarchyCanReceiveTasks(folder)
  const sortable = useSortable({ id: folderItemID(folder.id), disabled: !canManage, data: { type: 'folder', folderID: folder.id, canManage } })
  const containerID = containerFor(folder.id)
  const selected = scope.type === 'folder' && scope.id === folder.id
  const taskDropActive = canReceiveTasks && taskDropTarget?.type === 'folder' && taskDropTarget.id === folder.id
  return <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} data-task-drop-folder={canReceiveTasks ? folder.id : undefined} data-task-drop-label={canReceiveTasks ? folder.name : undefined} data-task-drop-color={canReceiveTasks ? folder.color : undefined} className={activeFolderID === folder.id ? 'opacity-30' : ''}>
    <ListDropContainer id={containerID} active={canManage && highlighted} label={`Carpeta ${folder.name}`} disabled={!canManage}>
      <div data-task-drop-highlight={taskDropActive || undefined} className={`group relative flex items-center rounded-xl transition-all duration-150 ${taskDropActive ? 'z-10 scale-[1.02] bg-emerald-50 shadow-[0_8px_22px_rgba(16,185,129,0.18)] ring-2 ring-emerald-400' : ''}`}><button type="button" onClick={onToggle} aria-label={`${expanded ? 'Contraer' : 'Expandir'} ${folder.name}`} aria-expanded={expanded} className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"><ChevronRight className={`h-3.5 w-3.5 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} /></button><button type="button" onClick={() => onSelect({ type: 'folder', id: folder.id })} title={hierarchyCountTooltip(folder)} className={`flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1 py-2 text-sm font-medium ${taskDropActive ? 'text-emerald-800' : selected ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-50'}`}><span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ color: folder.color, backgroundColor: `${folder.color}16` }}>{taskDropActive || (canManage && highlighted) || expanded ? <FolderOpen className="h-4 w-4" /> : <TaskContainerIcon value={folder.icon} className="h-4 w-4" />}</span><span className="min-w-0 flex-1 truncate text-left">{folder.name}</span><span aria-label={`${folder.open_task_count || 0} tareas abiertas`} className="text-[10px] text-slate-400">{folder.open_task_count || 0}</span></button>{taskDropActive && <span className="pointer-events-none absolute right-1 top-full z-20 mt-1 whitespace-nowrap rounded-full bg-emerald-700 px-2 py-1 text-[9px] font-black text-white shadow-lg">Suelta para elegir una lista</span>}{canManage && <button type="button" onClick={onEditFolder} aria-label={`Personalizar ${folder.name}`} className="flex h-7 w-7 items-center justify-center rounded-md text-slate-300 opacity-0 hover:bg-white hover:text-slate-600 focus:opacity-100 group-hover:opacity-100"><MoreHorizontal className="h-3.5 w-3.5" /></button>}{canManage && <button type="button" ref={sortable.setActivatorNodeRef} {...sortable.attributes} {...sortable.listeners} aria-label={`Mover carpeta ${folder.name}`} className="mr-1 flex h-7 w-7 cursor-grab items-center justify-center rounded-md text-slate-300 opacity-0 hover:bg-white hover:text-slate-600 focus:opacity-100 active:cursor-grabbing group-hover:opacity-100"><GripVertical className="h-3.5 w-3.5" /></button>}</div>
      <div aria-hidden={!expanded && !highlighted} className={`grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out ${expanded || highlighted ? 'visible grid-rows-[1fr] opacity-100' : 'invisible grid-rows-[0fr] opacity-0'}`}><div className="min-h-0 overflow-hidden"><div className={`ml-5 border-l pl-2 transition ${highlighted ? 'border-emerald-300' : 'border-slate-200'} ${highlighted && !items.length ? 'min-h-9 py-1' : ''}`}>
        {childrenState?.phase === 'loading' && !items.length && <div role="status" className="flex items-center gap-2 px-2 py-2 text-[10px] font-semibold text-slate-400"><Loader2 className="h-3 w-3 animate-spin" /> Cargando listas…</div>}
        {childrenState?.phase === 'error' && <div role="alert" className="my-1 rounded-lg border border-rose-100 bg-rose-50 px-2 py-2 text-[10px] text-rose-700"><p>{childrenState.error || 'No se pudieron cargar las listas.'}</p><button type="button" onClick={onRetryChildren} className="mt-1 inline-flex items-center gap-1 font-bold"><RotateCcw className="h-3 w-3" /> Reintentar</button></div>}
        <ListGroup items={items} containerID={containerID} activeListID={activeListID} scope={scope} taskDropTarget={taskDropTarget} onSelect={onSelect} onEdit={onEditList} highlighted={highlighted} />
        {childrenState?.nextCursor && <button type="button" disabled={childrenState.phase === 'loading'} onClick={onLoadMoreChildren} className="my-1 flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[10px] font-bold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">{childrenState.phase === 'loading' && <Loader2 className="h-3 w-3 animate-spin" />} Cargar más listas</button>}
        {childrenState?.phase === 'ready' && !items.length && !highlighted && <p className="px-2 py-2 text-[10px] text-slate-400">Esta carpeta no tiene listas.</p>}
      </div></div></div>
    </ListDropContainer>
  </div>
}

function MoveConfirmation({ move, folder, busy, onConfirm, onCancel }: { move: PendingMove; folder: TaskFolder; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  if (typeof document === 'undefined') return null
  return createPortal(<div className="fixed inset-0 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm" style={{ zIndex: TASK_OVERLAY_LAYERS.confirmation }} role="presentation" onMouseDown={event => event.target === event.currentTarget && !busy && onCancel()}><div role="dialog" aria-modal="true" className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl"><div className="flex items-start gap-3"><div className="rounded-2xl bg-amber-50 p-3 text-amber-600"><FolderOpen className="h-5 w-5" /></div><div><h2 className="text-lg font-black text-slate-900">Mover lista y adaptar estados</h2><p className="mt-1 text-sm leading-6 text-slate-500"><strong>{move.list.name}</strong> heredará el flujo de <strong>{folder.name}</strong>. La operación se cancelará completa si falta una equivalencia.</p></div></div><div className="mt-6 flex justify-end gap-2"><button type="button" disabled={busy} onClick={onCancel} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-100">Cancelar</button><button type="button" disabled={busy} onClick={onConfirm} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Mover lista</button></div></div></div>, document.body)
}

export default function TaskHierarchyTree({ folders, rootLists, scope, collapsed, users = [], onSelect, onChanged, onError, onOperation, taskDropTarget, taskDragActive = false, hierarchyPhase = 'ready', hierarchyError = '', hasMoreFolders = false, hasMoreRootLists = false, loadingMoreFolders = false, loadingMoreRootLists = false, folderChildrenState = {}, onRetryHierarchy, onLoadMoreFolders, onLoadMoreRootLists, onExpandFolder, onRetryFolderLists, onLoadMoreFolderLists }: Props) {
  const canonical = useMemo(() => buildOrderedLists(folders, rootLists), [folders, rootLists])
  const canonicalFolders = useMemo(() => [...folders].sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at)), [folders])
  const defaultList = rootLists.find(item => item.is_default)
  const canManageRoot = Boolean(defaultList && taskHierarchyCanManageStructure(defaultList))
  const [ordered, setOrdered] = useState(canonical)
  const [orderedFolders, setOrderedFolders] = useState(canonicalFolders)
  const [activeListID, setActiveListID] = useState('')
  const [activeFolderID, setActiveFolderID] = useState('')
  const [overContainerID, setOverContainerID] = useState<ContainerID | null>(null)
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null)
  const [appearance, setAppearance] = useState<AppearanceTarget | null>(null)
  const [saving, setSaving] = useState(false)
  const [expandedFolderIDs, setExpandedFolderIDs] = useState<Set<string>>(new Set())
  const listSnapshotRef = useRef(canonical)
  const folderSnapshotRef = useRef(canonicalFolders)
  const expansionSnapshotRef = useRef<Set<string>>(new Set())
  const expansionInitializedRef = useRef(false)
  const autoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoExpandTargetRef = useRef('')
  const taskDragExpansionSnapshotRef = useRef<Set<string> | null>(null)
  const taskDragAutoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))

  useEffect(() => { if (!activeListID && !pendingMove) setOrdered(canonical) }, [activeListID, canonical, pendingMove])
  useEffect(() => { if (!activeFolderID) setOrderedFolders(canonicalFolders) }, [activeFolderID, canonicalFolders])
  const allLists = useMemo(() => [...rootLists, ...folders.flatMap(folder => folder.lists)], [folders, rootLists])
  useEffect(() => {
    if (!canonicalFolders.length || expansionInitializedRef.current) return
    setExpandedFolderIDs(normalizeExpandedFolders(localStorage.getItem('clarin:tasks:expanded-folders'), canonicalFolders.map(folder => folder.id)))
    expansionInitializedRef.current = true
  }, [canonicalFolders])
  useEffect(() => {
    if (!expansionInitializedRef.current) return
    setExpandedFolderIDs(current => new Set(Array.from(current).filter(id => canonicalFolders.some(folder => folder.id === id))))
  }, [canonicalFolders])
  useEffect(() => {
    if (!expansionInitializedRef.current) return
    localStorage.setItem('clarin:tasks:expanded-folders', JSON.stringify(Array.from(expandedFolderIDs)))
  }, [expandedFolderIDs])
  useEffect(() => {
    const activeParentID = folderAutoExpandedForScope(scope, allLists)
    if (activeParentID) setExpandedFolderIDs(current => ensureExpandedFolder(current, activeParentID))
  }, [allLists, scope])
  useEffect(() => {
    if (!onExpandFolder) return
    expandedFolderIDs.forEach(folderID => onExpandFolder(folderID))
  }, [expandedFolderIDs, onExpandFolder])
  useEffect(() => {
    if (taskDragActive && !taskDragExpansionSnapshotRef.current) taskDragExpansionSnapshotRef.current = new Set(expandedFolderIDs)
    if (!taskDragActive && taskDragExpansionSnapshotRef.current) {
      setExpandedFolderIDs(new Set(taskDragExpansionSnapshotRef.current))
      taskDragExpansionSnapshotRef.current = null
    }
  }, [expandedFolderIDs, taskDragActive])
  useEffect(() => {
    if (taskDragAutoExpandTimerRef.current) clearTimeout(taskDragAutoExpandTimerRef.current)
    taskDragAutoExpandTimerRef.current = null
    if (!taskDragActive || taskDropTarget?.type !== 'folder' || expandedFolderIDs.has(taskDropTarget.id) || folders.find(folder => folder.id === taskDropTarget.id)?.permissions?.can_edit !== true) return
    const folderID = taskDropTarget.id
    taskDragAutoExpandTimerRef.current = setTimeout(() => {
      setExpandedFolderIDs(current => ensureExpandedFolder(current, folderID))
      taskDragAutoExpandTimerRef.current = null
    }, 550)
    return () => {
      if (taskDragAutoExpandTimerRef.current) clearTimeout(taskDragAutoExpandTimerRef.current)
      taskDragAutoExpandTimerRef.current = null
    }
  }, [expandedFolderIDs, folders, taskDragActive, taskDropTarget])
  useEffect(() => () => {
    if (autoExpandTimerRef.current) clearTimeout(autoExpandTimerRef.current)
    if (taskDragAutoExpandTimerRef.current) clearTimeout(taskDragAutoExpandTimerRef.current)
  }, [])
  const activeList = allLists.find(item => item.id === activeListID)
  const activeFolder = folders.find(item => item.id === activeFolderID)
  const collisionDetection = useCallback<CollisionDetection>(args => {
    const type = args.active.data.current?.type
    const valid = (item: ReturnType<typeof pointerWithin>[number]) => {
      if (item.id === args.active.id) return false
      if (item.data?.droppableContainer.data.current?.canManage !== true) return false
      const candidateType = item.data?.droppableContainer.data.current?.type
      return type === 'folder' ? candidateType === 'folder' : candidateType === 'list' || candidateType === 'container'
    }
    const pointer = args.pointerCoordinates ? pointerWithin(args).filter(valid) : closestCenter(args).filter(valid)
    return pointer.length ? pointer : rectIntersection(args).filter(valid)
  }, [])

  const restore = () => { setOrdered(listSnapshotRef.current); setOrderedFolders(folderSnapshotRef.current); setExpandedFolderIDs(new Set(expansionSnapshotRef.current)); setActiveListID(''); setActiveFolderID(''); setOverContainerID(null); if (autoExpandTimerRef.current) clearTimeout(autoExpandTimerRef.current); autoExpandTargetRef.current = '' }
  const targetFromOver = (over: DragOverEvent['over']) => {
    const data = over?.data.current
    if (data?.canManage !== true) return null
    if (data?.type === 'container') return { containerID: data.containerID as ContainerID, beforeListID: undefined }
    if (data?.type === 'list') return { containerID: data.containerID as ContainerID, beforeListID: data.listID as string }
    return null
  }
  const handleStart = (event: DragStartEvent) => {
    const id = String(event.active.id)
    const listID = listIDFromItem(id)
    const folderID = folderIDFromItem(id)
    listSnapshotRef.current = ordered
    folderSnapshotRef.current = orderedFolders
    expansionSnapshotRef.current = new Set(expandedFolderIDs)
    if (listID && allLists.find(item => item.id === listID)?.permissions?.can_delete === true) setActiveListID(listID)
    if (folderID && folders.find(item => item.id === folderID)?.permissions?.can_delete === true) setActiveFolderID(folderID)
  }
  const handleOver = (event: DragOverEvent) => {
    if (!activeListID && !listIDFromItem(String(event.active.id))) return
    const containerID = targetFromOver(event.over)?.containerID || null
    setOverContainerID(containerID)
    const folderID = containerID ? folderIDFromContainer(containerID) : null
    if (!folderID || expandedFolderIDs.has(folderID)) {
      if (autoExpandTimerRef.current) clearTimeout(autoExpandTimerRef.current)
      autoExpandTimerRef.current = null
      autoExpandTargetRef.current = ''
      return
    }
    if (autoExpandTargetRef.current === folderID) return
    if (autoExpandTimerRef.current) clearTimeout(autoExpandTimerRef.current)
    autoExpandTargetRef.current = folderID
    autoExpandTimerRef.current = setTimeout(() => {
      setExpandedFolderIDs(current => ensureExpandedFolder(current, folderID))
      autoExpandTimerRef.current = null
      autoExpandTargetRef.current = ''
    }, 650)
  }
  const persistListMove = async (move: PendingMove) => {
    const operationID = crypto.randomUUID()
    setSaving(true)
    onOperation?.(operationID, true)
    try {
      const folderID = folderIDFromContainer(move.containerID)
      const result = await apiPut(`/api/tasks/lists/${move.list.id}/structure`, { folder_id: folderID, before_list_id: move.beforeListID || null, workflow_inherited: Boolean(folderID), operation_id: operationID })
      if (!result.success) throw new Error(result.error || 'No se pudo mover la lista.')
      setPendingMove(null); setActiveListID(''); setOverContainerID(null); await onChanged()
    } catch (error) {
      setOrdered(move.snapshot); setPendingMove(null); setActiveListID(''); setOverContainerID(null); onError(error instanceof Error ? `${error.message} La jerarquía anterior fue restaurada.` : 'No se pudo mover la lista. La jerarquía anterior fue restaurada.'); await onChanged()
    } finally { onOperation?.(operationID, false); setSaving(false) }
  }
  const persistFolderMove = async (folderID: string, beforeFolderID: string | null, preview: TaskFolder[]) => {
    const operationID = crypto.randomUUID()
    setOrderedFolders(preview); setSaving(true)
    onOperation?.(operationID, true)
    try {
      const result = await apiPut(`/api/tasks/folders/${folderID}/structure`, { before_folder_id: beforeFolderID, operation_id: operationID })
      if (!result.success) throw new Error(result.error || 'No se pudo ordenar la carpeta.')
      setActiveFolderID(''); await onChanged()
    } catch (error) {
      setOrderedFolders(folderSnapshotRef.current); setActiveFolderID(''); onError(error instanceof Error ? `${error.message} El orden anterior fue restaurado.` : 'No se pudo ordenar la carpeta.'); await onChanged()
    } finally { onOperation?.(operationID, false); setSaving(false) }
  }
  const handleEnd = (event: DragEndEvent) => {
    if (autoExpandTimerRef.current) clearTimeout(autoExpandTimerRef.current)
    autoExpandTimerRef.current = null
    autoExpandTargetRef.current = ''
    const listID = listIDFromItem(String(event.active.id))
    if (listID) {
      const list = allLists.find(item => item.id === listID)
      const target = targetFromOver(event.over)
      if (!list || list.is_default || list.permissions?.can_delete !== true || !target) { restore(); return }
      let beforeListID = target.beforeListID
      if (beforeListID && event.active.rect.current.translated && event.active.rect.current.translated.top > event.over!.rect.top + event.over!.rect.height / 2) {
        const candidates = (listSnapshotRef.current[target.containerID] || []).filter(item => item.id !== listID)
        const index = candidates.findIndex(item => item.id === beforeListID)
        beforeListID = index >= 0 ? candidates[index + 1]?.id : undefined
      }
      const preview = movePreview(listSnapshotRef.current, listID, target.containerID, beforeListID)
      if (sameOrder(listSnapshotRef.current, preview)) { restore(); return }
      setOrdered(preview); setActiveListID(''); setOverContainerID(null)
      const move = { list, containerID: target.containerID, beforeListID, snapshot: listSnapshotRef.current }
      const targetFolder = folders.find(folder => folder.id === folderIDFromContainer(target.containerID))
      if (targetFolder?.workflow_id && targetFolder.workflow_id !== list.workflow_id && list.task_count > 0) setPendingMove(move)
      else void persistListMove(move)
      return
    }
    const folderID = folderIDFromItem(String(event.active.id))
    const overFolderID = folderIDFromItem(String(event.over?.id || ''))
    if (!folderID || !overFolderID || folderID === overFolderID || folders.find(item => item.id === folderID)?.permissions?.can_delete !== true || folders.find(item => item.id === overFolderID)?.permissions?.can_delete !== true) { restore(); return }
    const candidates = folderSnapshotRef.current.filter(item => item.id !== folderID)
    let targetIndex = candidates.findIndex(item => item.id === overFolderID)
    if (targetIndex < 0) { restore(); return }
    if (event.active.rect.current.translated && event.active.rect.current.translated.top > event.over!.rect.top + event.over!.rect.height / 2) targetIndex++
    const moving = folderSnapshotRef.current.find(item => item.id === folderID)!
    const preview = [...candidates.slice(0, targetIndex), moving, ...candidates.slice(targetIndex)]
    const beforeFolderID = preview[preview.findIndex(item => item.id === folderID) + 1]?.id || null
    void persistFolderMove(folderID, beforeFolderID, preview)
  }

  if (collapsed) return <div className="space-y-1.5 px-1">
    {hierarchyPhase === 'loading' && !rootLists.length && !folders.length && <div role="status" aria-label="Cargando jerarquía" className="flex h-10 items-center justify-center text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /></div>}
    {hierarchyPhase === 'error' && !rootLists.length && !folders.length && <button type="button" aria-label="Reintentar jerarquía" title={hierarchyError} onClick={onRetryHierarchy} className="flex h-10 w-full items-center justify-center rounded-xl bg-rose-50 text-rose-600"><AlertCircle className="h-4 w-4" /></button>}
    {defaultList && <button type="button" data-task-drop-list={taskHierarchyCanReceiveTasks(defaultList) ? defaultList.id : undefined} data-task-drop-label={taskHierarchyCanReceiveTasks(defaultList) ? defaultList.name : undefined} data-task-drop-color={taskHierarchyCanReceiveTasks(defaultList) ? defaultList.color : undefined} title={`${defaultList.name} · ${hierarchyCountTooltip(defaultList)}`} onClick={() => onSelect({ type: 'list', id: defaultList.id })} className={`relative flex h-10 w-full items-center justify-center rounded-xl border transition ${taskHierarchyCanReceiveTasks(defaultList) && taskDropTarget?.type === 'list' && taskDropTarget.id === defaultList.id ? 'scale-105 border-emerald-400 bg-emerald-50 text-emerald-700 shadow-lg ring-2 ring-emerald-200' : scope.type === 'list' && scope.id === defaultList.id ? 'border-emerald-200 bg-emerald-50 text-emerald-700 shadow-sm' : 'border-transparent text-slate-500 hover:border-slate-200 hover:bg-slate-50'}`}><TaskContainerIcon value={defaultList.icon || 'inbox'} className="h-4 w-4" />{Boolean(hierarchyItemOpenCount(defaultList)) && <span aria-label={`${hierarchyItemOpenCount(defaultList)} tareas abiertas`} className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-slate-900 px-1 text-[8px] font-black leading-4 text-white">{hierarchyItemOpenCount(defaultList)}</span>}</button>}
    {(ordered.root || []).map(list => <button key={list.id} type="button" data-task-drop-list={taskHierarchyCanReceiveTasks(list) ? list.id : undefined} data-task-drop-label={taskHierarchyCanReceiveTasks(list) ? list.name : undefined} data-task-drop-color={taskHierarchyCanReceiveTasks(list) ? list.color : undefined} title={`${list.name} · ${hierarchyCountTooltip(list)}`} onClick={() => onSelect({ type: 'list', id: list.id })} className={`relative flex h-10 w-full items-center justify-center rounded-xl border transition ${taskHierarchyCanReceiveTasks(list) && taskDropTarget?.type === 'list' && taskDropTarget.id === list.id ? 'scale-105 border-emerald-400 bg-emerald-50 text-emerald-700 shadow-lg ring-2 ring-emerald-200' : scope.type === 'list' && scope.id === list.id ? 'border-emerald-200 bg-emerald-50 text-emerald-700 shadow-sm' : 'border-transparent text-slate-500 hover:border-slate-200 hover:bg-slate-50'}`}><TaskContainerIcon value={list.icon} className="h-4 w-4" />{Boolean(hierarchyItemOpenCount(list)) && <span aria-label={`${hierarchyItemOpenCount(list)} tareas abiertas`} className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-slate-900 px-1 text-[8px] font-black leading-4 text-white">{hierarchyItemOpenCount(list)}</span>}</button>)}
    <div className="mx-auto my-2 h-px w-7 bg-slate-200" />
    {orderedFolders.map(folder => <button key={folder.id} type="button" data-task-drop-folder={taskHierarchyCanReceiveTasks(folder) ? folder.id : undefined} data-task-drop-label={taskHierarchyCanReceiveTasks(folder) ? folder.name : undefined} data-task-drop-color={taskHierarchyCanReceiveTasks(folder) ? folder.color : undefined} title={`${folder.name} · ${hierarchyCountTooltip(folder)}`} onClick={() => onSelect({ type: 'folder', id: folder.id })} className={`relative flex h-10 w-full items-center justify-center rounded-xl border transition ${taskHierarchyCanReceiveTasks(folder) && taskDropTarget?.type === 'folder' && taskDropTarget.id === folder.id ? 'scale-105 border-emerald-400 bg-emerald-50 text-emerald-700 shadow-lg ring-2 ring-emerald-200' : scope.type === 'folder' && scope.id === folder.id ? 'border-emerald-200 bg-emerald-50 text-emerald-700 shadow-sm' : 'border-transparent text-slate-500 hover:border-slate-200 hover:bg-slate-50'}`}>{taskHierarchyCanReceiveTasks(folder) && taskDropTarget?.type === 'folder' && taskDropTarget.id === folder.id ? <FolderOpen className="h-4 w-4" /> : <TaskContainerIcon value={folder.icon} className="h-4 w-4" />}{Boolean(hierarchyItemOpenCount(folder)) && <span aria-label={`${hierarchyItemOpenCount(folder)} tareas abiertas`} className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-slate-900 px-1 text-[8px] font-black leading-4 text-white">{hierarchyItemOpenCount(folder)}</span>}</button>)}
  </div>

  return <>
    {hierarchyError && <div role="alert" className="mb-2 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-[10px] text-rose-700"><p>{hierarchyError}</p><button type="button" onClick={onRetryHierarchy} className="mt-1 inline-flex items-center gap-1 font-bold"><RotateCcw className="h-3 w-3" /> Reintentar</button></div>}
    {hierarchyPhase === 'loading' && !rootLists.length && !folders.length && <div role="status" className="flex items-center gap-2 rounded-xl px-3 py-4 text-xs font-semibold text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Cargando carpetas y listas…</div>}
    <DndContext sensors={sensors} collisionDetection={collisionDetection} measuring={{ droppable: { strategy: MeasuringStrategy.Always } }} onDragStart={handleStart} onDragOver={handleOver} onDragEnd={handleEnd} onDragCancel={(_event: DragCancelEvent) => restore()}>
      <div className="space-y-1">
        {defaultList && <DefaultListRow list={defaultList} selected={scope.type === 'list' && scope.id === defaultList.id} taskDropActive={taskDropTarget?.type === 'list' && taskDropTarget.id === defaultList.id} onSelect={() => onSelect({ type: 'list', id: defaultList.id })} onEdit={() => setAppearance({ type: 'list', item: defaultList })} />}
        <ListDropContainer id="root" active={canManageRoot && overContainerID === 'root'} label="Listas independientes" disabled={!canManageRoot}><div title="Listas que no pertenecen a una carpeta" className={`mb-0.5 mt-1 flex items-center gap-2 rounded-lg px-2 py-1 text-[9px] font-bold uppercase tracking-[0.12em] ${canManageRoot && overContainerID === 'root' ? 'text-emerald-700' : 'text-slate-400'}`}>{canManageRoot && overContainerID === 'root' ? <Undo2 className="h-3 w-3" /> : <Info className="h-3 w-3" />}{canManageRoot && overContainerID === 'root' ? 'Soltar para mover al nivel principal' : 'Listas independientes'}</div><div className="px-1"><ListGroup items={ordered.root || []} containerID="root" activeListID={activeListID} scope={scope} taskDropTarget={taskDropTarget} onSelect={onSelect} onEdit={list => setAppearance({ type: 'list', item: list })} highlighted={canManageRoot && overContainerID === 'root'} />{hasMoreRootLists && <button type="button" disabled={loadingMoreRootLists} onClick={onLoadMoreRootLists} className="my-1 flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[10px] font-bold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">{loadingMoreRootLists && <Loader2 className="h-3 w-3 animate-spin" />}Cargar más listas</button>}</div></ListDropContainer>
        <div className="px-2 pb-1 pt-2 text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">Carpetas</div>
        <SortableContext items={orderedFolders.map(item => folderItemID(item.id))} strategy={verticalListSortingStrategy}>{orderedFolders.map(folder => <SortableFolderBlock key={folder.id} folder={folder} items={ordered[containerFor(folder.id)] || []} activeFolderID={activeFolderID} activeListID={activeListID} highlighted={overContainerID === containerFor(folder.id)} taskDropTarget={taskDropTarget} expanded={expandedFolderIDs.has(folder.id)} scope={scope} childrenState={folderChildrenState[folder.id]} onSelect={next => { if (next.type === 'folder' && next.id === folder.id) setExpandedFolderIDs(current => toggleExpandedFolder(current, folder.id)); onSelect(next) }} onToggle={() => setExpandedFolderIDs(current => toggleExpandedFolder(current, folder.id))} onRetryChildren={() => onRetryFolderLists?.(folder.id)} onLoadMoreChildren={() => onLoadMoreFolderLists?.(folder.id)} onEditFolder={() => setAppearance({ type: 'folder', item: folder })} onEditList={list => setAppearance({ type: 'list', item: list })} />)}</SortableContext>
        {hasMoreFolders && <button type="button" disabled={loadingMoreFolders} onClick={onLoadMoreFolders} className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-[10px] font-bold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">{loadingMoreFolders && <Loader2 className="h-3 w-3 animate-spin" />}Cargar más carpetas</button>}
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: 'ease-out' }}>{(activeList || activeFolder) && <div data-task-hierarchy-overlay className="flex w-60 items-center gap-2 rounded-xl border border-emerald-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 shadow-2xl"><GripVertical className="h-4 w-4 text-emerald-500" /><TaskContainerIcon value={activeList?.icon || activeFolder?.icon} className="h-4 w-4" /><span className="min-w-0 flex-1 truncate">{activeList?.name || activeFolder?.name}</span></div>}</DragOverlay>
    </DndContext>
    {pendingMove && <MoveConfirmation move={pendingMove} folder={folders.find(folder => folder.id === folderIDFromContainer(pendingMove.containerID))!} busy={saving} onConfirm={() => void persistListMove(pendingMove)} onCancel={() => { setPendingMove(null); restore() }} />}
    {appearance && taskHierarchyCanManageStructure(appearance.item) && <TaskAppearanceDialog item={appearance.item} type={appearance.type} users={users} onClose={() => setAppearance(null)} onSaved={onChanged} onError={onError} onOperation={onOperation} />}
    {saving && <div className="pointer-events-none fixed bottom-5 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-2 rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-xl"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Guardando estructura…</div>}
  </>
}
