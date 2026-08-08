'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Circle, ListTodo, Loader2, Plus, RefreshCw } from 'lucide-react'
import { apiGet, subscribeWebSocket } from '@/lib/api'
import type { RelatedTaskScope } from '@/types/crm-detail'
import type { Task, TaskEnvironment, TaskFolder, TaskList, TaskWorkflow } from '@/types/task'
import TaskDetailDrawer from './TaskDetailDrawer'
import TaskEditorModal, { type TaskAccountUser } from './TaskEditorModal'

type Props = {
  scope: RelatedTaskScope
  title?: string
  readOnly?: boolean
  embedded?: boolean
  onCountChange?: (count: number) => void
}

type TaskResponse = { tasks: Task[]; total?: number; next_cursor?: string }
type TaskMetadata = {
  environmentId: string
  folders: TaskFolder[]
  lists: TaskList[]
  workflows: TaskWorkflow[]
  users: TaskAccountUser[]
  currentUserId: string
  storageScope: string
}

export function relatedTaskScopeKey(scope: RelatedTaskScope) {
  return `${scope.contactId || ''}:${scope.leadId || ''}:${scope.eventId || ''}`
}

export function relatedTaskQuery(scope: RelatedTaskScope, includeClosed = true, cursor?: string) {
  const params = new URLSearchParams({ limit: '50', include_closed: String(includeClosed) })
  if (scope.contactId) params.set('contact_id', scope.contactId)
  if (scope.leadId) params.set('lead_id', scope.leadId)
  if (scope.eventId) params.set('event_id', scope.eventId)
  if (cursor) params.set('cursor', cursor)
  return `/api/tasks?${params.toString()}`
}

function isClosed(task: Task) {
  const category = task.status_detail?.category
  return category === 'done' || category === 'cancelled' || task.status === 'completed' || task.status === 'cancelled'
}

export default function RelatedTasksPanel({ scope, title = 'Tareas relacionadas', readOnly = false, embedded = false, onCountChange }: Props) {
  const scopeKey = relatedTaskScopeKey(scope)
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [nextCursor, setNextCursor] = useState('')
  const [error, setError] = useState('')
  const [showClosed, setShowClosed] = useState(false)
  const [metadata, setMetadata] = useState<TaskMetadata | null>(null)
  const [metadataLoading, setMetadataLoading] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const requestRef = useRef(0)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const load = useCallback(async (silent = false, cursor = '') => {
    const request = ++requestRef.current
    if (cursor) setLoadingMore(true)
    else if (silent) setRefreshing(true)
    else setLoading(true)
    setError('')
    const result = await apiGet<TaskResponse>(relatedTaskQuery(scope, true, cursor))
    if (request !== requestRef.current) return
    if (!result.success) setError(result.error || 'No se pudieron cargar las tareas relacionadas.')
    else {
      const page = Array.isArray(result.data?.tasks) ? result.data.tasks : []
      const next = cursor ? [...tasks, ...page.filter(task => !tasks.some(existing => existing.id === task.id))] : page
      setTasks(next)
      setNextCursor(result.data?.next_cursor || '')
      onCountChange?.(next.filter(task => !isClosed(task)).length)
    }
    setLoading(false)
    setRefreshing(false)
    setLoadingMore(false)
  }, [onCountChange, scope, tasks])

  useEffect(() => {
    requestRef.current += 1
    setTasks([])
    setNextCursor('')
    setMetadata(null)
    setSelectedTaskId(null)
    setEditorOpen(false)
    setEditingTask(null)
    void load()
    // The stable scope key deliberately controls entity switching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  useEffect(() => subscribeWebSocket(message => {
    if (!message || typeof message !== 'object') return
    const event = (message as { event?: string }).event || ''
    if (event.startsWith('task_')) void load(true)
  }), [load])

  const ensureMetadata = useCallback(async (environmentId?: string) => {
    if (metadata && (!environmentId || metadata.environmentId === environmentId)) return metadata
    setMetadataLoading(true)
    setError('')
    const [environmentResult, userResult, meResult] = await Promise.all([
      apiGet<{ environments: TaskEnvironment[] }>('/api/tasks/environments?limit=50'),
      apiGet<{ users: TaskAccountUser[] }>('/api/account/users'),
      apiGet<{ user: { id: string; account_id: string } }>('/api/me'),
    ])
    if (!environmentResult.success || !userResult.success || !meResult.success) {
      setMetadataLoading(false)
      setError(environmentResult.error || userResult.error || meResult.error || 'No se pudo preparar Clarin Work.')
      return null
    }
    const environments = environmentResult.data?.environments || []
    let environment = environments.find(item => item.id === environmentId)
    if (environmentId && !environment) {
      const requested = await apiGet<{ environment: TaskEnvironment }>(`/api/tasks/environments/${encodeURIComponent(environmentId)}`)
      if (requested.success) environment = requested.data?.environment
    }
    environment ||= environments.find(item => item.is_default) || environments[0]
    if (!environment) {
      setMetadataLoading(false)
      setError('No hay un Entorno de trabajo accesible para esta cuenta.')
      return null
    }
    const [hierarchyResult, workflowResult] = await Promise.all([
      apiGet<{ folders: TaskFolder[]; root_lists: TaskList[] }>(`/api/tasks/environments/${encodeURIComponent(environment.id)}/hierarchy`),
      apiGet<{ workflows: TaskWorkflow[] }>(`/api/tasks/workflows?environment_id=${encodeURIComponent(environment.id)}`),
    ])
    if (!hierarchyResult.success || !workflowResult.success) {
      setMetadataLoading(false)
      setError(hierarchyResult.error || workflowResult.error || 'No se pudo preparar la jerarquía de tareas.')
      return null
    }
    const folders = hierarchyResult.data?.folders || []
    const lists = [...(hierarchyResult.data?.root_lists || []), ...folders.flatMap(folder => folder.lists || [])]
    const next: TaskMetadata = {
      environmentId: environment.id,
      folders,
      lists,
      workflows: workflowResult.data?.workflows || [],
      users: userResult.data?.users || [],
      currentUserId: meResult.data?.user?.id || '',
      storageScope: `${meResult.data?.user?.account_id || 'account'}:${meResult.data?.user?.id || 'user'}:crm-related`,
    }
    setMetadata(next)
    setMetadataLoading(false)
    return next
  }, [metadata])

  const openCreate = async (trigger: HTMLButtonElement) => {
    triggerRef.current = trigger
    const ready = await ensureMetadata()
    if (ready) { setEditingTask(null); setEditorOpen(true) }
  }

  const openTask = async (task: Task, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger
    const ready = await ensureMetadata(task.environment_id)
    if (ready) setSelectedTaskId(task.id)
  }

  const closeChild = () => {
    setSelectedTaskId(null)
    setEditorOpen(false)
    setEditingTask(null)
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }

  const openTasks = useMemo(() => tasks.filter(task => !isClosed(task)), [tasks])
  const closedTasks = useMemo(() => tasks.filter(isClosed), [tasks])
  const visible = showClosed ? [...openTasks, ...closedTasks] : openTasks

  return (
    <section data-related-tasks-panel className={embedded ? 'scroll-mt-24' : 'scroll-mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm'} aria-labelledby={`related-tasks-${scopeKey}`}>
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 id={`related-tasks-${scopeKey}`} className="flex items-center gap-2 text-sm font-bold text-slate-900"><ListTodo className="h-4 w-4 text-emerald-600" />{title}</h3><p className="mt-1 text-xs text-slate-500">{openTasks.length} abierta{openTasks.length === 1 ? '' : 's'} · {closedTasks.length} finalizada{closedTasks.length === 1 ? '' : 's'}</p></div>{!readOnly && <button data-related-task-add type="button" onClick={event => { void openCreate(event.currentTarget) }} disabled={metadataLoading} className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl bg-emerald-600 px-3 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50">{metadataLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}Nueva tarea</button>}</div>
      {refreshing && <p role="status" className="mt-2 flex items-center gap-1.5 text-[10px] font-semibold text-emerald-700"><Loader2 className="h-3 w-3 animate-spin" />Actualizando sin interrumpir la vista…</p>}
      {error && <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 flex-1">{error}</span><button type="button" onClick={() => void load()} aria-label="Reintentar tareas" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg hover:bg-red-100"><RefreshCw className="h-4 w-4" /></button></div>}
      {loading ? <div className="flex min-h-24 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-emerald-600" /></div> : visible.length ? <div className="mt-3 space-y-2">{visible.map(task => <button key={task.id} type="button" onClick={event => { void openTask(task, event.currentTarget) }} className="group flex min-h-12 w-full items-center gap-3 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2 text-left transition hover:border-emerald-200 hover:bg-emerald-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">{isClosed(task) ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" /> : <Circle className="h-4 w-4 shrink-0 text-slate-300 group-hover:text-emerald-500" />}<span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold text-slate-800">{task.title}</span><span className="mt-0.5 block truncate text-[10px] text-slate-400">{task.list_name || 'Lista de tareas'}{task.assigned_to_name ? ` · ${task.assigned_to_name}` : ''}</span></span></button>)}</div> : <p className="mt-3 rounded-xl border border-dashed border-slate-200 px-3 py-6 text-center text-xs text-slate-400">No hay tareas abiertas relacionadas.</p>}
      {closedTasks.length > 0 && <button type="button" onClick={() => setShowClosed(value => !value)} aria-expanded={showClosed} className="mt-3 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl text-xs font-bold text-slate-500 hover:bg-slate-50">{showClosed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}{showClosed ? 'Ocultar finalizadas' : `Ver ${closedTasks.length} finalizada${closedTasks.length === 1 ? '' : 's'}`}</button>}
      {nextCursor && <button type="button" onClick={() => void load(false, nextCursor)} disabled={loadingMore} className="mt-2 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50">{loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}{loadingMore ? 'Cargando…' : 'Cargar más tareas'}</button>}

      {metadata && <>
        <TaskEditorModal open={editorOpen} environmentId={metadata.environmentId} task={editingTask} defaultListId={metadata.lists.find(list => list.is_default)?.id || metadata.lists[0]?.id} defaultOwnerId={metadata.currentUserId} lists={metadata.lists} folders={metadata.folders} workflows={metadata.workflows} users={metadata.users} relatedScope={scope} storageScope={metadata.storageScope} onClose={closeChild} onSaved={(saved) => { setTasks(current => [saved, ...current.filter(task => task.id !== saved.id)]); void load(true) }} />
        <TaskDetailDrawer taskId={selectedTaskId} allTasks={tasks} users={metadata.users} lists={metadata.lists} folders={metadata.folders} workflows={metadata.workflows} storageScope={metadata.storageScope} onClose={closeChild} onEdit={task => { setSelectedTaskId(null); setEditingTask(task); setEditorOpen(true) }} onOpenTask={setSelectedTaskId} onCreateSubtask={task => { setSelectedTaskId(null); setError(`Abre la tarea “${task.title}” en Clarin Work para crear una subtarea en su lista real.`) }} onChanged={(changed) => { if (changed) setTasks(current => current.map(task => task.id === changed.id ? changed : task)); void load(true) }} onDeleted={(id) => { setTasks(current => current.filter(task => task.id !== id)); setSelectedTaskId(null); void load(true); return true }} />
      </>}
    </section>
  )
}
