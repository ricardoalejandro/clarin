'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown,
  CircleDot, Columns3, Folder, FolderOpen, GanttChartSquare, Inbox, LayoutList, Menu, MoreHorizontal,
  PanelLeftClose, PanelLeftOpen, Plus, RotateCcw, Search, Settings2, Sparkles, Star, Trash2, X,
} from 'lucide-react'
import { apiDelete, apiGet, apiPost, apiPut, subscribeWebSocket } from '@/lib/api'
import {
  TASK_PRIORITY_CONFIG, TASK_TYPE_CONFIG, Task, TaskFolder, TaskGanttData, TaskList, TaskViewMode,
  TaskWorkflow, TaskWorkflowStatus, TaskWorkSummary,
} from '@/types/task'
import TaskDetailDrawer from './TaskDetailDrawer'
import TaskEditorModal, { TaskAccountUser } from './TaskEditorModal'
import TaskGanttView from './TaskGanttView'
import TaskStructureModal from './TaskStructureModal'

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
  if (scope.type === 'trash') params.set('deleted', 'true')
  return params
}

async function fetchTaskPages(params: URLSearchParams) {
  const firstParams = new URLSearchParams(params)
  firstParams.set('limit', '200')
  firstParams.set('offset', '0')
  const first = await apiGet<{ tasks: Task[]; total: number }>(`/api/tasks?${firstParams}`)
  if (!first.success) return first
  const total = first.data?.total || 0
  const pages: Task[] = [...(first.data?.tasks || [])]
  const offsets = Array.from({ length: Math.max(0, Math.ceil(total / 200) - 1) }, (_, index) => (index + 1) * 200)
  for (let index = 0; index < offsets.length; index += 5) {
    const batch = await Promise.all(offsets.slice(index, index + 5).map(offset => {
      const pageParams = new URLSearchParams(params)
      pageParams.set('limit', '200')
      pageParams.set('offset', String(offset))
      return apiGet<{ tasks: Task[]; total: number }>(`/api/tasks?${pageParams}`)
    }))
    for (const page of batch) if (page.success) pages.push(...(page.data?.tasks || []))
  }
  return { success: true, data: { tasks: pages, total } }
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

function ListView({ tasks, statuses, onOpen, onStatus, onStar }: { tasks: Task[]; statuses: TaskWorkflowStatus[]; onOpen: (task: Task) => void; onStatus: (task: Task, statusId: string) => void; onStar: (task: Task) => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const sections = statuses.map(status => ({ status, tasks: tasks.filter(task => task.status_id === status.id) })).filter(section => section.tasks.length)
  const orphaned = tasks.filter(task => !statuses.some(status => status.id === task.status_id))
  if (orphaned.length) sections.push({ status: { id: 'other', name: 'Otros', color: '#94a3b8', category: 'not_started', sort_order: 999 } as TaskWorkflowStatus, tasks: orphaned })
  return <div className="space-y-3 pb-8">{sections.map(section => <section key={section.status.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <button onClick={() => setCollapsed(current => ({ ...current, [section.status.id]: !current[section.status.id] }))} className="flex w-full items-center gap-2 border-b border-slate-100 px-4 py-3 text-left"><ChevronDown className={`h-4 w-4 text-slate-400 transition ${collapsed[section.status.id] ? '-rotate-90' : ''}`} /><i className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: section.status.color }} /><span className="text-xs font-bold uppercase tracking-wider text-slate-600">{section.status.name}</span><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-400">{section.tasks.length}</span></button>
    {!collapsed[section.status.id] && <div className="divide-y divide-slate-100">{section.tasks.map(task => { const allowed = statuses.filter(status => status.workflow_id === task.status_detail?.workflow_id); return <div key={task.id} onClick={() => onOpen(task)} className="group grid cursor-pointer grid-cols-[minmax(180px,1fr)_110px] items-center gap-3 px-4 py-3 hover:bg-slate-50 sm:grid-cols-[minmax(220px,1fr)_150px_120px_110px_44px]">
      <div className="flex min-w-0 items-center gap-3"><button onClick={event => { event.stopPropagation(); const next = allowed.find(status => status.category === (task.status_detail?.category === 'done' ? 'not_started' : 'done')); if (next) onStatus(task, next.id) }} className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${task.status_detail?.category === 'done' ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 bg-white'}`}>{task.status_detail?.category === 'done' && <Check className="h-3 w-3" />}</button><div className="min-w-0"><p className={`truncate text-sm font-medium ${task.status_detail?.category === 'done' ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{task.title}</p><p className="mt-0.5 truncate text-[10px] text-slate-400">{task.list_name || 'Bandeja general'}{task.subtask_count ? ` · ${task.subtask_done}/${task.subtask_count} subtareas` : ''}</p></div></div>
      <select value={task.status_id || ''} onClick={event => event.stopPropagation()} onChange={event => onStatus(task, event.target.value)} className="rounded-lg border-0 bg-slate-100 px-2 py-1.5 text-[11px] font-semibold text-slate-600 outline-none">{allowed.map(status => <option key={status.id} value={status.id}>{status.name}</option>)}</select>
      <div className="hidden items-center gap-2 sm:flex"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-[9px] font-bold text-slate-500">{(task.assigned_to_name || '?').slice(0,2).toUpperCase()}</span><span className="truncate text-xs text-slate-500">{task.assigned_to_name || 'Sin nombre'}</span></div>
      <span className={`hidden text-xs sm:block ${taskIsOverdue(task) ? 'font-semibold text-rose-600' : 'text-slate-400'}`}>{task.due_at ? dateShort.format(new Date(task.due_at)) : 'Sin fecha'}</span>
      <button onClick={event => { event.stopPropagation(); onStar(task) }} className={`hidden rounded-lg p-2 sm:block ${task.starred ? 'text-amber-400' : 'text-slate-300 opacity-0 group-hover:opacity-100'}`}><Star className={`h-4 w-4 ${task.starred ? 'fill-current' : ''}`} /></button>
    </div> })}</div>}
  </section>)}{!tasks.length && <EmptyState />}</div>
}

function BoardView({ tasks, statuses, onOpen, onStatus, onCreate }: { tasks: Task[]; statuses: TaskWorkflowStatus[]; onOpen: (task: Task) => void; onStatus: (task: Task, statusId: string) => void; onCreate: (statusId: string) => void }) {
  const [over, setOver] = useState('')
  return <div className="flex h-full min-h-0 gap-3 overflow-x-auto pb-4">{statuses.map(status => { const items = tasks.filter(task => status.id.startsWith('category:') ? task.status_detail?.category === status.category : task.status_id === status.id); return <section key={status.id} onDragOver={event => { event.preventDefault(); setOver(status.id) }} onDragLeave={() => setOver('')} onDrop={event => { event.preventDefault(); const task = tasks.find(item => item.id === event.dataTransfer.getData('text/task-id')); if (task && task.status_id !== status.id) onStatus(task, status.id); setOver('') }} className={`flex w-[290px] shrink-0 flex-col rounded-2xl border p-2 transition ${over === status.id ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-200 bg-slate-100/70'}`}>
    <header className="flex items-center gap-2 px-2 py-2"><i className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: status.color }} /><h3 className="text-xs font-bold uppercase tracking-wider text-slate-600">{status.name}</h3><span className="rounded-full bg-white px-2 py-0.5 text-[10px] text-slate-400 shadow-sm">{items.length}</span><button onClick={() => onCreate(status.id)} className="ml-auto rounded-lg p-1 text-slate-400 hover:bg-white hover:text-emerald-600"><Plus className="h-4 w-4" /></button></header>
    <div className="min-h-[120px] flex-1 space-y-2 overflow-y-auto p-1">{items.map(task => <div key={task.id} draggable onDragStart={event => { event.dataTransfer.setData('text/task-id', task.id); event.dataTransfer.effectAllowed = 'move' }}><TaskCard task={task} onOpen={() => onOpen(task)} /></div>)}{!items.length && <div className="rounded-xl border border-dashed border-slate-300 px-3 py-8 text-center text-xs text-slate-400">Suelta tareas aquí</div>}</div>
  </section> })}</div>
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
  return <div className="flex min-h-[340px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center"><div className="rounded-2xl bg-emerald-50 p-4"><Sparkles className="h-7 w-7 text-emerald-600" /></div><h3 className="mt-4 text-base font-bold text-slate-800">Todo listo para empezar</h3><p className="mt-1 max-w-xs text-sm leading-6 text-slate-400">Crea la primera tarea o cambia los filtros para ver el trabajo existente.</p></div>
}

function TrashView({ tasks, onRestore }: { tasks: Task[]; onRestore: (task: Task) => void }) {
  return <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-100 px-5 py-4"><h3 className="text-sm font-bold text-slate-800">Tareas archivadas</h3><p className="mt-1 text-xs text-slate-400">Restaurar una tarea también recupera sus subtareas.</p></div><div className="divide-y divide-slate-100">{tasks.map(task => <div key={task.id} className="flex items-center gap-3 px-5 py-3"><div className="rounded-xl bg-slate-100 p-2"><Trash2 className="h-4 w-4 text-slate-400" /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-700">{task.title}</p><p className="text-[10px] text-slate-400">{task.list_name || 'Bandeja general'} · archivada {task.deleted_at ? dateShort.format(new Date(task.deleted_at)) : ''}</p></div><button onClick={() => onRestore(task)} className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700"><RotateCcw className="h-3.5 w-3.5" /> Restaurar</button></div>)}{!tasks.length && <div className="py-16 text-center text-sm text-slate-400">La papelera está vacía.</div>}</div></div>
}

export default function TaskWorkspace() {
  const [folders, setFolders] = useState<TaskFolder[]>([])
  const [rootLists, setRootLists] = useState<TaskList[]>([])
  const [workflows, setWorkflows] = useState<TaskWorkflow[]>([])
  const [users, setUsers] = useState<TaskAccountUser[]>([])
  const [currentUserId, setCurrentUserId] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [summary, setSummary] = useState<TaskWorkSummary | null>(null)
  const [gantt, setGantt] = useState<TaskGanttData>({ tasks: [], dependencies: [], critical_task_ids: [], slack_minutes: {} })
  const [scope, setScope] = useState<Scope>({ type: 'all' })
  const [view, setView] = useState<TaskViewMode>(() => typeof window === 'undefined' ? 'list' : (localStorage.getItem('tasks:view') as TaskViewMode) || 'list')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [ownerFilter, setOwnerFilter] = useState('')
  const [starredOnly, setStarredOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [createStatusId, setCreateStatusId] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [structureOpen, setStructureOpen] = useState(false)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const lists = useMemo(() => [...rootLists, ...folders.flatMap(folder => folder.lists)], [rootLists, folders])
  const activeList = scope.type === 'list' ? lists.find(list => list.id === scope.id) : undefined
  const activeFolder = scope.type === 'folder' ? folders.find(folder => folder.id === scope.id) : activeList?.folder_id ? folders.find(folder => folder.id === activeList.folder_id) : undefined
  const scopeName = scope.type === 'all' ? 'Todo el trabajo' : scope.type === 'folder' ? activeFolder?.name || 'Carpeta' : scope.type === 'list' ? activeList?.name || 'Lista' : 'Papelera'

  const loadStructure = useCallback(async () => {
    const [hierarchyRes, workflowRes, userRes, meRes] = await Promise.all([
      apiGet<{ folders: TaskFolder[]; root_lists: TaskList[] }>('/api/tasks/hierarchy'),
      apiGet<{ workflows: TaskWorkflow[] }>('/api/tasks/workflows'),
      apiGet<{ users: TaskAccountUser[] }>('/api/account/users'),
      apiGet<{ user: { id: string } }>('/api/me'),
    ])
    if (hierarchyRes.success) { setFolders(hierarchyRes.data?.folders || []); setRootLists(hierarchyRes.data?.root_lists || []) }
    if (workflowRes.success) setWorkflows(workflowRes.data?.workflows || [])
    if (userRes.success) setUsers(userRes.data?.users || [])
    if (meRes.success) setCurrentUserId(meRes.data?.user?.id || '')
  }, [])

  const loadTasks = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true)
    const params = scopeQuery(scope)
    if (debouncedSearch) params.set('search', debouncedSearch)
    if (statusFilter) params.set('status', statusFilter)
    if (ownerFilter) params.set('assigned_to', ownerFilter)
    if (starredOnly) params.set('starred', 'true')
    const summaryParams = scopeQuery(scope)
    const [taskRes, summaryRes] = await Promise.all([
      fetchTaskPages(params),
      scope.type === 'trash' ? Promise.resolve({ success: true, data: { summary: null as unknown as TaskWorkSummary } }) : apiGet<{ summary: TaskWorkSummary }>(`/api/tasks/summary?${summaryParams}`),
    ])
    if (taskRes.success) setTasks(taskRes.data?.tasks || [])
    else setError(taskRes.error || 'No se pudieron cargar las tareas')
    if (summaryRes.success) setSummary(summaryRes.data?.summary || null)
    if (view === 'gantt') {
      const ganttRes = await apiGet<TaskGanttData>(`/api/tasks/gantt?${summaryParams}`)
      if (ganttRes.success && ganttRes.data) setGantt({ tasks: ganttRes.data.tasks || [], dependencies: ganttRes.data.dependencies || [], critical_task_ids: ganttRes.data.critical_task_ids || [], slack_minutes: ganttRes.data.slack_minutes || {} })
    }
    setLoading(false)
  }, [scope, debouncedSearch, statusFilter, ownerFilter, starredOnly, view])

  useEffect(() => { void loadStructure() }, [loadStructure])
  useEffect(() => {
    if (scope.type === 'list' && !lists.some(list => list.id === scope.id)) setScope({ type: 'all' })
    if (scope.type === 'folder' && !folders.some(folder => folder.id === scope.id)) setScope({ type: 'all' })
  }, [scope, lists, folders])
  useEffect(() => { const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250); return () => clearTimeout(timer) }, [search])
  useEffect(() => { void loadTasks(true) }, [loadTasks])
  useEffect(() => { localStorage.setItem('tasks:view', view) }, [view])
  useEffect(() => subscribeWebSocket(raw => { const message = raw as { event?: string }; if (message.event !== 'task_update' && message.event !== 'task_overdue') return; if (refreshTimer.current) clearTimeout(refreshTimer.current); refreshTimer.current = setTimeout(() => { void loadTasks(false); void loadStructure() }, 180) }), [loadTasks, loadStructure])
  useEffect(() => { const listener = (event: KeyboardEvent) => { if ((event.target as HTMLElement)?.matches('input,textarea,select')) return; if (event.key.toLowerCase() === 'n') { event.preventDefault(); setEditingTask(null); setEditorOpen(true) } if (event.key === '/') { event.preventDefault(); document.getElementById('task-search')?.focus() } }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener) }, [])

  const scopeWorkflow = workflows.find(item => item.id === (activeList?.workflow_id || activeFolder?.workflow_id)) || workflows.find(item => item.is_default) || workflows[0]
  const statuses = useMemo(() => {
    const source = [...(scopeWorkflow?.statuses || [])]
    for (const task of tasks) if (task.status_detail && !source.some(status => status.id === task.status_detail!.id)) source.push(task.status_detail)
    return source.sort((a,b) => a.sort_order-b.sort_order)
  }, [scopeWorkflow, tasks])
  const boardStatuses = useMemo(() => {
    const workflowIDs = new Set(tasks.map(task => task.status_detail?.workflow_id).filter(Boolean))
    if (scope.type !== 'all' || workflowIDs.size <= 1) return statuses
    const labels = { not_started: ['Por hacer', '#64748b'], active: ['En curso', '#3b82f6'], done: ['Completadas', '#10b981'], cancelled: ['Canceladas', '#ef4444'] } as const
    return (Object.keys(labels) as Array<keyof typeof labels>).map((category, index) => ({ id: `category:${category}`, workflow_id: '', account_id: '', name: labels[category][0], color: labels[category][1], category, sort_order: index, is_default: false, created_at: '', updated_at: '' }))
  }, [scope.type, statuses, tasks])

  const updateTask = async (task: Task, body: Record<string, unknown>) => {
    const result = await apiPut<{ task: Task }>(`/api/tasks/${task.id}`, { ...body, version: task.version })
    if (result.success && result.data?.task) {
      setTasks(current => current.map(item => item.id === task.id ? result.data!.task : item))
      return result.data.task
    }
    setError(result.error || 'No se pudo actualizar la tarea')
  }
  const moveGantt = async (task: Task, startAt: Date, dueAt: Date) => { await updateTask(task, { start_at: startAt.toISOString(), due_at: dueAt.toISOString() }); await loadTasks(false) }
  const toggleStar = async (task: Task) => { const result = await apiPost<{ starred: boolean }>(`/api/tasks/${task.id}/star`, {}); if (result.success) setTasks(current => current.map(item => item.id === task.id ? { ...item, starred: result.data?.starred } : item)) }
  const restoreTask = async (task: Task) => { const result = await apiPost(`/api/tasks/${task.id}/restore`, {}); if (result.success) setTasks(current => current.filter(item => item.id !== task.id)); else setError(result.error || 'No se pudo restaurar la tarea') }
  const selectScope = (next: Scope) => { setScope(next); setSidebarOpen(false) }
  const openCreate = (statusId?: string) => { setEditingTask(null); setCreateStatusId(statusId || ''); setEditorOpen(true) }
  const moveToBoardStatus = (task: Task, statusId: string) => {
    if (!statusId.startsWith('category:')) { void updateTask(task, { status_id: statusId }); return }
    const category = statusId.replace('category:', '')
    const target = statuses.find(status => status.workflow_id === task.status_detail?.workflow_id && status.category === category)
    if (target) void updateTask(task, { status_id: target.id })
  }
  const createInBoardStatus = (statusId: string) => {
    if (!statusId.startsWith('category:')) { openCreate(statusId); return }
    const category = statusId.replace('category:', '')
    openCreate(scopeWorkflow?.statuses.find(status => status.category === category)?.id)
  }

  return <div className="relative flex h-[calc(100vh-64px)] min-h-[620px] overflow-hidden bg-slate-50">
    {sidebarOpen && <button aria-label="Cerrar navegación" onClick={() => setSidebarOpen(false)} className="fixed inset-0 z-40 bg-slate-950/30 lg:hidden" />}
    <aside className={`absolute inset-y-0 left-0 z-50 flex shrink-0 flex-col border-r border-slate-200 bg-white transition-all lg:relative lg:z-10 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'} ${sidebarCollapsed ? 'w-[72px]' : 'w-[268px]'}`}>
      <div className="flex h-16 items-center border-b border-slate-100 px-4"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white"><Check className="h-4 w-4" /></div>{!sidebarCollapsed && <div className="ml-3 min-w-0"><p className="truncate text-sm font-black text-slate-900">Clarin Work</p><p className="text-[10px] font-semibold uppercase tracking-[.16em] text-emerald-600">Tareas y proyectos</p></div>}<button onClick={() => setSidebarCollapsed(value => !value)} className="ml-auto hidden rounded-lg p-2 text-slate-400 hover:bg-slate-100 lg:block">{sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}</button><button onClick={() => setSidebarOpen(false)} className="ml-auto rounded-lg p-2 text-slate-400 lg:hidden"><X className="h-4 w-4" /></button></div>
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <button title="Todo el trabajo" onClick={() => selectScope({ type: 'all' })} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold ${scope.type === 'all' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-600 hover:bg-slate-50'}`}><Inbox className="h-4 w-4 shrink-0" />{!sidebarCollapsed && <><span className="flex-1 text-left">Todo el trabajo</span><span className="text-[10px] text-slate-400">{summary?.total || 0}</span></>}</button>
        {!sidebarCollapsed && <div className="mb-2 mt-5 flex items-center justify-between px-2"><span className="text-[10px] font-bold uppercase tracking-[.16em] text-slate-400">Carpetas y listas</span><button onClick={() => setStructureOpen(true)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-emerald-600"><Plus className="h-3.5 w-3.5" /></button></div>}
        {folders.map(folder => <div key={folder.id} className="mb-1"><button title={folder.name} onClick={() => selectScope({ type: 'folder', id: folder.id })} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium ${scope.type === 'folder' && scope.id === folder.id ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-50'}`}>{scope.type === 'folder' && scope.id === folder.id ? <FolderOpen className="h-4 w-4 shrink-0" style={{ color: folder.color }} /> : <Folder className="h-4 w-4 shrink-0" style={{ color: folder.color }} />}{!sidebarCollapsed && <><span className="min-w-0 flex-1 truncate text-left">{folder.name}</span><span className="text-[10px] text-slate-400">{folder.task_count}</span></>}</button>{!sidebarCollapsed && <div className="ml-5 border-l border-slate-200 pl-2">{folder.lists.map(list => <button key={list.id} onClick={() => selectScope({ type: 'list', id: list.id })} className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${scope.type === 'list' && scope.id === list.id ? 'bg-emerald-50 font-semibold text-emerald-700' : 'text-slate-500 hover:bg-slate-50'}`}><i className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: list.color }} /><span className="min-w-0 flex-1 truncate text-left">{list.name}</span><span className="text-[9px] text-slate-400">{list.task_count}</span></button>)}</div>}</div>)}
        {rootLists.map(list => <button key={list.id} title={list.name} onClick={() => selectScope({ type: 'list', id: list.id })} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm ${scope.type === 'list' && scope.id === list.id ? 'bg-emerald-50 font-semibold text-emerald-700' : 'text-slate-600 hover:bg-slate-50'}`}><CircleDot className="h-4 w-4 shrink-0" style={{ color: list.color }} />{!sidebarCollapsed && <><span className="min-w-0 flex-1 truncate text-left">{list.name}</span><span className="text-[10px] text-slate-400">{list.task_count}</span></>}</button>)}
      </nav>
      <div className="border-t border-slate-100 p-2"><button onClick={() => selectScope({ type: 'trash' })} title="Papelera" className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold ${scope.type === 'trash' ? 'bg-slate-100 text-slate-800' : 'text-slate-500 hover:bg-slate-50'}`}><Trash2 className="h-4 w-4 shrink-0" />{!sidebarCollapsed && 'Papelera'}</button><button onClick={() => setStructureOpen(true)} title="Configurar" className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-500 hover:bg-slate-50 hover:text-slate-800"><Settings2 className="h-4 w-4 shrink-0" />{!sidebarCollapsed && 'Configurar espacio'}</button></div>
    </aside>

    <main className="flex min-w-0 flex-1 flex-col">
      <header className="border-b border-slate-200 bg-white px-3 py-3 sm:px-5">
        <div className="flex items-center gap-3"><button onClick={() => setSidebarOpen(true)} className="rounded-xl p-2 text-slate-500 hover:bg-slate-100 lg:hidden"><Menu className="h-5 w-5" /></button><div className="min-w-0"><div className="flex items-center gap-1 text-[10px] text-slate-400"><span>Clarin Work</span>{activeFolder && <><ChevronRight className="h-3 w-3" /><span>{activeFolder.name}</span></>}</div><h1 className="truncate text-lg font-black text-slate-900">{scopeName}</h1></div><div className="ml-auto flex items-center gap-2"><button onClick={() => setStructureOpen(true)} className="hidden rounded-xl border border-slate-200 p-2.5 text-slate-500 hover:bg-slate-50 sm:block"><Settings2 className="h-4 w-4" /></button>{scope.type !== 'trash' && <button onClick={() => { setEditingTask(null); setEditorOpen(true) }} className="flex items-center gap-2 rounded-xl bg-slate-900 px-3.5 py-2.5 text-sm font-bold text-white shadow-lg shadow-slate-200 transition hover:bg-emerald-700"><Plus className="h-4 w-4" /><span className="hidden sm:inline">Nueva tarea</span></button>}</div></div>
        <div className="mt-3 flex flex-wrap items-center gap-2"><div className="relative min-w-[180px] flex-1 sm:max-w-sm"><Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" /><input id="task-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar tareas…  /" className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm outline-none focus:border-emerald-300 focus:bg-white" /></div>{scope.type !== 'trash' && <><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600"><option value="">Todos los estados</option><option value="overdue">Vencidas</option>{statuses.map(status => <option key={status.id} value={status.id}>{status.name}</option>)}</select><select value={ownerFilter} onChange={event => setOwnerFilter(event.target.value)} className="hidden rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 sm:block"><option value="">Todo el equipo</option>{users.map(user => <option key={user.id} value={user.id}>{user.display_name || user.username}</option>)}</select><button onClick={() => setStarredOnly(value => !value)} className={`rounded-xl border p-2 ${starredOnly ? 'border-amber-200 bg-amber-50 text-amber-500' : 'border-slate-200 bg-white text-slate-400'}`}><Star className={`h-4 w-4 ${starredOnly ? 'fill-current' : ''}`} /></button></>}</div>
        {scope.type !== 'trash' && <div className="mt-3 flex overflow-x-auto rounded-xl bg-slate-100 p-1 sm:w-fit">{viewOptions.map(option => { const Icon = option.icon; return <button key={option.id} onClick={() => setView(option.id)} className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition ${view === option.id ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}><Icon className="h-3.5 w-3.5" />{option.label}</button> })}</div>}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-5">
        {error && <div className="mb-3 flex items-center justify-between rounded-xl bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"><span>{error}</span><button onClick={() => setError('')}><X className="h-4 w-4" /></button></div>}
        {loading ? <div className="space-y-3">{Array.from({length:5}).map((_,index) => <div key={index} className="h-16 animate-pulse rounded-2xl bg-slate-200/60" />)}</div> : <div className="h-full min-h-[420px]">
          {scope.type === 'trash' && <TrashView tasks={tasks} onRestore={task => void restoreTask(task)} />}
          {scope.type !== 'trash' && view === 'list' && <ListView tasks={tasks} statuses={statuses} onOpen={task => setSelectedTaskId(task.id)} onStatus={(task,statusId) => void updateTask(task,{status_id:statusId})} onStar={task => void toggleStar(task)} />}
          {scope.type !== 'trash' && view === 'board' && <BoardView tasks={tasks} statuses={boardStatuses} onOpen={task => setSelectedTaskId(task.id)} onStatus={moveToBoardStatus} onCreate={createInBoardStatus} />}
          {scope.type !== 'trash' && view === 'calendar' && <CalendarView tasks={tasks} onOpen={task => setSelectedTaskId(task.id)} />}
          {scope.type !== 'trash' && view === 'gantt' && <TaskGanttView data={gantt} onOpen={task => setSelectedTaskId(task.id)} onMove={moveGantt} />}
          {scope.type !== 'trash' && view === 'summary' && <SummaryView tasks={tasks} summary={summary} users={users} />}
        </div>}
      </div>
    </main>

    <TaskEditorModal open={editorOpen} task={editingTask?.id ? editingTask : null} defaultListId={activeList?.id || activeFolder?.lists[0]?.id} defaultStatusId={createStatusId} defaultOwnerId={currentUserId} lists={lists} workflows={workflows} users={users} onClose={() => { setEditorOpen(false); setEditingTask(null); setCreateStatusId('') }} onSaved={saved => { setTasks(current => { const exists = current.some(item => item.id === saved.id); return exists ? current.map(item => item.id === saved.id ? saved : item) : [saved, ...current] }); void loadTasks(false) }} />
    <TaskDetailDrawer taskId={selectedTaskId} allTasks={tasks} users={users} lists={lists} workflows={workflows} onClose={() => setSelectedTaskId(null)} onEdit={task => { setEditingTask(task); setEditorOpen(true) }} onChanged={changed => { if (changed) setTasks(current => current.map(item => item.id === changed.id ? changed : item)); void loadTasks(false) }} onDeleted={id => setTasks(current => current.filter(item => item.id !== id))} />
    <TaskStructureModal open={structureOpen} folders={folders} lists={lists} workflows={workflows} onClose={() => setStructureOpen(false)} onChanged={loadStructure} />
  </div>
}
