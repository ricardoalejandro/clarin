'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  getFirstCollision,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  defaultAnimateLayoutChanges,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  type AnimateLayoutChanges,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  CalendarDays,
  Check,
  ChevronLeft,
  Flag,
  GripVertical,
  ListChecks,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Star,
  UserRound,
  X,
} from 'lucide-react'
import { apiPost } from '@/lib/api'
import {
  TASK_PRIORITY_CONFIG,
  Task,
  TaskList,
  TaskMoveResponse,
  TaskPriority,
  TaskWorkflowStatus,
} from '@/types/task'
import TaskUserCombobox from './TaskUserCombobox'
import type { TaskAccountUser } from './TaskEditorModal'

export interface TaskInlineDraft {
  title: string
  listId: string
  statusId: string
  ownerId: string
  dueDate: string
  priority: TaskPriority
}

interface Props {
  tasks: Task[]
  statuses: TaskWorkflowStatus[]
  allStatuses: TaskWorkflowStatus[]
  lists: TaskList[]
  users: TaskAccountUser[]
  currentUserId: string
  defaultListId?: string
  showListName?: boolean
  collapsedStatusIds: string[]
  onCollapsedStatusIdsChange: (ids: string[]) => void
  onTasksChange: Dispatch<SetStateAction<Task[]>>
  onCanonicalTask: (task: Task, action?: string) => boolean
  onOperation: (operationId: string, active: boolean) => void
  onDragStateChange: (active: boolean) => void
  onOpen: (task: Task) => void
  onEdit: (task: Task) => void
  onCreateSubtask: (task: Task) => void
  onCreateFull: (statusId?: string, draft?: TaskInlineDraft) => void
  onConfigureStatuses: () => void
  onStar: (task: Task) => void | Promise<void>
  onQuickUpdate: (task: Task, body: Record<string, unknown>) => Promise<Task | undefined>
  onRefresh: () => void | Promise<void>
  onError: (message: string) => void
}

type ColumnOrders = Record<string, string[]>

const dueFormatter = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' })
const animateTaskLayoutChanges: AnimateLayoutChanges = args => args.previousItems !== args.items
  ? false
  : defaultAnimateLayoutChanges(args)

function isSyntheticStatus(status: TaskWorkflowStatus) {
  return status.id.startsWith('category:')
}

function taskBelongsToColumn(task: Task, status: TaskWorkflowStatus) {
  return isSyntheticStatus(status)
    ? task.status_detail?.category === status.category
    : task.status_id === status.id
}

function resolvedStatus(task: Task, boardStatus: TaskWorkflowStatus, allStatuses: TaskWorkflowStatus[]) {
  if (!isSyntheticStatus(boardStatus)) return allStatuses.find(status => status.id === boardStatus.id) || boardStatus
  if (task.status_detail?.category === boardStatus.category) {
    return allStatuses.find(status => status.id === task.status_id) || task.status_detail
  }
  return allStatuses.find(status => status.workflow_id === task.status_detail?.workflow_id && status.category === boardStatus.category)
}

function upsertTask(tasks: Task[], incoming: Task) {
  const index = tasks.findIndex(task => task.id === incoming.id)
  if (index < 0) return [incoming, ...tasks]
  return tasks.map(task => task.id === incoming.id ? incoming : task)
}

function resolvedCreateStatus(boardStatus: TaskWorkflowStatus, list: TaskList | undefined, allStatuses: TaskWorkflowStatus[]) {
  if (!isSyntheticStatus(boardStatus)) return allStatuses.find(status => status.id === boardStatus.id) || boardStatus
  if (!list?.workflow_id) return undefined
  return allStatuses.find(status => status.workflow_id === list.workflow_id && status.category === boardStatus.category)
}

function initialOrders(tasks: Task[], statuses: TaskWorkflowStatus[], lists: TaskList[], groupByList: boolean): ColumnOrders {
  const listRanks = new Map(lists.map((list, index) => [list.id, index]))
  const sorted = [...tasks].sort((a, b) => {
    if (groupByList) {
      const rankDelta = (listRanks.get(a.list_id || '') ?? Number.MAX_SAFE_INTEGER) - (listRanks.get(b.list_id || '') ?? Number.MAX_SAFE_INTEGER)
      if (rankDelta) return rankDelta
      const listDelta = (a.list_id || '').localeCompare(b.list_id || '')
      if (listDelta) return listDelta
    }
    return (a.sort_order || 0) - (b.sort_order || 0) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
  })
  return Object.fromEntries(statuses.map(status => [status.id, sorted.filter(task => taskBelongsToColumn(task, status)).map(task => task.id)]))
}

function findColumn(orders: ColumnOrders, taskId: string) {
  return Object.keys(orders).find(columnId => orders[columnId]?.includes(taskId))
}

function sameOrder(left: string[] | undefined, right: string[] | undefined) {
  if (left === right) return true
  if (!left || !right || left.length !== right.length) return false
  return left.every((id, index) => id === right[index])
}

function isBelowTarget(event: DragOverEvent | DragEndEvent) {
  if (event.activatorEvent.type === 'keydown') return event.delta.y > 0 || (event.delta.y === 0 && event.delta.x > 0)
  return Boolean(event.active.rect.current.translated && event.active.rect.current.translated.top > event.over!.rect.top + event.over!.rect.height / 2)
}

function insertTaskInColumn({
  orders,
  activeId,
  destination,
  overId,
  below,
  groupByList,
  tasksById,
  lists,
}: {
  orders: ColumnOrders
  activeId: string
  destination: string
  overId?: string
  below: boolean
  groupByList: boolean
  tasksById: Map<string, Task>
  lists: TaskList[]
}) {
  const source = findColumn(orders, activeId)
  const task = tasksById.get(activeId)
  if (!source || !task || !orders[destination]) return orders

  const sourceItems = orders[source].filter(id => id !== activeId)
  const destinationItems = (source === destination ? sourceItems : orders[destination]).filter(id => id !== activeId)
  const overIndex = overId && overId !== activeId ? destinationItems.indexOf(overId) : -1
  let destinationIndex = destinationItems.length

  if (groupByList) {
    const overTask = overId ? tasksById.get(overId) : undefined
    if (overIndex >= 0 && overTask?.list_id === task.list_id) {
      destinationIndex = overIndex + (below ? 1 : 0)
    } else {
      const sameListIndexes = destinationItems.flatMap((id, index) => tasksById.get(id)?.list_id === task.list_id ? [index] : [])
      if (sameListIndexes.length) {
        destinationIndex = sameListIndexes[sameListIndexes.length - 1] + 1
      } else {
        const taskListRank = lists.findIndex(list => list.id === task.list_id)
        const nextListIndex = destinationItems.findIndex(id => {
          const candidateListRank = lists.findIndex(list => list.id === tasksById.get(id)?.list_id)
          return candidateListRank >= 0 && (taskListRank < 0 || candidateListRank > taskListRank)
        })
        if (nextListIndex >= 0) destinationIndex = nextListIndex
      }
    }
  } else if (overIndex >= 0) {
    destinationIndex = overIndex + (below ? 1 : 0)
  }

  const nextDestination = [...destinationItems]
  nextDestination.splice(destinationIndex, 0, activeId)
  if (source === destination && sameOrder(orders[source], nextDestination)) return orders

  return {
    ...orders,
    [source]: sourceItems,
    [destination]: nextDestination,
  }
}

function updateTaskStatus(task: Task, status: TaskWorkflowStatus): Task {
  return {
    ...task,
    status_id: status.id,
    status_detail: status,
    status: status.category === 'done' ? 'completed' : status.category === 'cancelled' ? 'cancelled' : 'pending',
    progress: status.category === 'done' ? 100 : task.status_detail?.category === 'done' && task.progress === 100 ? 0 : task.progress,
  }
}

function materializeMove(tasks: Task[], activeTaskId: string, activeStatus: TaskWorkflowStatus, beforeTaskId: string | null) {
  const active = tasks.find(task => task.id === activeTaskId)
  if (!active) return tasks
  const canonical = tasks
    .filter(task => task.id !== activeTaskId && task.list_id === active.list_id && task.parent_task_id === active.parent_task_id)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id.localeCompare(b.id))
  let insertAt = canonical.length
  if (beforeTaskId) {
    const index = canonical.findIndex(task => task.id === beforeTaskId)
    if (index >= 0) insertAt = index
  } else {
    const lastTarget = canonical.reduce((last, task, index) => task.status_detail?.workflow_id === activeStatus.workflow_id && task.status_detail?.category === activeStatus.category ? index : last, -1)
    if (lastTarget >= 0) insertAt = lastTarget + 1
  }
  const previous = insertAt > 0 ? canonical[insertAt - 1]?.sort_order : undefined
  const following = insertAt < canonical.length ? canonical[insertAt]?.sort_order : undefined
  const sortOrder = previous === undefined && following === undefined ? 1024
    : previous === undefined ? (following || 1024) / 2
      : following === undefined ? previous + 1024
        : previous + (following - previous) / 2
  return tasks.map(task => task.id === activeTaskId ? { ...updateTaskStatus(task, activeStatus), sort_order: sortOrder } : task)
}

function applyCanonicalOrder(tasks: Task[], response: TaskMoveResponse) {
  const canonicalTask = response.task
  const positions = new Map((response.order?.task_ids || []).map((id, index) => [id, (index + 1) * 1024]))
  return tasks.map(task => {
    const next = task.id === canonicalTask.id ? canonicalTask : task
    const sortOrder = positions.get(task.id)
    return sortOrder === undefined ? next : { ...next, sort_order: sortOrder }
  })
}

function stopControlStart(event: React.SyntheticEvent) {
  event.stopPropagation()
}

function TaskBoardCard({
  task,
  columnId,
  showListName,
  suppressOpen,
  onOpen,
  onEdit,
  onCreateSubtask,
  onStar,
  onComplete,
}: {
  task: Task
  columnId: string
  showListName?: boolean
  suppressOpen: () => boolean
  onOpen: () => void
  onEdit: () => void
  onCreateSubtask: () => void
  onStar: () => void
  onComplete?: () => void
}) {
  const sortableData = useMemo(() => ({ type: 'task', columnId, listId: task.list_id }), [columnId, task.list_id])
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: sortableData,
    animateLayoutChanges: animateTaskLayoutChanges,
  })
  const overdue = Boolean(task.due_at && new Date(task.due_at) < new Date() && !['done', 'cancelled'].includes(task.status_detail?.category || ''))
  const done = task.status_detail?.category === 'done'
  const priority = TASK_PRIORITY_CONFIG[task.priority]

  return <article
    ref={setNodeRef}
    data-task-id={task.id}
    data-task-column-id={columnId}
    style={{ transform: CSS.Transform.toString(transform), transition }}
    {...attributes}
    {...listeners}
    onClick={() => { if (!suppressOpen()) onOpen() }}
    className={`group relative cursor-grab touch-manipulation select-none overflow-hidden rounded-xl border bg-white p-3 text-left shadow-sm outline-none transition focus-visible:ring-2 focus-visible:ring-emerald-500 active:cursor-grabbing ${isDragging ? 'opacity-20' : 'hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md'} ${overdue ? 'border-rose-200' : 'border-slate-200'}`}
  >
    <span className="absolute inset-y-0 left-0 w-0.5" style={{ backgroundColor: task.status_detail?.color || '#64748b' }} />
    <div className="flex items-start gap-2">
      <button
        type="button"
        disabled={!onComplete}
        onPointerDown={stopControlStart}
        onMouseDown={stopControlStart}
        onTouchStart={stopControlStart}
        onClick={event => { event.stopPropagation(); onComplete?.() }}
        title={done ? onComplete ? 'Marcar como pendiente' : 'Tarea completada' : onComplete ? 'Marcar como completada' : 'Este flujo no tiene estado completado'}
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-50 ${done ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 bg-white hover:border-emerald-500 hover:bg-emerald-50'}`}
      >{done && <Check className="h-3 w-3" />}</button>
      <h4 className={`min-w-0 flex-1 text-sm font-semibold leading-5 ${done ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{task.title}</h4>
      <GripVertical className="mt-0.5 h-4 w-4 shrink-0 text-slate-200 transition group-hover:text-slate-400" />
    </div>

    {showListName && <p className="ml-7 mt-1 truncate text-[10px] font-medium text-slate-400">{task.list_name || 'Bandeja general'}</p>}

    <div className="ml-7 mt-2.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px]">
      {(task.priority === 'high' || task.priority === 'urgent') && <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-semibold ${priority.bg} ${priority.color}`}><Flag className="h-3 w-3" />{priority.label}</span>}
      {task.due_at && <span className={`inline-flex items-center gap-1 rounded-md bg-slate-50 px-1.5 py-1 font-medium ${overdue ? 'bg-rose-50 text-rose-600' : 'text-slate-500'}`}><CalendarDays className="h-3 w-3" />{dueFormatter.format(new Date(task.due_at))}</span>}
      {Boolean(task.subtask_count) && <span className={`inline-flex items-center gap-1 rounded-md bg-slate-50 px-1.5 py-1 ${task.subtask_done === task.subtask_count ? 'text-emerald-600' : 'text-slate-400'}`}><ListChecks className="h-3 w-3" />{task.subtask_done}/{task.subtask_count}</span>}
      {Boolean(task.comment_count) && <span className="inline-flex items-center gap-1 text-slate-400"><MessageCircle className="h-3 w-3" />{task.comment_count}</span>}
      {Boolean(task.attachment_count) && <span className="inline-flex items-center gap-1 text-slate-400"><Paperclip className="h-3 w-3" />{task.attachment_count}</span>}
      <span className="ml-auto flex h-6 min-w-6 items-center justify-center rounded-full bg-slate-100 px-1.5 font-bold text-slate-500" title={task.assigned_to_name || 'Sin responsable'}>{(task.assigned_to_name || '?').slice(0, 2).toUpperCase()}</span>
    </div>

    <div className="pointer-events-none absolute right-2 top-2 flex translate-y-[-3px] items-center gap-0.5 rounded-lg border border-slate-200 bg-white p-0.5 opacity-0 shadow-lg transition group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:translate-y-0 [@media(pointer:coarse)]:opacity-100">
      <button type="button" onPointerDown={stopControlStart} onMouseDown={stopControlStart} onTouchStart={stopControlStart} onClick={event => { event.stopPropagation(); onCreateSubtask() }} title="Crear subtarea" className="rounded-md p-1.5 text-slate-400 hover:bg-emerald-50 hover:text-emerald-700"><Plus className="h-3.5 w-3.5" /></button>
      <button type="button" onPointerDown={stopControlStart} onMouseDown={stopControlStart} onTouchStart={stopControlStart} onClick={event => { event.stopPropagation(); onEdit() }} title="Editar tarea" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><Pencil className="h-3.5 w-3.5" /></button>
      <button type="button" onPointerDown={stopControlStart} onMouseDown={stopControlStart} onTouchStart={stopControlStart} onClick={event => { event.stopPropagation(); onStar() }} title={task.starred ? 'Quitar de favoritas' : 'Añadir a favoritas'} className={`rounded-md p-1.5 hover:bg-amber-50 ${task.starred ? 'text-amber-500' : 'text-slate-400 hover:text-amber-500'}`}><Star className={`h-3.5 w-3.5 ${task.starred ? 'fill-current' : ''}`} /></button>
    </div>
  </article>
}

function InlineCreate({
  status,
  allStatuses,
  lists,
  defaultListId,
  users,
  currentUserId,
  onCreated,
  onMore,
}: {
  status: TaskWorkflowStatus
  allStatuses: TaskWorkflowStatus[]
  lists: TaskList[]
  defaultListId?: string
  users: TaskAccountUser[]
  currentUserId: string
  onCreated: (task: Task) => void
  onMore: (statusId?: string, draft?: TaskInlineDraft) => void
}) {
  const [open, setOpen] = useState(false)
  const [listId, setListId] = useState(defaultListId || (lists.length === 1 ? lists[0].id : ''))
  const [title, setTitle] = useState('')
  const [ownerId, setOwnerId] = useState(currentUserId || users[0]?.id || '')
  const [dueDate, setDueDate] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const list = lists.find(item => item.id === listId)
  const targetStatus = resolvedCreateStatus(status, list, allStatuses)

  useEffect(() => {
    if (!ownerId && (currentUserId || users[0]?.id)) setOwnerId(currentUserId || users[0].id)
  }, [currentUserId, ownerId, users])
  useEffect(() => {
    if (lists.some(item => item.id === listId)) return
    setListId(lists.find(item => item.id === defaultListId)?.id || (lists.length === 1 ? lists[0].id : ''))
  }, [defaultListId, listId, lists])

  const draft = (): TaskInlineDraft | undefined => list && targetStatus ? {
    title: title.trim(), listId: list.id, statusId: targetStatus.id, ownerId, dueDate, priority,
  } : undefined

  const close = () => { setOpen(false); setTitle(''); setDueDate(''); setPriority('medium'); setError('') }
  const create = async () => {
    if (!title.trim() || !ownerId || !list || !targetStatus || saving) return
    setSaving(true)
    setError('')
    const result = await apiPost<{ task: Task }>('/api/tasks', {
      title: title.trim(),
      description: '',
      type: 'reminder',
      priority,
      assigned_to: ownerId,
      list_id: list.id,
      status_id: targetStatus.id,
      due_at: dueDate ? new Date(`${dueDate}T17:00:00`).toISOString() : '',
      recurrence_rule: '',
      reminder_minutes: 0,
      placement: 'top',
    })
    if (!result.success || !result.data?.task) {
      setError(result.error || 'No se pudo crear la tarea')
      setSaving(false)
      return
    }
    onCreated(result.data.task)
    setSaving(false)
    close()
  }

  if (!open) return <button type="button" onClick={() => setOpen(true)} className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-xs font-semibold text-slate-500 transition hover:bg-white hover:text-emerald-700"><Plus className="h-3.5 w-3.5" />Agregar tarea</button>

  return <div className="rounded-xl border border-emerald-300 bg-white p-2.5 shadow-lg shadow-emerald-950/5">
    <input autoFocus value={title} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void create() } if (event.key === 'Escape') { event.preventDefault(); close() } }} placeholder="Nombre de la tarea…" className="w-full bg-transparent text-sm font-semibold text-slate-800 outline-none placeholder:text-slate-300" />
    {lists.length > 1 && <select value={listId} onChange={event => setListId(event.target.value)} aria-label="Lista de la tarea" className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-[11px] font-semibold text-slate-600 outline-none focus:border-emerald-400"><option value="">Selecciona una lista…</option>{lists.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
    {!list && <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[10px] font-medium text-amber-700">Selecciona una lista para crear desde el tablero.</p>}
    {list && !targetStatus && <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[10px] font-medium text-amber-700">La lista no tiene un estado equivalente.</p>}
    <div className="mt-2 grid grid-cols-2 gap-1.5">
      <TaskUserCombobox users={users} value={ownerId} onChange={setOwnerId} className="min-h-9 !rounded-lg !px-2 !py-1 text-xs" />
      <input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} aria-label="Fecha de entrega" className="min-w-0 rounded-lg border border-slate-200 px-2 text-[11px] text-slate-500 outline-none focus:border-emerald-400" />
      <select value={priority} onChange={event => setPriority(event.target.value as TaskPriority)} aria-label="Prioridad" className="rounded-lg border border-slate-200 px-2 py-2 text-[11px] font-medium text-slate-600 outline-none focus:border-emerald-400">{(Object.keys(TASK_PRIORITY_CONFIG) as TaskPriority[]).map(value => <option key={value} value={value}>{TASK_PRIORITY_CONFIG[value].label}</option>)}</select>
      <button type="button" onClick={() => { const snapshot = draft(); const selectedStatusId = targetStatus?.id; close(); onMore(selectedStatusId, snapshot) }} className="rounded-lg border border-slate-200 px-2 py-2 text-[11px] font-semibold text-slate-500 hover:bg-slate-50">Más opciones</button>
    </div>
    {error && <p className="mt-2 text-[10px] font-medium text-rose-600">{error}</p>}
    <div className="mt-2 flex items-center justify-between"><span className="text-[9px] text-slate-400">Enter para guardar · Esc para cancelar</span><div className="flex gap-1"><button type="button" onClick={close} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Cancelar"><X className="h-3.5 w-3.5" /></button><button type="button" disabled={!title.trim() || !ownerId || !list || !targetStatus || saving} onClick={() => void create()} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[11px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">{saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}Crear</button></div></div>
  </div>
}

function BoardColumn({
  status,
  taskIds,
  tasksById,
  allStatuses,
  users,
  currentUserId,
  lists,
  defaultListId,
  collapsed,
  temporarilyExpanded,
  activeTask,
  showListName,
  suppressOpen,
  onCollapse,
  onConfigureStatuses,
  onTaskCreated,
  onCreateFull,
  onOpen,
  onEdit,
  onCreateSubtask,
  onStar,
  onComplete,
}: {
  status: TaskWorkflowStatus
  taskIds: string[]
  tasksById: Map<string, Task>
  allStatuses: TaskWorkflowStatus[]
  users: TaskAccountUser[]
  currentUserId: string
  lists: TaskList[]
  defaultListId?: string
  collapsed: boolean
  temporarilyExpanded: boolean
  activeTask?: Task
  showListName?: boolean
  suppressOpen: () => boolean
  onCollapse: () => void
  onConfigureStatuses: () => void
  onTaskCreated: (task: Task) => void
  onCreateFull: (statusId?: string, draft?: TaskInlineDraft) => void
  onOpen: (task: Task) => void
  onEdit: (task: Task) => void
  onCreateSubtask: (task: Task) => void
  onStar: (task: Task) => void
  onComplete: (task: Task, status: TaskWorkflowStatus) => void
}) {
  const expanded = !collapsed || temporarilyExpanded
  const defaultList = lists.find(item => item.id === defaultListId)
  const canReceive = !activeTask || Boolean(resolvedStatus(activeTask, status, allStatuses))
  const droppableData = useMemo(() => ({ type: 'column', columnId: status.id }), [status.id])
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status.id}`, data: droppableData, disabled: !canReceive })
  const [menuOpen, setMenuOpen] = useState(false)
  const statusColor = status.color || '#64748b'

  if (!expanded) return <section ref={setNodeRef} data-task-column-id={status.id} data-task-column-collapsed="true" className={`flex h-full w-12 shrink-0 flex-col items-center overflow-hidden rounded-2xl border bg-white shadow-sm transition ${isOver && canReceive ? 'border-emerald-400 ring-2 ring-emerald-200' : 'border-slate-200'}`}>
    <button type="button" onClick={onCollapse} className="flex h-full w-full flex-col items-center gap-3 py-3 text-slate-500 hover:bg-slate-50" title={`Expandir ${status.name}`}>
      <ChevronLeft className="h-4 w-4 rotate-180" />
      <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-slate-100 px-1 text-[10px] font-bold">{taskIds.length}</span>
      <span className="[writing-mode:vertical-rl] text-[10px] font-bold uppercase tracking-[.14em]">{status.name}</span>
    </button>
  </section>

  return <section ref={setNodeRef} data-task-column-id={status.id} data-task-column-collapsed="false" className={`flex h-full min-h-[360px] w-[300px] shrink-0 flex-col overflow-hidden rounded-2xl border shadow-sm transition ${isOver && canReceive ? 'border-emerald-400 ring-2 ring-emerald-200' : 'border-slate-200'}`} style={{ background: `color-mix(in srgb, ${statusColor} 6%, #f8fafc)` }}>
    <header className="relative flex shrink-0 items-center gap-2 border-b border-white/80 bg-white/85 px-3 py-2.5 backdrop-blur">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-slate-100" style={{ backgroundColor: statusColor }} />
      <h3 className="min-w-0 truncate text-xs font-black uppercase tracking-[.08em] text-slate-700">{status.name}</h3>
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold tabular-nums text-slate-500">{taskIds.length}</span>
      <div className="ml-auto flex items-center gap-0.5">
        <button type="button" onClick={() => onCreateFull(resolvedCreateStatus(status, defaultList, allStatuses)?.id)} title="Crear tarea con todos los campos" className="rounded-lg p-1.5 text-slate-400 hover:bg-emerald-50 hover:text-emerald-700"><Plus className="h-3.5 w-3.5" /></button>
        <button type="button" onClick={() => setMenuOpen(value => !value)} aria-expanded={menuOpen} aria-haspopup="menu" title="Opciones de columna" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><MoreHorizontal className="h-4 w-4" /></button>
      </div>
      {menuOpen && <><button type="button" aria-label="Cerrar menú" onClick={() => setMenuOpen(false)} className="fixed inset-0 z-20 cursor-default" /><div role="menu" className="absolute right-2 top-10 z-30 w-48 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl">
        <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onCollapse() }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-slate-600 hover:bg-slate-50"><ChevronLeft className="h-3.5 w-3.5" />Contraer columna</button>
        {!isSyntheticStatus(status) && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onConfigureStatuses() }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-slate-600 hover:bg-slate-50"><Pencil className="h-3.5 w-3.5" />Modificar estados</button>}
      </div></>}
    </header>

    <div className="shrink-0 px-2 pt-2"><InlineCreate status={status} allStatuses={allStatuses} lists={lists} defaultListId={defaultListId} users={users} currentUserId={currentUserId} onCreated={onTaskCreated} onMore={onCreateFull} /></div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 [scrollbar-width:thin]">
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy} id={`sortable:${status.id}`}>
        <div className="min-h-[96px] space-y-2">
          {taskIds.map(taskId => {
            const task = tasksById.get(taskId)
            if (!task) return null
            const toggleStatus = allStatuses.find(item => item.workflow_id === task.status_detail?.workflow_id && item.category === (task.status_detail?.category === 'done' ? 'not_started' : 'done'))
            return <TaskBoardCard key={task.id} task={task} columnId={status.id} showListName={showListName} suppressOpen={suppressOpen} onOpen={() => onOpen(task)} onEdit={() => onEdit(task)} onCreateSubtask={() => onCreateSubtask(task)} onStar={() => onStar(task)} onComplete={toggleStatus ? () => onComplete(task, toggleStatus) : undefined} />
          })}
          {!taskIds.length && <div className={`flex min-h-[110px] flex-col items-center justify-center rounded-xl border border-dashed px-4 text-center transition ${isOver ? 'border-emerald-400 bg-white text-emerald-700' : 'border-slate-300/80 text-slate-400'}`}><UserRound className="h-5 w-5 opacity-50" /><p className="mt-2 text-xs font-semibold">{isOver ? 'Suelta aquí' : 'Sin tareas en este estado'}</p></div>}
        </div>
      </SortableContext>
    </div>
  </section>
}

function OverlayCard({ task }: { task: Task }) {
  return <div className="w-[284px] rotate-1 rounded-xl border border-emerald-300 bg-white p-3 shadow-2xl shadow-slate-900/20">
    <div className="flex items-start gap-2"><GripVertical className="mt-0.5 h-4 w-4 text-emerald-500" /><p className="line-clamp-2 text-sm font-semibold text-slate-800">{task.title}</p></div>
    <p className="ml-6 mt-2 truncate text-[10px] text-slate-400">{task.assigned_to_name || 'Sin responsable'}{task.list_name ? ` · ${task.list_name}` : ''}</p>
  </div>
}

export default function TaskBoard({
  tasks,
  statuses,
  allStatuses,
  lists,
  users,
  currentUserId,
  defaultListId,
  showListName,
  collapsedStatusIds,
  onCollapsedStatusIdsChange,
  onTasksChange,
  onCanonicalTask,
  onOperation,
  onDragStateChange,
  onOpen,
  onEdit,
  onCreateSubtask,
  onCreateFull,
  onConfigureStatuses,
  onStar,
  onQuickUpdate,
  onRefresh,
  onError,
}: Props) {
  const [localTasks, setLocalTasks] = useState(tasks)
  const groupByList = Boolean(showListName)
  const [orders, setOrders] = useState<ColumnOrders>(() => initialOrders(tasks, statuses, lists, groupByList))
  const ordersRef = useRef<ColumnOrders>(initialOrders(tasks, statuses, lists, groupByList))
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overColumnId, setOverColumnId] = useState<string | null>(null)
  const [moveError, setMoveError] = useState<{ message: string; retry: () => void } | null>(null)
  const snapshotRef = useRef<{ tasks: Task[]; orders: ColumnOrders } | null>(null)
  const boardViewportRef = useRef<HTMLDivElement | null>(null)
  const lastOverIdRef = useRef<string | null>(null)
  const validDestinationColumnIdsRef = useRef<Set<string>>(new Set(statuses.map(status => status.id)))
  const recentlyMovedToNewColumnRef = useRef(false)
  const recentlyMovedFrameRef = useRef<number | null>(null)
  const lastDragEndRef = useRef(0)
  const tasksById = useMemo(() => new Map(localTasks.map(task => [task.id, task])), [localTasks])
  const activeTask = activeId ? tasksById.get(activeId) : undefined

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 240, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => {
    if (activeId) return
    const nextOrders = initialOrders(tasks, statuses, lists, groupByList)
    setLocalTasks(tasks)
    setOrders(nextOrders)
    ordersRef.current = nextOrders
  }, [activeId, groupByList, lists, statuses, tasks])

  useEffect(() => () => {
    if (recentlyMovedFrameRef.current !== null) cancelAnimationFrame(recentlyMovedFrameRef.current)
  }, [])

  const markRecentlyMovedToNewColumn = useCallback(() => {
    recentlyMovedToNewColumnRef.current = true
    if (recentlyMovedFrameRef.current !== null) cancelAnimationFrame(recentlyMovedFrameRef.current)
    recentlyMovedFrameRef.current = requestAnimationFrame(() => {
      recentlyMovedToNewColumnRef.current = false
      recentlyMovedFrameRef.current = null
    })
  }, [])

  const collisionDetectionStrategy = useCallback<CollisionDetection>(args => {
    const activeIdentifier = String(args.active.id)
    const boardRect = boardViewportRef.current?.getBoundingClientRect()
    if (args.pointerCoordinates && boardRect) {
      const { x, y } = args.pointerCoordinates
      if (x < boardRect.left || x > boardRect.right || y < boardRect.top || y > boardRect.bottom) {
        lastOverIdRef.current = null
        return []
      }
    }

    const allowedContainers = args.droppableContainers.filter(container => {
      if (String(container.id) === activeIdentifier) return false
      const columnId = container.data.current?.columnId as string | undefined
      return !columnId || validDestinationColumnIdsRef.current.has(columnId)
    })
    const taskContainers = allowedContainers.filter(container => container.data.current?.type === 'task')
    const columnContainers = allowedContainers.filter(container => container.data.current?.type === 'column')

    let overId: string | null = null
    if (args.pointerCoordinates) {
      const taskCollisions = pointerWithin({ ...args, droppableContainers: taskContainers })
      overId = getFirstCollision(taskCollisions, 'id')?.toString() || null
      if (!overId) {
        const columnCollisions = pointerWithin({ ...args, droppableContainers: columnContainers })
        overId = getFirstCollision(columnCollisions, 'id')?.toString() || null
      }
    } else {
      const intersections = rectIntersection({ ...args, droppableContainers: allowedContainers })
      overId = getFirstCollision(intersections, 'id')?.toString() || null
      if (!overId) {
        const closest = closestCenter({ ...args, droppableContainers: allowedContainers })
        overId = getFirstCollision(closest, 'id')?.toString() || null
      }
    }

    if (overId?.startsWith('column:')) {
      const columnId = overId.slice(7)
      const itemIds = new Set((ordersRef.current[columnId] || []).filter(id => id !== activeIdentifier))
      const itemContainers = taskContainers.filter(container => itemIds.has(String(container.id)))
      if (itemContainers.length) {
        const closestItem = closestCenter({ ...args, droppableContainers: itemContainers })
        overId = getFirstCollision(closestItem, 'id')?.toString() || overId
      }
    }

    if (overId) {
      lastOverIdRef.current = overId
      return [{ id: overId }]
    }
    if (recentlyMovedToNewColumnRef.current && lastOverIdRef.current) {
      const lastOverStillExists = allowedContainers.some(container => String(container.id) === lastOverIdRef.current)
      if (lastOverStillExists) return [{ id: lastOverIdRef.current }]
    }
    lastOverIdRef.current = null
    return []
  }, [])

  const suppressOpen = useCallback(() => Date.now() - lastDragEndRef.current < 160, [])
  const toggleCollapsed = (statusId: string) => onCollapsedStatusIdsChange(collapsedStatusIds.includes(statusId) ? collapsedStatusIds.filter(id => id !== statusId) : [...collapsedStatusIds, statusId])

  const resetDrag = () => {
    if (recentlyMovedFrameRef.current !== null) {
      cancelAnimationFrame(recentlyMovedFrameRef.current)
      recentlyMovedFrameRef.current = null
    }
    recentlyMovedToNewColumnRef.current = false
    lastOverIdRef.current = null
    validDestinationColumnIdsRef.current = new Set(statuses.map(status => status.id))
    setActiveId(null)
    setOverColumnId(null)
    snapshotRef.current = null
    lastDragEndRef.current = Date.now()
    onDragStateChange(false)
  }

  const rollback = (snapshot: { tasks: Task[]; orders: ColumnOrders }) => {
    setLocalTasks(snapshot.tasks)
    setOrders(snapshot.orders)
    ordersRef.current = snapshot.orders
    onTasksChange(snapshot.tasks)
  }

  const move = useCallback(async (taskId: string, destinationColumnId: string, nextOrders: ColumnOrders, snapshot: { tasks: Task[]; orders: ColumnOrders }) => {
    const task = snapshot.tasks.find(item => item.id === taskId) || localTasks.find(item => item.id === taskId)
    const boardStatus = statuses.find(status => status.id === destinationColumnId)
    if (!task || !boardStatus) return
    const targetStatus = resolvedStatus(task, boardStatus, allStatuses)
    if (!targetStatus) {
      rollback(snapshot)
      const message = `El flujo de “${task.title}” no tiene un estado equivalente a ${boardStatus.name}.`
      setMoveError({ message, retry: () => undefined })
      onError(message)
      return
    }

    const destinationIds = nextOrders[destinationColumnId] || []
    const activeIndex = destinationIds.indexOf(taskId)
    const beforeTaskId = destinationIds.slice(activeIndex + 1).find(id => {
      const candidate = localTasks.find(item => item.id === id)
      return candidate?.list_id === task.list_id
        && candidate?.status_detail?.workflow_id === targetStatus.workflow_id
        && candidate?.status_detail?.category === targetStatus.category
    }) || null
    const operationId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${task.id}`
    const optimistic = materializeMove(localTasks, taskId, targetStatus, beforeTaskId)
    setLocalTasks(optimistic)
    setOrders(nextOrders)
    ordersRef.current = nextOrders
    onTasksChange(optimistic)
    onOperation(operationId, true)

    const execute = async () => {
      const result = await apiPost<TaskMoveResponse>(`/api/tasks/${task.id}/move`, {
        status_id: targetStatus.id,
        before_task_id: beforeTaskId,
        version: task.version,
        operation_id: operationId,
      })
      if (!result.success || !result.data?.task) {
        rollback(snapshot)
        const message = result.status === 409 ? 'La tarea cambió en otra sesión. Actualizamos el tablero para evitar sobrescribirla.' : result.error || 'No se pudo mover la tarea.'
        setMoveError({ message, retry: () => { setMoveError(null); if (result.status === 409) void onRefresh(); else void move(taskId, destinationColumnId, nextOrders, snapshot) } })
        if (result.status === 409) void onRefresh()
        onError(message)
        return
      }
      if (!onCanonicalTask(result.data.task, 'moved')) {
        await onRefresh()
        return
      }
      const committed = applyCanonicalOrder(optimistic, result.data)
      const committedOrders = initialOrders(committed, statuses, lists, groupByList)
      setLocalTasks(committed)
      setOrders(committedOrders)
      ordersRef.current = committedOrders
      onTasksChange(committed)
      setMoveError(null)
    }
    try {
      await execute()
    } finally {
      onOperation(operationId, false)
    }
  }, [allStatuses, groupByList, lists, localTasks, onCanonicalTask, onError, onOperation, onRefresh, onTasksChange, statuses])

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id)
    const task = tasksById.get(id)
    validDestinationColumnIdsRef.current = new Set(statuses.filter(status => !task || Boolean(resolvedStatus(task, status, allStatuses))).map(status => status.id))
    lastOverIdRef.current = null
    recentlyMovedToNewColumnRef.current = false
    snapshotRef.current = { tasks: localTasks, orders: Object.fromEntries(Object.entries(ordersRef.current).map(([key, ids]) => [key, [...ids]])) }
    setActiveId(id)
    setMoveError(null)
    onDragStateChange(true)
  }

  const destinationFromEvent = (event: DragOverEvent | DragEndEvent) => {
    if (!event.over) return undefined
    return event.over.data.current?.columnId as string | undefined || (String(event.over.id).startsWith('column:') ? String(event.over.id).slice(7) : findColumn(ordersRef.current, String(event.over.id)))
  }

  const handleDragOver = (event: DragOverEvent) => {
    if (!event.over) return
    const taskId = String(event.active.id)
    const overId = String(event.over.id)
    if (overId === taskId) return
    const destination = destinationFromEvent(event)
    if (!destination || !ordersRef.current[destination]) return
    const task = tasksById.get(taskId)
    const boardStatus = statuses.find(status => status.id === destination)
    if (!task || !boardStatus || !resolvedStatus(task, boardStatus, allStatuses)) return
    setOverColumnId(current => current === destination ? current : destination)

    const current = ordersRef.current
    const source = findColumn(current, taskId)
    if (!source || source === destination) return
    const below = isBelowTarget(event)
    const next = insertTaskInColumn({ orders: current, activeId: taskId, destination, overId, below, groupByList, tasksById, lists })
    if (next === current) return
    ordersRef.current = next
    setOrders(next)
    markRecentlyMovedToNewColumn()
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const taskId = String(event.active.id)
    const destination = destinationFromEvent(event)
    const snapshot = snapshotRef.current
    if (!event.over || !destination || !snapshot) {
      if (snapshot) rollback(snapshot)
      resetDrag()
      return
    }
    const overId = String(event.over.id)
    if (overId === taskId) {
      rollback(snapshot)
      resetDrag()
      return
    }
    const below = isBelowTarget(event)
    const current = ordersRef.current
    const nextOrders = insertTaskInColumn({ orders: current, activeId: taskId, destination, overId, below, groupByList, tasksById, lists })
    if (nextOrders !== current) {
      ordersRef.current = nextOrders
      setOrders(nextOrders)
    }
    const source = findColumn(snapshot.orders, taskId)
    const sourceIndex = source ? snapshot.orders[source]?.indexOf(taskId) : -1
    const targetIndex = nextOrders[destination]?.indexOf(taskId)
    resetDrag()
    if (source === destination && sourceIndex === targetIndex) return
    void move(taskId, destination, nextOrders, snapshot)
  }

  const handleDragCancel = (_event: DragCancelEvent) => {
    if (snapshotRef.current) rollback(snapshotRef.current)
    resetDrag()
  }

  const quickComplete = async (task: Task, status: TaskWorkflowStatus) => {
    const operationId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${task.id}-complete`
    onOperation(operationId, true)
    const optimisticPatch = (items: Task[]) => items.map(item => item.id === task.id ? updateTaskStatus(item, status) : item)
    setLocalTasks(optimisticPatch)
    onTasksChange(optimisticPatch)
    try {
      const saved = await onQuickUpdate(task, { status_id: status.id })
      if (saved) {
        const canonicalPatch = (items: Task[]) => items.map(item => item.id === saved.id ? saved : item)
        setLocalTasks(canonicalPatch)
        onTasksChange(canonicalPatch)
      } else await onRefresh()
    } finally {
      onOperation(operationId, false)
    }
  }

  return <div className="relative flex h-full min-h-[430px] flex-col">
    {moveError && <div className="mb-2 flex shrink-0 items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700"><span className="min-w-0 flex-1">{moveError.message}</span><button type="button" onClick={moveError.retry} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-white px-2.5 py-1.5 font-bold shadow-sm"><RotateCcw className="h-3 w-3" />Reintentar</button><button type="button" onClick={() => setMoveError(null)} aria-label="Cerrar" className="rounded p-1 hover:bg-white"><X className="h-3.5 w-3.5" /></button></div>}
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetectionStrategy}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      autoScroll
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      accessibility={{ screenReaderInstructions: { draggable: 'Presiona espacio para tomar una tarea, usa las flechas para moverla, espacio para soltarla o Escape para cancelar.' } }}
    >
      <div ref={boardViewportRef} data-testid="task-board-viewport" className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto overscroll-x-contain pb-2 [scrollbar-width:thin]">
        {statuses.map(status => <BoardColumn
          key={status.id}
          status={status}
          taskIds={orders[status.id] || []}
          tasksById={tasksById}
          allStatuses={allStatuses}
          users={users}
          currentUserId={currentUserId}
          lists={lists}
          defaultListId={defaultListId}
          collapsed={collapsedStatusIds.includes(status.id)}
          temporarilyExpanded={Boolean(activeId && overColumnId === status.id)}
          activeTask={activeTask}
          showListName={showListName}
          suppressOpen={suppressOpen}
          onCollapse={() => toggleCollapsed(status.id)}
          onConfigureStatuses={onConfigureStatuses}
          onTaskCreated={task => {
            if (!onCanonicalTask(task, 'created')) {
              void onRefresh()
              return
            }
            const next = upsertTask(localTasks, task)
            const nextOrders = initialOrders(next, statuses, lists, groupByList)
            setLocalTasks(next)
            setOrders(nextOrders)
            ordersRef.current = nextOrders
            onTasksChange(current => upsertTask(current, task))
          }}
          onCreateFull={onCreateFull}
          onOpen={onOpen}
          onEdit={onEdit}
          onCreateSubtask={onCreateSubtask}
          onStar={task => void onStar(task)}
          onComplete={(task, doneStatus) => void quickComplete(task, doneStatus)}
        />)}
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: 'ease-out' }}>{activeTask ? <OverlayCard task={activeTask} /> : null}</DragOverlay>
    </DndContext>
  </div>
}
