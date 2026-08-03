'use client'

import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, Plus, X } from 'lucide-react'
import { apiPost } from '@/lib/api'
import type { Task, TaskFolder, TaskList, TaskWorkflowStatus } from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'
import type { TaskInlineDraft } from './TaskBoard'
import { TaskListPicker } from './TaskSelectPicker'
import TaskUserCombobox from './TaskUserCombobox'
import { calendarDefaultList, calendarSlot, type TaskCalendarMode } from './taskCalendarState'
import type { TaskHierarchyCounts } from './taskHierarchyCounts'

interface Props {
  tasks: Task[]
  lists: TaskList[]
  folders: TaskFolder[]
  statuses: TaskWorkflowStatus[]
  users: TaskAccountUser[]
  currentUserID: string
  scopeListID?: string
  onOpen: (task: Task) => void
  onCreated: (task: Task, operationID: string, hierarchyCounts?: TaskHierarchyCounts) => void
  onOperation: (operationID: string, active: boolean) => void
  onMore: (statusID?: string, draft?: TaskInlineDraft) => void
  canCreate?: boolean
}

type Composer = { startAt: string; dueAt: string; allDay: boolean }
const hours = Array.from({ length: 12 }, (_, index) => index + 8)

export default function TaskCalendarView({ tasks, lists, folders, statuses, users, currentUserID, scopeListID, onOpen, onCreated, onOperation, onMore, canCreate = true }: Props) {
  const [mode, setMode] = useState<TaskCalendarMode>('month')
  const [cursor, setCursor] = useState(new Date())
  const [composer, setComposer] = useState<Composer | null>(null)
  const [title, setTitle] = useState('')
  const [lastListID, setLastListID] = useState('')
  const [listID, setListID] = useState(() => calendarDefaultList(scopeListID, '', lists.map(list => list.id)))
  const [ownerID, setOwnerID] = useState(currentUserID)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const folderByID = useMemo(() => new Map(folders.map(folder => [folder.id, folder])), [folders])
  const dayTasks = (day: Date) => tasks.filter(task => task.due_at && new Date(task.due_at).toDateString() === day.toDateString())
  const move = (direction: number) => setCursor(value => { const next = new Date(value); if (mode === 'month') next.setMonth(next.getMonth() + direction); else if (mode === 'week') next.setDate(next.getDate() + direction * 7); else next.setDate(next.getDate() + direction); return next })
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const gridStart = new Date(first); gridStart.setDate(1 - ((first.getDay() + 6) % 7))
  const monthDays = Array.from({ length: 42 }, (_, index) => { const date = new Date(gridStart); date.setDate(gridStart.getDate() + index); return date })
  const weekStart = new Date(cursor); weekStart.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7)); weekStart.setHours(0, 0, 0, 0)
  const weekDays = Array.from({ length: 7 }, (_, index) => { const date = new Date(weekStart); date.setDate(weekStart.getDate() + index); return date })

  const openComposer = (date: Date, hour?: number) => {
    if (!canCreate) return
    setComposer(calendarSlot(date, hour))
    setListID(calendarDefaultList(scopeListID, lastListID, lists.map(list => list.id)))
    setOwnerID(currentUserID || users[0]?.id || '')
    setTitle('')
    setError('')
  }
  const close = () => { setComposer(null); setTitle(''); setError('') }
  const selectedList = lists.find(list => list.id === listID)
  const status = statuses.find(item => item.workflow_id === selectedList?.workflow_id && item.category === 'not_started')
  const create = async () => {
    if (!canCreate || !composer || !title.trim() || !selectedList || !status || !ownerID || saving) return
    setSaving(true)
    const operationID = crypto.randomUUID()
    onOperation(operationID, true)
    try {
      const result = await apiPost<{ task: Task; operation_id?: string; hierarchy_counts?: TaskHierarchyCounts }>('/api/tasks', { title: title.trim(), description: '', type: 'reminder', priority: 'medium', assigned_to: ownerID, list_id: listID, status_id: status.id, start_at: composer.startAt, due_at: composer.dueAt, is_all_day: composer.allDay, recurrence_rule: '', reminder_minutes: 0, placement: 'top', operation_id: operationID })
      if (!result.success || !result.data?.task) { setError(result.error || 'No se pudo crear la tarea'); return }
      setLastListID(listID)
      onCreated(result.data.task, result.data.operation_id || operationID, result.data.hierarchy_counts)
      close()
    } finally { setSaving(false); onOperation(operationID, false) }
  }
  const more = () => {
    if (!canCreate || !composer) return
    onMore(status?.id, { title, listId: listID, statusId: status?.id || '', ownerId: ownerID, dueDate: composer.dueAt.slice(0, 10), priority: 'medium', startAt: composer.startAt, dueAt: composer.dueAt, isAllDay: composer.allDay })
    close()
  }

  return <div data-task-calendar className="relative flex h-full min-h-0 flex-col overflow-hidden border-y border-slate-200 bg-white">
    <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3"><button onClick={() => move(-1)} className="rounded-xl p-2 text-slate-500 hover:bg-slate-100"><ChevronLeft className="h-4 w-4" /></button><button onClick={() => setCursor(new Date())} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600">Hoy</button><button onClick={() => move(1)} className="rounded-xl p-2 text-slate-500 hover:bg-slate-100"><ChevronRight className="h-4 w-4" /></button><h3 className="ml-1 text-sm font-black capitalize text-slate-800">{cursor.toLocaleDateString('es', mode === 'month' ? { month: 'long', year: 'numeric' } : { day: 'numeric', month: 'long', year: 'numeric' })}</h3><div className="ml-auto flex rounded-xl bg-slate-100 p-1">{(['month', 'week', 'day'] as TaskCalendarMode[]).map(item => <button key={item} onClick={() => setMode(item)} className={`rounded-lg px-3 py-1.5 text-[11px] font-bold ${mode === item ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'}`}>{item === 'month' ? 'Mes' : item === 'week' ? 'Semana' : 'Día'}</button>)}</div></header>
    <div className="min-h-0 flex-1 overflow-auto">
      {mode === 'month' && <div className="grid min-h-full grid-cols-7 grid-rows-[32px_repeat(6,minmax(100px,1fr))]">{['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map(day => <div key={day} className="flex items-center justify-center border-b border-r border-slate-100 text-[10px] font-black uppercase text-slate-400">{day}</div>)}{monthDays.map(day => { const items = dayTasks(day); const activeMonth = day.getMonth() === cursor.getMonth(); const today = day.toDateString() === new Date().toDateString(); return <button type="button" key={day.toISOString()} onClick={() => openComposer(day)} className={`group min-h-[100px] border-b border-r border-slate-100 p-1.5 text-left transition ${canCreate ? 'hover:bg-emerald-50/40' : 'cursor-default'} ${activeMonth ? 'bg-white' : 'bg-slate-50/70'}`}><div className="flex items-center justify-between"><span className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ${today ? 'bg-emerald-600 text-white' : activeMonth ? 'text-slate-600' : 'text-slate-300'}`}>{day.getDate()}</span>{canCreate && <Plus className="h-3.5 w-3.5 text-emerald-500 opacity-0 transition group-hover:opacity-100" />}</div><div className="mt-1 space-y-1">{items.slice(0, 3).map(task => <span key={task.id} role="button" tabIndex={0} onClick={event => { event.stopPropagation(); onOpen(task) }} className="block w-full truncate rounded px-1.5 py-1 text-[10px] font-semibold text-white" style={{ backgroundColor: task.status_detail?.color || '#64748b' }}>{task.title}</span>)}{items.length > 3 && <span className="px-1 text-[9px] font-bold text-slate-400">+{items.length - 3} más</span>}</div></button> })}</div>}
      {mode !== 'month' && <div className={`grid min-w-[720px] ${mode === 'week' ? 'grid-cols-[52px_repeat(7,minmax(96px,1fr))]' : 'grid-cols-[64px_1fr]'}`}><div className="border-r border-slate-100" />{(mode === 'week' ? weekDays : [cursor]).map(day => <div key={`head:${day.toISOString()}`} className="sticky top-0 z-10 border-b border-r border-slate-100 bg-white/95 p-2 text-center backdrop-blur"><p className="text-[10px] font-black uppercase text-slate-400">{day.toLocaleDateString('es', { weekday: 'short' })}</p><p className="text-sm font-black text-slate-700">{day.getDate()}</p></div>)}{hours.flatMap(hour => [<div key={`label:${hour}`} className="border-r border-t border-slate-100 pr-2 pt-1 text-right text-[10px] font-semibold text-slate-400">{String(hour).padStart(2, '0')}:00</div>, ...(mode === 'week' ? weekDays : [cursor]).map(day => <button key={`${day.toISOString()}:${hour}`} type="button" onClick={() => openComposer(day, hour)} className={`group relative min-h-14 border-r border-t border-slate-100 text-left ${canCreate ? 'hover:bg-emerald-50/50' : 'cursor-default'}`}>{canCreate && <Plus className="absolute right-2 top-2 h-3.5 w-3.5 text-emerald-500 opacity-0 group-hover:opacity-100" />}{dayTasks(day).filter(task => new Date(task.due_at!).getHours() === hour).map(task => <span key={task.id} onClick={event => { event.stopPropagation(); onOpen(task) }} className="m-1 block truncate rounded-lg px-2 py-1 text-[10px] font-semibold text-white" style={{ backgroundColor: task.status_detail?.color || '#64748b' }}>{task.title}</span>)}</button>)])}</div>}
    </div>
    {composer && <div className="fixed inset-0 z-[145] flex items-center justify-center bg-slate-950/25 p-4 backdrop-blur-[2px]" onMouseDown={event => event.target === event.currentTarget && close()}><div role="dialog" aria-modal="true" aria-labelledby="calendar-composer-title" className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl"><div className="flex items-start justify-between"><div><p className="text-[10px] font-black uppercase tracking-[.16em] text-emerald-600">Calendario</p><h2 id="calendar-composer-title" className="mt-1 text-lg font-black text-slate-900">Crear tarea</h2><p className="mt-1 text-xs text-slate-400">{new Date(composer.startAt).toLocaleString('es', composer.allDay ? { dateStyle: 'full' } : { dateStyle: 'medium', timeStyle: 'short' })}</p></div><button onClick={close} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button></div><input autoFocus value={title} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void create() }; if (event.key === 'Escape') { event.preventDefault(); close() } }} placeholder="¿Qué hay que lograr?" className="mt-4 w-full rounded-2xl border border-slate-200 px-4 py-3 text-base font-semibold outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100" /><div className="mt-3 grid gap-3 sm:grid-cols-2"><TaskListPicker value={listID} lists={lists} folders={folders} onChange={setListID} /><TaskUserCombobox users={users} value={ownerID} onChange={setOwnerID} /></div>{selectedList && <p className="mt-2 text-[10px] text-slate-400">Destino: {selectedList.folder_id ? `${folderByID.get(selectedList.folder_id)?.name || 'Carpeta'} / ` : ''}{selectedList.name}</p>}{error && <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{error}</p>}<div className="mt-5 flex justify-end gap-2"><button onClick={more} className="rounded-xl px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-100">Más opciones</button><button disabled={!title.trim() || !selectedList || !status || !ownerID || saving} onClick={() => void create()} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-black text-white shadow-lg shadow-emerald-100 hover:bg-emerald-700 disabled:opacity-40">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Crear</button></div></div></div>}
  </div>
}
