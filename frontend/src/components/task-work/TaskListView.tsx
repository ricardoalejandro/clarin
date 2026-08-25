'use client'

import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, useDroppable, useSensor, useSensors, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, ChevronDown, CornerDownRight, GripVertical, Layers3, Loader2, MoreHorizontal, MoveRight, PencilLine, Plus, RotateCcw, Star, Trash2, X } from 'lucide-react'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import { type Task, type TaskFolder, type TaskGroupBy, type TaskGroupDirection, type TaskList, type TaskWorkflowStatus } from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'
import { TaskStatusPicker } from './TaskPropertyPicker'
import { TaskListPicker } from './TaskSelectPicker'
import TaskDateTimePicker from './TaskDateTimePicker'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import { buildTaskListGroups, reorderTaskSelection, taskListDropMutation, type TaskListGroup } from './taskListGrouping'
import { taskListDensity, taskListPresentation } from './taskListDensity'
import { taskLocationLabel } from './taskBreadcrumbVisibility'
import type { TaskHierarchyCounts } from './taskHierarchyCounts'
import { allTasksCanBeAdministered, canAdministerTask, canEditTask } from './taskPermissionActions'
import TaskParticipantGrantConfirmDialog from './TaskParticipantGrantConfirmDialog'
import TaskListTitleButton from './TaskListTitleButton'
import { TaskPriorityIndicator } from './TaskSemanticIndicators'
import TaskCompletionButton from './TaskCompletionButton'
import { resolveTaskIdentityColor, taskIdentityTint } from './taskIdentityColor'
import {
  measureTaskNavigationTargets,
  pointerFromTaskDragActivator,
  resolveTaskDropTarget,
  sameTaskDropTarget,
  taskDropAutoScrollDelta,
  taskExternalListDropNeedsWrite,
  type TaskDropPoint,
  type TaskExternalDropTarget,
} from './taskDropTargets'
import {
  createTaskListSubtaskState,
  reconcileParentAfterChildStatus,
  TASK_SUBTASK_MAX_CONCURRENT_LOADS,
  taskListSubtaskReducer,
  taskSubtaskParentExpanded,
  type TaskSubtaskDisplayMode,
} from './taskListSubtasks'

interface Props {
  tasks: Task[]
  statuses: TaskWorkflowStatus[]
  lists: TaskList[]
  folders: TaskFolder[]
  users: TaskAccountUser[]
  groupBy: TaskGroupBy
  groupDirection: TaskGroupDirection
  collapsedGroupKeys: string[]
  subtaskDisplayMode: TaskSubtaskDisplayMode
  subtaskScope: string
  subtaskRealtimeEvent?: { task: Task; action: string; operationID?: string } | null
  activeTaskId?: string
  onGroupingChange: (groupBy: TaskGroupBy, direction: TaskGroupDirection, collapsed: string[]) => void
  onOpen: (task: Task, trigger?: HTMLElement | null) => void
  onStatus: (task: Task, statusId: string) => void
  onStar: (task: Task) => void
  onAddSubtask: (task: Task, trigger?: HTMLElement | null) => void
  onRenameTask: (task: Task, title: string) => void | boolean | Promise<void | boolean>
  onCanonicalTasks: (tasks: Task[], action?: string) => Task[]
  onHierarchyCounts?: (counts?: TaskHierarchyCounts | null, operationID?: string) => boolean | void
  onOperation?: (operationID: string, active: boolean) => void
  onDragStateChange?: (active: boolean) => void
  onExternalDropTargetChange?: (target: TaskExternalDropTarget | null) => void
  onRefresh: () => void | Promise<void>
  onError: (message: string) => void
}

function GroupDrop({ group, children }: { group: TaskListGroup; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${group.key}`, data: { type: 'group', groupKey: group.key } })
  return <section ref={setNodeRef} data-task-list-group={group.key} className={`overflow-hidden rounded-xl border bg-white shadow-sm transition ${isOver ? 'scale-[1.005] border-emerald-400 ring-4 ring-emerald-100' : 'border-slate-200'}`}>{children}</section>
}

function taskRowProgressiveControlClass(pinned: boolean) {
  return pinned
    ? 'pointer-events-auto opacity-100'
    : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100'
}

function useTaskRowRename(task: Task, onRenameTask: Props['onRenameTask']) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task.title)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const draftRef = useRef(task.title)
  const inFlightRef = useRef<Promise<void> | null>(null)

  useEffect(() => {
    if (!editing || pending) return
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true })
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [editing, pending])

  const changeDraft = (value: string) => {
    draftRef.current = value
    setDraft(value)
    if (error) setError('')
  }
  const start = () => {
    if (pending) return
    draftRef.current = task.title
    setDraft(task.title)
    setError('')
    setEditing(true)
  }
  const cancel = () => {
    if (pending) return
    draftRef.current = task.title
    setDraft(task.title)
    setError('')
    setEditing(false)
  }
  const commit = () => {
    if (inFlightRef.current) return inFlightRef.current
    const title = draftRef.current.trim()
    if (!title) {
      setError('Escribe un nombre para guardar la tarea.')
      requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
      return
    }
    if (title === task.title.trim()) {
      setError('')
      setEditing(false)
      return
    }

    setPending(true)
    setError('')
    let request: Promise<void>
    request = Promise.resolve()
      .then(() => onRenameTask(task, title))
      .then(result => {
        if (result === false) throw new Error('No se pudo cambiar el nombre. Inténtalo de nuevo.')
        draftRef.current = title
        setDraft(title)
        setEditing(false)
      })
      .catch(reason => {
        const message = reason instanceof Error && reason.message.trim()
          ? reason.message
          : 'No se pudo cambiar el nombre. Inténtalo de nuevo.'
        setError(message)
      })
      .finally(() => {
        if (inFlightRef.current === request) inFlightRef.current = null
        setPending(false)
      })
    inFlightRef.current = request
    return request
  }

  return { editing, draft, pending, error, inputRef, changeDraft, start, cancel, commit }
}

type TaskRowRenameController = ReturnType<typeof useTaskRowRename>

function TaskRowRenameField({ task, metadata, rename }: {
  task: Task
  metadata: string
  rename: TaskRowRenameController
}) {
  return <div className="min-w-0 flex-1" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <div className="relative">
      <input
        ref={rename.inputRef}
        data-task-row-rename-input
        aria-label={`Nuevo nombre de ${task.title}`}
        aria-invalid={Boolean(rename.error)}
        aria-busy={rename.pending || undefined}
        disabled={rename.pending}
        value={rename.draft}
        onChange={event => rename.changeDraft(event.target.value)}
        onBlur={() => { void rename.commit() }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            rename.cancel()
          } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            event.stopPropagation()
            void rename.commit()
          }
        }}
        className="h-8 w-full rounded-lg border border-emerald-300 bg-white px-2.5 pr-8 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 disabled:cursor-wait disabled:bg-slate-50"
      />
      {rename.pending && <Loader2 data-task-row-rename-pending aria-label="Guardando nombre" className="pointer-events-none absolute right-2 top-2 h-4 w-4 animate-spin text-emerald-600" />}
    </div>
    <span role={rename.error ? 'alert' : undefined} className={`block truncate text-[10px] leading-4 ${rename.error ? 'font-semibold text-rose-600' : 'text-slate-400'}`}>{rename.error || metadata}</span>
  </div>
}

function TaskRowActions({ task, editable, pinned, rename, onAddSubtask, onStar, positionClass }: {
  task: Task
  editable: boolean
  pinned: boolean
  rename: TaskRowRenameController
  onAddSubtask?: (trigger: HTMLButtonElement) => void
  onStar?: () => void
  positionClass: string
}) {
  const [touchMenuOpen, setTouchMenuOpen] = useState(false)
  const [touchMenuPosition, setTouchMenuPosition] = useState({ left: 8, top: 8, width: 216 })
  const touchTriggerRef = useRef<HTMLButtonElement>(null)
  const touchMenuRef = useRef<HTMLDivElement>(null)

  const placeTouchMenu = () => {
    const trigger = touchTriggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const viewport = window.visualViewport
    const viewportLeft = viewport?.offsetLeft || 0
    const viewportTop = viewport?.offsetTop || 0
    const viewportWidth = viewport?.width || window.innerWidth
    const viewportHeight = viewport?.height || window.innerHeight
    const width = Math.max(176, Math.min(224, viewportWidth - 16))
    const estimatedHeight = (1 + (onAddSubtask ? 1 : 0) + (onStar ? 1 : 0)) * 44 + 16
    const left = Math.min(Math.max(rect.right - width, viewportLeft + 8), viewportLeft + viewportWidth - width - 8)
    const below = rect.bottom + 6
    const top = below + estimatedHeight <= viewportTop + viewportHeight - 8
      ? below
      : Math.max(viewportTop + 8, rect.top - estimatedHeight - 6)
    setTouchMenuPosition({ left, top, width })
  }
  const closeTouchMenu = (restoreFocus: boolean) => {
    setTouchMenuOpen(false)
    if (restoreFocus) requestAnimationFrame(() => touchTriggerRef.current?.focus({ preventScroll: true }))
  }
  const moveTouchMenuFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    if (!items.length) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (current + 1 + items.length) % items.length
          : (current - 1 + items.length) % items.length
    items[next]?.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (!touchMenuOpen) return
    placeTouchMenu()
    const frame = requestAnimationFrame(() => touchMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true }))
    const reposition = () => placeTouchMenu()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeTouchMenu(true)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    window.visualViewport?.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('scroll', reposition)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      window.visualViewport?.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('scroll', reposition)
    }
  // Position is recalculated from the live trigger whenever this touch-only menu opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touchMenuOpen])

  if (!editable) return null
  const progressiveClass = taskRowProgressiveControlClass(pinned || touchMenuOpen)
  return <div
    data-task-row-actions
    data-task-row-controls-pinned={pinned || undefined}
    className={`absolute top-1/2 z-[1] flex -translate-y-1/2 items-center gap-0.5 rounded-xl border border-slate-200/90 bg-white/95 p-0.5 shadow-md shadow-slate-900/5 backdrop-blur transition-[opacity,transform] duration-150 motion-reduce:transition-none ${positionClass} ${progressiveClass}`}
    onPointerDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}
  >
    {onAddSubtask && <button
      type="button"
      disabled={rename.editing || rename.pending}
      aria-label={`Agregar subtarea a ${task.title}`}
      title="Agregar subtarea"
      onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); onAddSubtask(event.currentTarget) }}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 outline-none transition hover:bg-emerald-50 hover:text-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-35 [@media(pointer:coarse)]:hidden"
    ><Plus className="h-4 w-4" /></button>}
    <button
      type="button"
      disabled={rename.pending}
      aria-label={rename.editing ? `Guardar nombre de ${task.title}` : `Cambiar nombre de ${task.title}`}
      title={rename.editing ? 'Guardar nombre' : 'Cambiar nombre'}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); if (rename.editing) void rename.commit(); else rename.start() }}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 outline-none transition hover:bg-slate-100 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-wait disabled:opacity-45 [@media(pointer:coarse)]:hidden"
    >{rename.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : rename.editing ? <Check className="h-4 w-4 text-emerald-600" /> : <PencilLine className="h-4 w-4" />}</button>
    <button
      ref={touchTriggerRef}
      type="button"
      disabled={rename.editing || rename.pending}
      aria-label={`Acciones de ${task.title}`}
      aria-haspopup="menu"
      aria-expanded={touchMenuOpen}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); setTouchMenuOpen(value => !value) }}
      className="hidden h-11 w-11 items-center justify-center rounded-lg text-slate-600 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-40 [@media(pointer:coarse)]:flex"
    ><MoreHorizontal className="h-5 w-5" /></button>
    {touchMenuOpen && createPortal(<>
      <div role="presentation" className="fixed inset-0" style={{ zIndex: TASK_OVERLAY_LAYERS.workspacePopover - 1 }} onPointerDown={() => closeTouchMenu(true)} />
      <div ref={touchMenuRef} role="menu" aria-label={`Acciones de ${task.title}`} onKeyDown={moveTouchMenuFocus} className="fixed rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-950/15" style={{ left: touchMenuPosition.left, top: touchMenuPosition.top, width: touchMenuPosition.width, zIndex: TASK_OVERLAY_LAYERS.workspacePopover }}>
        {onAddSubtask && <button type="button" role="menuitem" onClick={() => { const trigger = touchTriggerRef.current; setTouchMenuOpen(false); if (trigger) onAddSubtask(trigger) }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-700 hover:bg-emerald-50 hover:text-emerald-800 focus:outline-none focus:ring-2 focus:ring-emerald-400"><Plus className="h-4 w-4 text-emerald-600" />Agregar subtarea</button>}
        <button type="button" role="menuitem" onClick={() => { setTouchMenuOpen(false); rename.start() }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-400"><PencilLine className="h-4 w-4 text-slate-500" />Cambiar nombre</button>
        {onStar && <button type="button" role="menuitem" onClick={() => { setTouchMenuOpen(false); onStar() }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-700 hover:bg-amber-50 focus:outline-none focus:ring-2 focus:ring-emerald-400"><Star className={`h-4 w-4 text-amber-500 ${task.starred ? 'fill-current' : ''}`} />{task.starred ? 'Quitar de destacadas' : 'Destacar tarea'}</button>}
      </div>
    </>, document.body)}
  </div>
}

function SortableRow({ task, groupKey, active, selected, selectionMode, density, allStatuses, subtaskExpanded, onToggleSubtasks, onOpen, onSelect, onStatus, onStar, onAddSubtask, onRenameTask }: {
  task: Task; groupKey: string; active: boolean; selected: boolean; selectionMode: boolean; density: ReturnType<typeof taskListDensity>; allStatuses: TaskWorkflowStatus[]; subtaskExpanded: boolean; onToggleSubtasks: () => void; onOpen: (trigger?: HTMLElement | null) => void; onSelect: (shift: boolean) => void; onStatus: (statusId: string) => void; onStar: () => void; onAddSubtask: (trigger: HTMLButtonElement) => void; onRenameTask: Props['onRenameTask']
}) {
  const editable = canEditTask(task)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, data: { type: 'row', groupKey }, disabled: !editable })
  const rename = useTaskRowRename(task, onRenameTask)
  const allowed = allStatuses.filter(status => status.workflow_id === task.status_detail?.workflow_id).sort((a,b) => a.sort_order-b.sort_order)
  const done = task.status_detail?.category === 'done'
  const compactMetadata = density === 'stacked'
    ? ` · ${task.status_detail?.name || 'Sin estado'} · ${task.assigned_to_name || 'Sin responsable'} · ${task.due_at ? new Date(task.due_at).toLocaleDateString('es', { day: 'numeric', month: 'short' }) : 'Sin fecha'}`
    : ''
  const metadata = `${taskLocationLabel(task)}${compactMetadata}${!editable ? ' · Solo lectura' : ''}`
  const presentation = taskListPresentation(density)
	const identityColor = task.resolved_color || resolveTaskIdentityColor(task.color).color
  const controlsPinned = selected || isDragging || rename.editing || rename.pending
  const progressiveControlClass = taskRowProgressiveControlClass(controlsPinned)
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, backgroundColor: selected ? taskIdentityTint(identityColor, .1) : undefined }} data-task-list-row={task.id} data-task-parent-expanded={subtaskExpanded || undefined} data-task-active={active || undefined} data-task-row-pending={rename.pending || undefined} aria-busy={rename.pending || undefined} aria-current={active ? 'true' : undefined} onClick={event => {
    if (editable && (event.ctrlKey || event.metaKey || event.shiftKey || selectionMode)) { event.preventDefault(); onSelect(event.shiftKey); return }
    const trigger = event.currentTarget.querySelector<HTMLElement>('[data-task-title-button]')
    trigger?.focus({ preventScroll: true })
    onOpen(trigger)
  }} className={`group relative grid min-h-12 items-center gap-1.5 px-2.5 transition [@media(pointer:coarse)]:min-h-14 [@media(pointer:coarse)]:gap-2 [@media(pointer:coarse)]:px-3 ${isDragging ? 'opacity-25' : 'hover:bg-slate-50'} ${selected ? 'bg-emerald-50/70 ring-1 ring-inset ring-emerald-200' : ''} ${active ? 'before:absolute before:inset-y-2 before:right-0.5 before:w-0.5 before:rounded-full before:bg-slate-500' : ''} ${presentation.gridClass}`}>
    <button type="button" {...attributes} {...listeners} disabled={!editable} data-task-row-grip onPointerDown={event => { event.stopPropagation(); listeners?.onPointerDown?.(event) }} onClick={event => event.stopPropagation()} aria-label={editable ? `Arrastrar ${task.title}` : `${task.title}: solo lectura`} title={editable ? 'Arrastrar tarea' : 'No tienes permiso para mover esta tarea'} className={`flex h-11 w-6 cursor-grab items-center justify-center rounded-lg text-slate-300 outline-none transition-[opacity,color,background-color] duration-150 hover:bg-slate-100 hover:text-slate-600 focus:ring-2 focus:ring-emerald-400 active:cursor-grabbing disabled:cursor-default disabled:[&>svg]:opacity-25 motion-reduce:transition-none [@media(pointer:coarse)]:w-11 ${progressiveControlClass}`}><GripVertical className="h-4 w-4" /></button>
			<div className="flex min-w-0 items-center gap-1.5"><span data-task-disclosure-slot className="flex h-11 w-8 shrink-0 items-center justify-center">{Boolean(task.subtask_count) && <button type="button" aria-expanded={subtaskExpanded} aria-controls={`task-subtasks-${task.id}`} aria-label={`${subtaskExpanded ? 'Contraer' : 'Expandir'} subtareas de ${task.title}`} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onToggleSubtasks() }} className="flex h-11 w-8 items-center justify-center rounded-lg text-slate-400 outline-none hover:bg-slate-100 hover:text-slate-700 focus:ring-2 focus:ring-emerald-400"><ChevronDown className={`h-4 w-4 transition-transform duration-200 motion-reduce:transition-none ${subtaskExpanded ? '' : '-rotate-90'}`} /></button>}</span><span data-task-row-completion className="flex h-11 w-11 shrink-0 items-center justify-center"><TaskCompletionButton compact task={task} statuses={allowed} disabled={!editable} onChange={onStatus} className={`transition-opacity duration-150 motion-reduce:transition-none ${progressiveControlClass}`} /></span><span className="h-5 w-1 shrink-0 rounded-full" style={{ backgroundColor: identityColor }} aria-label={`Color de identidad ${identityColor}`} />{rename.editing ? <TaskRowRenameField task={task} metadata={metadata} rename={rename} /> : <TaskListTitleButton title={task.title} metadata={metadata} done={done} editable={editable} selectionMode={selectionMode} onOpen={onOpen} onSelect={onSelect} />}<TaskPriorityIndicator priority={task.priority} />{Boolean(task.subtask_count) && <span data-task-subtask-summary className="hidden shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-bold text-slate-500 min-[520px]:inline-flex" title={`${task.subtask_done || 0} de ${task.subtask_count} subtareas completadas`}><Layers3 className="h-3 w-3 text-slate-400" />{task.subtask_done || 0}/{task.subtask_count}<span className="sr-only"> subtareas</span></span>}{selected && <span className="ml-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[9px] font-black text-white">Seleccionada</span>}</div>
    {density !== 'stacked' && <><div onClick={event => event.stopPropagation()}><TaskStatusPicker value={task.status_id || ''} statuses={allowed} compact disabled={!editable} onChange={onStatus} /></div><div className="flex min-w-0 items-center gap-1.5"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[9px] font-black text-slate-500">{(task.assigned_to_name || '?').slice(0,2).toUpperCase()}</span><span className="truncate text-xs text-slate-500">{task.assigned_to_name || 'Sin responsable'}</span></div><span className="truncate text-xs text-slate-400">{task.due_at ? new Date(task.due_at).toLocaleDateString('es', { day: 'numeric', month: 'short' }) : 'Sin fecha'}</span></>}
    <button type="button" disabled={!editable} aria-label={task.starred ? `Quitar ${task.title} de destacadas` : `Destacar ${task.title}`} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onStar() }} className={`flex h-11 w-full items-center justify-center rounded-lg outline-none transition-opacity duration-150 focus:ring-2 focus:ring-emerald-400 disabled:cursor-not-allowed disabled:[&>svg]:opacity-25 motion-reduce:transition-none [@media(pointer:coarse)]:invisible [@media(pointer:coarse)]:pointer-events-none ${task.starred || controlsPinned ? 'pointer-events-auto opacity-100' : 'pointer-events-none text-slate-300 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100'} ${task.starred ? 'text-amber-400' : 'text-slate-300'}`}><Star className={`h-4 w-4 ${task.starred ? 'fill-current' : ''}`} /></button>
    <TaskRowActions task={task} editable={editable} pinned={controlsPinned} rename={rename} onAddSubtask={onAddSubtask} onStar={onStar} positionClass="right-10 [@media(pointer:coarse)]:right-0.5" />
  </div>
}

function SubtaskRow({ task, allStatuses, density, active, pending, onOpen, onStatus, onRenameTask }: {
  task: Task
  allStatuses: TaskWorkflowStatus[]
  density: ReturnType<typeof taskListDensity>
  active: boolean
  pending: boolean
  onOpen: (trigger?: HTMLElement | null) => void
  onStatus: (statusID: string) => void
  onRenameTask: Props['onRenameTask']
}) {
  const editable = canEditTask(task)
  const rename = useTaskRowRename(task, onRenameTask)
  const allowed = allStatuses.filter(status => status.workflow_id === task.status_detail?.workflow_id).sort((a, b) => a.sort_order - b.sort_order)
  const done = task.status_detail?.category === 'done'
  const presentation = taskListPresentation(density)
  const compactMetadata = density === 'stacked'
    ? `${task.status_detail?.name || 'Sin estado'} · ${task.assigned_to_name || 'Sin responsable'} · ${task.due_at ? new Date(task.due_at).toLocaleDateString('es', { day: 'numeric', month: 'short' }) : 'Sin fecha'}`
    : 'Subtarea'
  const controlsPinned = pending || rename.editing || rename.pending
  const progressiveControlClass = taskRowProgressiveControlClass(controlsPinned)
  return <div data-task-subtask-row={task.id} data-task-active={active || undefined} data-task-row-pending={(pending || rename.pending) || undefined} aria-busy={(pending || rename.pending) || undefined} aria-current={active ? 'true' : undefined} className={`group relative grid min-h-11 items-center gap-1.5 rounded-lg px-2.5 transition hover:bg-white focus-within:bg-white ${active ? 'before:absolute before:inset-y-2 before:right-0.5 before:w-0.5 before:rounded-full before:bg-slate-500' : ''} ${presentation.gridClass}`}>
		<span aria-hidden="true" className="h-10 w-6 [@media(pointer:coarse)]:w-11" />
		<div className="flex min-w-0 items-center gap-1.5">
			<span aria-hidden="true" className="h-10 w-8 shrink-0" />
			<span data-task-row-completion className="flex h-10 w-11 shrink-0 items-center justify-center"><TaskCompletionButton compact task={task} statuses={allowed} disabled={!editable} pending={pending} onChange={onStatus} className={`transition-opacity duration-150 motion-reduce:transition-none ${progressiveControlClass}`} /></span>
			<span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center text-slate-300"><CornerDownRight className="h-3.5 w-3.5" /></span>
			{rename.editing ? <TaskRowRenameField task={task} metadata={compactMetadata} rename={rename} /> : <button type="button" data-task-subtask-title onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onOpen(event.currentTarget) }} className="min-w-0 flex-1 rounded-lg py-1 text-left outline-none focus:ring-2 focus:ring-emerald-400"><span className={`block truncate text-[13px] font-semibold ${done ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{task.title}</span><span className="block truncate text-[10px] text-slate-400">{compactMetadata}</span></button>}<TaskPriorityIndicator priority={task.priority} />
    </div>
    {density !== 'stacked' && <><div onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}><TaskStatusPicker value={task.status_id || ''} statuses={allowed} compact disabled={!editable || pending} onChange={onStatus} /></div><div className="flex min-w-0 items-center gap-1.5"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-[9px] font-black text-slate-500 ring-1 ring-slate-200">{(task.assigned_to_name || '?').slice(0, 2).toUpperCase()}</span><span className="truncate text-xs text-slate-500">{task.assigned_to_name || 'Sin responsable'}</span></div><span className="truncate text-xs text-slate-400">{task.due_at ? new Date(task.due_at).toLocaleDateString('es', { day: 'numeric', month: 'short' }) : 'Sin fecha'}</span><span aria-hidden="true" /> </>}
    {density === 'stacked' && <span aria-hidden="true" />}
    <TaskRowActions task={task} editable={editable} pinned={controlsPinned} rename={rename} positionClass="right-1" />
  </div>
}

export default function TaskListView({ tasks, statuses, lists, folders, users, groupBy, groupDirection, collapsedGroupKeys, subtaskDisplayMode, subtaskScope, subtaskRealtimeEvent, activeTaskId, onGroupingChange, onOpen, onStatus, onStar, onAddSubtask, onRenameTask, onCanonicalTasks, onHierarchyCounts, onOperation, onDragStateChange, onExternalDropTargetChange, onRefresh, onError }: Props) {
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
  const [externalDropTarget, setExternalDropTarget] = useState<TaskExternalDropTarget | null>(null)
  const [pendingFolderDrop, setPendingFolderDrop] = useState<{ folder: TaskFolder; taskIDs: string[] } | null>(null)
  const [participantGrantPrompt, setParticipantGrantPrompt] = useState<{
    affectedUserIDs: string[]
    taskIDs: string[]
    mutation: NonNullable<ReturnType<typeof taskListDropMutation>>
    dateValue?: string | null
  } | null>(null)
  const [subtaskState, dispatchSubtasks] = useReducer(taskListSubtaskReducer, subtaskDisplayMode, createTaskListSubtaskState)
  const [pendingChildIDs, setPendingChildIDs] = useState<string[]>([])
  const subtaskStateRef = useRef(subtaskState)
  const subtaskQueueRef = useRef<Array<{ parentID: string; force: boolean }>>([])
  const queuedSubtaskParentsRef = useRef(new Set<string>())
  const activeSubtaskLoadsRef = useRef(new Map<string, { controller: AbortController; requestID: number }>())
  const subtaskRequestSequenceRef = useRef(0)
  const activeSubtaskScopeRef = useRef(subtaskScope)
  const dragPointerOriginRef = useRef<TaskDropPoint | null>(null)
  subtaskStateRef.current = subtaskState

  const pumpSubtaskLoads = () => {
    while (activeSubtaskLoadsRef.current.size < TASK_SUBTASK_MAX_CONCURRENT_LOADS && subtaskQueueRef.current.length > 0) {
      const queued = subtaskQueueRef.current.shift()
      if (!queued) break
      queuedSubtaskParentsRef.current.delete(queued.parentID)
      if (activeSubtaskLoadsRef.current.has(queued.parentID)) continue
      const cached = subtaskStateRef.current.cache[queued.parentID]
      if (!queued.force && cached?.phase === 'ready') continue
      const controller = new AbortController()
      const requestID = ++subtaskRequestSequenceRef.current
      activeSubtaskLoadsRef.current.set(queued.parentID, { controller, requestID })
      dispatchSubtasks({ type: 'load-started', parentID: queued.parentID, requestID })
      void apiGet<{ tasks: Task[] }>(`/api/tasks/${queued.parentID}/children`, { signal: controller.signal }).then(result => {
        if (controller.signal.aborted) {
          dispatchSubtasks({ type: 'load-cancelled', parentID: queued.parentID, requestID })
        } else if (result.success) {
          dispatchSubtasks({ type: 'load-succeeded', parentID: queued.parentID, requestID, items: result.data?.tasks || [] })
        } else {
          dispatchSubtasks({ type: 'load-failed', parentID: queued.parentID, requestID, error: result.error || 'No se pudieron cargar las subtareas.' })
        }
      }).finally(() => {
        const active = activeSubtaskLoadsRef.current.get(queued.parentID)
        if (active?.requestID === requestID) activeSubtaskLoadsRef.current.delete(queued.parentID)
        pumpSubtaskLoads()
      })
    }
  }
  const queueSubtaskLoad = (parentID: string, force = false) => {
    const cached = subtaskStateRef.current.cache[parentID]
    if ((!force && cached?.phase === 'ready') || activeSubtaskLoadsRef.current.has(parentID) || queuedSubtaskParentsRef.current.has(parentID)) return
    queuedSubtaskParentsRef.current.add(parentID)
    subtaskQueueRef.current.push({ parentID, force })
    pumpSubtaskLoads()
  }
  const cancelSubtaskLoad = (parentID: string) => {
    subtaskQueueRef.current = subtaskQueueRef.current.filter(item => item.parentID !== parentID)
    queuedSubtaskParentsRef.current.delete(parentID)
    activeSubtaskLoadsRef.current.get(parentID)?.controller.abort()
  }
  const toggleSubtasks = (parentID: string) => {
    const wasExpanded = taskSubtaskParentExpanded(subtaskStateRef.current, parentID)
    dispatchSubtasks({ type: 'toggle-parent', parentID })
    if (wasExpanded) cancelSubtaskLoad(parentID)
    else queueSubtaskLoad(parentID)
  }
  useEffect(() => setLocalTasks(tasks), [tasks])
  useEffect(() => {
    dispatchSubtasks({ type: 'set-mode', mode: subtaskDisplayMode })
    if (subtaskDisplayMode === 'expanded') {
      tasks.filter(task => Boolean(task.subtask_count)).forEach(task => queueSubtaskLoad(task.id))
    } else {
      subtaskQueueRef.current = []
      queuedSubtaskParentsRef.current.clear()
      for (const parentID of Array.from(activeSubtaskLoadsRef.current.keys())) cancelSubtaskLoad(parentID)
    }
  // The queue is intentionally driven only by the persisted global mode.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtaskDisplayMode])
  useEffect(() => {
    if (activeSubtaskScopeRef.current === subtaskScope) return
    activeSubtaskScopeRef.current = subtaskScope
    for (const load of Array.from(activeSubtaskLoadsRef.current.values())) load.controller.abort()
    activeSubtaskLoadsRef.current.clear()
    subtaskQueueRef.current = []
    queuedSubtaskParentsRef.current.clear()
    dispatchSubtasks({ type: 'reset-scope', mode: subtaskDisplayMode })
    if (subtaskDisplayMode === 'expanded') {
      tasks.filter(task => Boolean(task.subtask_count)).forEach(task => queueSubtaskLoad(task.id, true))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtaskScope])
  useEffect(() => {
    const parentIDs = tasks.map(task => task.id)
    dispatchSubtasks({ type: 'retain-parents', parentIDs })
    if (subtaskDisplayMode === 'expanded') tasks.filter(task => Boolean(task.subtask_count)).forEach(task => queueSubtaskLoad(task.id))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, subtaskDisplayMode])
  useEffect(() => {
    if (!subtaskRealtimeEvent?.task.parent_task_id) return
    if (subtaskRealtimeEvent.action === 'deleted' || subtaskRealtimeEvent.action === 'trashed') {
      dispatchSubtasks({ type: 'remove-child', parentID: subtaskRealtimeEvent.task.parent_task_id, childID: subtaskRealtimeEvent.task.id })
    } else {
      dispatchSubtasks({ type: 'reconcile-child', child: subtaskRealtimeEvent.task })
    }
  }, [subtaskRealtimeEvent])
  useEffect(() => () => {
    for (const load of Array.from(activeSubtaskLoadsRef.current.values())) load.controller.abort()
    activeSubtaskLoadsRef.current.clear()
  }, [])
  useEffect(() => {
    setSelectedIDs(current => current.filter(id => {
      const item = tasks.find(task => task.id === id)
      return Boolean(item && canEditTask(item))
    }))
  }, [tasks])
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
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 520, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
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
  const selectedTasks = () => selectedIDs.map(id => localTasks.find(task => task.id === id)).filter((task): task is Task => Boolean(task && !task.parent_task_id && canEditTask(task)))
  const mutate = async (ids: string[], mutation: ReturnType<typeof taskListDropMutation>, dateValue?: string | null, confirmGrants = false) => {
    if (!mutation || !ids.length) return
    const affected = ids.map(id => localTasks.find(task => task.id === id)).filter((task): task is Task => Boolean(task && !task.parent_task_id && canEditTask(task)))
    if (mutation.endpoint === 'move' && mutation.listId && !taskExternalListDropNeedsWrite(affected.map(task => task.list_id || ''), mutation.listId)) {
      setAnnouncement(affected.length === 1 ? 'La tarea ya pertenece a esa lista.' : 'Las tareas ya pertenecen a esa lista.')
      return
    }
    const items = affected.map(task => ({ id: task.id, version: task.version || 1 }))
    if (!items.length) return
    const operationID = crypto.randomUUID()
    setBusy(true)
    onOperation?.(operationID, true)
    type BulkMutationResponse = {
      tasks?: Task[]
      operation_id?: string
      hierarchy_counts?: TaskHierarchyCounts
      code?: string
      affected_user_ids?: string[]
    }
    const result = mutation.endpoint === 'move'
      ? await apiPost<BulkMutationResponse>('/api/tasks/bulk-move', { items, destination_list_id: mutation.listId, destination_status_category: mutation.statusCategory, operation_id: operationID })
      : await apiPost<BulkMutationResponse>('/api/tasks/bulk-update', { items, property: mutation.property, value: mutation.property === 'due_at' ? dateValue : mutation.value, operation_id: operationID, confirm_grants: confirmGrants })
    onOperation?.(operationID, false)
    setBusy(false)
    if (!result.success && result.status === 409 && result.data?.code === 'access_change_confirmation_required') {
      setParticipantGrantPrompt({
        affectedUserIDs: result.data.affected_user_ids || [],
        taskIDs: affected.map(task => task.id),
        mutation,
        dateValue,
      })
      return
    }
    if (!result.success || !result.data?.tasks) { onError(result.error || 'No se pudo aplicar el cambio masivo. No se modificó ninguna tarea.'); await onRefresh(); return }
    onCanonicalTasks(result.data.tasks, mutation.endpoint === 'move' ? 'bulk_moved' : 'bulk_updated')
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
    const affected = selectedTasks().filter(canAdministerTask)
    if (!affected.length || affected.length !== selectedTasks().length) {
      onError('Necesitas Administrar en todas las tareas seleccionadas para enviarlas a Papelera.')
      return
    }
    const operationID = crypto.randomUUID()
    setBusy(true)
    const result = await apiPost<{ task_ids: string[]; operation_id?: string; hierarchy_counts?: TaskHierarchyCounts }>('/api/tasks/bulk-trash', { items: affected.map(task => ({ id: task.id, version: task.version || 1 })), confirmation: trashPhrase, operation_id: operationID })
    setBusy(false)
    if (!result.success) { onError(result.error || 'No se pudo mover la selección a Papelera'); return }
    onHierarchyCounts?.(result.data?.hierarchy_counts, result.data?.operation_id || operationID)
    setTrashDialog(false); setTrashPhrase(''); setSelectedIDs([]); await onRefresh()
  }
  const reorder = async (ids: string[], beforeTaskID: string) => {
    const affected = ids.map(id => localTasks.find(task => task.id === id)).filter((task): task is Task => Boolean(task && !task.parent_task_id && canEditTask(task)))
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
    onCanonicalTasks(result.data.tasks, 'bulk_reordered')
    onHierarchyCounts?.(result.data.hierarchy_counts, result.data.operation_id || operationID)
    setAnnouncement(`${result.data.tasks.length} tareas reordenadas`)
    await onRefresh()
  }
  const resetDrag = () => {
    setDragIDs([])
    setExternalDropTarget(null)
    dragPointerOriginRef.current = null
    onExternalDropTargetChange?.(null)
    onDragStateChange?.(false)
  }
  const startDrag = (event: DragStartEvent) => {
    const id = String(event.active.id)
    const activeTask = localTasks.find(task => task.id === id)
    if (!activeTask || !canEditTask(activeTask)) return
    const ids = (selected.has(id) ? selectedIDs : [id]).filter(taskID => {
      const item = localTasks.find(task => task.id === taskID)
      return Boolean(item && !item.parent_task_id && canEditTask(item))
    })
    if (!selected.has(id)) setSelectedIDs([id])
    setDragIDs(ids)
    dragPointerOriginRef.current = pointerFromTaskDragActivator(event.activatorEvent)
    onDragStateChange?.(true)
    setAnnouncement(`Moviendo ${ids.length} ${ids.length === 1 ? 'tarea' : 'tareas'}`)
  }
  const moveDrag = (event: DragMoveEvent) => {
    const origin = dragPointerOriginRef.current
    if (!origin) return
    const point = { x: origin.x + event.delta.x, y: origin.y + event.delta.y }
    const next = resolveTaskDropTarget(point, measureTaskNavigationTargets(), externalDropTarget)
    setExternalDropTarget(current => sameTaskDropTarget(current, next) ? current : next)
    onExternalDropTargetChange?.(next)
    const navigation = document.querySelector<HTMLElement>('[data-task-navigation-scroll]')
    if (!navigation) return
    const rect = navigation.getBoundingClientRect()
    if (point.x < rect.left || point.x > rect.right) return
    const delta = taskDropAutoScrollDelta(point.y, rect)
    if (delta) navigation.scrollBy({ top: delta, behavior: 'auto' })
  }
  const endDrag = (event: DragEndEvent) => {
    const ids = dragIDs.length ? [...dragIDs] : [String(event.active.id)]
    if (externalDropTarget) {
      const target = externalDropTarget
      resetDrag()
      if (target.type === 'list') {
        void mutate(ids, { endpoint: 'move', listId: target.id })
      } else {
        const folder = folders.find(item => item.id === target.id)
        if (folder) setPendingFolderDrop({ folder, taskIDs: ids })
      }
      return
    }
    resetDrag()
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
  const mutateSubtaskStatus = async (parent: Task, child: Task, statusID: string) => {
    if (!canEditTask(child) || pendingChildIDs.includes(child.id)) return
    const status = statuses.find(item => item.id === statusID && item.workflow_id === child.status_detail?.workflow_id)
    if (!status) return
    const optimistic = { ...child, status_id: status.id, status_detail: status }
    const operationID = crypto.randomUUID()
    setPendingChildIDs(current => [...current, child.id])
    dispatchSubtasks({ type: 'replace-child', parentID: parent.id, child: optimistic })
    setLocalTasks(current => current.map(item => item.id === parent.id ? reconcileParentAfterChildStatus(item, child, optimistic) : item))
    onOperation?.(operationID, true)
    const result = await apiPut<{ task?: Task; operation_id?: string; hierarchy_counts?: TaskHierarchyCounts }>(`/api/tasks/${child.id}`, {
      status_id: status.id,
      version: child.version || 1,
      operation_id: operationID,
    })
    onOperation?.(operationID, false)
    setPendingChildIDs(current => current.filter(id => id !== child.id))
    if (result.success && result.data?.task) {
      dispatchSubtasks({ type: 'replace-child', parentID: parent.id, child: result.data.task })
      onHierarchyCounts?.(result.data.hierarchy_counts, result.data.operation_id || operationID)
      setAnnouncement(`Subtarea ${result.data.task.status_detail?.category === 'done' ? 'completada' : 'actualizada'}`)
      await onRefresh()
      return
    }
    dispatchSubtasks({ type: 'replace-child', parentID: parent.id, child })
    setLocalTasks(current => current.map(item => item.id === parent.id ? reconcileParentAfterChildStatus(item, optimistic, child) : item))
    if (result.status === 409) {
      queueSubtaskLoad(parent.id, true)
      onError('La subtarea cambió en otra sesión. Restauramos el estado visible y cargamos la versión reciente.')
    } else {
      onError(result.error || 'No se pudo actualizar la subtarea. Se restauró el estado anterior.')
    }
  }
  const selectedEditableTasks = selectedTasks()
  const selectedCanTrash = allTasksCanBeAdministered(selectedEditableTasks)
  const editableLists = lists.filter(list => list.permissions?.can_edit === true)
  return <div ref={containerRef} className="min-h-0 space-y-2 pb-8">{selectedIDs.length > 0 && <div data-task-list-selection-toolbar className="sticky top-0 z-20 flex min-h-14 flex-wrap items-center gap-2 rounded-xl border border-emerald-200 bg-white/95 px-3 py-1.5 shadow-lg shadow-emerald-950/5 backdrop-blur"><span className="rounded-full bg-emerald-600 px-2.5 py-1 text-[10px] font-black text-white">{selectedIDs.length}</span><span className="text-xs font-semibold text-slate-600">{selectedIDs.length === 1 ? 'tarea seleccionada' : 'tareas seleccionadas'}</span><div className="ml-auto flex items-center gap-1.5"><button onClick={() => setMoveDialog(true)} className="flex min-h-11 items-center gap-1.5 rounded-xl border border-slate-200 px-3 text-xs font-bold text-slate-600 hover:border-emerald-300"><MoveRight className="h-4 w-4" />Mover</button>{selectedCanTrash && <button onClick={() => setTrashDialog(true)} className="flex min-h-11 items-center gap-1.5 rounded-xl border border-rose-200 px-3 text-xs font-bold text-rose-600 hover:bg-rose-50"><Trash2 className="h-4 w-4" />Papelera</button>}<button onClick={() => { setSelectedIDs([]); setSelectionAnchor('') }} aria-label="Limpiar selección" className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button></div></div>}<div className="sr-only" aria-live="polite">{announcement}</div>
    {!tasks.length && <div className="flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white text-center text-sm text-slate-400"><div><Layers3 className="mx-auto mb-2 h-6 w-6 text-slate-300" /><p>No hay tareas para esta vista.</p><p className="mt-1 text-xs">Puedes conservar o cambiar la agrupación antes de crear trabajo.</p></div></div>}
    <DndContext sensors={sensors} onDragStart={startDrag} onDragMove={moveDrag} onDragEnd={endDrag} onDragCancel={resetDrag}><div className="space-y-1.5">{groups.map(group => { const collapsed = collapsedGroupKeys.includes(group.key); const ordered = group.tasks.map(task => task.id); return <GroupDrop key={group.key} group={group}><button type="button" aria-expanded={!collapsed} aria-controls={`task-list-group-${group.key}`} onClick={() => onGroupingChange(groupBy, groupDirection, collapsed ? collapsedGroupKeys.filter(key => key !== group.key) : [...collapsedGroupKeys, group.key])} className="flex min-h-10 w-full items-center gap-2 border-b border-slate-100 px-3 text-left [@media(pointer:coarse)]:min-h-11"><ChevronDown className={`h-4 w-4 text-slate-400 transition motion-reduce:transition-none ${collapsed ? '-rotate-90' : ''}`} /><i className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: group.color }} /><span className="text-xs font-black uppercase tracking-wider text-slate-600">{group.label}</span><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-400">{group.tasks.length}</span></button><div {...({ inert: collapsed ? '' : undefined } as Record<string, string | undefined>)} id={`task-list-group-${group.key}`} role="region" aria-label={`Tareas en ${group.label}`} aria-hidden={collapsed} className={`grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none ${collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}><div className="min-h-0 overflow-hidden"><SortableContext items={ordered} strategy={verticalListSortingStrategy}><div className="divide-y divide-slate-100">{group.tasks.map(task => { const expanded = Boolean(task.subtask_count) && taskSubtaskParentExpanded(subtaskState, task.id); const entry = subtaskState.cache[task.id] || { phase: 'idle', items: [] }; return <div key={task.id}><SortableRow task={task} groupKey={group.key} active={activeTaskId === task.id} selected={selected.has(task.id)} selectionMode={selectedIDs.length > 0} density={density} allStatuses={statuses} subtaskExpanded={expanded} onToggleSubtasks={() => toggleSubtasks(task.id)} onOpen={trigger => onOpen(task, trigger)} onSelect={shift => toggleSelection(task.id, shift, ordered)} onStatus={statusID => onStatus(task, statusID)} onStar={() => onStar(task)} onAddSubtask={trigger => onAddSubtask(task, trigger)} onRenameTask={onRenameTask} />{Boolean(task.subtask_count) && <div {...({ inert: expanded ? undefined : '' } as Record<string, string | undefined>)} id={`task-subtasks-${task.id}`} role="region" aria-label={`Subtareas de ${task.title}`} aria-hidden={!expanded} className={`grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}><div className="min-h-0 overflow-hidden"><div data-task-subtask-group className="mb-2 rounded-xl border-y border-slate-200 bg-slate-50/80 py-1.5 shadow-inner shadow-slate-900/[0.02]">{entry.phase === 'loading' && !entry.items.length && <div role="status" className="flex min-h-12 items-center gap-2 px-4 text-xs font-semibold text-slate-400"><Loader2 className="h-4 w-4 animate-spin text-emerald-500" />Cargando subtareas…</div>}{entry.items.map(child => <SubtaskRow key={child.id} task={child} allStatuses={statuses} density={density} active={activeTaskId === child.id} pending={pendingChildIDs.includes(child.id)} onOpen={trigger => onOpen(child, trigger)} onStatus={statusID => void mutateSubtaskStatus(task, child, statusID)} onRenameTask={onRenameTask} />)}{entry.phase === 'ready' && !entry.items.length && <p className="px-4 py-3 text-xs text-slate-400">Esta tarea ya no tiene subtareas activas.</p>}{entry.phase === 'error' && <div role="alert" className="flex min-h-12 flex-wrap items-center gap-2 rounded-lg border border-rose-200 bg-rose-50/70 px-4 py-2 text-xs font-semibold text-rose-700"><span className="min-w-0 flex-1">{entry.error}</span><button type="button" onClick={() => queueSubtaskLoad(task.id, true)} className="flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-400"><RotateCcw className="h-3.5 w-3.5" />Reintentar</button></div>}</div></div></div>}</div> })}{!group.tasks.length && <p className="px-4 py-6 text-center text-xs text-slate-400">Suelta aquí para quitar la fecha, previa confirmación.</p>}</div></SortableContext></div></div></GroupDrop> })}</div><DragOverlay style={{ zIndex: TASK_OVERLAY_LAYERS.dragOverlay }}>{dragIDs.length > 0 && <div className="relative w-72"><div className="absolute inset-0 translate-x-2 translate-y-2 rotate-2 rounded-xl border border-emerald-200 bg-white/80" /><div className="relative rounded-xl border border-emerald-400 bg-white p-3 shadow-2xl"><div className="flex items-center gap-2"><GripVertical className="h-4 w-4 text-emerald-600" /><p className="truncate text-sm font-black text-slate-800">{localTasks.find(task => task.id === dragIDs[0])?.title}</p></div><p className="mt-1 text-[10px] font-bold text-emerald-700">{dragIDs.length} {dragIDs.length === 1 ? 'tarea' : 'tareas'}{externalDropTarget ? ` · ${externalDropTarget.label}` : ''}</p></div></div>}</DragOverlay></DndContext>
    {moveDialog && createPortal(<div className="fixed inset-0 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm" style={{ zIndex: TASK_OVERLAY_LAYERS.confirmation }}><div role="dialog" aria-modal="true" className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl"><p className="text-[10px] font-black uppercase tracking-[.16em] text-emerald-600">Acción preparada</p><h2 className="mt-1 text-xl font-black text-slate-900">Mover {selectedIDs.length} tareas</h2><p className="mt-2 text-sm leading-6 text-slate-500">Elige el destino. Las subtareas acompañarán a sus tareas principales y los estados se remapearán por categoría. Nada cambiará hasta confirmar.</p><label className="mt-4 block text-xs font-bold text-slate-600">Lista destino<span className="mt-2 block"><TaskListPicker value={pendingListID} lists={editableLists} folders={folders} onChange={setPendingListID} /></span></label>{pendingListID && <div className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">Destino preparado: {lists.find(list => list.id === pendingListID)?.name}</div>}<div className="mt-6 flex justify-end gap-2"><button onClick={() => { setMoveDialog(false); setPendingListID('') }} className="rounded-xl px-4 py-2.5 text-sm font-bold text-slate-600">Cancelar</button><button disabled={!pendingListID || busy} onClick={() => void bulkMove()} className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-black text-white disabled:opacity-40">{busy ? 'Moviendo…' : 'Confirmar movimiento'}</button></div></div></div>, document.body)}
    {trashDialog && createPortal(<div className="fixed inset-0 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm" style={{ zIndex: TASK_OVERLAY_LAYERS.confirmation }}><div role="alertdialog" aria-modal="true" className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl"><p className="text-[10px] font-black uppercase tracking-[.16em] text-rose-600">Acción masiva protegida</p><h2 className="mt-1 text-xl font-black text-slate-900">Mover a Papelera</h2><p className="mt-2 text-sm leading-6 text-slate-500">Se moverán {selectedIDs.length} tareas y sus subtareas. Podrás restaurarlas durante el plazo configurado; no se eliminarán permanentemente.</p><label className="mt-4 block text-xs font-bold text-slate-600">Escribe exactamente <strong>MOVER {selectedIDs.length} TAREAS</strong><input value={trashPhrase} onChange={event => setTrashPhrase(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3 outline-none focus:border-rose-400 focus:ring-4 focus:ring-rose-100" /></label><div className="mt-6 flex justify-end gap-2"><button onClick={() => { setTrashDialog(false); setTrashPhrase('') }} className="rounded-xl px-4 py-2.5 text-sm font-bold text-slate-600">Cancelar</button><button disabled={trashPhrase !== `MOVER ${selectedIDs.length} TAREAS` || busy} onClick={() => void bulkTrash()} className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-black text-white disabled:opacity-40">{busy ? 'Moviendo…' : 'Mover a Papelera'}</button></div></div></div>, document.body)}
    {pendingFolderDrop && createPortal(<div className="fixed inset-0 flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-sm" style={{ zIndex: TASK_OVERLAY_LAYERS.confirmation }} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setPendingFolderDrop(null) }}><div role="dialog" aria-modal="true" aria-labelledby="task-list-folder-drop-title" className="w-full max-w-md rounded-3xl bg-white p-5 shadow-2xl"><div className="flex items-start justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-[.16em] text-emerald-600">Elegir destino</p><h2 id="task-list-folder-drop-title" className="mt-1 text-lg font-black text-slate-900">{pendingFolderDrop.folder.name}</h2><p className="mt-1 text-sm text-slate-500">Cada tarea debe pertenecer a una lista concreta. Elige una dentro de esta carpeta.</p></div><button type="button" aria-label="Cerrar selección de lista" onClick={() => setPendingFolderDrop(null)} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button></div><div className="mt-4 space-y-2">{pendingFolderDrop.folder.lists.filter(list => list.permissions?.can_edit === true).map(list => <button key={list.id} type="button" onClick={() => { const ids = pendingFolderDrop.taskIDs; setPendingFolderDrop(null); void mutate(ids, { endpoint: 'move', listId: list.id }) }} className="flex w-full items-center gap-3 rounded-2xl border border-slate-200 px-4 py-3 text-left transition hover:border-emerald-300 hover:bg-emerald-50"><span className="h-3 w-3 rounded-full" style={{ backgroundColor: list.color }} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-slate-700">{list.name}</span><span className="text-[10px] text-slate-400">{pendingFolderDrop.folder.name} / {list.name}</span></span></button>)}{!pendingFolderDrop.folder.lists.some(list => list.permissions?.can_edit === true) && <div className="rounded-2xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">No hay listas editables en esta carpeta.</div>}</div></div></div>, document.body)}
    {dueDialog && createPortal(<div className="fixed inset-0 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm" style={{ zIndex: TASK_OVERLAY_LAYERS.confirmation }}><div role="dialog" aria-modal="true" className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl"><h2 className="text-lg font-black text-slate-900">{dueDialog.clear ? 'Quitar vencimiento' : 'Confirmar fecha exacta'}</h2><p className="mt-2 text-sm leading-6 text-slate-500">{dueDialog.clear ? 'El drop nunca quita fechas automáticamente. Confirma para dejar estas tareas sin fecha.' : 'El grupo temporal no asigna una fecha automática. Elige el día y hora exactos.'}</p>{!dueDialog.clear && <div className="mt-4"><TaskDateTimePicker label="Nueva entrega" value={dueValue} onChange={setDueValue} /></div>}<div className="mt-6 flex justify-end gap-2"><button onClick={() => setDueDialog(null)} className="rounded-xl px-4 py-2.5 text-sm font-bold text-slate-600">Cancelar</button><button disabled={!dueDialog.clear && !dueValue} onClick={() => { const pending = dueDialog; setDueDialog(null); void mutate(pending.ids, { endpoint: 'update', property: 'due_at', value: dueValue }, pending.clear ? null : new Date(dueValue).toISOString()) }} className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-black text-white disabled:opacity-40">Confirmar</button></div></div></div>, document.body)}
    <TaskParticipantGrantConfirmDialog
      open={participantGrantPrompt !== null}
      affectedUserIDs={participantGrantPrompt?.affectedUserIDs || []}
      users={users}
      busy={busy}
      onClose={() => setParticipantGrantPrompt(null)}
      onConfirm={() => {
        const pending = participantGrantPrompt
        if (!pending) return
        setParticipantGrantPrompt(null)
        void mutate(pending.taskIDs, pending.mutation, pending.dateValue, true)
      }}
    />
  </div>
}
