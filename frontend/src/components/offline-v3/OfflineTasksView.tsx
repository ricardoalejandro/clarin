import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ChevronDown, ListChecks, Loader2, Plus, RefreshCw } from 'lucide-react'
import type { OfflineDataGateway } from '@/offline-v3/gateway'
import type { OfflineTask, OfflineTaskList, SyncStatus } from '@/offline-v3/types'
import type { TaskCompleteInput, TaskCreateInput } from '@/offline-v3/types'
import { operationErrorMessage, operationOutcomeIsUnknown } from '@/offline-v3/operationAttempt'
import { offlineTaskCanComplete } from '@/offline-v3/taskReadModel'
import OfflineTaskCard from './OfflineTaskCard'

type Props = {
  gateway: OfflineDataGateway
  canCreate: boolean
  canComplete: boolean
  onSync: (sync: SyncStatus) => void
  refreshToken?: string
}

export default function OfflineTasksView(props: Props) {
  const scope = useRef({ gateway: props.gateway, generation: 0 })
  if (scope.current.gateway !== props.gateway) scope.current = { gateway: props.gateway, generation: scope.current.generation + 1 }
  // No loaded row, draft, retry ID or completion may survive an identity's
  // gateway. The runtime also remounts on the authoritative profile epoch.
  return <OfflineTasksSession key={scope.current.generation} {...props} />
}

function OfflineTasksSession({ gateway, canCreate, canComplete, onSync, refreshToken = '' }: Props) {
  const [lists, setLists] = useState<OfflineTaskList[]>([])
  const [selectionId, setSelectionId] = useState('')
  const [tasks, setTasks] = useState<OfflineTask[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [creating, setCreating] = useState(false)
  const [completing, setCompleting] = useState('')
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium')
  const [dueDate, setDueDate] = useState('')
  const [createAttempt, setCreateAttempt] = useState<TaskCreateInput | null>(null)
  const [completeAttempts, setCompleteAttempts] = useState<Record<string, TaskCompleteInput>>({})
  const [error, setError] = useState('')
  const loadedSelectionRef = useRef('')
  const alive = useRef(true)
  const scope = useRef({ selectionId, generation: 0 })
  const mutationRevision = useRef(0)
  if (scope.current.selectionId !== selectionId) scope.current = { selectionId, generation: scope.current.generation + 1 }
  const currentScope = (generation: number) => alive.current && scope.current.generation === generation

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  useEffect(() => {
    let active = true
    void gateway.taskLists().then(page => {
      if (!active) return
      setLists(page.items)
      setSelectionId(current => !current ? page.items[0]?.selection_id || '' : page.items.some(item => item.selection_id === current) ? current : '')
    }).catch(requestError => {
      if (active) setError((requestError as Error).message)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [gateway, refreshToken])

  useEffect(() => {
    if (!selectionId) {
      setTasks([])
      setNextCursor(undefined)
      loadedSelectionRef.current = ''
      return
    }
    let active = true
    const revision = mutationRevision.current
    // A completed background sync reconciles the visible page silently. The
    // creation draft and any ambiguity-safe operation IDs live outside this
    // collection and must not be reset or hidden behind a skeleton.
    const background = loadedSelectionRef.current === selectionId && Boolean(refreshToken)
    if (!background) { setLoading(true); setTasks([]); setNextCursor(undefined) }
    setError('')
    void gateway.tasks(selectionId).then(page => {
      if (!active || revision !== mutationRevision.current) return
      setTasks(page.items)
      setNextCursor(page.next_cursor)
      loadedSelectionRef.current = selectionId
    }).catch(requestError => {
      if (active) setError((requestError as Error).message)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [gateway, refreshToken, selectionId])

  useEffect(() => { setCompleting(''); setLoadingMore(false) }, [selectionId])

  const currentList = useMemo(() => lists.find(item => item.selection_id === selectionId), [lists, selectionId])

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    const generation = scope.current.generation
    const revision = mutationRevision.current
    setLoadingMore(true)
    try {
      const page = await gateway.tasks(selectionId, nextCursor)
      if (!currentScope(generation) || revision !== mutationRevision.current) return
      setTasks(current => [...current, ...page.items.filter(item => !current.some(existing => existing.id === item.id))])
      setNextCursor(page.next_cursor)
    } catch (requestError) {
      if (currentScope(generation)) setError((requestError as Error).message)
    } finally {
      if (currentScope(generation)) setLoadingMore(false)
    }
  }

  async function createTask(event: React.FormEvent) {
    event.preventDefault()
    const normalized = title.trim()
    if (!canCreate || currentList?.can_create !== true || !normalized || !selectionId || creating) return
    const generation = scope.current.generation
    mutationRevision.current += 1
    setCreating(true)
    setError('')
    try {
      const dueAt = dueDate ? new Date(`${dueDate}T23:59:59`).toISOString() : null
      const input = createAttempt || {
        operation_id: crypto.randomUUID(),
        selection_id: selectionId,
        task_id: crypto.randomUUID(),
        client_occurred_at: new Date().toISOString(),
        patch: { title: normalized, description: '', start_at: null, due_at: dueAt, due_end_at: null, is_all_day: Boolean(dueAt), priority },
      }
      setCreateAttempt(input)
      const result = await gateway.createTask(input)
      if (!currentScope(generation)) return
      mutationRevision.current += 1
      setTasks(current => [result.local_task, ...current.filter(item => item.id !== result.local_task.id)])
      onSync(result.sync)
      setTitle('')
      setDueDate('')
      setPriority('medium')
      setCreateAttempt(null)
    } catch (requestError) {
      if (!currentScope(generation)) return
      if (!operationOutcomeIsUnknown(requestError)) setCreateAttempt(null)
      setError(operationErrorMessage(requestError))
    } finally {
      if (currentScope(generation)) setCreating(false)
    }
  }

  async function completeTask(task: OfflineTask) {
    if (!offlineTaskCanComplete(task, canComplete) || completing) return
    const generation = scope.current.generation
    mutationRevision.current += 1
    setCompleting(task.id)
    setError('')
    try {
      const input = completeAttempts[task.id] || {
        operation_id: crypto.randomUUID(),
        selection_id: selectionId,
        base_version: task.version,
        client_occurred_at: new Date().toISOString(),
      }
      setCompleteAttempts(current => ({ ...current, [task.id]: input }))
      const result = await gateway.completeTask(task.id, input)
      if (!currentScope(generation)) return
      mutationRevision.current += 1
      setTasks(current => current.map(item => item.id === task.id ? result.local_task : item))
      onSync(result.sync)
      setCompleteAttempts(current => {
        const next = { ...current }
        delete next[task.id]
        return next
      })
    } catch (requestError) {
      if (!currentScope(generation)) return
      if (!operationOutcomeIsUnknown(requestError)) {
        setCompleteAttempts(current => {
          const next = { ...current }
          delete next[task.id]
          return next
        })
      }
      setError(operationErrorMessage(requestError))
    } finally {
      if (currentScope(generation)) setCompleting('')
    }
  }

  return (
    <section className="offline-module" aria-labelledby="offline-tasks-title">
      <header className="offline-module__header">
        <div><p className="offline-eyebrow">Clarin Work</p><h1 id="offline-tasks-title">Tareas disponibles</h1><p>Solo puedes leer, crear y completar dentro de las listas autorizadas.</p></div>
        {lists.length > 0 && <label className="offline-select"><span>Lista</span><span className="offline-select__control"><select value={selectionId} onChange={event => setSelectionId(event.target.value)} disabled={Boolean(createAttempt)}>{lists.map(list => <option key={list.selection_id} value={list.selection_id}>{list.environment_name} · {list.name}</option>)}</select><ChevronDown /></span></label>}
      </header>

      {canCreate && currentList?.can_create === true && selectionId && <form className="offline-task-create" onSubmit={createTask}>
        <div className="offline-task-create__title"><Plus /><input value={title} onChange={event => setTitle(event.target.value)} placeholder={`Nueva tarea en ${currentList?.name || 'la lista'}`} maxLength={300} disabled={Boolean(createAttempt)} /></div>
        <select aria-label="Prioridad" value={priority} onChange={event => setPriority(event.target.value as typeof priority)} disabled={Boolean(createAttempt)}><option value="low">Prioridad baja</option><option value="medium">Prioridad media</option><option value="high">Prioridad alta</option></select>
        <input aria-label="Fecha límite" type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} disabled={Boolean(createAttempt)} />
        <button className="offline-button offline-button--primary" disabled={!title.trim() || creating}>{creating ? <Loader2 className="spin" /> : <Plus />}{createAttempt ? 'Reintentar sin duplicar' : 'Crear localmente'}</button>
      </form>}

      {error && <div className="offline-alert offline-alert--error" role="alert"><AlertCircle />{error}</div>}
      {loading ? <div className="offline-loading"><Loader2 className="spin" />Cargando copia protegida…</div> : !selectionId ? <div className="offline-empty"><ListChecks /><h2>No hay listas preparadas</h2><p>Una lista autorizada debe terminar de sincronizarse antes de aparecer aquí.</p></div> : tasks.length === 0 ? loadedSelectionRef.current === selectionId ? <div className="offline-empty"><ListChecks /><h2>La lista está disponible y no contiene tareas</h2><p>Este vacío proviene de una copia preparada; no de un error de descarga.</p></div> : <div className="offline-empty"><ListChecks /><h2>No se pudo abrir la copia de esta lista</h2><p>No se ha confirmado que la lista esté vacía.</p></div> : <div className="offline-task-list">{tasks.map(task => <OfflineTaskCard key={task.id} task={task} canComplete={canComplete} completing={completing === task.id} onComplete={() => void completeTask(task)} />)}</div>}
      {nextCursor && <button type="button" className="offline-button offline-button--secondary offline-load-more" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? <Loader2 className="spin" /> : <RefreshCw />}Cargar más</button>}
    </section>
  )
}
