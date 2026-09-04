'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { CalendarClock, Check, CirclePlus, GripVertical, ListChecks, Loader2, Plus, RotateCcw, Search, Sparkles, X } from 'lucide-react'
import { apiDelete, apiGet, apiPost, apiPut, subscribeWebSocket } from '@/lib/api'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import type { Task, TaskMyWorkItem, TaskMyWorkMutation, TaskMyWorkResponse, TaskMyWorkSuggestion, TaskMyWorkSummary } from '@/types/task'
import { TaskPriorityIndicator, TaskStatusIndicator } from './TaskSemanticIndicators'
import { taskLocationLabel } from './taskBreadcrumbVisibility'
import { applyTaskMyWorkMutationOrder, reorderTaskMyWorkItems, taskMyWorkBeforeTaskID, taskMyWorkShouldRefresh } from './taskMyWorkState'

const dueFormatter = new Intl.DateTimeFormat('es-PE', { day: 'numeric', month: 'short', timeZone: 'America/Lima' })
const dayFormatter = new Intl.DateTimeFormat('es-PE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Lima' })

type MutationResponse = { mutation: TaskMyWorkMutation }

const reasonLabels = {
  overdue: 'Vencida',
  due_today: 'Vence hoy',
  previous_focus: 'Quedó de tu último foco',
} as const

function mutationBody(summary: TaskMyWorkSummary) {
  return { business_date: summary.business_date, expected_revision: summary.revision, operation_id: crypto.randomUUID() }
}

function notifyTaskMyWorkChanged(mutation?: TaskMyWorkMutation) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('task-my-work-changed', { detail: mutation }))
}

export function TaskMyWorkNavButton({ active, collapsed, onSelect }: { active: boolean; collapsed: boolean; onSelect: () => void }) {
  const [summary, setSummary] = useState<TaskMyWorkSummary | null>(null)
  const load = useCallback(async () => {
    const result = await apiGet<{ summary: TaskMyWorkSummary }>('/api/tasks/my-work/summary')
    if (result.success && result.data?.summary) setSummary(result.data.summary)
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void load(), 120) }
    const unsubscribe = subscribeWebSocket(raw => { if (taskMyWorkShouldRefresh(raw)) refresh() })
    window.addEventListener('task-my-work-changed', refresh)
    return () => { unsubscribe(); window.removeEventListener('task-my-work-changed', refresh); if (timer) clearTimeout(timer) }
  }, [load])

  const count = summary?.focus_count || 0
  return <button
    type="button"
    data-task-my-work-nav
    aria-current={active ? 'page' : undefined}
    title={collapsed ? `Mi trabajo · ${count} en foco` : undefined}
    onClick={onSelect}
    className={`mb-2 flex min-h-11 w-full items-center rounded-xl text-left transition focus:outline-none focus:ring-2 focus:ring-emerald-400 ${collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5'} ${active ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`}
  >
    <span className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${active ? 'bg-white/10 text-emerald-300' : 'bg-emerald-50 text-emerald-700'}`}><ListChecks className="h-4 w-4" />{collapsed && count > 0 && <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-emerald-500 px-1 text-center text-[9px] font-black leading-4 text-white">{count > 99 ? '99+' : count}</span>}</span>
    {!collapsed && <><span className="min-w-0 flex-1"><span className="block text-xs font-black">Mi trabajo</span><span className={`block truncate text-[9px] font-semibold ${active ? 'text-slate-300' : 'text-slate-400'}`}>Tu foco personal de hoy</span></span><span className={`min-w-7 rounded-full px-2 py-1 text-center text-[10px] font-black ${active ? 'bg-white/10 text-white' : 'bg-slate-100 text-slate-600'}`}>{count}</span></>}
  </button>
}

function TaskMyWorkTaskPicker({ open, excludedIDs, onClose, onAdd }: { open: boolean; excludedIDs: Set<string>; onClose: () => void; onAdd: (task: Task) => Promise<boolean> }) {
  const [query, setQuery] = useState('')
  const [settledQuery, setSettledQuery] = useDebouncedValue('')
  const [results, setResults] = useState<Task[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [pendingID, setPendingID] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const generation = useRef(0)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSettledQuery('')
    setResults([])
    setError('')
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open, setSettledQuery])

  useEffect(() => {
    if (!open || !settledQuery.trim()) { setResults([]); setLoading(false); return }
    const controller = new AbortController()
    const current = ++generation.current
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ search: settledQuery.trim(), include_subtasks: 'true', include_closed: 'false', limit: '50' })
    void apiGet<{ tasks: Task[] }>(`/api/tasks?${params}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || current !== generation.current) return
      if (!result.success) setError(result.error || 'No se pudieron buscar tareas.')
      else setResults((result.data?.tasks || []).filter(task => !excludedIDs.has(task.id)))
      setLoading(false)
    })
    return () => controller.abort()
  }, [excludedIDs, open, settledQuery])

  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !pendingID) onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose, open, pendingID])

  if (!open || typeof document === 'undefined') return null
  return createPortal(<div className="fixed inset-0 z-[150] flex items-start justify-center overflow-y-auto bg-slate-950/45 p-3 pt-[max(3rem,10vh)] backdrop-blur-[3px]" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !pendingID) onClose() }}>
    <div role="dialog" aria-modal="true" aria-labelledby="task-my-work-picker-title" className="w-full max-w-2xl overflow-hidden rounded-3xl border border-white/20 bg-white shadow-2xl">
      <header className="flex items-start gap-3 border-b border-slate-100 px-4 py-4 sm:px-5"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700"><Search className="h-4 w-4" /></span><div className="min-w-0 flex-1"><h2 id="task-my-work-picker-title" className="text-base font-black text-slate-900">Añadir una tarea visible</h2><p className="mt-0.5 text-xs leading-5 text-slate-500">Busca en todos tus Entornos autorizados. La tarea conservará su lista, estado y prioridad compartida.</p></div><button type="button" disabled={Boolean(pendingID)} onClick={onClose} aria-label="Cerrar búsqueda" className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 disabled:opacity-40"><X className="h-4 w-4" /></button></header>
      <div className="p-4 sm:p-5"><div className="relative"><Search className="absolute left-3.5 top-3.5 h-4 w-4 text-slate-400" /><input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="Nombre o descripción de la tarea…" className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-10 text-sm text-slate-800 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-100" />{query.trim() !== settledQuery.trim() || loading ? <Loader2 aria-label="Buscando" className="absolute right-3.5 top-3.5 h-4 w-4 animate-spin text-emerald-500" /> : query && <button type="button" aria-label="Limpiar búsqueda" onClick={() => { setQuery(''); setSettledQuery(''); setResults([]) }} className="absolute right-2 top-1 flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><X className="h-3.5 w-3.5" /></button>}</div>
        <div className="mt-3 max-h-[min(52vh,440px)] overflow-y-auto rounded-2xl border border-slate-100">
          {!query.trim() && <div className="px-5 py-12 text-center"><Sparkles className="mx-auto h-7 w-7 text-emerald-400" /><p className="mt-3 text-sm font-bold text-slate-600">Escribe para encontrar una tarea</p><p className="mt-1 text-xs text-slate-400">La búsqueda comienza 500 ms después de dejar de escribir.</p></div>}
          {query.trim() && settledQuery.trim() && !loading && !error && !results.length && <div className="px-5 py-12 text-center"><p className="text-sm font-bold text-slate-600">No encontramos tareas abiertas visibles</p><p className="mt-1 text-xs text-slate-400">Prueba con otro nombre o una parte de la descripción.</p></div>}
          {error && <div role="alert" className="m-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-semibold text-rose-700">{error}</div>}
          <div className="divide-y divide-slate-100">{results.map(task => <button key={task.id} type="button" disabled={Boolean(pendingID)} onClick={() => { setPendingID(task.id); void onAdd(task).then(saved => { if (saved) onClose() }).finally(() => setPendingID('')) }} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left hover:bg-emerald-50/50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-emerald-400 disabled:opacity-50"><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-slate-800">{task.title}</span><span className="mt-1 block truncate text-[10px] font-semibold text-slate-400">{taskLocationLabel(task)}{task.parent_task_id ? ' · Subtarea' : ''}</span></span><TaskPriorityIndicator priority={task.priority} compact />{pendingID === task.id ? <Loader2 className="h-4 w-4 animate-spin text-emerald-600" /> : <Plus className="h-4 w-4 text-emerald-600" />}</button>)}</div>
        </div>
      </div>
    </div>
  </div>, document.body)
}

function TaskMyWorkRow({ item, pending, onOpen, onRemove }: { item: TaskMyWorkItem; pending: boolean; onOpen: (task: Task, trigger?: HTMLElement | null) => void; onRemove: (task: Task) => void }) {
  const sortable = useSortable({ id: item.task.id, disabled: pending })
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }
  const task = item.task
  return <div ref={sortable.setNodeRef} style={style} data-task-my-work-row={task.id} className={`group flex min-h-[68px] items-center gap-2 px-3 py-2.5 transition ${sortable.isDragging ? 'relative z-10 opacity-35' : 'hover:bg-slate-50'}`}>
    <button ref={sortable.setActivatorNodeRef} type="button" disabled={pending} aria-label={`Reordenar ${task.title}`} {...sortable.attributes} {...sortable.listeners} className="flex h-11 w-8 shrink-0 touch-none items-center justify-center rounded-lg text-slate-300 hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:cursor-wait"><GripVertical className="h-4 w-4" /></button>
    <button type="button" onClick={event => onOpen(task, event.currentTarget)} className="min-w-0 flex-1 rounded-lg py-1 text-left focus:outline-none focus:ring-2 focus:ring-emerald-400"><span className="block truncate text-sm font-bold text-slate-800">{task.title}</span><span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-semibold text-slate-400"><span className="max-w-[280px] truncate">{taskLocationLabel(task)}</span>{task.parent_task_id && <span>Subtarea</span>}{task.due_at && <span className={new Date(task.due_at).getTime() < Date.now() ? 'text-rose-600' : ''}>{dueFormatter.format(new Date(task.due_at))}</span>}</span></button>
    <TaskStatusIndicator status={task.status_detail} compact />
    <TaskPriorityIndicator priority={task.priority} compact />
    <button type="button" disabled={pending} onClick={() => onRemove(task)} aria-label={`Quitar ${task.title} de Mi trabajo`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-300 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-rose-300 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 disabled:opacity-30"><X className="h-4 w-4" /></button>
  </div>
}

function TaskMyWorkCompletedRow({ item, pending, onOpen, onRemove }: { item: TaskMyWorkItem; pending: boolean; onOpen: (task: Task, trigger?: HTMLElement | null) => void; onRemove: (task: Task) => void }) {
  return <div className="group flex min-h-[60px] items-center gap-3 px-4 py-2.5 hover:bg-slate-50"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><Check className="h-4 w-4" /></span><button type="button" onClick={event => onOpen(item.task, event.currentTarget)} className="min-w-0 flex-1 rounded-lg text-left focus:outline-none focus:ring-2 focus:ring-emerald-400"><span className="block truncate text-sm font-semibold text-slate-500 line-through">{item.task.title}</span><span className="mt-0.5 block truncate text-[10px] text-slate-400">{taskLocationLabel(item.task)}</span></button><button type="button" disabled={pending} aria-label={`Quitar ${item.task.title} de Mi trabajo`} onClick={() => onRemove(item.task)} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-300 opacity-0 hover:bg-rose-50 hover:text-rose-600 focus:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"><X className="h-4 w-4" /></button></div>
}

export function TaskMyWorkView({ onOpen, onExit }: { onOpen: (task: Task, trigger?: HTMLElement | null) => void; onExit: () => void }) {
  const [data, setData] = useState<TaskMyWorkResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [draggedID, setDraggedID] = useState('')
  const initialTaskOpened = useRef(false)
  const loadGeneration = useRef(0)
  const dataRef = useRef(data)
  dataRef.current = data
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 520, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const load = useCallback(async (showLoader = false) => {
    const generation = ++loadGeneration.current
    if (showLoader || !dataRef.current) setLoading(true)
    else setRefreshing(true)
    const result = await apiGet<TaskMyWorkResponse>('/api/tasks/my-work?section=all&limit=50')
    if (generation !== loadGeneration.current) return
    if (!result.success || !result.data) setError(result.error || 'No se pudo cargar Mi trabajo.')
    else { setData(result.data); setError('') }
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => { void load(true) }, [load])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeWebSocket(raw => {
      if (!taskMyWorkShouldRefresh(raw)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(false), 120)
    })
    return () => { unsubscribe(); if (timer) clearTimeout(timer) }
  }, [load])
  useEffect(() => {
    if (!data?.summary.reset_at) return
    const delay = Math.max(1000, new Date(data.summary.reset_at).getTime() - Date.now() + 250)
    const timer = window.setTimeout(() => void load(false), Math.min(delay, 2_147_000_000))
    return () => window.clearTimeout(timer)
  }, [data?.summary.reset_at, load])
  useEffect(() => {
    if (!data || initialTaskOpened.current || typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('attention') !== 'my-work') return
    const taskID = params.get('task')
    if (!taskID) return
    const task = [...data.focus_items, ...data.completed_items].find(item => item.task.id === taskID)?.task
    if (!task) return
    initialTaskOpened.current = true
    onOpen(task)
  }, [data, onOpen])

  const runMutation = useCallback(async (kind: 'add' | 'remove' | 'reorder', task: Task, beforeTaskID?: string | null) => {
    const current = dataRef.current
    if (!current || pending) return false
    const snapshot = current
    const body = mutationBody(current.summary)
    setPending(`${kind}:${task.id}`)
    setError('')
    if (kind === 'add') {
      const optimisticItem: TaskMyWorkItem = { task, position: (current.focus_items.at(-1)?.position || 0) + 1024, added_at: new Date().toISOString() }
      setData({ ...current, focus_items: [...current.focus_items, optimisticItem], suggestions: current.suggestions.filter(item => item.task.id !== task.id), summary: { ...current.summary, focus_count: current.summary.focus_count + 1 } })
    } else if (kind === 'remove') {
      setData({ ...current, focus_items: current.focus_items.filter(item => item.task.id !== task.id), completed_items: current.completed_items.filter(item => item.task.id !== task.id), summary: { ...current.summary, focus_count: Math.max(0, current.summary.focus_count - (current.focus_items.some(item => item.task.id === task.id) ? 1 : 0)), completed_count: Math.max(0, current.summary.completed_count - (current.completed_items.some(item => item.task.id === task.id) ? 1 : 0)) } })
    }
    const result = kind === 'add'
      ? await apiPost<MutationResponse>('/api/tasks/my-work/items', { ...body, task_id: task.id })
      : kind === 'remove'
        ? await apiDelete<MutationResponse>(`/api/tasks/my-work/items/${task.id}`, body)
        : await apiPut<MutationResponse>(`/api/tasks/my-work/items/${task.id}/order`, { ...body, before_task_id: beforeTaskID })
    if (!result.success || !result.data?.mutation) {
      setData(snapshot)
      setError(result.status === 409 ? 'Mi trabajo cambió en otra sesión. Restauramos el orden y cargamos la versión actual.' : result.error || 'No se pudo actualizar Mi trabajo. Restauramos el estado anterior.')
      if (result.status === 409) await load(false)
      setPending('')
      return false
    }
    setData(currentData => currentData ? applyTaskMyWorkMutationOrder(currentData, result.data!.mutation) : currentData)
    notifyTaskMyWorkChanged(result.data.mutation)
    setPending('')
    void load(false)
    return true
  }, [load, pending])

  const reorder = async (event: DragEndEvent) => {
    setDraggedID('')
    const current = dataRef.current
    const activeID = String(event.active.id)
    const overID = event.over ? String(event.over.id) : null
    if (!current || !overID || activeID === overID || pending) return
    const snapshot = current
    const nextItems = reorderTaskMyWorkItems(current.focus_items, activeID, overID)
    if (nextItems === current.focus_items) return
    const task = current.focus_items.find(item => item.task.id === activeID)?.task
    if (!task) return
    setData({ ...current, focus_items: nextItems })
    const ok = await runMutation('reorder', task, taskMyWorkBeforeTaskID(nextItems, activeID))
    if (!ok) setData(snapshot)
  }

  const loadMoreSuggestions = async () => {
    const current = dataRef.current
    if (!current?.suggestions_next_cursor || pending) return
    setPending('suggestions:more')
    const params = new URLSearchParams({ section: 'suggestions', limit: '50', cursor: current.suggestions_next_cursor })
    const result = await apiGet<TaskMyWorkResponse>(`/api/tasks/my-work?${params}`)
    if (!result.success || !result.data) setError(result.error || 'No se pudieron cargar más sugerencias.')
    else setData(dataNow => dataNow ? { ...dataNow, suggestions: Array.from(new Map([...dataNow.suggestions, ...result.data!.suggestions].map(item => [item.task.id, item])).values()), suggestions_next_cursor: result.data!.suggestions_next_cursor, summary: result.data!.summary } : dataNow)
    setPending('')
  }

  const existingIDs = useMemo(() => new Set([...(data?.focus_items || []), ...(data?.completed_items || [])].map(item => item.task.id)), [data?.completed_items, data?.focus_items])
  const focusIDs = data?.focus_items.map(item => item.task.id) || []
  const dragged = data?.focus_items.find(item => item.task.id === draggedID)?.task

  if (loading && !data) return <div className="mx-auto w-full max-w-5xl space-y-3 pb-8" aria-label="Cargando Mi trabajo">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-20 animate-pulse rounded-2xl bg-slate-200/70" />)}</div>
  if (!data) return <div className="mx-auto flex min-h-[420px] w-full max-w-5xl items-center justify-center"><div className="max-w-md text-center"><ListChecks className="mx-auto h-9 w-9 text-slate-300" /><p className="mt-3 text-sm font-black text-slate-700">No pudimos abrir Mi trabajo</p><p role="alert" className="mt-1 text-xs text-rose-600">{error}</p><button type="button" onClick={() => void load(true)} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-xs font-bold text-white"><RotateCcw className="h-4 w-4" />Reintentar</button></div></div>

  return <div data-task-my-work className="mx-auto w-full max-w-5xl space-y-4 pb-8">
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><header className="flex flex-wrap items-start gap-3 border-b border-slate-100 px-4 py-4 sm:px-5"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-emerald-300"><ListChecks className="h-5 w-5" /></span><div className="min-w-[180px] flex-1"><div className="flex items-center gap-2"><h2 className="text-base font-black text-slate-900">Tu foco de hoy</h2>{refreshing && <Loader2 aria-label="Actualizando Mi trabajo" className="h-3.5 w-3.5 animate-spin text-emerald-500" />}</div><p className="mt-0.5 text-xs leading-5 text-slate-500"><span className="capitalize">{dayFormatter.format(new Date(`${data.summary.business_date}T12:00:00-05:00`))}</span> · privado para ti · se reinicia cada día</p></div><button type="button" onClick={() => setPickerOpen(true)} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-3.5 text-xs font-black text-white shadow-sm transition hover:bg-emerald-700 focus:outline-none focus:ring-4 focus:ring-emerald-200"><CirclePlus className="h-4 w-4" />Añadir tarea</button><button type="button" onClick={onExit} className="min-h-11 rounded-xl border border-slate-200 px-3 text-xs font-bold text-slate-600 hover:bg-slate-50">Volver al Entorno</button></header>
      {error && <div role="alert" className="m-3 flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-semibold text-rose-700"><span>{error}</span><button type="button" aria-label="Cerrar error" onClick={() => setError('')}><X className="h-4 w-4" /></button></div>}
      <DndContext sensors={sensors} onDragStart={(event: DragStartEvent) => setDraggedID(String(event.active.id))} onDragCancel={() => setDraggedID('')} onDragEnd={event => void reorder(event)}><SortableContext items={focusIDs} strategy={verticalListSortingStrategy}><div className="divide-y divide-slate-100">{data.focus_items.map(item => <TaskMyWorkRow key={item.task.id} item={item} pending={Boolean(pending)} onOpen={onOpen} onRemove={task => void runMutation('remove', task)} />)}</div></SortableContext><DragOverlay>{dragged && <div className="w-[min(520px,calc(100vw-32px))] rounded-2xl border border-emerald-300 bg-white px-4 py-3 shadow-2xl"><div className="flex items-center gap-2"><GripVertical className="h-4 w-4 text-emerald-600" /><p className="truncate text-sm font-black text-slate-800">{dragged.title}</p></div><p className="mt-1 text-[10px] font-bold text-emerald-700">Reordenando tu foco personal</p></div>}</DragOverlay></DndContext>
      {!data.focus_items.length && <div className="px-5 py-14 text-center"><Sparkles className="mx-auto h-8 w-8 text-emerald-400" /><p className="mt-3 text-sm font-black text-slate-700">Tu foco está vacío</p><p className="mx-auto mt-1 max-w-md text-xs leading-5 text-slate-400">Elige únicamente lo que sí quieres trabajar hoy. Las tareas vencidas y asignadas aparecen como sugerencias, nunca se agregan solas.</p><button type="button" onClick={() => setPickerOpen(true)} className="mt-4 min-h-11 rounded-xl border border-emerald-200 bg-emerald-50 px-4 text-xs font-black text-emerald-700 hover:bg-emerald-100">Elegir una tarea</button></div>}
    </section>

    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><header className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-4 py-3 sm:px-5"><div><h3 className="text-sm font-black text-slate-800">Por revisar</h3><p className="mt-0.5 text-[10px] font-semibold text-slate-400">Sugerencias asignadas a ti, vencidas, de hoy o de tu último foco</p></div><span className="rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-black text-amber-700">{data.summary.suggestion_count}</span></header><div className="divide-y divide-slate-100">{data.suggestions.map((suggestion: TaskMyWorkSuggestion) => <div key={suggestion.task.id} className="group flex min-h-[68px] items-center gap-3 px-4 py-2.5 hover:bg-amber-50/30"><button type="button" onClick={event => onOpen(suggestion.task, event.currentTarget)} className="min-w-0 flex-1 rounded-lg text-left focus:outline-none focus:ring-2 focus:ring-emerald-400"><span className="block truncate text-sm font-bold text-slate-800">{suggestion.task.title}</span><span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">{suggestion.reasons.map(reason => <span key={reason} className={`rounded-md px-1.5 py-0.5 text-[9px] font-black ${reason === 'overdue' ? 'bg-rose-100 text-rose-700' : reason === 'due_today' ? 'bg-amber-100 text-amber-700' : 'bg-sky-100 text-sky-700'}`}>{reasonLabels[reason]}</span>)}<span className="max-w-[260px] truncate text-[10px] font-semibold text-slate-400">{taskLocationLabel(suggestion.task)}</span></span></button><TaskPriorityIndicator priority={suggestion.task.priority} compact /><button type="button" disabled={Boolean(pending)} onClick={() => void runMutation('add', suggestion.task)} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 text-[10px] font-black text-emerald-700 hover:bg-emerald-100 disabled:opacity-40">{pending === `add:${suggestion.task.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}Enfocar</button></div>)}</div>{!data.suggestions.length && <div className="px-5 py-10 text-center"><Check className="mx-auto h-7 w-7 text-emerald-500" /><p className="mt-2 text-sm font-bold text-slate-600">No hay nada pendiente por revisar</p></div>}{data.suggestions_next_cursor && <div className="border-t border-slate-100 p-3 text-center"><button type="button" disabled={Boolean(pending)} onClick={() => void loadMoreSuggestions()} className="min-h-10 rounded-xl border border-slate-200 px-4 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50">{pending === 'suggestions:more' ? 'Cargando…' : 'Mostrar más sugerencias'}</button></div>}
    </section>

    {data.completed_items.length > 0 && <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><header className="flex items-center justify-between border-b border-slate-100 bg-emerald-50/40 px-4 py-3 sm:px-5"><div><h3 className="text-sm font-black text-slate-800">Terminadas hoy</h3><p className="mt-0.5 text-[10px] font-semibold text-slate-400">Siguen en su lista original y salen de tu foco abierto</p></div><span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-black text-emerald-700">{data.completed_items.length}</span></header><div className="divide-y divide-slate-100">{data.completed_items.map(item => <TaskMyWorkCompletedRow key={item.task.id} item={item} pending={Boolean(pending)} onOpen={onOpen} onRemove={task => void runMutation('remove', task)} />)}</div></section>}
    <div className="flex items-center justify-center gap-2 px-4 text-center text-[10px] font-semibold text-slate-400"><CalendarClock className="h-3.5 w-3.5" />Al comenzar un nuevo día tu foco queda vacío; lo inconcluso se sugerirá para que decidas de nuevo.</div>
    <TaskMyWorkTaskPicker open={pickerOpen} excludedIDs={existingIDs} onClose={() => setPickerOpen(false)} onAdd={task => runMutation('add', task)} />
  </div>
}
