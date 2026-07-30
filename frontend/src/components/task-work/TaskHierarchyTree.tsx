'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  closestCenter,
  DndContext,
  DragCancelEvent,
  DragEndEvent,
  DragOverlay,
  DragOverEvent,
  DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, CircleDot, Folder, FolderOpen, GripVertical, Loader2, LockKeyhole, Undo2 } from 'lucide-react'
import { apiPut } from '@/lib/api'
import type { TaskFolder, TaskList } from '@/types/task'

type HierarchyScope = { type: 'all' | 'trash' } | { type: 'folder' | 'list'; id: string }
type ContainerID = `folder:${string}` | 'root'
type OrderedLists = Record<string, TaskList[]>

interface Props {
  folders: TaskFolder[]
  rootLists: TaskList[]
  scope: HierarchyScope
  collapsed: boolean
  onSelect: (scope: HierarchyScope) => void
  onChanged: () => Promise<void> | void
  onError: (message: string) => void
}

interface PendingMove {
  list: TaskList
  containerID: ContainerID
  beforeListID?: string
  snapshot: OrderedLists
}

const containerFor = (folderID?: string): ContainerID => folderID ? `folder:${folderID}` : 'root'
const folderIDFromContainer = (containerID: ContainerID) => containerID === 'root' ? '' : containerID.slice('folder:'.length)
const itemID = (listID: string) => `list:${listID}`
const listIDFromItem = (id: string) => id.startsWith('list:') ? id.slice('list:'.length) : ''

function buildOrderedLists(folders: TaskFolder[], rootLists: TaskList[]): OrderedLists {
  return Object.fromEntries([
    ['root', [...rootLists].sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))],
    ...folders.map(folder => [containerFor(folder.id), [...folder.lists].sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))]),
  ])
}

function sameOrder(left: OrderedLists, right: OrderedLists) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of Array.from(keys)) {
    const leftIDs = (left[key] || []).map(item => item.id)
    const rightIDs = (right[key] || []).map(item => item.id)
    if (leftIDs.length !== rightIDs.length || leftIDs.some((id, index) => rightIDs[index] !== id)) return false
  }
  return true
}

function findContainer(ordered: OrderedLists, listID: string): ContainerID | undefined {
  return Object.keys(ordered).find(key => ordered[key].some(item => item.id === listID)) as ContainerID | undefined
}

function movePreview(ordered: OrderedLists, listID: string, destination: ContainerID, beforeListID?: string) {
  const source = findContainer(ordered, listID)
  if (!source) return ordered
  const sourceItems = ordered[source]
  const moving = sourceItems.find(item => item.id === listID)
  if (!moving) return ordered
  const next: OrderedLists = { ...ordered, [source]: sourceItems.filter(item => item.id !== listID) }
  const destinationItems = source === destination ? next[source] : [...(ordered[destination] || [])]
  const targetIndex = beforeListID ? destinationItems.findIndex(item => item.id === beforeListID) : -1
  const insertAt = targetIndex >= 0 ? targetIndex : destinationItems.length
  next[destination] = [...destinationItems.slice(0, insertAt), moving, ...destinationItems.slice(insertAt)]
  return sameOrder(ordered, next) ? ordered : next
}

function SortableListRow({ list, containerID, active, selected, onSelect }: { list: TaskList; containerID: ContainerID; active: boolean; selected: boolean; onSelect: () => void }) {
  const sortableData = useMemo(() => ({ type: 'list', listID: list.id, containerID }), [containerID, list.id])
  const sortable = useSortable({
    id: itemID(list.id),
    disabled: list.is_default,
    data: sortableData,
  })
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }
  return <div ref={sortable.setNodeRef} style={style} data-task-hierarchy-list={list.id} className={`group flex items-center rounded-lg transition ${active ? 'opacity-30' : ''} ${selected ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50'}`}>
    <button type="button" onClick={onSelect} className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-xs ${selected ? 'font-semibold' : ''}`}>
      <i className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: list.color }} />
      <span className="min-w-0 flex-1 truncate">{list.name}</span>
      <span className="text-[9px] text-slate-400">{list.task_count}</span>
    </button>
    {list.is_default ? <span title="La Bandeja general permanece en la raíz" className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center text-slate-300"><LockKeyhole className="h-3 w-3" /></span> : <button type="button" ref={sortable.setActivatorNodeRef} {...sortable.attributes} {...sortable.listeners} aria-label={`Mover ${list.name}`} title={`Arrastrar ${list.name}`} className="mr-0.5 flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded-md text-slate-300 opacity-0 transition hover:bg-white hover:text-slate-600 focus:opacity-100 active:cursor-grabbing group-hover:opacity-100"><GripVertical className="h-3.5 w-3.5" /></button>}
  </div>
}

function DropContainer({ id, active, children, label }: { id: ContainerID; active: boolean; children: React.ReactNode; label: string }) {
  const droppableData = useMemo(() => ({ type: 'container', containerID: id }), [id])
  const droppable = useDroppable({ id, data: droppableData })
  return <div ref={droppable.setNodeRef} data-task-hierarchy-container={id} className={`rounded-xl transition-all duration-200 ${active || droppable.isOver ? 'bg-emerald-50/80 ring-2 ring-inset ring-emerald-300' : ''}`} aria-label={label}>{children}</div>
}

function SortableListGroup({ items, containerID, activeListID, scope, onSelect, highlighted = false }: { items: TaskList[]; containerID: ContainerID; activeListID: string; scope: HierarchyScope; onSelect: (scope: HierarchyScope) => void; highlighted?: boolean }) {
  const sortableIDs = useMemo(() => items.map(item => itemID(item.id)), [items])
  return <SortableContext items={sortableIDs} strategy={verticalListSortingStrategy}><div>{highlighted && <div data-task-hierarchy-placeholder className="mb-1 flex h-8 animate-pulse items-center justify-center rounded-lg border border-dashed border-emerald-300 bg-emerald-50 text-[10px] font-semibold text-emerald-600">Soltar aquí</div>}{items.map(list => <SortableListRow key={list.id} list={list} containerID={containerID} active={activeListID === list.id} selected={scope.type === 'list' && scope.id === list.id} onSelect={() => onSelect({ type: 'list', id: list.id })} />)}</div></SortableContext>
}

function MoveConfirmation({ move, folder, busy, onConfirm, onCancel }: { move: PendingMove; folder: TaskFolder; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  if (typeof document === 'undefined') return null
  return createPortal(<div className="fixed inset-0 z-[115] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm" role="presentation" onMouseDown={event => event.target === event.currentTarget && !busy && onCancel()}>
    <div role="dialog" aria-modal="true" aria-labelledby="task-list-move-title" className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
      <div className="flex items-start gap-3"><div className="rounded-2xl bg-amber-50 p-3 text-amber-600"><FolderOpen className="h-5 w-5" /></div><div className="min-w-0"><h2 id="task-list-move-title" className="text-lg font-black text-slate-900">Mover lista y adaptar estados</h2><p className="mt-1 text-sm leading-6 text-slate-500"><strong className="text-slate-700">{move.list.name}</strong> heredará el flujo de <strong className="text-slate-700">{folder.name}</strong>. Sus tareas se remapearán por categoría y la operación se cancelará completa si falta una equivalencia.</p></div></div>
      <div className="mt-6 flex justify-end gap-2"><button type="button" disabled={busy} onClick={onCancel} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40">Cancelar</button><button type="button" disabled={busy} onClick={onConfirm} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Mover lista</button></div>
    </div>
  </div>, document.body)
}

export default function TaskHierarchyTree({ folders, rootLists, scope, collapsed, onSelect, onChanged, onError }: Props) {
  const canonical = useMemo(() => buildOrderedLists(folders, rootLists), [folders, rootLists])
  const [ordered, setOrdered] = useState<OrderedLists>(canonical)
  const [activeListID, setActiveListID] = useState('')
  const [overContainerID, setOverContainerID] = useState<ContainerID | null>(null)
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null)
  const [saving, setSaving] = useState(false)
  const snapshotRef = useRef<OrderedLists>(canonical)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => {
    if (!activeListID && !pendingMove) setOrdered(canonical)
  }, [activeListID, canonical, pendingMove])

  const allLists = useMemo(() => [...rootLists, ...folders.flatMap(folder => folder.lists)], [folders, rootLists])
  const activeList = allLists.find(list => list.id === activeListID)
  const collisionDetection = useCallback<CollisionDetection>(args => {
    const candidates = (args.pointerCoordinates ? pointerWithin(args) : closestCenter(args)).filter(item => item.id !== args.active.id)
    if (candidates.length) return candidates
    return rectIntersection(args).filter(item => item.id !== args.active.id)
  }, [])

  const restore = (snapshot = snapshotRef.current) => {
    setOrdered(snapshot)
    setActiveListID('')
    setOverContainerID(null)
  }

  const targetFromOver = (over: DragOverEvent['over']) => {
    if (!over) return null
    const data = over.data.current
    if (data?.type === 'container') return { containerID: data.containerID as ContainerID, beforeListID: undefined }
    if (data?.type === 'list') return { containerID: data.containerID as ContainerID, beforeListID: data.listID as string }
    return null
  }

  const handleStart = (event: DragStartEvent) => {
    const listID = listIDFromItem(String(event.active.id))
    const list = allLists.find(item => item.id === listID)
    if (!list || list.is_default) return
    snapshotRef.current = ordered
    setActiveListID(listID)
  }
  const handleOver = (event: DragOverEvent) => {
    const listID = listIDFromItem(String(event.active.id))
    if (!listID) return
    const target = targetFromOver(event.over)
    if (!target) { setOverContainerID(null); return }
    setOverContainerID(target.containerID)
  }
  const handleCancel = (_event?: DragCancelEvent) => restore()

  const persistMove = async (move: PendingMove) => {
    setSaving(true)
    try {
      const folderID = folderIDFromContainer(move.containerID)
      const result = await apiPut(`/api/tasks/lists/${move.list.id}/structure`, {
        folder_id: folderID,
        before_list_id: move.beforeListID || '',
        workflow_inherited: Boolean(folderID),
      })
      if (result.success) {
        setPendingMove(null)
        setActiveListID('')
        setOverContainerID(null)
        await onChanged()
        return
      }
      restore(move.snapshot)
      setPendingMove(null)
      onError(result.error || 'No se pudo mover la lista. La jerarquía anterior fue restaurada.')
      if (result.status === 409 || result.status === 422) await onChanged()
    } catch {
      restore(move.snapshot)
      setPendingMove(null)
      onError('No se pudo mover la lista. La jerarquía anterior fue restaurada.')
    } finally {
      setSaving(false)
    }
  }

  const handleEnd = (event: DragEndEvent) => {
    const listID = listIDFromItem(String(event.active.id))
    const list = allLists.find(item => item.id === listID)
    if (!list || list.is_default || !event.over) { restore(); return }
    const target = targetFromOver(event.over)
    if (!target) { restore(); return }
    const destination = target.containerID
    let beforeListID = target.beforeListID
    if (beforeListID) {
      const translated = event.active.rect.current.translated
      const isAfterTarget = Boolean(translated && translated.top > event.over.rect.top + event.over.rect.height / 2)
      if (isAfterTarget) {
        const withoutActive = (snapshotRef.current[destination] || []).filter(item => item.id !== listID)
        const targetIndex = withoutActive.findIndex(item => item.id === beforeListID)
        beforeListID = targetIndex >= 0 ? withoutActive[targetIndex + 1]?.id : undefined
      }
    }
    const preview = movePreview(snapshotRef.current, listID, destination, beforeListID)
    if (sameOrder(snapshotRef.current, preview)) { restore(); return }
    setOrdered(preview)
    const move: PendingMove = { list, containerID: destination, beforeListID, snapshot: snapshotRef.current }
    setActiveListID('')
    setOverContainerID(null)
    const targetFolder = folders.find(folder => folder.id === folderIDFromContainer(destination))
    const changesWorkflow = Boolean(targetFolder && targetFolder.workflow_id && targetFolder.workflow_id !== list.workflow_id && list.task_count > 0)
    if (changesWorkflow) setPendingMove(move)
    else void persistMove(move)
  }

  if (collapsed) return <div className="space-y-1">
    {folders.map(folder => <button key={folder.id} type="button" title={folder.name} onClick={() => onSelect({ type: 'folder', id: folder.id })} className={`flex w-full justify-center rounded-xl p-2 ${scope.type === 'folder' && scope.id === folder.id ? 'bg-slate-100' : 'hover:bg-slate-50'}`}><Folder className="h-4 w-4" style={{ color: folder.color }} /></button>)}
    {rootLists.map(list => <button key={list.id} type="button" title={list.name} onClick={() => onSelect({ type: 'list', id: list.id })} className={`flex w-full justify-center rounded-xl p-2 ${scope.type === 'list' && scope.id === list.id ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}><CircleDot className="h-4 w-4" style={{ color: list.color }} /></button>)}
  </div>

  return <>
    <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={handleStart} onDragOver={handleOver} onDragEnd={handleEnd} onDragCancel={handleCancel}>
      <div className="space-y-1">
        {folders.map(folder => {
          const containerID = containerFor(folder.id)
          const items = ordered[containerID] || []
          const selected = scope.type === 'folder' && scope.id === folder.id
          const highlighted = overContainerID === containerID
          return <DropContainer key={folder.id} id={containerID} active={highlighted} label={`Carpeta ${folder.name}`}>
            <button type="button" title={folder.name} onClick={() => onSelect({ type: 'folder', id: folder.id })} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium ${selected ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-50'}`}>{selected || highlighted ? <FolderOpen className="h-4 w-4 shrink-0" style={{ color: folder.color }} /> : <Folder className="h-4 w-4 shrink-0" style={{ color: folder.color }} />}<span className="min-w-0 flex-1 truncate text-left">{folder.name}</span><span className="text-[10px] text-slate-400">{folder.task_count}</span></button>
            <div className={`ml-5 border-l pl-2 transition ${highlighted ? 'border-emerald-300' : 'border-slate-200'} ${highlighted && !items.length ? 'min-h-9 py-1' : ''}`}><SortableListGroup items={items} containerID={containerID} activeListID={activeListID} scope={scope} onSelect={onSelect} highlighted={highlighted} /></div>
          </DropContainer>
        })}
        <DropContainer id="root" active={overContainerID === 'root'} label="Listas sin carpeta">
          <div className={`mb-0.5 mt-2 flex items-center gap-2 rounded-lg px-2 py-1 text-[9px] font-bold uppercase tracking-[0.12em] transition ${overContainerID === 'root' ? 'text-emerald-700' : 'text-slate-400'}`}><Undo2 className="h-3 w-3" /> Sin carpeta</div>
          <div className="px-1"><SortableListGroup items={ordered.root || []} containerID="root" activeListID={activeListID} scope={scope} onSelect={onSelect} highlighted={overContainerID === 'root'} /></div>
        </DropContainer>
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: 'ease-out' }}>{activeList && <div data-task-hierarchy-overlay className="flex w-56 items-center gap-2 rounded-xl border border-emerald-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 shadow-2xl shadow-slate-900/20"><GripVertical className="h-4 w-4 text-emerald-500" /><CircleDot className="h-4 w-4" style={{ color: activeList.color }} /><span className="min-w-0 flex-1 truncate">{activeList.name}</span><span className="text-[10px] text-slate-400">{activeList.task_count}</span></div>}</DragOverlay>
    </DndContext>
    {pendingMove && <MoveConfirmation move={pendingMove} folder={folders.find(folder => folder.id === folderIDFromContainer(pendingMove.containerID))!} busy={saving} onConfirm={() => { void persistMove(pendingMove) }} onCancel={() => { restore(pendingMove.snapshot); setPendingMove(null) }} />}
    {saving && !pendingMove && <div className="pointer-events-none fixed bottom-5 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-2 rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-xl"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Guardando ubicación…</div>}
  </>
}
