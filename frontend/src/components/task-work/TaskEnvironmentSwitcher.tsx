'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, ChevronDown, Globe2, Loader2, LockKeyhole, Plus, Search, Settings2, ShieldCheck, X } from 'lucide-react'
import { apiGet } from '@/lib/api'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import type { TaskEnvironment } from '@/types/task'
import { TaskContainerIcon } from './TaskContainerAppearance'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'
import { environmentListQuery, taskAccessLabel } from './taskEnvironmentAccess'

type EnvironmentListResponse = {
  environments: TaskEnvironment[]
  next_cursor?: string
  can_create?: boolean
}

interface Props {
  active?: TaskEnvironment
  environments: TaskEnvironment[]
  collapsed?: boolean
  canCreate: boolean
  onSelect: (environment: TaskEnvironment) => void
  onCreate: () => void
  onConfigure: (environment: TaskEnvironment) => void
}

function mergeEnvironments(current: TaskEnvironment[], incoming: TaskEnvironment[]) {
  return Array.from(new Map([...current, ...incoming].map(item => [item.id, item])).values())
}

export function taskEnvironmentActorAccessLabel(environment: Pick<TaskEnvironment, 'permissions'>) {
  return taskAccessLabel(environment.permissions?.level)
}

export default function TaskEnvironmentSwitcher({
  active,
  environments,
  collapsed = false,
  canCreate,
  onSelect,
  onCreate,
  onConfigure,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const requestRef = useRef(0)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useDebouncedValue(query)
  const [showArchived, setShowArchived] = useState(false)
  const [items, setItems] = useState<TaskEnvironment[]>(environments)
  const [nextCursor, setNextCursor] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [remoteCanCreate, setRemoteCanCreate] = useState<boolean | undefined>()
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({})

  useEffect(() => {
    if (!open && !debouncedQuery) setItems(environments)
  }, [debouncedQuery, environments, open])

  const load = useCallback(async (search: string, cursor = '', append = false, includeArchived = showArchived) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const request = ++requestRef.current
    append ? setLoadingMore(true) : setLoading(true)
    setError('')
    const result = await apiGet<EnvironmentListResponse>(
      `/api/tasks/environments?${environmentListQuery(search, cursor, includeArchived)}`,
      { signal: controller.signal },
    )
    if (controller.signal.aborted || request !== requestRef.current) return
    setLoading(false)
    setLoadingMore(false)
    if (!result.success) {
      setError(result.error || 'No se pudieron cargar los Entornos.')
      return
    }
    const received = result.data?.environments || []
    setItems(current => append ? mergeEnvironments(current, received) : mergeEnvironments(search ? [] : environments, received))
    setNextCursor(result.data?.next_cursor || '')
    if (typeof result.data?.can_create === 'boolean') setRemoteCanCreate(result.data.can_create)
  }, [environments, showArchived])

  useEffect(() => {
    if (!open) return
    void load(debouncedQuery, '', false, showArchived)
  }, [debouncedQuery, load, open, showArchived])

  useEffect(() => () => abortRef.current?.abort(), [])

  useEffect(() => {
    if (!open) return
    const position = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(388, window.innerWidth - 24)
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
      const availableBelow = window.innerHeight - rect.bottom - 12
      const height = Math.min(520, Math.max(320, window.innerHeight - 32))
      const top = availableBelow >= Math.min(height, 420)
        ? rect.bottom + 8
        : Math.max(12, rect.top - height - 8)
      setPanelStyle({ left, top, width, maxHeight: Math.min(height, window.innerHeight - top - 12) })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])

  const close = useCallback((restoreFocus = true) => {
    abortRef.current?.abort()
    requestRef.current += 1
    setOpen(false)
    setQuery('')
    setDebouncedQuery('')
    setShowArchived(false)
    setError('')
    setNextCursor('')
    setItems(environments)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }, [environments, setDebouncedQuery])

  const visibleItems = useMemo(() => items.filter(item => showArchived ? Boolean(item.archived_at) : !item.archived_at), [items, showArchived])
  const virtualizer = useVirtualizer({
    count: visibleItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 66,
    overscan: 8,
  })

  const choose = (environment: TaskEnvironment) => {
    onSelect(environment)
    close()
  }

  const allowCreate = remoteCanCreate ?? canCreate

  return <>
    <button
      ref={triggerRef}
      type="button"
      title={active ? `Entorno: ${active.name}` : 'Seleccionar Entorno'}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen(value => !value)}
      className={`group flex w-full items-center rounded-2xl border border-slate-200 bg-slate-50/80 text-left transition hover:border-emerald-200 hover:bg-emerald-50/50 ${collapsed ? 'h-11 justify-center px-2' : 'gap-3 px-3 py-2.5'}`}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-white shadow-sm" style={{ backgroundColor: active?.color || '#6366F1' }}>
        <TaskContainerIcon value={active?.icon || 'layers'} className="h-4 w-4" />
      </span>
      {!collapsed && <>
        <span className="min-w-0 flex-1">
          <span className="block text-[9px] font-black uppercase tracking-[.16em] text-slate-400">Entorno</span>
          <span className="mt-0.5 block truncate text-sm font-bold text-slate-800">{active?.name || 'Seleccionar'}</span>
        </span>
        {active?.visibility === 'restricted' ? <LockKeyhole className="h-3.5 w-3.5 text-slate-400" aria-label="Entorno privado" /> : <Globe2 className="h-3.5 w-3.5 text-slate-400" aria-label="Visible para la cuenta" />}
        <ChevronDown className={`h-4 w-4 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
      </>}
    </button>

    {open && typeof document !== 'undefined' && createPortal(<>
      <button
        type="button"
        aria-label="Cerrar selector de Entorno"
        className="fixed inset-0 cursor-default"
        style={{ zIndex: TASK_OVERLAY_LAYERS.workspacePopover - 1 }}
        onMouseDown={() => close(false)}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Seleccionar Entorno"
        style={{ ...panelStyle, zIndex: TASK_OVERLAY_LAYERS.workspacePopover }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
            return
          }
          if (event.key === 'Tab' && panelRef.current) {
            const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
              'button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ))
            if (!focusable.length) {
              event.preventDefault()
              panelRef.current.focus()
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
        }}
        tabIndex={-1}
        className="fixed flex min-h-0 flex-col overflow-hidden rounded-3xl border border-white/80 bg-white shadow-[0_26px_80px_rgba(15,23,42,0.24)] ring-1 ring-slate-900/10"
      >
        <div className="border-b border-slate-100 p-3.5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-violet-50 text-violet-700"><ShieldCheck className="h-5 w-5" /></span>
            <span className="min-w-0 flex-1"><span className="block text-sm font-black text-slate-900">Entornos de trabajo</span><span className="mt-0.5 block text-[11px] leading-4 text-slate-400">Cada Entorno conserva su propia estructura y permisos.</span></span>
            <button type="button" aria-label="Cerrar" onClick={() => close()} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X className="h-4 w-4" /></button>
          </div>
          <div className="relative mt-3">
            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              ref={inputRef}
              value={query}
              onChange={event => {
                setQuery(event.target.value)
                if (!event.target.value) setDebouncedQuery('')
              }}
              placeholder="Buscar Entornos…"
              className="h-11 w-full rounded-2xl border border-slate-200 bg-slate-50 pl-10 pr-10 text-sm text-slate-700 outline-none transition focus:border-emerald-300 focus:bg-white focus:ring-4 focus:ring-emerald-100"
            />
            {query.trim() !== debouncedQuery.trim() && <Loader2 aria-label="Esperando para buscar" className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-500" />}
          </div>
          <div className="mt-2 flex rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Estado de Entornos"><button type="button" role="tab" aria-selected={!showArchived} onClick={() => setShowArchived(false)} className={`flex-1 rounded-lg px-3 py-1.5 text-[10px] font-bold ${!showArchived ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-400'}`}>Activos</button><button type="button" role="tab" aria-selected={showArchived} onClick={() => setShowArchived(true)} className={`flex-1 rounded-lg px-3 py-1.5 text-[10px] font-bold ${showArchived ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-400'}`}>Archivados</button></div>
        </div>

        <div ref={scrollRef} className="min-h-[220px] flex-1 overflow-y-auto px-2 py-2">
          {loading && !visibleItems.length ? <div className="space-y-2 p-1">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-14 animate-pulse rounded-2xl bg-slate-100" />)}</div> : <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map(row => {
              const environment = visibleItems[row.index]
              const selected = environment.id === active?.id
              return <div key={environment.id} ref={virtualizer.measureElement} data-index={row.index} style={{ position: 'absolute', left: 0, top: 0, width: '100%', transform: `translateY(${row.start}px)` }}>
                <div className={`group flex w-full items-center rounded-2xl transition ${selected ? 'bg-emerald-50 ring-1 ring-emerald-100' : 'hover:bg-slate-50'}`}>
                  <button type="button" disabled={Boolean(environment.archived_at)} onClick={() => choose(environment)} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left disabled:cursor-default">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white" style={{ backgroundColor: environment.color }}><TaskContainerIcon value={environment.icon} className="h-4 w-4" /></span>
                    <span className="min-w-0 flex-1"><span className="flex items-center gap-1.5"><span className="truncate text-sm font-bold text-slate-700">{environment.name}</span>{environment.is_default && <span className="rounded-md bg-violet-50 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide text-violet-600">General</span>}</span><span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-400">{environment.visibility === 'restricted' ? <LockKeyhole className="h-3 w-3" /> : <Globe2 className="h-3 w-3" />}<span>{environment.visibility === 'restricted' ? 'Privado' : 'Cuenta'}</span><span>·</span><span>{taskEnvironmentActorAccessLabel(environment)}</span></span></span>
                    {selected && <Check className="h-4 w-4 shrink-0 text-emerald-600" />}
                  </button>
                  {environment.permissions?.can_delete && <button type="button" aria-label={`${environment.archived_at ? 'Restaurar' : 'Administrar'} ${environment.name}`} title={environment.archived_at ? 'Restaurar Entorno' : 'Administrar Entorno'} onClick={() => { onConfigure(environment); close(false) }} className="mr-2 rounded-lg p-1.5 text-slate-400 opacity-100 transition hover:bg-white hover:text-slate-700 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"><Settings2 className="h-3.5 w-3.5" /></button>}
                </div>
              </div>
            })}
          </div>}
          {!loading && !visibleItems.length && <div className="flex min-h-[220px] flex-col items-center justify-center px-6 text-center"><Search className="h-6 w-6 text-slate-300" /><p className="mt-2 text-sm font-semibold text-slate-500">No encontramos Entornos.</p><p className="mt-1 text-xs leading-5 text-slate-400">Prueba otro término o crea uno nuevo si tienes permiso.</p></div>}
          {error && <div role="alert" className="m-2 rounded-xl bg-rose-50 px-3 py-2.5 text-xs text-rose-700"><p>{error}</p><button type="button" onClick={() => void load(debouncedQuery)} className="mt-1 font-bold underline">Reintentar</button></div>}
          {nextCursor && !error && <button type="button" disabled={loadingMore} onClick={() => void load(debouncedQuery, nextCursor, true, showArchived)} className="mx-2 mb-2 flex w-[calc(100%-1rem)] items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50">{loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Cargar más</button>}
        </div>

        <div className="flex items-center gap-2 border-t border-slate-100 bg-slate-50/80 p-3">
          {active?.permissions?.can_delete && <button type="button" onClick={() => { onConfigure(active); close(false) }} className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-bold text-slate-600 hover:border-slate-300"><Settings2 className="h-3.5 w-3.5" />Administrar</button>}
          <button type="button" disabled={!allowCreate} title={!allowCreate ? 'Tu rol no permite crear Entornos' : 'Crear Entorno'} onClick={() => { onCreate(); close(false) }} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-black text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-35"><Plus className="h-3.5 w-3.5" />Nuevo Entorno</button>
        </div>
      </div>
    </>, document.body)}
  </>
}
