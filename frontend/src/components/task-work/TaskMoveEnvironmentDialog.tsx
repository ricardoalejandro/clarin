'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowRight, ArrowRightLeft, Check, FolderInput, Loader2, LockKeyhole, Search, ShieldAlert, X } from 'lucide-react'
import { apiGet, apiPost } from '@/lib/api'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import type { Task, TaskEnvironment, TaskFolder, TaskList } from '@/types/task'
import { TaskContainerIcon } from './TaskContainerAppearance'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import { environmentFolderQuery, environmentListQuery, environmentTaskListQuery, taskAccessLabel } from './taskEnvironmentAccess'
import { taskMoveConfirmationLabel, taskMoveNeedsAccessConfirmation, type TaskMoveConflict } from './taskEnvironmentMove'

type EnvironmentResponse = { environments: TaskEnvironment[]; next_cursor?: string }
type ListResponse = { lists: TaskList[]; next_cursor?: string }
type FolderResponse = { folders: TaskFolder[]; next_cursor?: string }
type MoveResponse = TaskMoveConflict & { task?: Task; operation_id?: string }

interface Props {
  open: boolean
  task: Task
  onClose: () => void
  onMoved: (task: Task, operationID?: string) => void
}

export default function TaskMoveEnvironmentDialog({ open, task, onClose, onMoved }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const movingRef = useRef(false)
  const onCloseRef = useRef(onClose)
  const searchAbortRef = useRef<AbortController | null>(null)
  const listAbortRef = useRef<AbortController | null>(null)
  const folderAbortRef = useRef<AbortController | null>(null)
  const environmentScrollRef = useRef<HTMLDivElement>(null)
  const listScrollRef = useRef<HTMLDivElement>(null)
  const environmentRequestRef = useRef(0)
  const listRequestRef = useRef(0)
  const folderRequestRef = useRef(0)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useDebouncedValue(query)
  const [listQuery, setListQuery] = useState('')
  const [debouncedListQuery, setDebouncedListQuery] = useDebouncedValue(listQuery)
  const [environments, setEnvironments] = useState<TaskEnvironment[]>([])
  const [nextCursor, setNextCursor] = useState('')
  const [selectedEnvironmentID, setSelectedEnvironmentID] = useState('')
  const [lists, setLists] = useState<TaskList[]>([])
  const [folders, setFolders] = useState<TaskFolder[]>([])
  const [listNextCursor, setListNextCursor] = useState('')
  const [folderNextCursor, setFolderNextCursor] = useState('')
  const [targetListID, setTargetListID] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [listLoading, setListLoading] = useState(false)
  const [listLoadingMore, setListLoadingMore] = useState(false)
  const [folderLoadingMore, setFolderLoadingMore] = useState(false)
  const [listError, setListError] = useState('')
  const [moving, setMoving] = useState(false)
  const [affectedUserIDs, setAffectedUserIDs] = useState<string[]>([])
  const [error, setError] = useState('')

  movingRef.current = moving
  onCloseRef.current = onClose

  const loadEnvironments = useCallback(async (search: string, cursor = '', append = false) => {
    searchAbortRef.current?.abort()
    const controller = new AbortController()
    searchAbortRef.current = controller
    const request = ++environmentRequestRef.current
    append ? setLoadingMore(true) : setLoading(true)
    setError('')
    const result = await apiGet<EnvironmentResponse>(`/api/tasks/environments?${environmentListQuery(search, cursor)}`, { signal: controller.signal })
    if (controller.signal.aborted || request !== environmentRequestRef.current) return
    setLoading(false)
    setLoadingMore(false)
    if (!result.success) {
      setError(result.error || 'No se pudieron cargar los Entornos de destino.')
      return
    }
    const eligible = (result.data?.environments || []).filter(environment =>
      environment.id !== task.environment_id && !environment.archived_at && environment.permissions?.can_edit === true,
    )
    setEnvironments(current => append
      ? Array.from(new Map([...current, ...eligible].map(item => [item.id, item])).values())
      : eligible)
    setNextCursor(result.data?.next_cursor || '')
  }, [task.environment_id])

  const loadLists = useCallback(async (environmentID: string, search: string, cursor = '', append = false) => {
    listAbortRef.current?.abort()
    const controller = new AbortController()
    listAbortRef.current = controller
    const request = ++listRequestRef.current
    append ? setListLoadingMore(true) : setListLoading(true)
    setListError('')
    const result = await apiGet<ListResponse>(`/api/tasks/environments/${encodeURIComponent(environmentID)}/lists?${environmentTaskListQuery(search, cursor)}`, { signal: controller.signal })
    if (controller.signal.aborted || request !== listRequestRef.current) return
    setListLoading(false)
    setListLoadingMore(false)
    if (!result.success) {
      setListError(result.error || 'No se pudieron cargar las listas del Entorno.')
      return
    }
    const eligible = (result.data?.lists || []).filter(list => list.permissions?.can_edit === true)
    setLists(current => {
      const next = append
        ? Array.from(new Map([...current, ...eligible].map(item => [item.id, item])).values())
        : eligible
      setTargetListID(selected => selected && next.some(list => list.id === selected)
        ? selected
        : next.find(list => list.is_default)?.id || next[0]?.id || '')
      return next
    })
    setListNextCursor(result.data?.next_cursor || '')
  }, [])

  const loadFolders = useCallback(async (environmentID: string, cursor = '', append = false) => {
    folderAbortRef.current?.abort()
    const controller = new AbortController()
    folderAbortRef.current = controller
    const request = ++folderRequestRef.current
    if (append) setFolderLoadingMore(true)
    const result = await apiGet<FolderResponse>(`/api/tasks/environments/${encodeURIComponent(environmentID)}/folders?${environmentFolderQuery('', cursor, 200)}`, { signal: controller.signal })
    if (controller.signal.aborted || request !== folderRequestRef.current) return
    setFolderLoadingMore(false)
    if (!result.success) return
    const received = result.data?.folders || []
    setFolders(current => append
      ? Array.from(new Map([...current, ...received].map(item => [item.id, item])).values())
      : received)
    setFolderNextCursor(result.data?.next_cursor || '')
  }, [])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setDebouncedQuery('')
    setEnvironments([])
    setNextCursor('')
    setSelectedEnvironmentID('')
    setListQuery('')
    setDebouncedListQuery('')
    setLists([])
    setFolders([])
    setListNextCursor('')
    setFolderNextCursor('')
    setTargetListID('')
    setAffectedUserIDs([])
    setError('')
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => dialogRef.current?.focus({ preventScroll: true }))
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !movingRef.current) {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])'))
      if (!focusable.length) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', keydown)
      searchAbortRef.current?.abort()
      listAbortRef.current?.abort()
      folderAbortRef.current?.abort()
      previousFocus?.focus({ preventScroll: true })
    }
  }, [loadEnvironments, open, setDebouncedListQuery, setDebouncedQuery])

  useEffect(() => {
    if (open) void loadEnvironments(debouncedQuery)
  }, [debouncedQuery, loadEnvironments, open])

  useEffect(() => {
    if (!selectedEnvironmentID) return
    setListQuery('')
    setDebouncedListQuery('')
    setLists([])
    setFolders([])
    setListNextCursor('')
    setFolderNextCursor('')
    setTargetListID('')
    setListError('')
  }, [selectedEnvironmentID, setDebouncedListQuery])

  useEffect(() => {
    if (!open || !selectedEnvironmentID) return
    void loadLists(selectedEnvironmentID, debouncedListQuery)
  }, [debouncedListQuery, loadLists, open, selectedEnvironmentID])

  useEffect(() => {
    if (!open || !selectedEnvironmentID) return
    void loadFolders(selectedEnvironmentID)
  }, [loadFolders, open, selectedEnvironmentID])

  const selectedEnvironment = environments.find(environment => environment.id === selectedEnvironmentID)
  const folderByID = useMemo(() => new Map(folders.map(folder => [folder.id, folder])), [folders])
  const environmentVirtualizer = useVirtualizer({
    count: environments.length,
    getScrollElement: () => environmentScrollRef.current,
    estimateSize: () => 60,
    overscan: 8,
  })
  const listVirtualizer = useVirtualizer({
    count: lists.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => 52,
    overscan: 10,
  })

  const move = async (confirmGrants = false) => {
    if (!targetListID || moving) return
    setMoving(true)
    setError('')
    const operationID = crypto.randomUUID()
    const result = await apiPost<MoveResponse>(`/api/tasks/${task.id}/move`, {
      target_list_id: targetListID,
      version: task.version,
      operation_id: operationID,
      confirm_grants: confirmGrants,
    })
    setMoving(false)
    if (!result.success) {
      if (taskMoveNeedsAccessConfirmation(result.status, result.data)) {
        setAffectedUserIDs(result.data?.affected_user_ids || [])
        return
      }
      setError(result.status === 409 ? 'La tarea o el destino cambiaron en otra sesión. Reabre el selector para trabajar con la versión actual.' : result.error || 'No se pudo mover la tarea.')
      return
    }
    if (!result.data?.task) {
      setError('El servidor confirmó el movimiento sin devolver la tarea canónica.')
      return
    }
    onMoved(result.data.task, result.data.operation_id || operationID)
  }

  if (!open || typeof document === 'undefined') return null
  return createPortal(<div className="fixed inset-0 flex items-center justify-center bg-slate-950/55 p-3 backdrop-blur-sm sm:p-6" style={{ zIndex: TASK_OVERLAY_LAYERS.dialog }} onMouseDown={event => { if (event.target === event.currentTarget && !moving) onClose() }}>
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="move-environment-title" className="flex max-h-[min(820px,calc(100vh-24px))] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-white/70 bg-white shadow-2xl outline-none">
      <header className="flex shrink-0 items-start gap-3 border-b border-slate-100 px-5 py-4 sm:px-6"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-violet-50 text-violet-700"><FolderInput className="h-5 w-5" /></span><div className="min-w-0 flex-1"><p className="text-[10px] font-black uppercase tracking-[.16em] text-violet-600">Mover entre Entornos</p><h2 id="move-environment-title" className="mt-1 truncate text-lg font-black text-slate-900">{task.title}</h2><p className="mt-1 text-xs leading-5 text-slate-400">Se moverán la tarea principal y sus subtareas; el estado se remapeará por categoría.</p></div><button type="button" disabled={moving} aria-label="Cerrar" onClick={onClose} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 disabled:opacity-40"><X className="h-5 w-5" /></button></header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section>
            <div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-black uppercase tracking-[.14em] text-slate-400">1. Entorno de destino</h3>{loading && <Loader2 className="h-4 w-4 animate-spin text-violet-600" />}</div>
            <div className="relative"><Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value) setDebouncedQuery('') }} placeholder="Buscar Entornos…" className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-10 text-sm outline-none focus:border-violet-300 focus:bg-white focus:ring-4 focus:ring-violet-100" />{query.trim() !== debouncedQuery.trim() && <Loader2 className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-violet-600" />}</div>
            <div ref={environmentScrollRef} className="mt-2 max-h-72 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-1.5">
              <div style={{ height: environmentVirtualizer.getTotalSize(), position: 'relative' }}>{environmentVirtualizer.getVirtualItems().map(row => {
                const environment = environments[row.index]
                return <div key={environment.id} ref={environmentVirtualizer.measureElement} data-index={row.index} style={{ position: 'absolute', left: 0, top: 0, width: '100%', transform: `translateY(${row.start}px)` }}><button type="button" onClick={() => setSelectedEnvironmentID(environment.id)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ${selectedEnvironmentID === environment.id ? 'bg-violet-50 ring-1 ring-violet-100' : 'hover:bg-slate-50'}`}><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white" style={{ backgroundColor: environment.color }}><TaskContainerIcon value={environment.icon} className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-slate-700">{environment.name}</span><span className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-400">{environment.visibility === 'restricted' && <LockKeyhole className="h-3 w-3" />}{environment.visibility === 'restricted' ? 'Privado' : 'Cuenta'} · {taskAccessLabel(environment.permissions?.level)}</span></span>{selectedEnvironmentID === environment.id && <Check className="h-4 w-4 text-violet-600" />}</button></div>
              })}</div>
              {!loading && !environments.length && <div className="py-10 text-center"><ArrowRightLeft className="mx-auto h-6 w-6 text-slate-300" /><p className="mt-2 text-xs leading-5 text-slate-400">No hay otro Entorno editable disponible.</p></div>}
              {nextCursor && <button type="button" disabled={loadingMore} onClick={() => void loadEnvironments(debouncedQuery, nextCursor, true)} className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-bold text-slate-500 hover:bg-slate-50">{loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Cargar más</button>}
            </div>
          </section>
          <section>
            <div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-black uppercase tracking-[.14em] text-slate-400">2. Lista concreta</h3>{listLoading && <Loader2 className="h-4 w-4 animate-spin text-violet-600" />}</div>
            {!selectedEnvironment ? <div className="flex min-h-60 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 p-6 text-center"><ArrowRight className="h-6 w-6 text-slate-300" /><p className="mt-2 text-xs leading-5 text-slate-400">Selecciona primero el Entorno de destino.</p></div> : <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
              <div className="mb-3 flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl text-white" style={{ backgroundColor: selectedEnvironment.color }}><TaskContainerIcon value={selectedEnvironment.icon} className="h-4 w-4" /></span><div className="min-w-0"><p className="truncate text-sm font-black text-slate-800">{selectedEnvironment.name}</p><p className="text-[10px] text-slate-400">{lists.length} lista{lists.length === 1 ? '' : 's'} cargada{lists.length === 1 ? '' : 's'}</p></div></div>
              <div className="relative"><Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" /><input value={listQuery} onChange={event => { setListQuery(event.target.value); if (!event.target.value) setDebouncedListQuery('') }} placeholder="Buscar una lista…" className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-9 text-sm outline-none focus:border-violet-300 focus:ring-4 focus:ring-violet-100" />{listQuery.trim() !== debouncedListQuery.trim() && <Loader2 aria-label="Esperando para buscar" className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-violet-600" />}</div>
              <div ref={listScrollRef} role="listbox" aria-label="Listas de destino" className="mt-2 max-h-60 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5">
                {listLoading && !lists.length && Array.from({ length: 4 }, (_, index) => <div key={index} className="h-11 animate-pulse rounded-lg bg-slate-100" />)}
                {!listLoading && <div style={{ height: listVirtualizer.getTotalSize(), position: 'relative' }}>{listVirtualizer.getVirtualItems().map(row => {
                  const list = lists[row.index]
                  const folder = list.folder_id ? folderByID.get(list.folder_id) : undefined
                  return <div key={list.id} ref={listVirtualizer.measureElement} data-index={row.index} style={{ position: 'absolute', left: 0, top: 0, width: '100%', transform: `translateY(${row.start}px)` }}><button type="button" role="option" aria-selected={targetListID === list.id} onClick={() => setTargetListID(list.id)} className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left ${targetListID === list.id ? 'bg-violet-50 text-violet-800 ring-1 ring-violet-100' : 'text-slate-600 hover:bg-slate-50'}`}><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ color: list.color, backgroundColor: `${list.color}18` }}><TaskContainerIcon value={list.icon} className="h-3.5 w-3.5" /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold">{list.name}</span><span className="mt-0.5 block truncate text-[9px] text-slate-400">{folder ? `${folder.name} / ${list.name}` : list.folder_id ? 'Dentro de una carpeta' : list.is_default ? 'Bandeja general' : 'Lista independiente'} · {taskAccessLabel(list.permissions?.level)}</span></span>{targetListID === list.id && <Check className="h-4 w-4 shrink-0 text-violet-600" />}</button></div>
                })}</div>}
                {!listLoading && !lists.length && !listError && <p className="px-3 py-8 text-center text-xs leading-5 text-slate-400">No hay listas editables que coincidan con la búsqueda.</p>}
                {listNextCursor && <button type="button" disabled={listLoadingMore} onClick={() => void loadLists(selectedEnvironment.id, debouncedListQuery, listNextCursor, true)} className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-bold text-violet-700 hover:bg-violet-50 disabled:opacity-50">{listLoadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Cargar más listas</button>}
                {folderNextCursor && <button type="button" disabled={folderLoadingMore} onClick={() => void loadFolders(selectedEnvironment.id, folderNextCursor, true)} className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-[10px] font-bold text-slate-500 hover:bg-slate-50 disabled:opacity-50">{folderLoadingMore && <Loader2 className="h-3 w-3 animate-spin" />}Cargar más nombres de carpeta</button>}
              </div>
              {listError && <div role="alert" className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700"><p>{listError}</p><button type="button" onClick={() => void loadLists(selectedEnvironment.id, debouncedListQuery)} className="mt-1 font-bold">Reintentar</button></div>}
            </div>}
          </section>
        </div>
        {affectedUserIDs.length > 0 && <div role="alert" className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4"><div className="flex gap-3"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" /><div><p className="text-sm font-black text-amber-900">Confirma la continuidad de acceso</p><p className="mt-1 text-xs leading-5 text-amber-800">{taskMoveConfirmationLabel(affectedUserIDs)} El servidor creará o preservará grants explícitos en la misma transacción; retirar después a un participante no revocará esos grants silenciosamente.</p></div></div></div>}
        {error && <div role="alert" className="mt-5 rounded-xl bg-rose-50 px-4 py-3 text-xs font-semibold text-rose-700">{error}</div>}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/80 px-5 py-4 sm:px-6"><button type="button" disabled={moving} onClick={onClose} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-white disabled:opacity-40">Cancelar</button><button type="button" disabled={moving || !targetListID} onClick={() => void move(affectedUserIDs.length > 0)} className="flex min-w-44 items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-black text-white shadow-lg shadow-slate-200 hover:bg-slate-800 disabled:opacity-35">{moving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderInput className="h-4 w-4" />}{affectedUserIDs.length ? 'Confirmar y mover' : 'Mover tarea'}</button></footer>
    </div>
  </div>, document.body)
}
