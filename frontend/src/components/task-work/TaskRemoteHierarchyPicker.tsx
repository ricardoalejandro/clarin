'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, ChevronDown, Layers3, Loader2, Search, X } from 'lucide-react'
import { apiGet } from '@/lib/api'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import type { TaskFolder, TaskList } from '@/types/task'
import { TaskContainerIcon } from './TaskContainerAppearance'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import { environmentFolderQuery, environmentTaskListQuery, taskAccessLabel } from './taskEnvironmentAccess'

type ListPage = { lists: TaskList[]; next_cursor?: string | null }
type FolderPage = { folders: TaskFolder[]; next_cursor?: string | null }

export function mergeTaskCatalogPage<T extends { id: string }>(current: T[], incoming: T[], reset = false) {
  return Array.from(new Map([...(reset ? [] : current), ...incoming].map(item => [item.id, item])).values())
}

function usePickerPosition(open: boolean, triggerRef: RefObject<HTMLButtonElement>) {
  const [style, setStyle] = useState<CSSProperties>({})
  useEffect(() => {
    if (!open) return
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(Math.max(320, rect.width), window.innerWidth - 24)
      const roomBelow = window.innerHeight - rect.bottom
      const above = roomBelow < 360 && rect.top > roomBelow
      setStyle({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        width,
        maxHeight: Math.min(430, Math.max(220, above ? rect.top - 18 : roomBelow - 18)),
        ...(above ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, triggerRef])
  return style
}

function PickerTrigger({ triggerRef, open, disabled, selected, placeholder, onClick, className = '' }: {
  triggerRef: RefObject<HTMLButtonElement>
  open: boolean
  disabled?: boolean
  selected?: { name: string; description?: string; color?: string; icon?: string }
  placeholder: string
  onClick: () => void
  className?: string
}) {
  return <button ref={triggerRef} type="button" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} onClick={onClick} className={`flex min-h-11 w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-sm outline-none transition hover:border-slate-300 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 disabled:opacity-50 ${className}`}>
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-50" style={{ color: selected?.color || '#64748b' }}>{selected ? <TaskContainerIcon value={selected.icon || 'list'} className="h-3.5 w-3.5" /> : <Search className="h-3.5 w-3.5" />}</span>
    <span className="min-w-0 flex-1"><span className={`block truncate font-semibold ${selected ? 'text-slate-700' : 'text-slate-400'}`}>{selected?.name || placeholder}</span>{selected?.description && <span className="block truncate text-[10px] text-slate-400">{selected.description}</span>}</span>
    <ChevronDown className={`h-4 w-4 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
  </button>
}

export function TaskRemoteListPicker({ environmentId, value, initialLists, initialFolders = [], selectedLabel, selectedDescription, onChange, onItemsLoaded, disabled, className }: {
  environmentId: string
  value: string
  initialLists: TaskList[]
  initialFolders?: TaskFolder[]
  selectedLabel?: string
  selectedDescription?: string
  onChange: (value: string, list?: TaskList) => void
  onItemsLoaded?: (lists: TaskList[], folders: TaskFolder[]) => void
  disabled?: boolean
  className?: string
}) {
  const authorizedInitialLists = useMemo(() => initialLists.filter(list => list.permissions?.can_edit === true), [initialLists])
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const listAbortRef = useRef<AbortController | null>(null)
  const folderAbortRef = useRef<AbortController | null>(null)
  const requestRef = useRef(0)
  const folderRequestRef = useRef(0)
  const onItemsLoadedRef = useRef(onItemsLoaded)
  const initialListsRef = useRef(authorizedInitialLists)
  const initialFoldersRef = useRef(initialFolders)
  const foldersRef = useRef(initialFolders)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useDebouncedValue(query)
  const [items, setItems] = useState<TaskList[]>(authorizedInitialLists)
  const [folders, setFolders] = useState<TaskFolder[]>(initialFolders)
  const [nextCursor, setNextCursor] = useState('')
  const [folderNextCursor, setFolderNextCursor] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [folderLoadingMore, setFolderLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [folderError, setFolderError] = useState('')
  const style = usePickerPosition(open, triggerRef)
  onItemsLoadedRef.current = onItemsLoaded
  initialListsRef.current = authorizedInitialLists
  initialFoldersRef.current = initialFolders
  foldersRef.current = folders

  useEffect(() => {
    if (!open) {
      setItems(current => mergeTaskCatalogPage(current, authorizedInitialLists))
      setFolders(current => mergeTaskCatalogPage(current, initialFolders))
    }
  }, [authorizedInitialLists, initialFolders, open])

  const loadFolders = useCallback(async (cursor = '', append = false) => {
    if (!environmentId) return
    folderAbortRef.current?.abort()
    const controller = new AbortController()
    folderAbortRef.current = controller
    const request = ++folderRequestRef.current
    if (append) setFolderLoadingMore(true)
    else {
      setFolderLoadingMore(false)
      setFolderNextCursor('')
    }
    setFolderError('')
    const result = await apiGet<FolderPage>(`/api/tasks/environments/${encodeURIComponent(environmentId)}/folders?${environmentFolderQuery('', cursor, 200)}`, { signal: controller.signal })
    if (controller.signal.aborted || request !== folderRequestRef.current) return
    setFolderLoadingMore(false)
    if (!result.success) {
      setFolderError(result.error || 'No se pudieron completar los nombres de carpeta.')
      return
    }
    const received = result.data?.folders || []
    setFolders(current => mergeTaskCatalogPage(append ? current : initialFoldersRef.current, received))
    onItemsLoadedRef.current?.([], received)
    setFolderNextCursor(result.data?.next_cursor || '')
  }, [environmentId])

  const loadLists = useCallback(async (search: string, cursor = '', append = false) => {
    if (!environmentId) return
    listAbortRef.current?.abort()
    const controller = new AbortController()
    listAbortRef.current = controller
    const request = ++requestRef.current
    append ? setLoadingMore(true) : setLoading(true)
    setError('')
    const result = await apiGet<ListPage>(`/api/tasks/environments/${encodeURIComponent(environmentId)}/lists?${environmentTaskListQuery(search, cursor)}`, { signal: controller.signal })
    if (controller.signal.aborted || request !== requestRef.current) return
    setLoading(false)
    setLoadingMore(false)
    if (!result.success) {
      setError(result.error || 'No se pudieron cargar las listas del Entorno.')
      return
    }
    const received = (result.data?.lists || []).filter(list => list.permissions?.can_edit === true)
    setItems(current => mergeTaskCatalogPage(search || append ? current : initialListsRef.current, received, !append && Boolean(search)))
    onItemsLoadedRef.current?.(received, foldersRef.current)
    setNextCursor(result.data?.next_cursor || '')
  }, [environmentId])

  useEffect(() => {
    if (!open) return
    void loadLists(debouncedQuery)
  }, [debouncedQuery, loadLists, open])

  useEffect(() => {
    if (!open) return
    void loadFolders()
  }, [loadFolders, open])

  useEffect(() => () => {
    listAbortRef.current?.abort()
    folderAbortRef.current?.abort()
  }, [])

  const folderByID = useMemo(() => new Map(folders.map(folder => [folder.id, folder])), [folders])
  const selectedList = items.find(list => list.id === value) || authorizedInitialLists.find(list => list.id === value)
  const selectedFolder = selectedList?.folder_id ? folderByID.get(selectedList.folder_id) : undefined
  const selected = selectedList ? {
    name: selectedList.name,
    description: selectedFolder ? `${selectedFolder.name} / ${selectedList.name}` : selectedList.is_default ? 'Bandeja general' : 'Lista independiente',
    color: selectedList.color,
    icon: selectedList.icon || (selectedList.is_default ? 'inbox' : 'list'),
  } : selectedLabel ? { name: selectedLabel, description: selectedDescription, icon: 'list' } : undefined
  const virtualizer = useVirtualizer({ count: items.length, getScrollElement: () => scrollRef.current, estimateSize: () => 58, overscan: 8 })

  const close = () => {
    listAbortRef.current?.abort()
    requestRef.current += 1
    setOpen(false)
    setQuery('')
    setDebouncedQuery('')
    setError('')
    setFolderError('')
    setFolderNextCursor('')
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }
  const choose = (list: TaskList) => {
    onChange(list.id, list)
    close()
  }

  return <>
    <PickerTrigger triggerRef={triggerRef} open={open} disabled={disabled || !environmentId} selected={selected} placeholder="Selecciona una lista" onClick={() => setOpen(current => !current)} className={className} />
    {open && typeof document !== 'undefined' && createPortal(<><button type="button" data-task-picker-backdrop aria-label="Cerrar selector de lista" className="fixed inset-0 cursor-default" style={{ zIndex: TASK_OVERLAY_LAYERS.pickerBackdrop }} onMouseDown={close} /><div ref={panelRef} role="listbox" aria-label="Seleccionar lista" tabIndex={-1} style={{ ...style, zIndex: TASK_OVERLAY_LAYERS.picker }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close() } }} className="fixed flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-900/15 outline-none">
      <div className="mb-1 flex shrink-0 items-center gap-2 rounded-xl bg-slate-50 px-3"><Search className="h-4 w-4 text-slate-400" /><input autoFocus value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value) setDebouncedQuery('') }} placeholder="Buscar listas…" className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none" />{query.trim() !== debouncedQuery.trim() && <Loader2 aria-label="Esperando para buscar" className="h-3.5 w-3.5 animate-spin text-emerald-500" />}{query && <button type="button" aria-label="Limpiar búsqueda" onClick={() => { setQuery(''); setDebouncedQuery('') }} className="text-slate-400"><X className="h-3.5 w-3.5" /></button>}</div>
      <div ref={scrollRef} className="min-h-[180px] flex-1 overflow-y-auto">
        {loading && !items.length ? <div className="space-y-1 p-1">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-12 animate-pulse rounded-xl bg-slate-100" />)}</div> : <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>{virtualizer.getVirtualItems().map(row => {
          const list = items[row.index]
          const folder = list.folder_id ? folderByID.get(list.folder_id) : undefined
          return <div key={list.id} ref={virtualizer.measureElement} data-index={row.index} style={{ position: 'absolute', left: 0, top: 0, width: '100%', transform: `translateY(${row.start}px)` }}><button type="button" role="option" aria-selected={list.id === value} onClick={() => choose(list)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ${list.id === value ? 'bg-emerald-50 ring-1 ring-emerald-100' : 'hover:bg-slate-50'}`}><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white shadow-sm" style={{ color: list.color }}><TaskContainerIcon value={list.icon || (list.is_default ? 'inbox' : 'list')} className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-700">{list.name}</span><span className="block truncate text-[10px] text-slate-400">{folder ? `${folder.name} / ${list.name}` : list.is_default ? 'Bandeja general' : list.folder_id ? 'Dentro de una carpeta' : 'Lista independiente'} · {taskAccessLabel(list.permissions?.level)}</span></span>{list.id === value && <Check className="h-4 w-4 shrink-0 text-emerald-600" />}</button></div>
        })}</div>}
        {!loading && !items.length && !error && <div className="p-8 text-center text-xs leading-5 text-slate-400">No hay listas editables que coincidan con la búsqueda.</div>}
        {error && <div role="alert" className="m-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700"><p>{error}</p><button type="button" onClick={() => void loadLists(debouncedQuery)} className="mt-1 font-bold underline">Reintentar</button></div>}
        {nextCursor && !error && <button type="button" disabled={loadingMore} onClick={() => void loadLists(debouncedQuery, nextCursor, true)} className="m-2 flex w-[calc(100%-1rem)] items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50">{loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Cargar más listas</button>}
        {folderError && <div role="status" className="m-2 rounded-xl bg-amber-50 px-3 py-2 text-[10px] text-amber-800"><p>{folderError}</p><button type="button" onClick={() => void loadFolders()} className="mt-1 font-bold underline">Reintentar nombres</button></div>}
        {folderNextCursor && !folderError && <button type="button" disabled={folderLoadingMore} onClick={() => void loadFolders(folderNextCursor, true)} className="m-2 flex w-[calc(100%-1rem)] items-center justify-center gap-2 rounded-xl px-3 py-2 text-[10px] font-bold text-slate-500 hover:bg-slate-50 disabled:opacity-50">{folderLoadingMore && <Loader2 className="h-3 w-3 animate-spin" />}Cargar más nombres de carpeta</button>}
      </div>
    </div></>, document.body)}
  </>
}

export function TaskRemoteFolderPicker({ environmentId, value, initialFolders, onChange, disabled }: {
  environmentId: string
  value: string
  initialFolders: TaskFolder[]
  onChange: (value: string, folder?: TaskFolder) => void
  disabled?: boolean
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const requestRef = useRef(0)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useDebouncedValue(query)
  const [items, setItems] = useState(initialFolders)
  const [nextCursor, setNextCursor] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const style = usePickerPosition(open, triggerRef)
  const selectedFolder = items.find(folder => folder.id === value) || initialFolders.find(folder => folder.id === value)
  const selected = value ? selectedFolder ? { name: selectedFolder.name, description: 'Hereda el flujo de la carpeta', color: selectedFolder.color, icon: selectedFolder.icon } : { name: 'Carpeta seleccionada', icon: 'folder' } : { name: 'Listas independientes', description: 'Nivel principal', icon: 'layers' }

  const load = useCallback(async (search: string, cursor = '', append = false) => {
    if (!environmentId) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const request = ++requestRef.current
    append ? setLoadingMore(true) : setLoading(true)
    setError('')
    const result = await apiGet<FolderPage>(`/api/tasks/environments/${encodeURIComponent(environmentId)}/folders?${environmentFolderQuery(search, cursor)}`, { signal: controller.signal })
    if (controller.signal.aborted || request !== requestRef.current) return
    setLoading(false)
    setLoadingMore(false)
    if (!result.success) {
      setError(result.error || 'No se pudieron cargar las carpetas.')
      return
    }
    const received = result.data?.folders || []
    setItems(current => mergeTaskCatalogPage(search || append ? current : initialFolders, received, !append && Boolean(search)))
    setNextCursor(result.data?.next_cursor || '')
  }, [environmentId, initialFolders])

  useEffect(() => { if (open) void load(debouncedQuery) }, [debouncedQuery, load, open])
  useEffect(() => () => abortRef.current?.abort(), [])
  const virtualizer = useVirtualizer({ count: items.length + 1, getScrollElement: () => scrollRef.current, estimateSize: () => 56, overscan: 8 })
  const close = () => { abortRef.current?.abort(); requestRef.current += 1; setOpen(false); setQuery(''); setDebouncedQuery(''); requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true })) }

  return <>
    <PickerTrigger triggerRef={triggerRef} open={open} disabled={disabled || !environmentId} selected={selected} placeholder="Selecciona una ubicación" onClick={() => setOpen(current => !current)} />
    {open && typeof document !== 'undefined' && createPortal(<><button type="button" data-task-picker-backdrop aria-label="Cerrar selector de carpeta" className="fixed inset-0 cursor-default" style={{ zIndex: TASK_OVERLAY_LAYERS.pickerBackdrop }} onMouseDown={close} /><div role="listbox" aria-label="Ubicación de lista" tabIndex={-1} style={{ ...style, zIndex: TASK_OVERLAY_LAYERS.picker }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close() } }} className="fixed flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl outline-none"><div className="mb-1 flex items-center gap-2 rounded-xl bg-slate-50 px-3"><Search className="h-4 w-4 text-slate-400" /><input autoFocus value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value) setDebouncedQuery('') }} placeholder="Buscar carpetas…" className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none" />{query.trim() !== debouncedQuery.trim() && <Loader2 aria-label="Esperando para buscar" className="h-3.5 w-3.5 animate-spin text-emerald-500" />}</div><div ref={scrollRef} className="min-h-[180px] flex-1 overflow-y-auto">{loading && !items.length ? <div className="space-y-1 p-1">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-12 animate-pulse rounded-xl bg-slate-100" />)}</div> : <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>{virtualizer.getVirtualItems().map(row => {
        const folder = row.index === 0 ? undefined : items[row.index - 1]
        const id = folder?.id || ''
        return <div key={id || 'root'} ref={virtualizer.measureElement} data-index={row.index} style={{ position: 'absolute', left: 0, top: 0, width: '100%', transform: `translateY(${row.start}px)` }}><button type="button" role="option" aria-selected={id === value} onClick={() => { onChange(id, folder); close() }} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ${id === value ? 'bg-emerald-50 ring-1 ring-emerald-100' : 'hover:bg-slate-50'}`}><span className="flex h-8 w-8 items-center justify-center rounded-xl bg-white shadow-sm" style={{ color: folder?.color || '#64748b' }}>{folder ? <TaskContainerIcon value={folder.icon} className="h-4 w-4" /> : <Layers3 className="h-4 w-4" />}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-700">{folder?.name || 'Listas independientes'}</span><span className="block text-[10px] text-slate-400">{folder ? 'Hereda el flujo de la carpeta' : 'Nivel principal'}</span></span>{id === value && <Check className="h-4 w-4 text-emerald-600" />}</button></div>
      })}</div>}{error && <div role="alert" className="m-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>}{nextCursor && !error && <button type="button" disabled={loadingMore} onClick={() => void load(debouncedQuery, nextCursor, true)} className="m-2 w-[calc(100%-1rem)] rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600">{loadingMore ? 'Cargando…' : 'Cargar más carpetas'}</button>}</div></div></>, document.body)}
  </>
}
