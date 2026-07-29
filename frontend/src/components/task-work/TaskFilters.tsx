'use client'

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  Bookmark,
  Check,
  ChevronDown,
  Filter,
  Loader2,
  Save,
  SlidersHorizontal,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import { apiDelete, apiGet, apiPost, apiPut } from '@/lib/api'
import {
  TASK_PRIORITY_CONFIG,
  TASK_TYPE_CONFIG,
  TaskDueFilter,
  TaskFilters,
  TaskPriority,
  TaskSavedView,
  TaskType,
  TaskViewMode,
  TaskWorkflowStatus,
} from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'

export const EMPTY_TASK_FILTERS: TaskFilters = {
  status_ids: [],
  assigned_to_ids: [],
  collaborator_ids: [],
  priorities: [],
  types: [],
  creator_ids: [],
  due: '',
  created_from: '',
  created_to: '',
  completed_from: '',
  completed_to: '',
}

type ScopeDescriptor = { type: 'all' | 'folder' | 'list'; id?: string }

interface Props {
  filters: TaskFilters
  statuses: TaskWorkflowStatus[]
  users: TaskAccountUser[]
  scope: ScopeDescriptor
  view: TaskViewMode
  collapsedStatusIds: string[]
  onChange: (filters: TaskFilters) => void
  onApplyView: (view: TaskSavedView) => void
  applyDefaultOnLoad: boolean
  onDefaultLoadHandled: () => void
  onError: (message: string) => void
}

const dueOptions: Array<{ value: TaskDueFilter; label: string }> = [
  { value: '', label: 'Cualquier fecha' },
  { value: 'overdue', label: 'Vencidas' },
  { value: 'today', label: 'Vencen hoy' },
  { value: 'this_week', label: 'Esta semana' },
  { value: 'no_date', label: 'Sin fecha' },
]
function normalizeFilters(value?: Partial<TaskFilters> | null): TaskFilters {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const strings = (key: string) => Array.isArray(source[key])
    ? source[key].filter((item): item is string => typeof item === 'string')
    : []
  const text = (key: string) => typeof source[key] === 'string' ? source[key] as string : ''
  const optionalBoolean = (key: string) => typeof source[key] === 'boolean' ? source[key] as boolean : undefined
  const priorities = strings('priorities').filter((item): item is TaskPriority => item in TASK_PRIORITY_CONFIG)
  const types = strings('types').filter((item): item is TaskType => item in TASK_TYPE_CONFIG)
  const due = text('due')
  return {
    status_ids: strings('status_ids'),
    assigned_to_ids: strings('assigned_to_ids'),
    collaborator_ids: strings('collaborator_ids'),
    priorities,
    types,
    creator_ids: strings('creator_ids'),
    due: dueOptions.some(option => option.value === due) ? due as TaskDueFilter : '',
    created_from: text('created_from'),
    created_to: text('created_to'),
    completed_from: text('completed_from'),
    completed_to: text('completed_to'),
    has_subtasks: optionalBoolean('has_subtasks'),
    has_comments: optionalBoolean('has_comments'),
    has_attachments: optionalBoolean('has_attachments'),
    has_dependencies: optionalBoolean('has_dependencies'),
    starred: optionalBoolean('starred'),
  }
}

export function taskFilterCount(filters: TaskFilters) {
  return filters.status_ids.length + filters.assigned_to_ids.length + filters.collaborator_ids.length + filters.priorities.length + filters.types.length + filters.creator_ids.length
    + (filters.due ? 1 : 0)
    + (filters.created_from || filters.created_to ? 1 : 0)
    + (filters.completed_from || filters.completed_to ? 1 : 0)
    + (filters.has_subtasks !== undefined ? 1 : 0)
    + (filters.has_comments !== undefined ? 1 : 0)
    + (filters.has_attachments !== undefined ? 1 : 0)
    + (filters.has_dependencies !== undefined ? 1 : 0)
    + (filters.starred !== undefined ? 1 : 0)
}

function toggleArray<T extends string>(items: T[], value: T) {
  return items.includes(value) ? items.filter(item => item !== value) : [...items, value]
}

function Choice({ checked, label, detail, onChange }: { checked: boolean; label: string; detail?: string; onChange: () => void }) {
  return <button type="button" role="checkbox" aria-checked={checked} onClick={onChange} className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition ${checked ? 'bg-emerald-50 text-emerald-800' : 'text-slate-600 hover:bg-slate-50'}`}>
    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 bg-white'}`}>{checked && <Check className="h-3 w-3" />}</span>
    <span className="min-w-0 flex-1 truncate font-medium">{label}</span>{detail && <span className="shrink-0 text-[9px] text-slate-400">{detail}</span>}
  </button>
}

function FilterPanel({ filters, statuses, users, onChange, onClose }: Omit<Props, 'scope' | 'view' | 'collapsedStatusIds' | 'onApplyView' | 'applyDefaultOnLoad' | 'onDefaultLoadHandled' | 'onError'> & { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase('es')
  const shownStatuses = statuses.filter(status => !needle || status.name.toLocaleLowerCase('es').includes(needle))
  const shownUsers = users.filter(user => !needle || `${user.display_name} ${user.username}`.toLocaleLowerCase('es').includes(needle))
  const set = <K extends keyof TaskFilters>(key: K, value: TaskFilters[K]) => onChange({ ...filters, [key]: value })

  return <div className="flex max-h-[min(680px,calc(100vh-32px))] flex-col">
    <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3"><div><h3 className="text-sm font-bold text-slate-900">Filtrar tareas</h3><p className="text-[10px] text-slate-400">Combina criterios para enfocar el trabajo.</p></div><button type="button" onClick={() => onChange(EMPTY_TASK_FILTERS)} disabled={!taskFilterCount(filters)} className="ml-auto rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-slate-500 hover:bg-slate-100 disabled:opacity-40">Limpiar</button><button type="button" onClick={onClose} aria-label="Cerrar filtros" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button></div>
    <div className="border-b border-slate-100 p-3"><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar estado o persona…" className="w-full rounded-xl bg-slate-50 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-emerald-200" /></div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="grid gap-4 md:grid-cols-2">
        <section><h4 className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Estado</h4><div className="max-h-40 overflow-y-auto">{shownStatuses.map(status => <Choice key={status.id} checked={filters.status_ids.includes(status.id)} label={status.name} onChange={() => set('status_ids', toggleArray(filters.status_ids, status.id))} />)}{!shownStatuses.length && <p className="px-2 py-3 text-xs text-slate-400">Sin coincidencias.</p>}</div></section>
        <section><h4 className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Responsable</h4><div className="max-h-40 overflow-y-auto">{shownUsers.map(user => <Choice key={user.id} checked={filters.assigned_to_ids.includes(user.id)} label={user.display_name || user.username} detail={`@${user.username}`} onChange={() => set('assigned_to_ids', toggleArray(filters.assigned_to_ids, user.id))} />)}</div></section>
        <section><h4 className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Prioridad</h4>{(Object.keys(TASK_PRIORITY_CONFIG) as TaskPriority[]).map(priority => <Choice key={priority} checked={filters.priorities.includes(priority)} label={TASK_PRIORITY_CONFIG[priority].label} onChange={() => set('priorities', toggleArray(filters.priorities, priority))} />)}</section>
        <section><h4 className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Tipo</h4>{(Object.keys(TASK_TYPE_CONFIG) as TaskType[]).map(type => <Choice key={type} checked={filters.types.includes(type)} label={`${TASK_TYPE_CONFIG[type].icon} ${TASK_TYPE_CONFIG[type].label}`} onChange={() => set('types', toggleArray(filters.types, type))} />)}</section>
        <section><h4 className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Colaborador</h4><div className="max-h-36 overflow-y-auto">{shownUsers.map(user => <Choice key={user.id} checked={filters.collaborator_ids.includes(user.id)} label={user.display_name || user.username} onChange={() => set('collaborator_ids', toggleArray(filters.collaborator_ids, user.id))} />)}</div></section>
        <section><h4 className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Creador</h4><div className="max-h-36 overflow-y-auto">{shownUsers.map(user => <Choice key={user.id} checked={filters.creator_ids.includes(user.id)} label={user.display_name || user.username} onChange={() => set('creator_ids', toggleArray(filters.creator_ids, user.id))} />)}</div></section>
      </div>

      <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 md:grid-cols-3">
        <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Vencimiento<select value={filters.due} onChange={event => set('due', event.target.value as TaskDueFilter)} className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium normal-case tracking-normal text-slate-600 outline-none focus:border-emerald-400">{dueOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Creada desde<input type="date" value={filters.created_from} onChange={event => set('created_from', event.target.value)} className="mt-1.5 w-full rounded-lg border border-slate-200 px-2 py-2 text-xs font-medium normal-case tracking-normal text-slate-600 outline-none focus:border-emerald-400" /></label>
        <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Creada hasta<input type="date" value={filters.created_to} onChange={event => set('created_to', event.target.value)} className="mt-1.5 w-full rounded-lg border border-slate-200 px-2 py-2 text-xs font-medium normal-case tracking-normal text-slate-600 outline-none focus:border-emerald-400" /></label>
        <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Completada desde<input type="date" value={filters.completed_from} onChange={event => set('completed_from', event.target.value)} className="mt-1.5 w-full rounded-lg border border-slate-200 px-2 py-2 text-xs font-medium normal-case tracking-normal text-slate-600 outline-none focus:border-emerald-400" /></label>
        <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Completada hasta<input type="date" value={filters.completed_to} onChange={event => set('completed_to', event.target.value)} className="mt-1.5 w-full rounded-lg border border-slate-200 px-2 py-2 text-xs font-medium normal-case tracking-normal text-slate-600 outline-none focus:border-emerald-400" /></label>
      </div>

      <section className="mt-4 border-t border-slate-100 pt-4"><h4 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">Contenido</h4><div className="grid gap-1 sm:grid-cols-2">{([
        ['has_subtasks', 'Con subtareas'], ['has_comments', 'Con comentarios'], ['has_attachments', 'Con adjuntos'], ['has_dependencies', 'Con dependencias'], ['starred', 'Sólo favoritas'],
      ] as Array<[keyof TaskFilters, string]>).map(([key, label]) => <Choice key={key} checked={filters[key] === true} label={label} onChange={() => set(key, (filters[key] === true ? undefined : true) as never)} />)}</div></section>
    </div>
  </div>
}

function SavedViewsPanel({ views, loading, filters, scope, view, collapsedStatusIds, onReload, onApply, onError, onClose }: {
  views: TaskSavedView[]
  loading: boolean
  filters: TaskFilters
  scope: ScopeDescriptor
  view: TaskViewMode
  collapsedStatusIds: string[]
  onReload: () => Promise<void>
  onApply: (view: TaskSavedView) => void
  onError: (message: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [makeDefault, setMakeDefault] = useState(false)
  const [busyId, setBusyId] = useState('')

  const create = async () => {
    if (!name.trim() || busyId) return
    setBusyId('new')
    const result = await apiPost<{ view: TaskSavedView }>('/api/tasks/saved-views', {
      name: name.trim(), scope_type: scope.type, scope_id: scope.id || null, view_mode: view,
      filters, collapsed_status_ids: collapsedStatusIds, is_default: makeDefault,
    })
    if (!result.success) onError(result.error || 'No se pudo guardar la vista')
    else { setName(''); setMakeDefault(false); await onReload() }
    setBusyId('')
  }

  const update = async (saved: TaskSavedView) => {
    if (busyId) return
    setBusyId(saved.id)
    const result = await apiPut<{ view: TaskSavedView }>(`/api/tasks/saved-views/${saved.id}`, {
      name: saved.name, scope_type: scope.type, scope_id: scope.id || null, view_mode: view,
      filters, collapsed_status_ids: collapsedStatusIds, is_default: saved.is_default,
    })
    if (!result.success) onError(result.error || 'No se pudo actualizar la vista')
    else await onReload()
    setBusyId('')
  }

  const toggleDefault = async (saved: TaskSavedView) => {
    if (busyId) return
    setBusyId(saved.id)
    const result = await apiPut<{ view: TaskSavedView }>(`/api/tasks/saved-views/${saved.id}`, {
      name: saved.name,
      scope_type: saved.scope_type,
      scope_id: saved.scope_id || null,
      view_mode: saved.view_mode,
      filters: saved.filters,
      collapsed_status_ids: saved.collapsed_status_ids || [],
      is_default: !saved.is_default,
    })
    if (!result.success) onError(result.error || 'No se pudo cambiar la vista predeterminada')
    else await onReload()
    setBusyId('')
  }

  const remove = async (saved: TaskSavedView) => {
    if (!window.confirm(`¿Eliminar la vista “${saved.name}”?`)) return
    setBusyId(saved.id)
    const result = await apiDelete(`/api/tasks/saved-views/${saved.id}`)
    if (!result.success) onError(result.error || 'No se pudo eliminar la vista')
    else await onReload()
    setBusyId('')
  }

  return <div className="flex max-h-[min(600px,calc(100vh-32px))] flex-col">
    <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3"><div><h3 className="text-sm font-bold text-slate-900">Vistas guardadas</h3><p className="text-[10px] text-slate-400">Tus filtros te acompañan en cualquier dispositivo.</p></div><button type="button" onClick={onClose} aria-label="Cerrar vistas" className="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button></div>
    <div className="border-b border-slate-100 p-3"><div className="flex gap-2"><input value={name} disabled={Boolean(busyId)} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void create() }} placeholder="Nombre de la nueva vista…" className="min-w-0 flex-1 rounded-xl bg-slate-50 px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-emerald-200 disabled:opacity-60" /><button type="button" disabled={!name.trim() || Boolean(busyId)} onClick={() => void create()} className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3 text-xs font-bold text-white disabled:opacity-40">{busyId === 'new' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}Guardar</button></div><label className="mt-2 flex items-center gap-2 text-[11px] font-medium text-slate-500"><input type="checkbox" disabled={Boolean(busyId)} checked={makeDefault} onChange={event => setMakeDefault(event.target.checked)} className="accent-emerald-600" />Usar como vista predeterminada</label></div>
    <div className="min-h-0 flex-1 overflow-y-auto p-2">{loading ? <div className="flex items-center justify-center py-12 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div> : views.length ? views.map(saved => <div key={saved.id} className="group flex items-center gap-2 rounded-xl px-2 py-2 hover:bg-slate-50"><button type="button" onClick={() => onApply(saved)} className="flex min-w-0 flex-1 items-center gap-2 text-left"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600"><Bookmark className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="flex items-center gap-1.5 truncate text-xs font-semibold text-slate-700">{saved.name}{saved.is_default && <Star className="h-3 w-3 fill-amber-400 text-amber-400" />}</span><span className="block truncate text-[9px] uppercase tracking-wide text-slate-400">{saved.view_mode} · {taskFilterCount(normalizeFilters(saved.filters))} filtros</span></span></button><button type="button" disabled={Boolean(busyId)} onClick={() => void toggleDefault(saved)} title={saved.is_default ? 'Quitar como predeterminada' : 'Usar como predeterminada'} className={`rounded-lg p-1.5 opacity-0 hover:bg-amber-50 group-hover:opacity-100 focus:opacity-100 ${saved.is_default ? 'text-amber-400 !opacity-100' : 'text-slate-300 hover:text-amber-500'}`}><Star className={`h-3.5 w-3.5 ${saved.is_default ? 'fill-current' : ''}`} /></button><button type="button" disabled={Boolean(busyId)} onClick={() => void update(saved)} title="Actualizar con los filtros actuales" className="rounded-lg p-1.5 text-slate-300 opacity-0 hover:bg-white hover:text-emerald-600 group-hover:opacity-100 focus:opacity-100"><Save className="h-3.5 w-3.5" /></button><button type="button" disabled={Boolean(busyId)} onClick={() => void remove(saved)} title="Eliminar vista" className="rounded-lg p-1.5 text-slate-300 opacity-0 hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100 focus:opacity-100">{busyId === saved.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}</button></div>) : <div className="px-5 py-12 text-center"><Bookmark className="mx-auto h-7 w-7 text-slate-300" /><p className="mt-3 text-xs font-semibold text-slate-600">Aún no tienes vistas guardadas</p><p className="mt-1 text-[10px] leading-4 text-slate-400">Configura filtros y guárdalos para recuperarlos con un clic.</p></div>}</div>
  </div>
}

export default function TaskFilterToolbar({ filters, statuses, users, scope, view, collapsedStatusIds, onChange, onApplyView, applyDefaultOnLoad, onDefaultLoadHandled, onError }: Props) {
  const filterButtonRef = useRef<HTMLButtonElement>(null)
  const viewsButtonRef = useRef<HTMLButtonElement>(null)
  const [mode, setMode] = useState<'filters' | 'views' | null>(null)
  const [style, setStyle] = useState<CSSProperties>({})
  const [views, setViews] = useState<TaskSavedView[]>([])
  const [viewsLoading, setViewsLoading] = useState(false)
  const count = taskFilterCount(filters)
  const uniqueStatuses = useMemo(() => Array.from(new Map(statuses.map(status => [status.id, status])).values()), [statuses])

  const loadViews = async () => {
    setViewsLoading(true)
    const result = await apiGet<{ views: TaskSavedView[] }>('/api/tasks/saved-views')
    if (result.success) {
      const nextViews = result.data?.views || []
      setViews(nextViews)
      if (applyDefaultOnLoad) {
        onDefaultLoadHandled()
        const defaultView = nextViews.find(saved => saved.is_default)
        if (defaultView) onApplyView({ ...defaultView, filters: normalizeFilters(defaultView.filters) })
      }
    }
    else onError(result.error || 'No se pudieron cargar las vistas guardadas')
    setViewsLoading(false)
  }

  useEffect(() => { void loadViews() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!mode) return
    const position = () => {
      const trigger = (mode === 'filters' ? filterButtonRef : viewsButtonRef).current
      const rect = trigger?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(mode === 'filters' ? 620 : 430, window.innerWidth - 24)
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
      const roomBelow = window.innerHeight - rect.bottom
      setStyle(roomBelow > 350 ? { top: rect.bottom + 7, left, width } : { bottom: window.innerHeight - rect.top + 7, left, width })
    }
    position()
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setMode(null); requestAnimationFrame(() => (mode === 'filters' ? filterButtonRef : viewsButtonRef).current?.focus()) } }
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); window.removeEventListener('keydown', closeOnEscape) }
  }, [mode])

  const close = () => setMode(null)
  const removeChip = (key: keyof TaskFilters, value?: string) => {
    const current = filters[key]
    if (Array.isArray(current) && value) onChange({ ...filters, [key]: current.filter(item => item !== value) as never })
    else onChange({ ...filters, [key]: (typeof current === 'string' ? '' : undefined) as never })
  }
  const chips = [
    ...filters.status_ids.map(id => ({ key: 'status_ids' as const, value: id, label: uniqueStatuses.find(status => status.id === id)?.name || 'Estado' })),
    ...filters.assigned_to_ids.map(id => ({ key: 'assigned_to_ids' as const, value: id, label: users.find(user => user.id === id)?.display_name || users.find(user => user.id === id)?.username || 'Responsable' })),
    ...filters.collaborator_ids.map(id => ({ key: 'collaborator_ids' as const, value: id, label: `Colabora: ${users.find(user => user.id === id)?.display_name || users.find(user => user.id === id)?.username || 'Usuario'}` })),
    ...filters.creator_ids.map(id => ({ key: 'creator_ids' as const, value: id, label: `Creó: ${users.find(user => user.id === id)?.display_name || users.find(user => user.id === id)?.username || 'Usuario'}` })),
    ...filters.priorities.map(value => ({ key: 'priorities' as const, value, label: TASK_PRIORITY_CONFIG[value].label })),
    ...filters.types.map(value => ({ key: 'types' as const, value, label: TASK_TYPE_CONFIG[value].label })),
    ...(filters.due ? [{ key: 'due' as const, label: dueOptions.find(option => option.value === filters.due)?.label || 'Vencimiento' }] : []),
    ...(filters.created_from ? [{ key: 'created_from' as const, label: `Creada desde ${filters.created_from}` }] : []),
    ...(filters.created_to ? [{ key: 'created_to' as const, label: `Creada hasta ${filters.created_to}` }] : []),
    ...(filters.completed_from ? [{ key: 'completed_from' as const, label: `Completada desde ${filters.completed_from}` }] : []),
    ...(filters.completed_to ? [{ key: 'completed_to' as const, label: `Completada hasta ${filters.completed_to}` }] : []),
    ...(filters.has_subtasks !== undefined ? [{ key: 'has_subtasks' as const, label: filters.has_subtasks ? 'Con subtareas' : 'Sin subtareas' }] : []),
    ...(filters.has_comments !== undefined ? [{ key: 'has_comments' as const, label: filters.has_comments ? 'Con comentarios' : 'Sin comentarios' }] : []),
    ...(filters.has_attachments !== undefined ? [{ key: 'has_attachments' as const, label: filters.has_attachments ? 'Con adjuntos' : 'Sin adjuntos' }] : []),
    ...(filters.has_dependencies !== undefined ? [{ key: 'has_dependencies' as const, label: filters.has_dependencies ? 'Con dependencias' : 'Sin dependencias' }] : []),
    ...(filters.starred !== undefined ? [{ key: 'starred' as const, label: filters.starred ? 'Favoritas' : 'No favoritas' }] : []),
  ]

  return <div className="contents">
    <button ref={filterButtonRef} type="button" onClick={() => setMode(current => current === 'filters' ? null : 'filters')} aria-expanded={mode === 'filters'} aria-haspopup="dialog" className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition ${count ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}><Filter className="h-3.5 w-3.5" />Filtros{count > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-600 px-1 text-[9px] font-black text-white">{count}</span>}</button>
    <button ref={viewsButtonRef} type="button" onClick={() => setMode(current => current === 'views' ? null : 'views')} aria-expanded={mode === 'views'} aria-haspopup="dialog" className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"><Bookmark className="h-3.5 w-3.5" /><span className="hidden xl:inline">Vistas</span><ChevronDown className="h-3 w-3 text-slate-400" /></button>
    {chips.slice(0, 4).map(chip => { const value = 'value' in chip ? chip.value : undefined; return <span key={`${chip.key}:${value || chip.label}`} className="inline-flex max-w-36 items-center gap-1 rounded-lg bg-slate-100 px-2 py-1.5 text-[10px] font-semibold text-slate-600"><span className="truncate">{chip.label}</span><button type="button" onClick={() => removeChip(chip.key, value)} aria-label={`Quitar ${chip.label}`} className="rounded text-slate-400 hover:text-slate-700"><X className="h-3 w-3" /></button></span> })}
    {chips.length > 4 && <button type="button" onClick={() => setMode('filters')} className="rounded-lg bg-slate-100 px-2 py-1.5 text-[10px] font-bold text-slate-500">+{chips.length - 4}</button>}

    {mode && typeof document !== 'undefined' && createPortal(<><button type="button" aria-label="Cerrar panel" onMouseDown={close} className="fixed inset-0 z-[69] cursor-default" /><div role="dialog" aria-label={mode === 'filters' ? 'Filtros de tareas' : 'Vistas guardadas'} style={style} className="fixed z-[70] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/15">{mode === 'filters' ? <FilterPanel filters={filters} statuses={uniqueStatuses} users={users} onChange={onChange} onClose={close} /> : <SavedViewsPanel views={views} loading={viewsLoading} filters={filters} scope={scope} view={view} collapsedStatusIds={collapsedStatusIds} onReload={loadViews} onApply={saved => { onApplyView({ ...saved, filters: normalizeFilters(saved.filters) }); close() }} onError={onError} onClose={close} />}</div></>, document.body)}
  </div>
}

export function TaskFilterSummaryButton({ count, onClick }: { count: number; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500"><SlidersHorizontal className="h-3.5 w-3.5" />{count} filtros</button>
}
