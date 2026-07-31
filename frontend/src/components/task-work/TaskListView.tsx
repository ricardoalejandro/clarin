'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDownAZ, ArrowUpAZ, Check, ChevronDown, GripVertical, Layers3, Loader2, MoveRight, Star, Trash2, X } from 'lucide-react'
import { apiPost } from '@/lib/api'
import { TASK_PRIORITY_CONFIG, type Task, type TaskFolder, type TaskGroupBy, type TaskGroupDirection, type TaskList, type TaskWorkflowStatus } from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'
import { TaskStatusPicker } from './TaskPropertyPicker'
import { TaskListPicker, TaskSelectPicker } from './TaskSelectPicker'
import TaskDateTimePicker from './TaskDateTimePicker'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import { buildTaskListGroups, reorderTaskSelection, taskListDropMutation, type TaskListGroup } from './taskListGrouping'
import { taskListDensity } from './taskListDensity'
import type { TaskHierarchyCounts } from './taskHierarchyCounts'

interface Props {
  tasks: Task[]
  statuses: TaskWorkflowStatus[]
  lists: TaskList[]
  folders: TaskFolder[]
  users: TaskAccountUser[]
  groupBy: TaskGroupBy
  groupDirection: TaskGroupDirection
  collapsedGroupKeys: string[]
  onGroupingChange: (groupBy: TaskGroupBy, direction: TaskGroupDirection, collapsed: string[]) => void
  onOpen: (task: Task) => void
  onStatus: (task: Task, statusId: string) => void
  onStar: (task: Task) => void
  onCanonicalTask: (task: Task, action?: string) => boolean
  onHierarchyCounts?: (counts?: TaskHierarchyCounts | null, operationID?: string) => boolean | void
  onRefresh: () => void | Promise<void>
  onError: (message: string) => void
}

const groupOptions: { value: TaskGroupBy; label: string }[] = [
  { value: 'none', label: 'Sin agrupación' }, { value: 'status', label: 'Estado' }, { value: 'list', label: 'Lista' }, { value: 'assignee', label: 'Responsable' }, { value: 'priority', label: 'Prioridad' }, { value: 'type', label: 'Tipo' }, { value: 'due', label: 'Fecha de vencimiento' },
]

function GroupDrop({ group, children }: { group: TaskListGroup; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${group.key}`, data: { type: 'group', groupKey: group.key } })
  return <section ref={setNodeRef} data-task-list-group={group.key} className={`overflow-hidden rounded-2xl border bg-white shadow-sm transition ${isOver ? 'scale-[1.005] border-emerald-400 ring-4 ring-emerald-100' : 'border-slate-200'}`}>{children}</section>
}

function SortableRow({ task, groupKey, selected, selectionMode, density, allStatuses, onOpen, onSelect, onStatus, onStar }: {
  task: Task; groupKey: string; selected: boolean; selectionMode: boolean; density: ReturnType<typeof taskListDensity>; allStatuses: TaskWorkflowStatus[]; onOpen: () => void; onSelect: (shift: boolean) => void; onStatus: (statusId: string) => void; onStar: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, data: { type: 'row', groupKey } })
  const allowed = allStatuses.filter(status => status.workflow_id === task.status_detail?.workflow_id).sort((a,b) => a.sort_order-b.sort_order)
  const done = task.status_detail?.category === 'done'
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} data-task-list-row={task.id} onClick={event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || selectionMode) { event.preventDefault(); onSelect(event.shiftKey); return }
    onOpen()
  }} className={`group grid items-center gap-3 px-4 py-3 transition ${isDragging ? 'opacity-25' : 'hover:bg-slate-50'} ${selected ? 'bg-emerald-50/70 ring-1 ring-inset ring-emerald-200' : ''} ${density === 'comfortable' ? 'grid-cols-[32px_minmax(260px,1fr)_minmax(200px,220px)_minmax(150px,180px)_100px_40px]' : density === 'compact' ? 'grid-cols-[30px_minmax(220px,1fr)_minmax(176px,190px)_minmax(120px,150px)_90px_36px]' : 'grid-cols-[30px_1fr]'}`}>
    <button type="button" {...attributes} {...listeners} onClick={event => event.stopPropagation()} aria-label={`Arrastrar ${task.title}`} className="flex h-8 w-7 cursor-grab items-center justify-center rounded-lg text-slate-300 outline-none transition hover:bg-slate-100 hover:text-slate-600 focus:ring-2 focus:ring-emerald-400 active:cursor-grabbing"><GripVertical className="h-4 w-4" /></button>
    <div className="flex min-w-0 items-center gap-3"><button type="button" onClick={event => { event.stopPropagation(); const next = allowed.find(status => status.category === (done ? 'not_started' : 'done')); if (next) onStatus(next.id) }} className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${done ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 bg-white'}`}>{done && <Check className="h-3 w-3" />}</button><div className="min-w-0"><p className={`truncate text-sm font-semibold ${done ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{task.title}</p><p className="mt-0.5 truncate text-[10px] text-slate-400">{task.list_name || 'Bandeja general'}{task.subtask_count ? ` · ${task.subtask_done}/${task.subtask_count} subtareas` : ''}{density === 'stacked' ? ` · ${task.assigned_to_name || 'Sin responsable'}` : ''}</p></div>{selected && <span className="ml-auto rounded-full bg-emerald-600 px-2 py-0.5 text-[9px] font-black text-white">Seleccionada</span>}</div>
    {density !== 'stacked' && <><div onClick={event => event.stopPropagation()}><TaskStatusPicker value={task.status_id || ''} statuses={allowed} compact={density === 'compact'} onChange={onStatus} /></div><div className="flex min-w-0 items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-[9px] font-black text-slate-500">{(task.assigned_to_name || '?').slice(0,2).toUpperCase()}</span><span className="truncate text-xs text-slate-500">{task.assigned_to_name || 'Sin responsable'}</span></div><span className="text-xs text-slate-400">{task.due_at ? new Date(task.due_at).toLocaleDateString('es', { day: 'numeric', month: 'short' }) : 'Sin fecha'}</span><button type="button" onClick={event => { event.stopPropagation(); onStar() }} className={`rounded-lg p-2 ${task.starred ? 'text-amber-400' : 'text-slate-300 opacity-0 group-hover:opacity-100'}`}><Star className={`h-4 w-4 ${task.starred ? 'fill-current' : ''}`} /></button></>}
  </div>
}

export default function TaskListView({ tasks, statuses, lists, folders, users: _users, groupBy, groupDirection, collapsedGroupKeys, onGroupingChange, onOpen, onStatus, onStar, onCanonicalTask, onHierarchyCounts, onRefresh, onError }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [localTasks, setLocalTasks] = useState(tasks)
  const [selectedIDs, setSelectedIDs] = useState<string[]>([])
  const [selectionAnchor, setSelectionAnchor] = useState('')
  const [dragIDs, setDragIDs] = useState<string[]>([])
  const [pendingListID, setPendingListID] = useState('')
  const [moveDialog, setMoveDialog] = useState(false)
  const [trashDialog, setTrashDialog] = useState(false)
  const [trashPhrase, setTrashPhrase] = useState('')
  const [dueDialog, setDueDialog] = useState<{ ids: string[]; clear: boolean } | null>(null)
  const [dueValue, setDueValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => setLocalTasks(tasks), [tasks])
  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const observer = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width || 0))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && selectedIDs.length) { setSelectedIDs([]); setSelectionAnchor('') } }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [selectedIDs.length])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const density = taskListDensity(width)
  const groups = useMemo(() => buildTaskListGroups(localTasks, groupBy, groupDirection, statuses, lists), [groupBy, groupDirection, lists, localTasks, statuses])
  const selected = useMemo(() => new Set(selectedIDs), [selectedIDs])
  const toggleSelection = (taskID: string, shift: boolean, orderedIDs: string[]) => {
    setSelectedIDs(current => {
      if (shift && selectionAnchor) {
        const from = orderedIDs.indexOf(selectionAnchor); const to = orderedIDs.indexOf(taskID)
        if (from >= 0 && to >= 0) return Array.from(new Set([...current, ...orderedIDs.slice(Math.min(from,to), Math.max(from,to)+1)]))
      }
      return current.includes(taskID) ? current.filter(id => id !== taskID) : [...current, taskID]
    })
    setSelectionAnchor(taskID)
  }
  const selectedTasks = () => selectedIDs.map(id => localTasks.find(task => task.id === id)).filter((task): task is Task => Boolean(task && !task.parent_task_id))
  const mutate = async (ids: string[], mutation: ReturnType<typeof taskListDropMutation>, dateValue?: string | null) => {
    if (!mutation || !ids.length) return
    const affected = ids.map(id => localTasks.find(task => task.id === id)).filter((task): task is Task => Boolean(task))
    const items = affected.map(task => ({ id: task.id, version: task.version || 1 }))
    const operationID = crypto.randomUUID()
    setBusy(true)
    const result = mutation.endpoint === 'move'
      ? await apiPost<{ tasks: Task[]; operation_id?: string; hierarchy_counts?: TaskHierarchyCounts }>('/api/tasks/bulk-move', { items, destination_list_id: mutation.listId, destination_status_category: mutation.statusCategory, operation_id: operationID })
      : await apiPost<{ tasks: Task[]; operation_id?: string; hierarchy_counts?: TaskHierarchyCounts }>('/api/tasks/bulk-update', { items, property: mutation.property, value: mutation.property === 'due_at' ? dateValue : mutation.value, operation_id: operationID })
    setBusy(false)
    if (!result.success || !result.data?.tasks) { onError(result.error || 'No se pudo aplicar el cambio masivo. No se modificó ninguna tarea.'); await onRefresh(); return }
    result.data.tasks.forEach(task => onCanonicalTask(task, 'bulk_updated'))
    onHierarchyCounts?.(result.data.hierarchy_counts, result.data.operation_id || operationID)
    setSelectedIDs([]); setSelectionAnchor(''); setAnnouncement(`${result.data.tasks.length} tareas actualizadas`)
    await onRefresh()
  }
  const bulkMove = async () => {
    const target = lists.find(list => list.id === pendingListID)
    if (!target) return
    await mutate(selectedIDs, { endpoint: 'move', listId: target.id })
    setMoveDialog(false); setPendingListID('')
  }
  const bulkTrash = async () => {
    const affected = selectedTasks()
    const operationID = crypto.randomUUID()
    setBusy(true)
    const result = await apiPost<{ task_ids: string[]; operation_id?: string; hierarchy_counts?: TaskHierarchyCounts }>('/api/tasks/bulk-trash', { items: affected.map(task => ({ id: task.id, version: task.version || 1 })), confirmation: trashPhrase, operation_id: operationID })
    setBusy(false)
    if (!result.success) { onError(result.error || 'No se pudo mover la selección a Papelera'); return }
    onHierarchyCounts?.(result.data?.hierarchy_counts, result.data?.operation_id || operationID)
    setTrashDialog(false); setTrashPhrase(''); setSelectedIDs([]); await onRefresh()
  }
  const reorder = async (ids: string[], beforeTaskID: string) => {
    const affected = ids.map(id => localTasks.find(task => task.id === id)).filter((task): task is Task => Boolean(task && !task.parent_task_id))
    if (!affected.length || ids.includes(beforeTaskID)) return
    const snapshot = localTasks
    const operationID = crypto.randomUUID()
    setLocalTasks(current => reorderTaskSelection(current, ids, beforeTaskID))
    setBusy(true)
    const result = await apiPost<{ tasks: Task[]; operation_id?: string; hierarchy_counts?: TaskHierarchyCounts }>('/api/tasks/bulk-move', { items: affected.map(task => ({ id: task.id, version: task.version || 1 })), before_task_id: beforeTaskID, operation_id: operationID })
    setBusy(false)
    if (!result.success || !result.data?.tasks) {
      setLocalTasks(snapshot)
      onError(result.error || 'No se pudo guardar el nuevo orden. Se restauró la lista.')
      return
    }
    result.data.tasks.forEach(task => onCanonicalTask(task, 'bulk_reordered'))
    onHierarchyCounts?.(result.data.hierarchy_counts, result.data.operation_id || operationID)
    setAnnouncement(`${result.data.tasks.length} tareas reordenadas`)
    await onRefresh()
  }
  const startDrag = (event: DragStartEvent) => {
    const id = String(event.active.id)
    const ids = selected.has(id) ? selectedIDs : [id]
    if (!selected.has(id)) setSelectedIDs([id])
    setDragIDs(ids)
    setAnnouncement(`Moviendo ${ids.length} ${ids.length === 1 ? 'tarea' : 'tareas'}`)
  }
  const endDrag = (event: DragEndEvent) => {
    const ids = dragIDs
    setDragIDs([])
    if (!event.over) return
    const overID = String(event.over.id)
    const destinationKey = overID.startsWith('group:') ? overID.slice(6) : String(event.over.data.current?.groupKey || '')
    const group = groups.find(item => item.key === destinationKey)
    if (!group) return
    const sourceKey = String(event.active.data.current?.groupKey || '')
    if (!overID.startsWith('group:') && overID !== String(event.active.id) && destinationKey === sourceKey && !ids.includes(overID)) {
      void reorder(ids, overID)
      return
    }
    const mutation = taskListDropMutation(groupBy, group)
    if (!mutation) {
      return
    }
    if (mutation.endpoint === 'date') { setDueDialog({ ids, clear: mutation.clear }); setDueValue(''); return }
    void mutate(ids, mutation)
  }
  return <div ref={containerRef} className="min-h-0 space-y-3 pb-8"><div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white/95 p-2.5 shadow-sm backdrop-blur"><span className="flex items-center gap-2 px-2 text-[11px] font-black uppercase tracking-[.12em] text-slate-400"><Layers3 className="h-4 w-4" />Agrupar por</span><TaskSelectPicker value={groupBy} options={groupOptions.map(option => ({ ...option, leading: <Layers3 className="h-4 w-4" />, description: option.value === 'none' ? 'Orden manual continuo' : `Organiza las filas por ${option.label.toLocaleLowerCase('es')}` }))} onChange={value => onGroupingChange(value as TaskGroupBy, groupDirection, [])} label="Agrupar tareas por" className="!min-h-9 !w-56 !py-1" /><button type="button" onClick={() => onGroupingChange(groupBy, groupDirection === 'asc' ? 'desc' : 'asc', collapsedGroupKeys)} title="Cambiar dirección" className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50">{groupDirection === 'asc' ? <ArrowDownAZ className="h-4 w-4" /> : <ArrowUpAZ className="h-4 w-4" />}</button>{selectedIDs.length > 0 && <div className="ml-auto flex flex-wrap items-center gap-2"><span className="rounded-full bg-emerald-600 px-2.5 py-1 text-[10px] font-black text-white">{selectedIDs.length}</span><button onClick={() => setMoveDialog(true)} className="flex min-h-9 items-center gap-1.5 rounded-xl border border-slate-200 px-3 text-xs font-bold text-slate-600 hover:border-emerald-300"><MoveRight className="h-4 w-4" />Mover</button><button onClick={() => setTrashDialog(true)} className="flex min-h-9 items-center gap-1.5 rounded-xl border border-rose-200 px-3 text-xs font-bold text-rose-600 hover:bg-rose-50"><Trash2 className="h-4 w-4" />Papelera</button><button onClick={() => setSelectedIDs([])} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button></div>}</div><div className="sr-only" aria-live="polite">{announcement}</div>
    {!tasks.length && <div className="flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white text-center text-sm text-slate-400"><div><Layers3 className="mx-auto mb-2 h-6 w-6 text-slate-300" /><p>No hay tareas para esta vista.</p><p className="mt-1 text-xs">Puedes conservar o cambiar la agrupación antes de crear trabajo.</p></div></div>}
    <DndContext sensors={sensors} onDragStart={startDrag} onDragEnd={endDrag} onDragCancel={() => setDragIDs([])}><div className="space-y-3">{groups.map(group => { const collapsed = collapsedGroupKeys.includes(group.key); const ordered = group.tasks.map(task => task.id); return <GroupDrop key={group.key} group={group}><button type="button" aria-expanded={!collapsed} aria-controls={`task-list-group-${group.key}`} onClick={() => onGroupingChange(groupBy, groupDirection, collapsed ? collapsedGroupKeys.filter(key => key !== group.key) : [...collapsedGroupKeys, group.key])} className="flex w-full items-center gap-2 border-b border-slate-100 px-4 py-3 text-left"><ChevronDown className={`h-4 w-4 text-slate-400 transition motion-reduce:transition-none ${collapsed ? '-rotate-90' : ''}`} /><i className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: group.color }} /><span className="text-xs font-black uppercase tracking-wider text-slate-600">{group.label}</span><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-400">{group.tasks.length}</span></button><div {...({ inert: collapsed ? '' : undefined } as Record<string, string | undefined>)} id={`task-list-group-${group.key}`} role="region" aria-label={`Tareas en ${group.label}`} aria-hidden={collapsed} className={`grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none ${collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}><div className="min-h-0 overflow-hidden"><SortableContext items={ordered} strategy={verticalListSortingStrategy}><div className="divide-y divide-slate-100">{group.tasks.map(task => <SortableRow key={task.id} task={task} groupKey={group.key} selected={selected.has(task.id)} selectionMode={selectedIDs.length > 0} density={density} allStatuses={statuses} onOpen={() => onOpen(task)} onSelect={shift => toggleSelection(task.id, shift, ordered)} onStatus={statusID => onStatus(task, statusID)} onStar={() => onStar(task)} />)}{!group.tasks.length && <p className="px-4 py-6 text-center text-xs text-slate-400">Suelta aquí para quitar la fecha, previa confirmación.</p>}</div></SortableContext></div></div></GroupDrop> })}</div><DragOverlay style={{ zIndex: TASK_OVERLAY_LAYERS.dragOverlay }}>{dragIDs.length > 0 && <div className="relative w-72"><div className="absolute inset-0 translate-x-2 translate-y-2 rotate-2 rounded-xl border border-emerald-200 bg-white/80" /><div className="relative rounded-xl border border-emerald-400 bg-white p-3 shadow-2xl"><div className="flex items-center gap-2"><GripVertical className="h-4 w-4 text-emerald-600" /><p className="truncate text-sm font-black text-slate-800">{localTasks.find(task => task.id === dragIDs[0])?.title}</p></div><p className="mt-1 text-[10px] font-bold text-emerald-700">{dragIDs.length} {dragIDs.length === 1 ? 'tarea' : 'tareas'}</p></div></div>}</DragOverlay></DndContext>
    {moveDialog && createPortal(<div className="fixed inset-0 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm" style={{ zIndex: TASK_OVERLAY_LAYERS.confirmation }}><div role="dialog" aria-modal="true" className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl"><p className="text-[10px] font-black uppercase tracking-[.16em] text-emerald-600">Acción preparada</p><h2 className="mt-1 text-xl font-black text-slate-900">Mover {selectedIDs.length} tareas</h2><p className="mt-2 text-sm leading-6 text-slate-500">Elige el destino. Las subtareas acompañarán a sus tareas principales y los estados se remapearán por categoría. Nada cambiará hasta confirmar.</p><label className="mt-4 block text-xs font-bold text-slate-600">Lista destino<span className="mt-2 block"><TaskListPicker value={pendingListID} lists={lists} folders={folders} onChange={setPendingListID} /></span></label>{pendingListID && <div className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">Destino preparado: {lists.find(list => list.id === pendingListID)?.name}</div>}<div className="mt-6 flex justify-end gap-2"><button onClick={() => { setMoveDialog(false); setPendingListID('') }} className="rounded-xl px-4 py-2.5 text-sm font-bold text-slate-600">Cancelar</button><button disabled={!pendingListID || busy} onClick={() => void bulkMove()} className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-black text-white disabled:opacity-40">{busy ? 'Moviendo…' : 'Confirmar movimiento'}</button></div></div></div>, document.body)}
    {trashDialog && createPortal(<div className="fixed inset-0 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm" style={{ zIndex: TASK_OVERLAY_LAYERS.confirmation }}><div role="alertdialog" aria-modal="true" className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl"><p className="text-[10px] font-black uppercase tracking-[.16em] text-rose-600">Acción masiva protegida</p><h2 className="mt-1 text-xl font-black text-slate-900">Mover a Papelera</h2><p className="mt-2 text-sm leading-6 text-slate-500">Se moverán {selectedIDs.length} tareas y sus subtareas. Podrás restaurarlas durante el plazo configurado; no se eliminarán permanentemente.</p><label className="mt-4 block text-xs font-bold text-slate-600">Escribe exactamente <strong>MOVER {selectedIDs.length} TAREAS</strong><input value={trashPhrase} onChange={event => setTrashPhrase(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3 outline-none focus:border-rose-400 focus:ring-4 focus:ring-rose-100" /></label><div className="mt-6 flex justify-end gap-2"><button onClick={() => { setTrashDialog(false); setTrashPhrase('') }} className="rounded-xl px-4 py-2.5 text-sm font-bold text-slate-600">Cancelar</button><button disabled={trashPhrase !== `MOVER ${selectedIDs.length} TAREAS` || busy} onClick={() => void bulkTrash()} className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-black text-white disabled:opacity-40">{busy ? 'Moviendo…' : 'Mover a Papelera'}</button></div></div></div>, document.body)}
    {dueDialog && createPortal(<div className="fixed inset-0 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm" style={{ zIndex: TASK_OVERLAY_LAYERS.confirmation }}><div role="dialog" aria-modal="true" className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl"><h2 className="text-lg font-black text-slate-900">{dueDialog.clear ? 'Quitar vencimiento' : 'Confirmar fecha exacta'}</h2><p className="mt-2 text-sm leading-6 text-slate-500">{dueDialog.clear ? 'El drop nunca quita fechas automáticamente. Confirma para dejar estas tareas sin fecha.' : 'El grupo temporal no asigna una fecha automática. Elige el día y hora exactos.'}</p>{!dueDialog.clear && <div className="mt-4"><TaskDateTimePicker label="Nueva entrega" value={dueValue} onChange={setDueValue} /></div>}<div className="mt-6 flex justify-end gap-2"><button onClick={() => setDueDialog(null)} className="rounded-xl px-4 py-2.5 text-sm font-bold text-slate-600">Cancelar</button><button disabled={!dueDialog.clear && !dueValue} onClick={() => { const pending = dueDialog; setDueDialog(null); void mutate(pending.ids, { endpoint: 'update', property: 'due_at', value: dueValue }, pending.clear ? null : new Date(dueValue).toISOString()) }} className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-black text-white disabled:opacity-40">Confirmar</button></div></div></div>, document.body)}
  </div>
}
