'use client'

import { useState, useMemo, type RefObject } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Plus, GripVertical, ChevronDown, Star, CheckCircle2, ExternalLink, ListTodo } from 'lucide-react'
import { Task, TaskList, TASK_TYPE_CONFIG } from '@/types/task'

interface Props {
  tasks: Task[]
  taskLists: TaskList[]
  onComplete: (taskId: string) => void
  onDelete: (taskId: string) => void
  onUpdate: (taskId: string, fields: Record<string, unknown>) => void
  onOpenFullEdit: (task: Task) => void
  onToggleStar: (taskId: string) => void
  onInlineCreate: (title: string, listId: string | null) => void
  onMoveToList: (taskId: string, listId: string | null) => void
  onReorder: (taskIds: string[]) => void
  onReorderLists?: (listIds: string[]) => void
  kanbanRef?: RefObject<HTMLDivElement | null>
}

// ── Sortable Card ──
function SortableTaskCard({ task, onComplete, onOpenFullEdit, onToggleStar }: {
  task: Task
  onComplete: (id: string) => void
  onOpenFullEdit: (t: Task) => void
  onToggleStar: (id: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }
  const typeConfig = TASK_TYPE_CONFIG[task.type] || TASK_TYPE_CONFIG.reminder
  const isCompleted = task.status === 'completed' || task.status === 'cancelled'
  const isOverdue = task.status === 'overdue' || (task.due_at && new Date(task.due_at) < new Date() && !isCompleted)

  const getOriginBadge = () => {
    if (task.lead_id) return { icon: '👤', label: task.lead_name || 'Lead', href: `/dashboard/leads?lead_id=${task.lead_id}&scroll=tasks`, color: 'bg-slate-100 text-slate-600 hover:bg-slate-200' }
    if (task.event_id) return { icon: '📅', label: task.event_name || 'Evento', href: `/dashboard/events/${task.event_id}`, color: 'bg-purple-50 text-purple-600 hover:bg-purple-100' }
    if (task.program_id) return { icon: '📚', label: task.program_name || 'Programa', href: `/dashboard/programs/${task.program_id}`, color: 'bg-blue-50 text-blue-600 hover:bg-blue-100' }
    if (task.contact_id) return { icon: '💬', label: task.contact_name || 'Contacto', href: `/dashboard/contacts?contact_id=${task.contact_id}&scroll=tasks`, color: 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100' }
    return null
  }
  const originBadge = getOriginBadge()
  const subtaskTotal = task.subtask_count || 0
  const subtaskDone = task.subtask_done || 0

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-start gap-1.5 p-2 rounded-lg border bg-white hover:shadow-sm transition cursor-default ${
        isOverdue ? 'border-red-200 bg-red-50/50' : 'border-slate-100'
      } ${isCompleted ? 'opacity-60' : ''}`}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="mt-0.5 p-0.5 text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition shrink-0"
      >
        <GripVertical className="w-3 h-3" />
      </button>

      {/* Complete checkbox */}
      <button
        onClick={() => onComplete(task.id)}
        className={`mt-0.5 shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition ${
          isCompleted ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300 hover:border-emerald-400'
        }`}
      >
        {isCompleted && <CheckCircle2 className="w-3 h-3 text-white" />}
      </button>

      {/* Star */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggleStar(task.id) }}
        className={`mt-0.5 shrink-0 transition ${
          task.starred ? 'text-amber-400' : 'text-slate-200 opacity-0 group-hover:opacity-100 hover:text-amber-300'
        }`}
      >
        <Star className={`w-3.5 h-3.5 ${task.starred ? 'fill-amber-400' : ''}`} />
      </button>

      {/* Content */}
      <div
        className="flex-1 min-w-0 cursor-pointer"
        onClick={() => onOpenFullEdit(task)}
      >
        <p className={`text-xs font-medium truncate ${isCompleted ? 'line-through text-slate-400' : 'text-slate-700'}`}>
          {task.title}
        </p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[10px]">{typeConfig.icon}</span>
          {task.due_at && (
            <span className={`text-[10px] ${isOverdue ? 'text-red-500 font-medium' : 'text-slate-400'}`}>
              {new Date(task.due_at).toLocaleDateString('es', { day: 'numeric', month: 'short' })}
            </span>
          )}
          {task.assigned_to_name && (
            <span className="text-[10px] text-slate-400 truncate">· {task.assigned_to_name}</span>
          )}
          {subtaskTotal > 0 && (
            <span className={`inline-flex items-center gap-0.5 text-[10px] ${subtaskDone === subtaskTotal ? 'text-emerald-500' : 'text-slate-400'}`}>
              <ListTodo className="w-2.5 h-2.5" />{subtaskDone}/{subtaskTotal}
            </span>
          )}
        </div>
        {originBadge && (
          <a
            href={originBadge.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md mt-0.5 truncate max-w-full transition-colors ${originBadge.color}`}
          >
            <span>{originBadge.icon}</span>
            <span className="truncate">{originBadge.label}</span>
            <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-50" />
          </a>
        )}
      </div>
    </div>
  )
}

// ── Drag Overlay Card (shown while dragging) ──
function DragOverlayCard({ task }: { task: Task }) {
  const typeConfig = TASK_TYPE_CONFIG[task.type] || TASK_TYPE_CONFIG.reminder
  return (
    <div className="flex items-center gap-2 p-2 rounded-lg border border-emerald-300 bg-white shadow-xl">
      <GripVertical className="w-3 h-3 text-emerald-400" />
      <span className="text-[10px]">{typeConfig.icon}</span>
      <p className="text-xs font-medium text-slate-700 truncate">{task.title}</p>
    </div>
  )
}

// ── Column ──
function TaskColumn({ listId, listName, tasks, completedTasks, onComplete, onOpenFullEdit, onToggleStar, onInlineCreate, isDragOver, onColDragStart, onColDragOver, onColDrop, onColDragEnd }: {
  listId: string | null
  listName: string
  tasks: Task[]
  completedTasks: Task[]
  onComplete: (id: string) => void
  onOpenFullEdit: (t: Task) => void
  onToggleStar: (id: string) => void
  onInlineCreate: (title: string, listId: string | null) => void
  isDragOver?: boolean
  onColDragStart?: () => void
  onColDragOver?: (e: React.DragEvent) => void
  onColDrop?: (e: React.DragEvent) => void
  onColDragEnd?: () => void
}) {
  const [inlineTitle, setInlineTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const columnId = listId || 'none'
  const taskIds = tasks.map(t => t.id)

  const handleCreate = async () => {
    if (!inlineTitle.trim() || creating) return
    setCreating(true)
    onInlineCreate(inlineTitle.trim(), listId)
    setInlineTitle('')
    setCreating(false)
  }

  return (
    <div
      className={`flex flex-col bg-slate-50 rounded-xl border w-72 shrink-0 max-h-full transition-all ${isDragOver ? 'border-emerald-400 ring-2 ring-emerald-200' : 'border-slate-200'}`}
      onDragOver={onColDragOver}
      onDrop={onColDrop}
    >
      {/* Column header */}
      <div
        className="px-3 py-2.5 border-b border-slate-200 flex items-center justify-between bg-white rounded-t-xl group/colhdr"
        draggable={!!listId}
        onDragStart={e => { if (!listId) { e.preventDefault(); return } e.dataTransfer.effectAllowed = 'move'; onColDragStart?.() }}
        onDragEnd={() => onColDragEnd?.()}
      >
        {listId && <GripVertical className="w-3 h-3 text-slate-300 opacity-0 group-hover/colhdr:opacity-100 transition cursor-grab shrink-0 mr-1" />}
        <h3 className="text-sm font-bold text-slate-700 truncate flex-1">{listName}</h3>
        <span className="text-[11px] text-slate-400 tabular-nums">{tasks.length}</span>
      </div>

      {/* Inline create */}
      <div className="px-2 py-1.5 border-b border-slate-100">
        <div className="flex items-center gap-1.5">
          <Plus className={`w-3.5 h-3.5 shrink-0 ${creating ? 'text-slate-300 animate-spin' : 'text-emerald-500'}`} />
          <input
            value={inlineTitle}
            onChange={e => setInlineTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setInlineTitle('') }}
            placeholder="Agregar tarea..."
            disabled={creating}
            className="flex-1 text-xs text-slate-600 placeholder:text-slate-400 outline-none bg-transparent min-w-0"
          />
        </div>
      </div>

      {/* Tasks */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy} id={columnId}>
          {tasks.length === 0 && completedTasks.length === 0 ? (
            <p className="text-[11px] text-slate-400 text-center py-6">Sin tareas</p>
          ) : (
            tasks.map(task => (
              <SortableTaskCard
                key={task.id}
                task={task}
                onComplete={onComplete}
                onOpenFullEdit={onOpenFullEdit}
                onToggleStar={onToggleStar}
              />
            ))
          )}
        </SortableContext>

        {/* Collapsed completed section */}
        {completedTasks.length > 0 && (
          <div className="mt-2 pt-2 border-t border-slate-100">
            <button
              onClick={() => setShowCompleted(!showCompleted)}
              className="flex items-center gap-1 text-[11px] font-medium text-slate-400 hover:text-slate-600 transition w-full"
            >
              <ChevronDown className={`w-3 h-3 transition-transform ${showCompleted ? '' : '-rotate-90'}`} />
              Completadas ({completedTasks.length})
            </button>
            {showCompleted && (
              <div className="mt-1 space-y-1">
                {completedTasks.map(task => (
                  <SortableTaskCard
                    key={task.id}
                    task={task}
                    onComplete={onComplete}
                    onOpenFullEdit={onOpenFullEdit}
                    onToggleStar={onToggleStar}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Columns View ──
export default function TaskColumnsView({
  tasks, taskLists, onComplete, onDelete, onUpdate, onOpenFullEdit, onToggleStar,
  onInlineCreate, onMoveToList, onReorder, onReorderLists, kanbanRef,
}: Props) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [dragColId, setDragColId] = useState<string | null>(null)
  const [dragOverColId, setDragOverColId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  )

  // Build columns: one per list + "Sin lista"
  const columns = useMemo(() => {
    const cols: { id: string | null; name: string; tasks: Task[]; completedTasks: Task[] }[] = []

    taskLists.forEach(list => {
      const listTasks = tasks.filter(t => t.list_id === list.id && t.status !== 'completed' && t.status !== 'cancelled')
      const completedTasks = tasks.filter(t => t.list_id === list.id && (t.status === 'completed' || t.status === 'cancelled'))
      cols.push({ id: list.id, name: list.name, tasks: listTasks, completedTasks })
    })

    // "Sin lista" column
    const noListTasks = tasks.filter(t => !t.list_id && t.status !== 'completed' && t.status !== 'cancelled')
    const noListCompleted = tasks.filter(t => !t.list_id && (t.status === 'completed' || t.status === 'cancelled'))
    cols.push({ id: null, name: 'Sin lista', tasks: noListTasks, completedTasks: noListCompleted })

    return cols
  }, [tasks, taskLists])

  const activeTask = activeId ? tasks.find(t => t.id === activeId) : null

  // Find which column a task belongs to
  const findColumnForTask = (taskId: string): string | null => {
    const task = tasks.find(t => t.id === taskId)
    return task?.list_id || null
  }

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string)
  }

  const handleDragOver = (_event: DragOverEvent) => {
    // Could preview the card in the new column here — kept simple for now
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null)
    const { active, over } = event
    if (!over) return

    const activeTaskId = active.id as string
    const overId = over.id as string

    // Determine the destination column
    // over.id could be a task id or a column sortableContext id
    const overTask = tasks.find(t => t.id === overId)
    const sourceListId = findColumnForTask(activeTaskId)

    let destListId: string | null | undefined
    if (overTask) {
      destListId = overTask.list_id || null
    } else {
      // Dropped on a column zone (the SortableContext id is the column listId or 'none')
      destListId = overId === 'none' ? null : overId
    }

    // If moved to a different column, update the task's list_id
    if (destListId !== undefined && (destListId || null) !== (sourceListId || null)) {
      onMoveToList(activeTaskId, destListId)
    }

    // If same column, determine new order
    if (overTask && (destListId || null) === (sourceListId || null)) {
      const columnTasks = tasks.filter(t =>
        (t.list_id || null) === (sourceListId || null) && t.status !== 'completed' && t.status !== 'cancelled'
      )
      const oldIndex = columnTasks.findIndex(t => t.id === activeTaskId)
      const newIndex = columnTasks.findIndex(t => t.id === overId)
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const reordered = arrayMove(columnTasks, oldIndex, newIndex)
        onReorder(reordered.map(t => t.id))
      }
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div ref={kanbanRef as React.RefObject<HTMLDivElement>} className="flex gap-4 p-4 overflow-x-auto h-full items-start">
        {columns.map(col => (
          <TaskColumn
            key={col.id || 'none'}
            listId={col.id}
            listName={col.name}
            tasks={col.tasks}
            completedTasks={col.completedTasks}
            onComplete={onComplete}
            onOpenFullEdit={onOpenFullEdit}
            onToggleStar={onToggleStar}
            onInlineCreate={onInlineCreate}
            isDragOver={dragOverColId === (col.id || 'none')}
            onColDragStart={() => col.id && setDragColId(col.id)}
            onColDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverColId(col.id || 'none') }}
            onColDrop={e => {
              e.preventDefault()
              setDragOverColId(null)
              if (dragColId && col.id && dragColId !== col.id && onReorderLists) {
                const ids = taskLists.map(l => l.id)
                const from = ids.indexOf(dragColId)
                const to = ids.indexOf(col.id)
                if (from !== -1 && to !== -1) {
                  const newOrder = [...ids]
                  newOrder.splice(from, 1)
                  newOrder.splice(to, 0, dragColId)
                  onReorderLists(newOrder)
                }
              }
              setDragColId(null)
            }}
            onColDragEnd={() => { setDragColId(null); setDragOverColId(null) }}
          />
        ))}
      </div>

      <DragOverlay>
        {activeTask ? <DragOverlayCard task={activeTask} /> : null}
      </DragOverlay>
    </DndContext>
  )
}
