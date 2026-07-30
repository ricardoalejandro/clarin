'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArchiveRestore, BarChart3, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight,
  Clock3, Columns3, FolderOpen, GanttChartSquare, Inbox, LayoutList, ListTodo, Menu,
  Loader2, PanelLeftClose, PanelLeftOpen, Plus, RotateCcw, Search, Settings2, ShieldCheck, Sparkles, Star, Trash2, X,
} from 'lucide-react'
import { apiDelete, apiGet, apiPost, apiPut, subscribeWebSocket } from '@/lib/api'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import {
  TASK_PRIORITY_CONFIG, Task, TaskFilters, TaskFolder, TaskGanttData, TaskList, TaskSavedView,
  TaskTrashContainer, TaskTrashPolicy, TaskViewMode, TaskWorkflow, TaskWorkflowStatus, TaskWorkSummary,
} from '@/types/task'
import TaskBoard, { TaskInlineDraft } from './TaskBoard'
import TaskDetailDrawer from './TaskDetailDrawer'
import TaskEditorModal, { TaskAccountUser } from './TaskEditorModal'
import TaskFilterToolbar, { EMPTY_TASK_FILTERS, TaskFilterChips, taskFilterCount } from './TaskFilters'
import TaskGanttView from './TaskGanttView'
import TaskCalendarView from './TaskCalendarView'
import TaskHierarchyTree from './TaskHierarchyTree'
import TaskStructureModal from './TaskStructureModal'
import TaskDestructiveConfirmDialog from './TaskDestructiveConfirmDialog'
import { TaskContainerIcon } from './TaskContainerAppearance'
import { TaskStatusPicker } from './TaskPropertyPicker'
import { hasActiveTaskQuery, upsertCanonicalTask } from './taskWorkspaceState'
import type { TaskExternalDropTarget } from './taskDropTargets'
import { taskListDensity } from './taskListDensity'

type Scope = { type: 'all' } | { type: 'folder'; id: string } | { type: 'list'; id: string } | { type: 'trash' }
type CalendarMode = 'month' | 'week' | 'day'

const viewOptions: { id: TaskViewMode; label: string; icon: typeof LayoutList }[] = [
  { id: 'list', label: 'Lista', icon: LayoutList }, { id: 'board', label: 'Tablero', icon: Columns3 },
  { id: 'calendar', label: 'Calendario', icon: CalendarDays }, { id: 'gantt', label: 'Gantt', icon: GanttChartSquare },
  { id: 'summary', label: 'Resumen', icon: BarChart3 },
]
const dateShort = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' })
const dateLong = new Intl.DateTimeFormat('es', { weekday: 'short', day: 'numeric', month: 'short' })

function taskIsOverdue(task: Task) {
  return Boolean(task.due_at && new Date(task.due_at) < new Date() && !['done', 'cancelled'].includes(task.status_detail?.category || 'not_started'))
}

function taskStatus(task: Task): TaskWorkflowStatus | undefined {
  return task.status_detail
}

function scopeQuery(scope: Scope) {
  const params = new URLSearchParams()
  if (scope.type === 'folder') params.set('folder_id', scope.id)
  if (scope.type === 'list') params.set('list_id', scope.id)
  if (scope.type === 'trash') {
    params.set('deleted', 'true')
    params.set('include_subtasks', 'true')
  }
  return params
}

function appendTaskFilters(params: URLSearchParams, filters: TaskFilters) {
  if (filters.status_ids.length) {
    params.set('status_ids', filters.status_ids.join(','))
    if (filters.status_ids.length === 1) params.set('status', filters.status_ids[0])
  }
  if (filters.assigned_to_ids.length) {
    params.set('assigned_to_ids', filters.assigned_to_ids.join(','))
    if (filters.assigned_to_ids.length === 1) params.set('assigned_to', filters.assigned_to_ids[0])
  }
  if (filters.collaborator_ids.length) params.set('collaborator_ids', filters.collaborator_ids.join(','))
  if (filters.priorities.length) params.set('priorities', filters.priorities.join(','))
  if (filters.types.length) params.set('types', filters.types.join(','))
  if (filters.creator_ids.length) params.set('creator_ids', filters.creator_ids.join(','))
  if (filters.due) params.set('due', filters.due)
  if (filters.created_from) params.set('created_from', filters.created_from)
  if (filters.created_to) params.set('created_to', filters.created_to)
  if (filters.completed_from) params.set('completed_from', filters.completed_from)
  if (filters.completed_to) params.set('completed_to', filters.completed_to)
  if (filters.has_subtasks !== undefined) params.set('has_subtasks', String(filters.has_subtasks))
  if (filters.has_comments !== undefined) params.set('has_comments', String(filters.has_comments))
  if (filters.has_attachments !== undefined) params.set('has_attachments', String(filters.has_attachments))
  if (filters.has_dependencies !== undefined) params.set('has_dependencies', String(filters.has_dependencies))
  if (filters.starred !== undefined) params.set('starred', String(filters.starred))
}

async function fetchTaskPages(params: URLSearchParams, signal?: AbortSignal) {
  const firstParams = new URLSearchParams(params)
  firstParams.set('limit', '200')
  firstParams.set('offset', '0')
  const first = await apiGet<{ tasks: Task[]; total: number }>(`/api/tasks?${firstParams}`, { signal })
  if (!first.success) return first
  const total = first.data?.total || 0
  const pages: Task[] = [...(first.data?.tasks || [])]
  const offsets = Array.from({ length: Math.max(0, Math.ceil(total / 200) - 1) }, (_, index) => (index + 1) * 200)
  for (let index = 0; index < offsets.length; index += 5) {
    const batch = await Promise.all(offsets.slice(index, index + 5).map(offset => {
      const pageParams = new URLSearchParams(params)
      pageParams.set('limit', '200')
      pageParams.set('offset', String(offset))
      return apiGet<{ tasks: Task[]; total: number }>(`/api/tasks?${pageParams}`, { signal })
    }))
    const failed = batch.find(page => !page.success)
    if (failed) return { success: false, error: failed.error || 'No se pudo cargar una página de tareas' }
    for (const page of batch) pages.push(...(page.data?.tasks || []))
  }
  return { success: true, data: { tasks: Array.from(new Map(pages.map(task => [task.id, task])).values()), total } }
}

function TaskCard({ task, compact = false, onOpen, onStar }: { task: Task; compact?: boolean; onOpen: () => void; onStar?: () => void }) {
  const overdue = taskIsOverdue(task)
  return <article onClick={onOpen} className={`group cursor-pointer rounded-xl border bg-white transition hover:-translate-y-0.5 hover:border-emerald-200 hover:shadow-md ${compact ? 'p-3' : 'p-3.5'} ${overdue ? 'border-rose-200' : 'border-slate-200'}`}>
    <div className="flex items-start gap-2"><span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: task.status_detail?.color || '#64748b' }} /><h4 className={`min-w-0 flex-1 text-sm font-semibold leading-5 ${task.status_detail?.category === 'done' ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{task.title}</h4>{onStar && <button onClick={event => { event.stopPropagation(); onStar() }} className={`rounded p-1 ${task.starred ? 'text-amber-400' : 'text-slate-300 opacity-0 group-hover:opacity-100'}`}><Star className={`h-3.5 w-3.5 ${task.starred ? 'fill-current' : ''}`} /></button>}</div>
    {!compact && task.description && <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-400">{task.description}</p>}
    <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px]"><span className={`rounded-md px-1.5 py-1 font-semibold ${TASK_PRIORITY_CONFIG[task.priority].bg} ${TASK_PRIORITY_CONFIG[task.priority].color}`}>{TASK_PRIORITY_CONFIG[task.priority].label}</span>{task.due_at && <span className={`flex items-center gap-1 font-medium ${overdue ? 'text-rose-600' : 'text-slate-400'}`}><CalendarDays className="h-3 w-3" />{dateShort.format(new Date(task.due_at))}</span>}{Boolean(task.subtask_count) && <span className="text-slate-400">✓ {task.subtask_done}/{task.subtask_count}</span>}<span className="ml-auto flex h-6 min-w-6 items-center justify-center rounded-full bg-slate-100 px-1.5 font-bold text-slate-500" title={task.assigned_to_name}>{(task.assigned_to_name || '?').slice(0, 2).toUpperCase()}</span></div>
    {!compact && Boolean(task.progress) && <div className="mt-2 h-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-emerald-500" style={{ width: `${task.progress}%` }} /></div>}
  </article>
}

function ListView({ tasks, statuses, allStatuses, onOpen, onStatus, onStar }: { tasks: Task[]; statuses: TaskWorkflowStatus[]; allStatuses: TaskWorkflowStatus[]; onOpen: (task: Task) => void; onStatus: (task: Task, statusId: string) => void; onStar: (task: Task) => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(entries => setContainerWidth(Math.round(entries[0]?.contentRect.width || 0)))
    observer.observe(container)
    return () => observer.disconnect()
  }, [])
  const density = taskListDensity(containerWidth)
  if (!tasks.length) return <EmptyState />
  const sections = statuses.map(status => ({ status, tasks: tasks.filter(task => task.status_id === status.id) })).filter(section => section.tasks.length)
  const orphaned = tasks.filter(task => !statuses.some(status => status.id === task.status_id))
  if (orphaned.length) sections.push({ status: { id: 'other', name: 'Otros', color: '#94a3b8', category: 'not_started', sort_order: 999 } as TaskWorkflowStatus, tasks: orphaned })
  return <div ref={containerRef} data-task-list-density={density} className="space-y-3 pb-8">{sections.map(section => <section key={section.status.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <button onClick={() => setCollapsed(current => ({ ...current, [section.status.id]: !current[section.status.id] }))} className="flex w-full items-center gap-2 border-b border-slate-100 px-4 py-3 text-left"><ChevronDown className={`h-4 w-4 text-slate-400 transition ${collapsed[section.status.id] ? '-rotate-90' : ''}`} /><i className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: section.status.color }} /><span className="text-xs font-bold uppercase tracking-wider text-slate-600">{section.status.name}</span><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-400">{section.tasks.length}</span></button>
    {!collapsed[section.status.id] && <div className="divide-y divide-slate-100">{section.tasks.map(task => { const allowed = allStatuses.filter(status => status.workflow_id === task.status_detail?.workflow_id).sort((left, right) => left.sort_order - right.sort_order); return <div key={task.id} onClick={() => onOpen(task)} className={`group grid cursor-pointer items-center gap-3 px-4 py-3 hover:bg-slate-50 ${density === 'comfortable' ? 'grid-cols-[minmax(260px,1fr)_minmax(200px,220px)_minmax(150px,180px)_100px_40px]' : density === 'compact' ? 'grid-cols-[minmax(220px,1fr)_minmax(176px,190px)_minmax(120px,150px)_90px_36px]' : 'grid-cols-1'}`}>
      <div className="flex min-w-0 items-center gap-3"><button onClick={event => { event.stopPropagation(); const next = allowed.find(status => status.category === (task.status_detail?.category === 'done' ? 'not_started' : 'done')); if (next) onStatus(task, next.id) }} className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${task.status_detail?.category === 'done' ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 bg-white'}`}>{task.status_detail?.category === 'done' && <Check className="h-3 w-3" />}</button><div className="min-w-0"><p className={`truncate text-sm font-medium ${task.status_detail?.category === 'done' ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{task.title}</p><p className="mt-0.5 truncate text-[10px] text-slate-400">{task.list_name || 'Bandeja general'}{task.subtask_count ? ` · ${task.subtask_done}/${task.subtask_count} subtareas` : ''}{density === 'stacked' ? ` · ${task.assigned_to_name || 'Sin responsable'} · ${task.due_at ? dateShort.format(new Date(task.due_at)) : 'Sin fecha'}` : ''}</p></div></div>
      <div onClick={event => event.stopPropagation()}><TaskStatusPicker value={task.status_id || ''} statuses={allowed} compact={density === 'compact'} onChange={statusID => onStatus(task, statusID)} /></div>
      <div className={`items-center gap-2 ${density === 'stacked' ? 'hidden' : 'flex'}`}><span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-[9px] font-bold text-slate-500">{(task.assigned_to_name || '?').slice(0,2).toUpperCase()}</span><span className="truncate text-xs text-slate-500">{task.assigned_to_name || 'Sin nombre'}</span></div>
      <span className={`${density === 'stacked' ? 'hidden' : 'block'} text-xs ${taskIsOverdue(task) ? 'font-semibold text-rose-600' : 'text-slate-400'}`}>{task.due_at ? dateShort.format(new Date(task.due_at)) : 'Sin fecha'}</span>
      <button onClick={event => { event.stopPropagation(); onStar(task) }} className={`${density === 'stacked' ? 'hidden' : 'block'} rounded-lg p-2 ${task.starred ? 'text-amber-400' : 'text-slate-300 opacity-0 group-hover:opacity-100'}`}><Star className={`h-4 w-4 ${task.starred ? 'fill-current' : ''}`} /></button>
    </div> })}</div>}
  </section>)}</div>
}

function CalendarView({ tasks, onOpen }: { tasks: Task[]; onOpen: (task: Task) => void }) {
  const [mode, setMode] = useState<CalendarMode>('month')
  const [cursor, setCursor] = useState(new Date())
  const dayTasks = (day: Date) => tasks.filter(task => task.due_at && new Date(task.due_at).toDateString() === day.toDateString())
  const move = (direction: number) => setCursor(value => { const next = new Date(value); if (mode === 'month') next.setMonth(next.getMonth() + direction); else if (mode === 'week') next.setDate(next.getDate() + direction * 7); else next.setDate(next.getDate() + direction); return next })
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const gridStart = new Date(first); gridStart.setDate(1 - ((first.getDay() + 6) % 7))
  const monthDays = Array.from({ length: 42 }, (_, index) => { const date = new Date(gridStart); date.setDate(gridStart.getDate() + index); return date })
  const weekStart = new Date(cursor); weekStart.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7)); weekStart.setHours(0,0,0,0)
  const weekDays = Array.from({ length: 7 }, (_, index) => { const date = new Date(weekStart); date.setDate(weekStart.getDate() + index); return date })
  return <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3"><button onClick={() => move(-1)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><ChevronLeft className="h-4 w-4" /></button><button onClick={() => setCursor(new Date())} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600">Hoy</button><button onClick={() => move(1)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><ChevronRight className="h-4 w-4" /></button><h3 className="ml-1 text-sm font-bold capitalize text-slate-800">{cursor.toLocaleDateString('es', mode === 'month' ? { month: 'long', year: 'numeric' } : { day: 'numeric', month: 'long', year: 'numeric' })}</h3><div className="ml-auto flex rounded-lg bg-slate-100 p-1">{(['month','week','day'] as CalendarMode[]).map(item => <button key={item} onClick={() => setMode(item)} className={`rounded-md px-2.5 py-1.5 text-[11px] font-semibold ${mode === item ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-400'}`}>{item === 'month' ? 'Mes' : item === 'week' ? 'Semana' : 'Día'}</button>)}</div></header>
    <div className="min-h-0 flex-1 overflow-auto">
      {mode === 'month' && <div className="grid min-h-full grid-cols-7 grid-rows-[32px_repeat(6,minmax(100px,1fr))]">{['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].map(day => <div key={day} className="flex items-center justify-center border-b border-r border-slate-100 text-[10px] font-bold uppercase text-slate-400">{day}</div>)}{monthDays.map(day => { const items = dayTasks(day); const activeMonth = day.getMonth() === cursor.getMonth(); const today = day.toDateString() === new Date().toDateString(); return <div key={day.toISOString()} className={`min-h-[100px] border-b border-r border-slate-100 p-1.5 ${activeMonth ? 'bg-white' : 'bg-slate-50/70'}`}><div className={`mb-1 flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold ${today ? 'bg-emerald-600 text-white' : activeMonth ? 'text-slate-600' : 'text-slate-300'}`}>{day.getDate()}</div><div className="space-y-1">{items.slice(0,3).map(task => <button key={task.id} onClick={() => onOpen(task)} className="block w-full truncate rounded px-1.5 py-1 text-left text-[10px] font-medium text-white" style={{ backgroundColor: task.status_detail?.color || '#64748b' }}>{task.title}</button>)}{items.length > 3 && <span className="px-1 text-[9px] font-semibold text-slate-400">+{items.length - 3} más</span>}</div></div> })}</div>}
      {mode === 'week' && <div className="grid min-h-full grid-cols-7">{weekDays.map(day => <div key={day.toISOString()} className="border-r border-slate-100"><div className="sticky top-0 border-b border-slate-100 bg-white p-3 text-center"><p className="text-[10px] font-bold uppercase text-slate-400">{day.toLocaleDateString('es',{weekday:'short'})}</p><p className="mt-1 text-lg font-bold text-slate-700">{day.getDate()}</p></div><div className="space-y-2 p-2">{dayTasks(day).map(task => <TaskCard key={task.id} task={task} compact onOpen={() => onOpen(task)} />)}</div></div>)}</div>}
      {mode === 'day' && <div className="mx-auto max-w-3xl p-4"><h3 className="mb-4 text-sm font-bold capitalize text-slate-700">{dateLong.format(cursor)}</h3><div className="space-y-2">{dayTasks(cursor).sort((a,b) => new Date(a.due_at!).getTime()-new Date(b.due_at!).getTime()).map(task => <div key={task.id} className="grid grid-cols-[64px_1fr] items-start gap-3"><span className="pt-3 text-xs font-semibold text-slate-400">{new Date(task.due_at!).toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'})}</span><TaskCard task={task} onOpen={() => onOpen(task)} /></div>)}{!dayTasks(cursor).length && <div className="rounded-2xl border border-dashed border-slate-300 py-16 text-center text-sm text-slate-400">No hay tareas programadas.</div>}</div></div>}
    </div>
  </div>
}

function SummaryView({ tasks, summary, users }: { tasks: Task[]; summary: TaskWorkSummary | null; users: TaskAccountUser[] }) {
  const statusGroups = Array.from(new Map(tasks.filter(task => task.status_detail).map(task => [task.status_id!, task.status_detail!])).values()).map(status => ({ ...status, count: tasks.filter(task => task.status_id === status.id).length }))
  const maxStatus = Math.max(1, ...statusGroups.map(item => item.count))
  const workload = users.map(user => ({ user, tasks: tasks.filter(task => task.assigned_to === user.id), overdue: tasks.filter(task => task.assigned_to === user.id && taskIsOverdue(task)).length })).filter(item => item.tasks.length).sort((a,b) => b.tasks.length-a.tasks.length)
  const maxWork = Math.max(1, ...workload.map(item => item.tasks.length))
  const completion = summary?.total ? Math.round((summary.done / summary.total) * 100) : 0
  return <div className="space-y-5 pb-8">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{[
      ['Total', summary?.total || 0, 'text-slate-900'], ['Completadas', summary?.done || 0, 'text-emerald-600'],
      ['En curso', summary?.active || 0, 'text-blue-600'], ['Vencidas', summary?.overdue || 0, 'text-rose-600'],
      ['Progreso', `${Math.round(summary?.progress || 0)}%`, 'text-violet-600'],
    ].map(([label,value,color]) => <div key={label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p className="text-xs font-semibold text-slate-400">{label}</p><p className={`mt-2 text-2xl font-black ${color}`}>{value}</p></div>)}</div>
    <div className="grid gap-5 lg:grid-cols-[1fr_1fr_280px]">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h3 className="text-sm font-bold text-slate-800">Distribución por estado</h3><div className="mt-5 space-y-4">{statusGroups.map(status => <div key={status.id}><div className="mb-1.5 flex justify-between text-xs"><span className="font-medium text-slate-600">{status.name}</span><span className="font-bold text-slate-500">{status.count}</span></div><div className="h-2 rounded-full bg-slate-100"><div className="h-full rounded-full" style={{ width: `${(status.count/maxStatus)*100}%`, backgroundColor: status.color }} /></div></div>)}</div></section>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h3 className="text-sm font-bold text-slate-800">Carga del equipo</h3><div className="mt-5 space-y-4">{workload.map(item => <div key={item.user.id}><div className="mb-1.5 flex justify-between text-xs"><span className="font-medium text-slate-600">{item.user.display_name || item.user.username}</span><span className={item.overdue ? 'font-bold text-rose-600' : 'font-bold text-slate-500'}>{item.tasks.length}{item.overdue ? ` · ${item.overdue} vencidas` : ''}</span></div><div className="h-2 rounded-full bg-slate-100"><div className={`h-full rounded-full ${item.overdue ? 'bg-rose-400' : 'bg-blue-500'}`} style={{ width: `${(item.tasks.length/maxWork)*100}%` }} /></div></div>)}</div></section>
      <section className="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-slate-900 p-6 text-white shadow-sm"><div className="relative flex h-36 w-36 items-center justify-center rounded-full" style={{ background: `conic-gradient(#34d399 ${completion * 3.6}deg,#334155 0deg)` }}><div className="flex h-28 w-28 flex-col items-center justify-center rounded-full bg-slate-900"><span className="text-3xl font-black">{completion}%</span><span className="text-[10px] uppercase tracking-wider text-slate-400">completado</span></div></div><p className="mt-5 text-center text-xs leading-5 text-slate-400">{summary?.owners || 0} responsables participan en este ámbito.</p></section>
    </div>
  </div>
}

function EmptyState() {
  return <div className="flex h-full min-h-[300px] flex-col items-center justify-center bg-white p-6 text-center"><div className="rounded-2xl bg-emerald-50 p-4"><Sparkles className="h-7 w-7 text-emerald-600" /></div><h3 className="mt-4 text-base font-bold text-slate-800">Todo listo para empezar</h3><p className="mt-1 max-w-xs text-sm leading-6 text-slate-400">Crea la primera tarea o cambia los filtros para ver el trabajo existente.</p></div>
}

type TrashTarget = { kind: 'task' | 'list' | 'folder'; id: string; name: string }

function TrashView({ tasks, onChanged, onError }: { tasks: Task[]; onChanged: () => Promise<void>; onError: (message: string) => void }) {
  const [tab, setTab] = useState<'tasks' | 'containers'>('tasks')
  const [policy, setPolicy] = useState<TaskTrashPolicy>({ retention_days: 30, can_manage: false })
  const [containers, setContainers] = useState<TaskTrashContainer[]>([])
  const [loadingMeta, setLoadingMeta] = useState(true)
  const [pending, setPending] = useState('')
  const [purgeTarget, setPurgeTarget] = useState<TrashTarget | null>(null)
  const [purgeError, setPurgeError] = useState('')
  const [customDays, setCustomDays] = useState('30')

  const loadMeta = useCallback(async () => {
    setLoadingMeta(true)
    const [policyResult, containerResult] = await Promise.all([
      apiGet<TaskTrashPolicy>('/api/tasks/trash-policy'),
      apiGet<{ containers: TaskTrashContainer[] }>('/api/tasks/trash/containers'),
    ])
    if (policyResult.success && policyResult.data) {
      setPolicy(policyResult.data)
      if (policyResult.data.retention_days !== null) setCustomDays(String(policyResult.data.retention_days))
    } else onError(policyResult.error || 'No se pudo cargar la política de Papelera.')
    if (containerResult.success) setContainers(containerResult.data?.containers || [])
    else onError(containerResult.error || 'No se pudieron cargar las listas y carpetas archivadas.')
    setLoadingMeta(false)
  }, [onError])
  useEffect(() => { void loadMeta() }, [loadMeta])
  useEffect(() => subscribeWebSocket(raw => {
    const message = raw as { event?: string; data?: { action?: string } }
    if (message.event !== 'task_update') return
    if (['trash_policy_updated', 'folder_archived', 'folder_restored', 'folder_purged', 'list_deleted', 'list_restored', 'list_purged', 'deleted', 'restored', 'task_purged'].includes(message.data?.action || '')) void loadMeta()
  }), [loadMeta])

  const nextForTask = (task: Task) => {
    if (!task.deleted_at || policy.retention_days === null) return null
    return new Date(new Date(task.deleted_at).getTime() + policy.retention_days * 86_400_000)
  }
  const taskCanPurge = (task: Task) => {
    const next = nextForTask(task)
    return Boolean(next && next.getTime() <= Date.now())
  }
  const timing = (next?: Date | string | null) => {
    if (policy.retention_days === null) return 'Conservación permanente'
    if (!next) return `Retención de ${policy.retention_days} días`
    const date = typeof next === 'string' ? new Date(next) : next
    const remaining = Math.ceil((date.getTime() - Date.now()) / 86_400_000)
    return remaining <= 0 ? 'Elegible para eliminación permanente' : `${remaining} día${remaining === 1 ? '' : 's'} restante${remaining === 1 ? '' : 's'}`
  }
  const restoreTask = async (task: Task) => {
    const key = `restore-task:${task.id}`; if (pending) return; setPending(key)
    const result = await apiPost(`/api/tasks/${task.id}/restore`, { operation_id: crypto.randomUUID() })
    if (result.success) await Promise.all([onChanged(), loadMeta()]); else onError(result.error || 'No se pudo restaurar la tarea.')
    setPending('')
  }
  const restoreContainer = async (item: TaskTrashContainer) => {
    const key = `restore-${item.type}:${item.id}`; if (pending) return; setPending(key)
    const result = await apiPost(`/api/tasks/${item.type === 'folder' ? 'folders' : 'lists'}/${item.id}/restore`, { operation_id: crypto.randomUUID() })
    if (result.success) await Promise.all([onChanged(), loadMeta()]); else onError(result.error || `No se pudo restaurar ${item.type === 'folder' ? 'la carpeta' : 'la lista'}.`)
    setPending('')
  }
  const savePolicy = async (value: number | null) => {
    if (!policy.can_manage || pending || (value !== null && (value < 7 || value > 365))) return
    setPending('policy')
    const result = await apiPut<TaskTrashPolicy>('/api/tasks/trash-policy', { retention_days: value })
    if (result.success && result.data) { setPolicy(result.data); if (value !== null) setCustomDays(String(value)); await loadMeta() }
    else onError(result.error || 'No se pudo actualizar la retención.')
    setPending('')
  }
  const purge = async () => {
    if (!purgeTarget || pending) return
    const key = `purge-${purgeTarget.kind}:${purgeTarget.id}`; setPending(key); setPurgeError('')
    const endpoint = purgeTarget.kind === 'task' ? `/api/tasks/${purgeTarget.id}/purge` : `/api/tasks/${purgeTarget.kind === 'folder' ? 'folders' : 'lists'}/${purgeTarget.id}/purge`
    const result = await apiDelete(endpoint, { confirmation_name: purgeTarget.name, operation_id: crypto.randomUUID() })
    if (result.success) { setPurgeTarget(null); await Promise.all([onChanged(), loadMeta()]) }
    else setPurgeError(result.error || 'No se pudo eliminar permanentemente. Reintenta.')
    setPending('')
  }

  return <div className="min-h-full overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="border-b border-slate-100 px-4 py-4 sm:px-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-black text-slate-900">Papelera de Clarin Work</h3><p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">Solo una acción explícita de “Mover a Papelera” inicia la retención. Las tareas completadas permanecen en sus listas sin plazo de eliminación.</p></div><div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-[11px] font-bold text-emerald-700"><ShieldCheck className="h-4 w-4" />{policy.retention_days === null ? 'Nunca eliminar' : `${policy.retention_days} días de retención`}</div></div>
      {policy.can_manage && <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-100 bg-slate-50 p-2.5"><span className="mr-1 text-[10px] font-black uppercase tracking-[.12em] text-slate-400">Política de la cuenta</span>{[7, 30, 90, 180, 365].map(value => <button key={value} disabled={pending === 'policy'} onClick={() => void savePolicy(value)} className={`rounded-xl px-3 py-2 text-xs font-bold transition ${policy.retention_days === value ? 'bg-slate-900 text-white shadow-sm' : 'bg-white text-slate-500 hover:text-slate-800'}`}>{value} días</button>)}<button disabled={pending === 'policy'} onClick={() => void savePolicy(null)} className={`rounded-xl px-3 py-2 text-xs font-bold transition ${policy.retention_days === null ? 'bg-slate-900 text-white shadow-sm' : 'bg-white text-slate-500 hover:text-slate-800'}`}>Nunca</button><div className="ml-auto flex items-center gap-1.5"><input aria-label="Días de retención personalizados" type="number" min={7} max={365} value={customDays} onChange={event => setCustomDays(event.target.value)} className="h-9 w-20 rounded-xl border border-slate-200 bg-white px-2 text-center text-xs font-bold text-slate-700 outline-none focus:border-emerald-400" /><button disabled={pending === 'policy' || Number(customDays) < 7 || Number(customDays) > 365} onClick={() => void savePolicy(Number(customDays))} className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 hover:border-emerald-200 hover:text-emerald-700 disabled:opacity-30">Aplicar</button></div></div>}
    </div>
    <div className="flex border-b border-slate-100 bg-slate-50/60 px-4 pt-2 sm:px-5"><button onClick={() => setTab('tasks')} className={`flex items-center gap-2 border-b-2 px-3 py-2.5 text-xs font-bold ${tab === 'tasks' ? 'border-emerald-500 text-emerald-700' : 'border-transparent text-slate-400'}`}><ListTodo className="h-4 w-4" />Tareas <span className="rounded-full bg-white px-2 py-0.5 text-[10px] text-slate-500">{tasks.length}</span></button><button onClick={() => setTab('containers')} className={`flex items-center gap-2 border-b-2 px-3 py-2.5 text-xs font-bold ${tab === 'containers' ? 'border-emerald-500 text-emerald-700' : 'border-transparent text-slate-400'}`}><FolderOpen className="h-4 w-4" />Listas y carpetas <span className="rounded-full bg-white px-2 py-0.5 text-[10px] text-slate-500">{containers.length}</span></button></div>
    {tab === 'tasks' ? <div className="divide-y divide-slate-100">{tasks.map(task => { const next = nextForTask(task); const canPurge = taskCanPurge(task); return <div key={task.id} className={`flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-5 ${task.parent_task_id ? 'pl-8 sm:pl-10' : ''}`}><div className="rounded-xl bg-slate-100 p-2"><Trash2 className="h-4 w-4 text-slate-400" /></div><div className="min-w-[180px] flex-1"><p className="truncate text-sm font-semibold text-slate-700">{task.title}</p><p className="mt-0.5 text-[10px] text-slate-400">{task.parent_task_id ? 'Subtarea' : task.list_name || 'Bandeja general'} · movida {task.deleted_at ? dateShort.format(new Date(task.deleted_at)) : ''}</p></div><div className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[10px] font-bold ${canPurge ? 'bg-amber-50 text-amber-700' : 'bg-slate-50 text-slate-500'}`}><Clock3 className="h-3.5 w-3.5" />{timing(next)}</div><button disabled={Boolean(pending)} onClick={() => void restoreTask(task)} className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-40"><RotateCcw className="h-3.5 w-3.5" /> Restaurar</button>{policy.can_manage && canPurge && <button disabled={Boolean(pending)} onClick={() => { setPurgeError(''); setPurgeTarget({ kind: 'task', id: task.id, name: task.title }) }} className="rounded-xl px-3 py-2 text-xs font-bold text-rose-600 hover:bg-rose-50 disabled:opacity-40">Eliminar permanentemente</button>}</div>})}{!tasks.length && <div className="py-16 text-center"><ArchiveRestore className="mx-auto h-8 w-8 text-slate-300" /><p className="mt-3 text-sm font-semibold text-slate-500">No hay tareas en Papelera.</p></div>}</div> : <div className="divide-y divide-slate-100">{containers.map(item => <div key={`${item.type}:${item.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-5"><div className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ color: item.color, backgroundColor: `${item.color}18` }}><TaskContainerIcon value={item.icon} className="h-4 w-4" /></div><div className="min-w-[180px] flex-1"><p className="truncate text-sm font-semibold text-slate-700">{item.name}</p><p className="mt-0.5 text-[10px] text-slate-400">{item.type === 'folder' ? `Carpeta · ${item.list_count} lista${item.list_count === 1 ? '' : 's'}` : `Lista${item.original_folder_name ? ` · ${item.original_folder_name}` : ' · nivel principal'}`} · {item.task_count} tarea{item.task_count === 1 ? '' : 's'}</p></div><div className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[10px] font-bold ${item.can_purge ? 'bg-amber-50 text-amber-700' : 'bg-slate-50 text-slate-500'}`}><Clock3 className="h-3.5 w-3.5" />{timing(item.next_eligible_at)}</div><button disabled={Boolean(pending) || item.restore_blocked} title={item.restore_blocked ? 'Restaura primero la carpeta original' : 'Restaurar'} onClick={() => void restoreContainer(item)} className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-35"><RotateCcw className="h-3.5 w-3.5" /> Restaurar</button>{policy.can_manage && item.can_purge && <button disabled={Boolean(pending)} onClick={() => { setPurgeError(''); setPurgeTarget({ kind: item.type, id: item.id, name: item.name }) }} className="rounded-xl px-3 py-2 text-xs font-bold text-rose-600 hover:bg-rose-50 disabled:opacity-40">Eliminar permanentemente</button>}</div>)}{!containers.length && !loadingMeta && <div className="py-16 text-center"><FolderOpen className="mx-auto h-8 w-8 text-slate-300" /><p className="mt-3 text-sm font-semibold text-slate-500">No hay listas ni carpetas en Papelera.</p></div>}</div>}
    <TaskDestructiveConfirmDialog open={Boolean(purgeTarget)} permanent title={`Eliminar ${purgeTarget?.kind === 'folder' ? 'carpeta' : purgeTarget?.kind === 'list' ? 'lista' : 'tarea'} permanentemente`} description="Esta acción es irreversible. Se eliminará el elemento archivado y, cuando corresponda, todo su árbol. La operación se bloqueará si algún descendiente aún no cumple la retención." actionLabel="Eliminar permanentemente" confirmationName={purgeTarget?.name} busy={pending.startsWith('purge-')} error={purgeError} onClose={() => { if (!pending.startsWith('purge-')) { setPurgeTarget(null); setPurgeError('') } }} onConfirm={() => void purge()} />
  </div>
}

export default function TaskWorkspace() {
  const [folders, setFolders] = useState<TaskFolder[]>([])
  const [rootLists, setRootLists] = useState<TaskList[]>([])
  const [workflows, setWorkflows] = useState<TaskWorkflow[]>([])
  const [users, setUsers] = useState<TaskAccountUser[]>([])
  const [currentUserId, setCurrentUserId] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [gantt, setGantt] = useState<TaskGanttData>({ tasks: [], dependencies: [], critical_task_ids: [], slack_minutes: {}, unscheduled_count: 0 })
  const [scope, setScope] = useState<Scope>({ type: 'all' })
  const [view, setView] = useState<TaskViewMode>(() => typeof window === 'undefined' ? 'list' : (localStorage.getItem('tasks:view') as TaskViewMode) || 'list')
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [workspaceWidth, setWorkspaceWidth] = useState(0)
  const [debouncedSearch, setDebouncedSearch] = useDebouncedValue(search.trim(), 500)
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_TASK_FILTERS)
  const [collapsedStatusIds, setCollapsedStatusIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [recentlyCreatedTaskId, setRecentlyCreatedTaskId] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [taskDragActiveState, setTaskDragActiveState] = useState(false)
  const [taskDropTarget, setTaskDropTarget] = useState<TaskExternalDropTarget | null>(null)
  const boardSidebarWasCollapsedRef = useRef(false)
  const [navOverflow, setNavOverflow] = useState({ top: false, bottom: false })
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [subtaskParent, setSubtaskParent] = useState<Task | null>(null)
  const [createStatusId, setCreateStatusId] = useState('')
  const [createDraft, setCreateDraft] = useState<TaskInlineDraft | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [structureOpen, setStructureOpen] = useState(false)
  const [structureReady, setStructureReady] = useState(false)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const structureSequence = useRef(0)
  const loadSequence = useRef(0)
  const taskLoadAbortRef = useRef<AbortController | null>(null)
  const creationHighlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedOnce = useRef(false)
  const defaultViewLoadHandled = useRef(false)
  const tasksRef = useRef<Task[]>([])
  const taskVersions = useRef(new Map<string, number>())
  const taskTombstones = useRef(new Map<string, number>())
  const pendingOperations = useRef(new Set<string>())
  const pendingOperationTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const boardDragActive = useRef(false)
  const queuedRealtimeRefresh = useRef(false)
  const queuedStructureRefresh = useRef(false)
  const reconciliationTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const navRef = useRef<HTMLElement>(null)

  const lists = useMemo(() => [...rootLists, ...folders.flatMap(folder => folder.lists)], [rootLists, folders])
  const globalTaskCount = useMemo(() => lists.reduce((total, list) => total + (list.task_count || 0), 0), [lists])
  const activeList = scope.type === 'list' ? lists.find(list => list.id === scope.id) : undefined
  const activeFolder = scope.type === 'folder' ? folders.find(folder => folder.id === scope.id) : activeList?.folder_id ? folders.find(folder => folder.id === activeList.folder_id) : undefined
  const scopeName = scope.type === 'all' ? 'Todo el trabajo' : scope.type === 'folder' ? activeFolder?.name || 'Carpeta' : scope.type === 'list' ? activeList?.name || 'Lista' : 'Papelera'

  const acceptCanonicalTask = useCallback((incoming: Task, action = 'updated') => {
    const incomingVersion = incoming.version || 0
    const knownVersion = taskVersions.current.get(incoming.id) || 0
    const deletedVersion = taskTombstones.current.get(incoming.id)
    if (action === 'restored') {
      if (incomingVersion < Math.max(knownVersion, deletedVersion || 0)) return false
      taskTombstones.current.delete(incoming.id)
    } else if (deletedVersion !== undefined) return false
    if (incomingVersion < knownVersion) return false
    taskVersions.current.set(incoming.id, Math.max(knownVersion, incomingVersion))
    return true
  }, [])

  const markTaskDeleted = useCallback((taskID: string, version?: number) => {
    const knownVersion = taskVersions.current.get(taskID) || 0
    const deletedVersion = version || knownVersion
    if (deletedVersion < knownVersion) return false
    taskVersions.current.set(taskID, Math.max(knownVersion, deletedVersion))
    taskTombstones.current.set(taskID, Math.max(taskTombstones.current.get(taskID) || 0, deletedVersion))
    return true
  }, [])

  const loadStructure = useCallback(async () => {
    const sequence = ++structureSequence.current
    const [hierarchyRes, workflowRes, userRes, meRes] = await Promise.all([
      apiGet<{ folders: TaskFolder[]; root_lists: TaskList[] }>('/api/tasks/hierarchy'),
      apiGet<{ workflows: TaskWorkflow[] }>('/api/tasks/workflows'),
      apiGet<{ users: TaskAccountUser[] }>('/api/account/users'),
      apiGet<{ user: { id: string } }>('/api/me'),
    ])
    if (sequence !== structureSequence.current) return
    if (hierarchyRes.success) { setFolders(hierarchyRes.data?.folders || []); setRootLists(hierarchyRes.data?.root_lists || []) }
    if (workflowRes.success) setWorkflows(workflowRes.data?.workflows || [])
    if (userRes.success) setUsers(userRes.data?.users || [])
    if (meRes.success) setCurrentUserId(meRes.data?.user?.id || '')
    setStructureReady(true)
  }, [])

  const loadTasks = useCallback(async (showLoader = false) => {
    taskLoadAbortRef.current?.abort()
    const controller = new AbortController()
    taskLoadAbortRef.current = controller
    const sequence = ++loadSequence.current
    const versionsAtRequestStart = new Map(taskVersions.current)
    if (showLoader && !loadedOnce.current) setLoading(true)
    const params = scopeQuery(scope)
    if (debouncedSearch) params.set('search', debouncedSearch)
    appendTaskFilters(params, filters)
    const ganttParams = scopeQuery(scope)
    if (debouncedSearch) ganttParams.set('search', debouncedSearch)
    appendTaskFilters(ganttParams, filters)
    const queryActive = hasActiveTaskQuery(debouncedSearch, taskFilterCount(filters))
    const taskRes = await fetchTaskPages(params, controller.signal)
    if (sequence !== loadSequence.current || controller.signal.aborted) return
    if (taskRes.success) {
      const loadedTasks = taskRes.data?.tasks || []
      setTasks(current => {
        const currentByID = new Map(current.map(task => [task.id, task]))
        const reconciled = loadedTasks.flatMap(task => {
          const incomingVersion = task.version || 0
          const knownVersion = taskVersions.current.get(task.id) || 0
          const deletedVersion = taskTombstones.current.get(task.id)
          if (incomingVersion < knownVersion) {
            const newer = currentByID.get(task.id)
            return newer && (newer.version || 0) >= knownVersion ? [newer] : []
          }
          if (scope.type !== 'trash' && deletedVersion !== undefined && incomingVersion <= deletedVersion) return []
          taskVersions.current.set(task.id, Math.max(knownVersion, incomingVersion))
          if (scope.type !== 'trash') taskTombstones.current.delete(task.id)
          return [task]
        })
        const loadedIDs = new Set(loadedTasks.map(task => task.id))
        for (const task of queryActive ? [] : current) {
          if (!loadedIDs.has(task.id)
            && (task.version || 0) > (versionsAtRequestStart.get(task.id) || 0)
            && taskTombstones.current.get(task.id) === undefined) reconciled.push(task)
        }
        return reconciled
      })
    }
    else if (!controller.signal.aborted) setError(taskRes.error || 'No se pudieron cargar las tareas')
    if (view === 'gantt') {
      const ganttRes = await apiGet<TaskGanttData>(`/api/tasks/gantt?${ganttParams}`, { signal: controller.signal })
      if (sequence !== loadSequence.current || controller.signal.aborted) return
      if (ganttRes.success && ganttRes.data) setGantt({ tasks: ganttRes.data.tasks || [], dependencies: ganttRes.data.dependencies || [], critical_task_ids: ganttRes.data.critical_task_ids || [], slack_minutes: ganttRes.data.slack_minutes || {}, unscheduled_count: ganttRes.data.unscheduled_count || 0 })
      else if (!ganttRes.success && !controller.signal.aborted) setError(ganttRes.error || 'No se pudo cargar el diagrama Gantt')
    }
    loadedOnce.current = true
    setLoading(false)
  }, [scope, debouncedSearch, filters, view])

  const reconcileQueuedRealtime = useCallback(() => {
    if (reconciliationTimer.current) clearTimeout(reconciliationTimer.current)
    reconciliationTimer.current = setTimeout(() => {
      reconciliationTimer.current = null
      if (boardDragActive.current || pendingOperations.current.size > 0 || !queuedRealtimeRefresh.current) return
      const refreshStructure = queuedStructureRefresh.current
      queuedRealtimeRefresh.current = false
      queuedStructureRefresh.current = false
      if (refreshStructure) void loadStructure()
      void loadTasks(false)
    }, 0)
  }, [loadStructure, loadTasks])

  const handleBoardOperation = useCallback((operationId: string, active: boolean) => {
    const existingTimer = pendingOperationTimers.current.get(operationId)
    if (existingTimer) clearTimeout(existingTimer)
    if (active) {
      pendingOperations.current.add(operationId)
      const timeout = setTimeout(() => {
        pendingOperationTimers.current.delete(operationId)
        pendingOperations.current.delete(operationId)
        reconcileQueuedRealtime()
      }, 15_000)
      pendingOperationTimers.current.set(operationId, timeout)
      return
    }
    pendingOperationTimers.current.delete(operationId)
    pendingOperations.current.delete(operationId)
    reconcileQueuedRealtime()
  }, [reconcileQueuedRealtime])

  const handleBoardDragState = useCallback((active: boolean) => {
    boardDragActive.current = active
    setTaskDragActiveState(active)
    if (active) {
      boardSidebarWasCollapsedRef.current = sidebarCollapsed
      if (sidebarCollapsed) setSidebarCollapsed(false)
      return
    }
    setTaskDropTarget(null)
    if (boardSidebarWasCollapsedRef.current) setSidebarCollapsed(true)
    boardSidebarWasCollapsedRef.current = false
    reconcileQueuedRealtime()
  }, [reconcileQueuedRealtime, sidebarCollapsed])

  const revealCreatedTask = useCallback((saved: Task) => {
    if (!acceptCanonicalTask(saved, 'created')) return
    const clearedQuery = hasActiveTaskQuery(search, taskFilterCount(filters))
    if (refreshTimer.current) {
      clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    }
    taskLoadAbortRef.current?.abort()
    setSearch('')
    setDebouncedSearch('')
    setFilters(EMPTY_TASK_FILTERS)
    setTasks(current => upsertCanonicalTask(current, saved))
    setRecentlyCreatedTaskId(saved.id)
    setNotice(clearedQuery ? 'Limpiamos la búsqueda y los filtros para mostrar la tarea creada.' : 'Tarea creada y lista para trabajar.')
    if (creationHighlightTimer.current) clearTimeout(creationHighlightTimer.current)
    creationHighlightTimer.current = setTimeout(() => {
      setRecentlyCreatedTaskId('')
      setNotice('')
    }, 4200)
    void loadStructure()
  }, [acceptCanonicalTask, filters, loadStructure, search])

  useEffect(() => { void loadStructure() }, [loadStructure])
  useEffect(() => {
    if (!structureReady) return
    if (scope.type === 'list' && !lists.some(list => list.id === scope.id)) setScope({ type: 'all' })
    if (scope.type === 'folder' && !folders.some(folder => folder.id === scope.id)) setScope({ type: 'all' })
  }, [scope, lists, folders, structureReady])
  useEffect(() => { void loadTasks(!loadedOnce.current) }, [loadTasks])
  useEffect(() => {
    tasksRef.current = tasks
    for (const task of tasks) taskVersions.current.set(task.id, Math.max(taskVersions.current.get(task.id) || 0, task.version || 0))
  }, [tasks])
  useEffect(() => () => {
    taskLoadAbortRef.current?.abort()
    if (reconciliationTimer.current) clearTimeout(reconciliationTimer.current)
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    if (creationHighlightTimer.current) clearTimeout(creationHighlightTimer.current)
    pendingOperationTimers.current.forEach(timer => clearTimeout(timer))
    pendingOperationTimers.current.clear()
  }, [])
  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const update = () => setNavOverflow({ top: nav.scrollTop > 2, bottom: nav.scrollTop + nav.clientHeight < nav.scrollHeight - 2 })
    update()
    nav.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(nav)
    const mutation = new MutationObserver(update)
    mutation.observe(nav, { childList: true, subtree: true })
    return () => { nav.removeEventListener('scroll', update); observer.disconnect(); mutation.disconnect() }
  }, [sidebarCollapsed, folders, rootLists])
  useEffect(() => { localStorage.setItem('tasks:view', view) }, [view])
  useEffect(() => {
    const element = workspaceRef.current
    if (!element) return
    const observer = new ResizeObserver(entries => setWorkspaceWidth(Math.round(entries[0]?.contentRect.width || 0)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const taskFromURL = new URLSearchParams(window.location.search).get('task')
    if (taskFromURL) setSelectedTaskId(taskFromURL)
  }, [])
  useEffect(() => subscribeWebSocket(raw => {
    const message = raw as { event?: string; data?: { action?: string; task?: Task; task_id?: string; version?: number; operation_id?: string; structure_changed?: boolean; order?: { list_id?: string; task_ids?: string[] } } }
    if (message.event !== 'task_update' && message.event !== 'task_overdue') return
    const payload = message.data || {}
    const action = payload.action || ''
    const structureActions = new Set(['folder_created', 'folder_updated', 'folder_archived', 'folder_restored', 'folder_purged', 'list_created', 'list_updated', 'list_archived', 'list_deleted', 'list_restored', 'list_purged', 'workflow_created', 'workflow_updated', 'status_created', 'status_updated', 'status_deleted'])
    if (payload.operation_id && pendingOperations.current.has(payload.operation_id)) return
    if (boardDragActive.current || pendingOperations.current.size > 0) {
      queuedRealtimeRefresh.current = true
      if (structureActions.has(action) || action === 'restored' || payload.structure_changed) queuedStructureRefresh.current = true
      return
    }
    if (structureActions.has(action)) {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => { void loadStructure(); void loadTasks(false) }, 180)
      return
    }
    if (action === 'deleted' && payload.task_id) {
      const deletedVersion = payload.task?.version || payload.version
      if (!markTaskDeleted(payload.task_id, deletedVersion)) return
      setTasks(current => current.filter(task => task.id !== payload.task_id))
      void loadStructure()
      if (view === 'gantt' || scope.type === 'trash') {
        if (refreshTimer.current) clearTimeout(refreshTimer.current)
        refreshTimer.current = setTimeout(() => void loadTasks(false), 120)
      }
      return
    }
    if (payload.task) {
      if (payload.task.parent_task_id) {
        if (refreshTimer.current) clearTimeout(refreshTimer.current)
        refreshTimer.current = setTimeout(() => void loadTasks(false), 120)
        return
      }
      const incoming = payload.task
      if (hasActiveTaskQuery(search, taskFilterCount(filters))) {
        if (refreshTimer.current) clearTimeout(refreshTimer.current)
        refreshTimer.current = setTimeout(() => void loadTasks(false), 180)
        if (action === 'created' || action === 'restored' || payload.structure_changed) void loadStructure()
        return
      }
      if (!acceptCanonicalTask(incoming, action)) return
      const previous = tasksRef.current.find(task => task.id === incoming.id)
      setTasks(current => {
        const index = current.findIndex(task => task.id === incoming.id)
        const belongs = !incoming.parent_task_id && (scope.type === 'all'
          || (scope.type === 'list' && incoming.list_id === scope.id)
          || (scope.type === 'folder' && folders.find(folder => folder.id === scope.id)?.lists.some(list => list.id === incoming.list_id)))
        let next = index >= 0
          ? belongs
            ? current.map(task => task.id === incoming.id ? { ...task, ...incoming, status_detail: incoming.status_detail || task.status_detail } : task)
            : current.filter(task => task.id !== incoming.id)
          : belongs ? [incoming, ...current] : current
        const canonicalIDs = payload.order?.task_ids || []
        if (canonicalIDs.length) {
          const positions = new Map(canonicalIDs.map((id, orderIndex) => [id, (orderIndex + 1) * 1024]))
          next = next.map(task => task.list_id === payload.order?.list_id && positions.has(task.id)
            ? { ...task, sort_order: positions.get(task.id)! }
            : task)
        }
        return next
      })
      if (action === 'created' || action === 'restored' || payload.structure_changed || (previous && previous.list_id !== incoming.list_id)) void loadStructure()
      if (view === 'gantt' || debouncedSearch || taskFilterCount(filters)) {
        if (refreshTimer.current) clearTimeout(refreshTimer.current)
        refreshTimer.current = setTimeout(() => void loadTasks(false), 180)
      }
      return
    }
    if (payload.task_id && ['comment_created', 'comment_deleted', 'attachment_added', 'attachment_deleted'].includes(action)) {
      setTasks(current => current.map(task => {
        if (task.id !== payload.task_id) return task
        if (action === 'comment_created') return { ...task, comment_count: (task.comment_count || 0) + 1 }
        if (action === 'comment_deleted') return { ...task, comment_count: Math.max(0, (task.comment_count || 0) - 1) }
        return { ...task, attachment_count: Math.max(0, (task.attachment_count || 0) + (action === 'attachment_added' ? 1 : -1)) }
      }))
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => void loadTasks(false), 180)
      return
    }
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(() => void loadTasks(false), 180)
  }), [acceptCanonicalTask, debouncedSearch, filters, folders, loadTasks, loadStructure, markTaskDeleted, scope, search, view])
  useEffect(() => { const listener = (event: KeyboardEvent) => { if ((event.target as HTMLElement)?.matches('input,textarea,select,[contenteditable="true"]')) return; if (event.key.toLowerCase() === 'n') { event.preventDefault(); if (scope.type === 'trash') setError('Sal de la papelera para crear una tarea.'); else if (scope.type === 'folder' && !activeFolder?.lists.length) { setError('Esta carpeta todavía no tiene listas. Crea una lista antes de añadir tareas.'); setStructureOpen(true) } else { setSubtaskParent(null); setEditingTask(null); setEditorOpen(true) } } if (event.key === '/') { event.preventDefault(); setSearchOpen(true); requestAnimationFrame(() => searchInputRef.current?.focus()) } }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener) }, [activeFolder, scope.type])

  const defaultWorkflow = workflows.find(item => item.is_default) || workflows[0]
  const scopedLists = useMemo(() => scope.type === 'list'
    ? (activeList ? [activeList] : [])
    : scope.type === 'folder'
      ? (activeFolder?.lists || [])
      : scope.type === 'all' ? lists : [], [activeFolder, activeList, lists, scope.type])
  const scopedWorkflowIds = useMemo(() => Array.from(new Set(scopedLists
    .map(list => list.workflow_id || defaultWorkflow?.id)
    .filter((id): id is string => Boolean(id)))), [defaultWorkflow?.id, scopedLists])
  const scopeWorkflow = workflows.find(item => item.id === (scopedWorkflowIds[0] || activeFolder?.workflow_id)) || defaultWorkflow
  const statuses = useMemo(() => {
    const source = [...(scopeWorkflow?.statuses || [])]
    for (const task of tasks) if (task.status_detail && !source.some(status => status.id === task.status_detail!.id)) source.push(task.status_detail)
    return source.sort((a,b) => a.sort_order-b.sort_order)
  }, [scopeWorkflow, tasks])
  const boardStatuses = useMemo(() => {
    if (scopedWorkflowIds.length <= 1) return statuses
    const labels = { not_started: ['Por hacer', '#64748b'], active: ['En curso', '#3b82f6'], done: ['Completadas', '#10b981'], cancelled: ['Canceladas', '#ef4444'] } as const
    return (Object.keys(labels) as Array<keyof typeof labels>).map((category, index) => ({ id: `category:${category}`, workflow_id: '', account_id: '', name: labels[category][0], color: labels[category][1], category, sort_order: index, is_default: false, created_at: '', updated_at: '' }))
  }, [scopedWorkflowIds, statuses])
  const allStatuses = useMemo(() => Array.from(new Map([...workflows.flatMap(workflow => workflow.statuses || []), ...statuses].map(status => [status.id, status])).values()), [statuses, workflows])
  const boardDefaultListId = activeList?.id || activeFolder?.lists[0]?.id || lists.find(list => list.is_default)?.id || lists[0]?.id
  const editorLists = editingTask || subtaskParent ? lists : scopedLists
  const visibleSummary = useMemo<TaskWorkSummary>(() => ({
    total: tasks.length,
    done: tasks.filter(task => task.status_detail?.category === 'done').length,
    active: tasks.filter(task => task.status_detail?.category === 'active').length,
    overdue: tasks.filter(taskIsOverdue).length,
    owners: new Set(tasks.map(task => task.assigned_to).filter(Boolean)).size,
    progress: tasks.length ? tasks.reduce((sum, task) => sum + (task.progress || 0), 0) / tasks.length : 0,
  }), [tasks])

  const updateTask = async (task: Task, body: Record<string, unknown>) => {
    const result = await apiPut<{ task: Task }>(`/api/tasks/${task.id}`, { ...body, version: task.version })
    if (result.success && result.data?.task) {
      if (acceptCanonicalTask(result.data.task)) {
        setTasks(current => current.map(item => item.id === task.id ? result.data!.task : item))
        return result.data.task
      }
      return tasksRef.current.find(item => item.id === task.id)
    }
    if (result.status === 409) {
      setError('La tarea cambió en otra sesión. Actualizamos el tablero para que puedas intentarlo sobre la versión más reciente.')
      await loadTasks(false)
    } else setError(result.error || 'No se pudo actualizar la tarea')
  }
  const moveGantt = async (task: Task, startAt: Date, dueAt: Date) => { await updateTask(task, { start_at: startAt.toISOString(), due_at: dueAt.toISOString() }); await loadTasks(false) }
  const toggleStar = async (task: Task) => {
    const result = await apiPost<{ starred: boolean; task: Task }>(`/api/tasks/${task.id}/star`, {})
    if (result.success) {
      if (!result.data?.task || acceptCanonicalTask(result.data.task)) setTasks(current => current.map(item => item.id === task.id ? (result.data?.task || { ...item, starred: result.data?.starred }) : item))
      return
    }
    setError(result.error || 'No se pudo actualizar la tarea favorita. Inténtalo de nuevo.')
  }
  const selectScope = (next: Scope) => { setScope(next); setSidebarOpen(false) }
  const openCreate = (statusId?: string, draft?: TaskInlineDraft) => {
    if (scope.type === 'trash') {
      setError('Sal de la papelera para crear una tarea.')
      return
    }
    if (scope.type === 'folder' && !activeFolder?.lists.length) {
      setError('Esta carpeta todavía no tiene listas. Crea una lista antes de añadir tareas para que siempre aparezcan en el lugar correcto.')
      setStructureOpen(true)
      return
    }
    setSubtaskParent(null)
    setEditingTask(null)
    setCreateStatusId(statusId || draft?.statusId || '')
    setCreateDraft(draft || null)
    setEditorOpen(true)
  }
  const closeTaskDetail = () => {
    setSelectedTaskId(null)
    const url = new URL(window.location.href)
    if (url.searchParams.has('task')) { url.searchParams.delete('task'); window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`) }
  }
  const applySavedView = (saved: TaskSavedView) => {
    if (saved.scope_type === 'folder' && (!saved.scope_id || !folders.some(folder => folder.id === saved.scope_id))) {
      setError('La carpeta de esta vista ya no está disponible. La vista actual no cambió.')
      return
    }
    if (saved.scope_type === 'list' && (!saved.scope_id || !lists.some(list => list.id === saved.scope_id))) {
      setError('La lista de esta vista ya no está disponible. La vista actual no cambió.')
      return
    }
    setFilters(saved.filters || EMPTY_TASK_FILTERS)
    setView(saved.view_mode)
    setCollapsedStatusIds(saved.collapsed_status_ids || [])
    if (saved.scope_type === 'all') setScope({ type: 'all' })
    else if (saved.scope_id) setScope({ type: saved.scope_type, id: saved.scope_id })
  }

  const immersiveView = scope.type !== 'trash' && ['board', 'calendar', 'gantt'].includes(view)
  const searchPending = search.trim() !== debouncedSearch

  return <div ref={workspaceRef} data-task-workspace-width={workspaceWidth} className="relative flex h-full min-h-0 w-full overflow-hidden bg-slate-50">
    {sidebarOpen && <button aria-label="Cerrar navegación" onClick={() => setSidebarOpen(false)} className="fixed inset-0 z-40 bg-slate-950/30 lg:hidden" />}
    <aside className={`absolute inset-y-0 left-0 z-50 flex shrink-0 flex-col border-r border-slate-200 bg-white transition-all lg:relative lg:z-10 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'} ${sidebarCollapsed ? 'w-[72px]' : 'w-[268px]'}`}>
      <div className="flex h-16 items-center border-b border-slate-100 px-4"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white"><Check className="h-4 w-4" /></div>{!sidebarCollapsed && <div className="ml-3 min-w-0"><p className="truncate text-sm font-black text-slate-900">Clarin Work</p><p className="text-[10px] font-semibold uppercase tracking-[.16em] text-emerald-600">Tareas y proyectos</p></div>}<button onClick={() => setSidebarCollapsed(value => !value)} className="ml-auto hidden rounded-lg p-2 text-slate-400 hover:bg-slate-100 lg:block">{sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}</button><button onClick={() => setSidebarOpen(false)} className="ml-auto rounded-lg p-2 text-slate-400 lg:hidden"><X className="h-4 w-4" /></button></div>
      <div className="relative min-h-0 flex-1"><nav ref={navRef} data-task-navigation-scroll className="task-navigation-scroll h-full overflow-y-auto px-2 py-3">
        <button title="Todo el trabajo" onClick={() => selectScope({ type: 'all' })} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold ${scope.type === 'all' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-600 hover:bg-slate-50'}`}><Inbox className="h-4 w-4 shrink-0" />{!sidebarCollapsed && <><span className="flex-1 text-left">Todo el trabajo</span><span className="text-[10px] text-slate-400">{globalTaskCount}</span></>}</button>
        {!sidebarCollapsed && <div className="mb-2 mt-5 flex items-center justify-between px-2"><span className="text-[10px] font-bold uppercase tracking-[.16em] text-slate-400">Carpetas y listas</span><button onClick={() => setStructureOpen(true)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-emerald-600"><Plus className="h-3.5 w-3.5" /></button></div>}
        <TaskHierarchyTree folders={folders} rootLists={rootLists} scope={scope} collapsed={sidebarCollapsed} taskDragActive={taskDragActiveState} taskDropTarget={taskDropTarget} onSelect={selectScope} onChanged={async () => { await loadStructure(); await loadTasks(false) }} onError={setError} onOperation={handleBoardOperation} />
      </nav>{navOverflow.top && <div className="pointer-events-none absolute inset-x-0 top-0 h-5 bg-gradient-to-b from-white to-transparent" />}{navOverflow.bottom && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-white to-transparent" />}</div>
      <div className="border-t border-slate-100 p-2"><button onClick={() => selectScope({ type: 'trash' })} title="Papelera" className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold ${scope.type === 'trash' ? 'bg-slate-100 text-slate-800' : 'text-slate-500 hover:bg-slate-50'}`}><Trash2 className="h-4 w-4 shrink-0" />{!sidebarCollapsed && 'Papelera'}</button><button onClick={() => setStructureOpen(true)} title="Configurar" className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-500 hover:bg-slate-50 hover:text-slate-800"><Settings2 className="h-4 w-4 shrink-0" />{!sidebarCollapsed && 'Configurar espacio'}</button></div>
    </aside>

    <main className="flex min-w-0 flex-1 flex-col">
      <header data-task-workspace-header className="shrink-0 border-b border-slate-200 bg-white">
        <div className="flex items-center gap-3 px-3 pb-2 pt-3 sm:px-5"><button onClick={() => setSidebarOpen(true)} className="rounded-xl p-2 text-slate-500 hover:bg-slate-100 lg:hidden"><Menu className="h-5 w-5" /></button><div className="min-w-0"><div className="flex items-center gap-1 text-[10px] text-slate-400"><span>Clarin Work</span>{activeFolder && <><ChevronRight className="h-3 w-3" /><span>{activeFolder.name}</span></>}</div><h1 className="truncate text-lg font-black text-slate-900">{scopeName}</h1></div><div className="ml-auto flex items-center gap-2"><button onClick={() => setStructureOpen(true)} className="hidden rounded-xl border border-slate-200 p-2.5 text-slate-500 transition hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 sm:block"><Settings2 className="h-4 w-4" /></button>{scope.type !== 'trash' && <button onClick={() => openCreate()} className="group flex min-h-11 items-center gap-2 rounded-2xl border border-emerald-500/20 bg-gradient-to-b from-emerald-500 to-emerald-600 px-3.5 py-2.5 text-sm font-black text-white shadow-lg shadow-emerald-600/20 transition hover:-translate-y-0.5 hover:from-emerald-600 hover:to-emerald-700 hover:shadow-xl focus:outline-none focus:ring-4 focus:ring-emerald-200 active:translate-y-0"><span className="flex h-6 w-6 items-center justify-center rounded-lg bg-white/15 ring-1 ring-white/20"><Plus className="h-4 w-4 transition group-hover:rotate-90" /></span><span className="hidden sm:inline">Nueva tarea</span></button>}</div></div>
        <div className="flex min-w-0 items-center gap-2 px-3 pb-2 sm:px-5">
          {scope.type !== 'trash' && <div data-task-view-tabs className="flex min-w-0 flex-1 overflow-x-auto rounded-xl bg-slate-100 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{viewOptions.map(option => { const Icon = option.icon; return <button key={option.id} onClick={() => setView(option.id)} className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold transition sm:px-3 ${view === option.id ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}><Icon className="h-3.5 w-3.5" />{option.label}</button> })}</div>}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div className={`relative flex h-9 items-center overflow-hidden rounded-xl border transition-all duration-200 ${searchOpen ? `${workspaceWidth < 850 ? 'w-44' : 'w-64'} border-emerald-300 bg-white shadow-sm` : `w-9 ${search ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white'}`}`}>
              <button type="button" aria-label="Buscar tareas" onClick={() => { setSearchOpen(true); requestAnimationFrame(() => searchInputRef.current?.focus()) }} className="flex h-9 w-9 shrink-0 items-center justify-center text-slate-500"><Search className="h-4 w-4" /></button>
              <input ref={searchInputRef} id="task-search" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setSearchOpen(false); event.currentTarget.blur() } }} placeholder="Buscar tareas…" className="h-full min-w-0 flex-1 bg-transparent pr-1 text-sm text-slate-700 outline-none placeholder:text-slate-400" />
              {searchPending && <Loader2 data-task-search-pending className="h-3.5 w-3.5 shrink-0 animate-spin text-emerald-500" aria-label="Esperando para buscar" />}
              {search && <button type="button" aria-label="Limpiar búsqueda" onClick={() => { taskLoadAbortRef.current?.abort(); setSearch(''); setDebouncedSearch(''); setSearchOpen(false) }} className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X className="h-3.5 w-3.5" /></button>}
              {!searchOpen && search && <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-emerald-500" />}
            </div>
            {scope.type !== 'trash' && structureReady && <TaskFilterToolbar filters={filters} statuses={allStatuses} users={users} scope={scope.type === 'all' ? { type: 'all' } : { type: scope.type, id: scope.id }} view={view} collapsedStatusIds={collapsedStatusIds} onChange={setFilters} onApplyView={applySavedView} applyDefaultOnLoad={!defaultViewLoadHandled.current} onDefaultLoadHandled={() => { defaultViewLoadHandled.current = true }} onError={setError} showChips={false} />}
          </div>
        </div>
        {scope.type !== 'trash' && <TaskFilterChips filters={filters} statuses={allStatuses} users={users} onChange={setFilters} />}
      </header>

      <div data-task-workspace-canvas className={`min-h-0 flex-1 ${immersiveView ? 'overflow-hidden p-0' : 'overflow-auto p-2 sm:p-3'}`}>
        {notice && <div role="status" className="m-2 mb-3 flex items-center justify-between rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700"><span>{notice}</span><button aria-label="Cerrar aviso" onClick={() => setNotice('')}><X className="h-4 w-4" /></button></div>}
        {error && <div className="m-2 mb-3 flex items-center justify-between rounded-xl bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"><span>{error}</span><button onClick={() => setError('')}><X className="h-4 w-4" /></button></div>}
        {loading ? <div className="space-y-3">{Array.from({length:5}).map((_,index) => <div key={index} className="h-16 animate-pulse rounded-2xl bg-slate-200/60" />)}</div> : <div className="h-full min-h-[420px]">
          {scope.type === 'trash' && <TrashView tasks={tasks} onChanged={async () => { await Promise.all([loadTasks(false), loadStructure()]) }} onError={setError} />}
          {scope.type !== 'trash' && view === 'list' && <ListView tasks={tasks} statuses={statuses} allStatuses={allStatuses} onOpen={task => setSelectedTaskId(task.id)} onStatus={(task,statusId) => void updateTask(task,{status_id:statusId})} onStar={task => void toggleStar(task)} />}
          {scope.type !== 'trash' && view === 'board' && <TaskBoard tasks={tasks} statuses={boardStatuses} allStatuses={allStatuses} lists={scopedLists} allLists={lists} folders={folders} users={users} currentUserId={currentUserId} defaultListId={boardDefaultListId} showListName={scope.type !== 'list'} collapsedStatusIds={collapsedStatusIds} onCollapsedStatusIdsChange={setCollapsedStatusIds} onTasksChange={setTasks} onCanonicalTask={acceptCanonicalTask} onOperation={handleBoardOperation} onTaskCreated={revealCreatedTask} recentlyCreatedTaskId={recentlyCreatedTaskId} onDragStateChange={handleBoardDragState} onExternalDropTargetChange={setTaskDropTarget} onOpen={task => setSelectedTaskId(task.id)} onEdit={task => { setSubtaskParent(null); setEditingTask(task); setEditorOpen(true) }} onCreateSubtask={task => { setSubtaskParent(task); setEditingTask(null); setCreateStatusId(''); setCreateDraft(null); setEditorOpen(true) }} onCreateFull={openCreate} onConfigureStatuses={() => setStructureOpen(true)} onStar={toggleStar} onQuickUpdate={updateTask} onRefresh={() => loadTasks(false)} onError={setError} />}
          {scope.type !== 'trash' && view === 'calendar' && <TaskCalendarView tasks={tasks} lists={editorLists} folders={folders} statuses={allStatuses} users={users} currentUserID={currentUserId} scopeListID={scope.type === 'list' ? scope.id : undefined} onOpen={task => setSelectedTaskId(task.id)} onCreated={revealCreatedTask} onOperation={handleBoardOperation} onMore={openCreate} />}
          {scope.type !== 'trash' && view === 'gantt' && <TaskGanttView data={gantt} onOpen={task => setSelectedTaskId(task.id)} onMove={moveGantt} />}
          {scope.type !== 'trash' && view === 'summary' && <SummaryView tasks={tasks} summary={visibleSummary} users={users} />}
        </div>}
      </div>
    </main>

    <TaskEditorModal open={editorOpen} task={editingTask?.id ? editingTask : null} parentTaskId={subtaskParent?.id} parentTaskTitle={subtaskParent?.title} defaultListId={subtaskParent?.list_id || createDraft?.listId || activeList?.id || activeFolder?.lists[0]?.id || lists.find(list => list.is_default)?.id || lists[0]?.id} defaultStatusId={createStatusId} defaultOwnerId={subtaskParent?.assigned_to || createDraft?.ownerId || currentUserId} defaultTitle={createDraft?.title} defaultPriority={createDraft?.priority} defaultStartAt={createDraft?.startAt} defaultAllDay={createDraft?.isAllDay} defaultDueAt={createDraft?.dueAt || (createDraft?.dueDate ? new Date(`${createDraft.dueDate}T17:00:00`).toISOString() : undefined)} lists={editorLists} folders={folders} workflows={workflows} users={users} onOperation={handleBoardOperation} onClose={() => { setEditorOpen(false); setEditingTask(null); setSubtaskParent(null); setCreateStatusId(''); setCreateDraft(null) }} onSaved={saved => {
      if (saved.parent_task_id) {
        if (subtaskParent) setSelectedTaskId(subtaskParent.id)
        void loadTasks(false)
        return
      }
      if (!editingTask) {
        revealCreatedTask(saved)
        return
      }
      if (!acceptCanonicalTask(saved, 'updated')) return
      setTasks(current => upsertCanonicalTask(current, saved))
      if (!editingTask || editingTask.list_id !== saved.list_id || editingTask.parent_task_id !== saved.parent_task_id) void loadStructure()
      void loadTasks(false)
    }} />
    <TaskDetailDrawer taskId={selectedTaskId} allTasks={tasks} users={users} lists={lists} folders={folders} workflows={workflows} onClose={closeTaskDetail} onEdit={task => { setSubtaskParent(null); setCreateDraft(null); setEditingTask(task); setEditorOpen(true) }} onOpenTask={setSelectedTaskId} onCreateSubtask={task => { setSubtaskParent(task); setEditingTask(null); setCreateStatusId(''); setCreateDraft(null); setEditorOpen(true) }} onChanged={changed => { if (changed && acceptCanonicalTask(changed)) setTasks(current => current.map(item => item.id === changed.id ? changed : item)); void loadTasks(false) }} onDeleted={(id, version) => { const accepted = markTaskDeleted(id, version); if (accepted) { setTasks(current => current.filter(item => item.id !== id)); void loadStructure() }; return accepted }} />
    <TaskStructureModal open={structureOpen} folders={folders} lists={lists} workflows={workflows} onClose={() => setStructureOpen(false)} onChanged={async () => { await loadStructure(); await loadTasks(false) }} onOperation={handleBoardOperation} />
  </div>
}
