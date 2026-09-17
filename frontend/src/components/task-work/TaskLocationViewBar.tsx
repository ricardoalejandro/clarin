'use client'

import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  Columns3,
  Copy,
  GanttChartSquare,
  LayoutList,
  Loader2,
  LockKeyhole,
  MoreHorizontal,
  PenLine,
  PenTool,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import type { TaskLocationView, TaskLocationViewScopeType, TaskLocationViewVisibilityMode, TaskLocationViewVisibilityPolicy, TaskViewMode } from '@/types/task'
import {
  createTaskLocationViewOperationAttempt,
  splitTaskLocationViewTabs,
  taskLocationViewBreadcrumb,
  taskLocationViewName,
  taskLocationViewNameDraft,
  taskLocationViewTabCapacity,
} from '@/lib/taskLocationViews'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'
import { useWhiteboardDialogFocus } from '@/components/whiteboards/useWhiteboardDialogFocus'
import TaskLocationViewVisibilityFields, { type TaskLocationViewSelectedMember } from './TaskLocationViewVisibilityFields'
import TaskLocationViewAccessDialog from './TaskLocationViewAccessDialog'

const BUILTIN_VIEWS: Array<{ id: TaskViewMode; label: string; icon: typeof LayoutList }> = [
  { id: 'list', label: 'Lista', icon: LayoutList },
  { id: 'board', label: 'Tablero', icon: Columns3 },
  { id: 'calendar', label: 'Calendario', icon: CalendarDays },
  { id: 'gantt', label: 'Gantt', icon: GanttChartSquare },
  { id: 'summary', label: 'Resumen', icon: BarChart3 },
]

type ViewOperationModalState =
  | { kind: 'create'; operationID: string }
  | { kind: 'rename'; view: TaskLocationView; operationID: string }
  | { kind: 'duplicate'; view: TaskLocationView; operationID: string }
  | { kind: 'trash'; view: TaskLocationView; operationID: string }

type ModalState = ViewOperationModalState | { kind: 'access'; view: TaskLocationView } | null

type MenuState = { view: TaskLocationView; top: number; left: number } | null

interface TaskLocationViewBarProps {
  builtinView: TaskViewMode
  activeLocationView: TaskLocationView | null
  locationViews: TaskLocationView[]
  availableWidth: number
  locationLabel: string
  locationContextKey: string
  scopeType: TaskLocationViewScopeType
  scopeID: string
  parentAccessRevision: number
  featureEnabled: boolean
  canCreate: boolean
  canManageAccess: boolean
  loading?: boolean
  onSelectBuiltin: (view: TaskViewMode) => void
  onSelectLocation: (view: TaskLocationView) => void
  onCreate: (name: string, operationID: string, visibilityMode: TaskLocationViewVisibilityMode, visibleUserIDs: string[], expectedParentAccessRevision: number) => Promise<string | null>
  onRename: (view: TaskLocationView, name: string, operationID: string) => Promise<string | null>
  onDuplicate: (view: TaskLocationView, operationID: string) => Promise<string | null>
  onTrash: (view: TaskLocationView, operationID: string) => Promise<string | null>
  onPrepareAccessChange: () => Promise<string | null>
  onAccessChanged: (viewID: string, policy: TaskLocationViewVisibilityPolicy) => void
}

function ViewDialog({
  state,
  locationLabel,
  busy,
  error,
  name,
  scopeType,
  scopeID,
  canManageAccess,
  visibilityMode,
  visibilityMembers,
  onName,
  onVisibilityMode,
  onVisibilityMembers,
  onClose,
  onSubmit,
}: {
  state: ViewOperationModalState
  locationLabel: string
  busy: boolean
  error: string
  name: string
  scopeType: TaskLocationViewScopeType
  scopeID: string
  canManageAccess: boolean
  visibilityMode: TaskLocationViewVisibilityMode
  visibilityMembers: TaskLocationViewSelectedMember[]
  onName: (value: string) => void
  onVisibilityMode: (value: TaskLocationViewVisibilityMode) => void
  onVisibilityMembers: (value: TaskLocationViewSelectedMember[]) => void
  onClose: () => void
  onSubmit: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useWhiteboardDialogFocus(dialogRef, onClose, state.kind === 'trash' ? undefined : inputRef)
  const title = state.kind === 'create' ? 'Añadir vista' : state.kind === 'rename' ? 'Cambiar nombre' : state.kind === 'duplicate' ? 'Duplicar pizarra' : 'Mover pizarra a Papelera'
  const description = state.kind === 'trash'
    ? 'La misma pizarra dejará de aparecer en Work y en el Hub. Podrás restaurarla desde Pizarras.'
    : state.kind === 'duplicate'
      ? 'Clarin creará otra pizarra en la misma ubicación, conservando la escena canónica confirmada.'
      : state.kind === 'rename'
        ? `El nombre cambiará en Work y en el Hub. La privacidad seguirá vinculada a ${locationLabel}.`
        : `Se añadirá a ${locationLabel} como recurso compartido de Clarin Work.`

  return createPortal(<div className="fixed inset-0 flex items-center justify-center bg-slate-950/50 p-3 backdrop-blur-sm sm:p-5" style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.dialog }} role="presentation" onMouseDown={event => { if (!busy && event.target === event.currentTarget) onClose() }}>
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="task-location-view-dialog-title" aria-describedby="task-location-view-dialog-description" className="max-h-[min(720px,calc(100dvh-1.5rem))] w-full max-w-lg overflow-y-auto rounded-3xl border border-slate-200 bg-white shadow-2xl outline-none">
      <header className="flex items-start gap-4 border-b border-slate-100 px-5 py-5">
        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${state.kind === 'trash' ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-700'}`}>{state.kind === 'trash' ? <Trash2 className="h-5 w-5" /> : <PenTool className="h-5 w-5" />}</span>
        <div className="min-w-0 flex-1"><h2 id="task-location-view-dialog-title" className="text-lg font-black text-slate-900">{title}</h2><p id="task-location-view-dialog-description" className="mt-1 text-sm leading-5 text-slate-500">{description}</p></div>
        <button type="button" data-whiteboard-dialog-close disabled={busy} onClick={onClose} aria-label="Cerrar" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40"><X className="h-4 w-4" /></button>
      </header>
      <div className="p-5">
        {state.kind === 'create' && <div className="mb-5 rounded-2xl border-2 border-emerald-300 bg-emerald-50/60 p-4 shadow-sm ring-4 ring-emerald-50">
          <div className="flex items-start gap-3"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-emerald-700 shadow-sm"><PenLine className="h-5 w-5" /></span><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="text-sm font-black text-slate-900">Pizarra</p><Check className="h-4 w-4 text-emerald-600" /></div><p className="mt-1 text-xs leading-5 text-slate-500">Lienzo visual colaborativo con historial, archivos y guardado automático.</p></div></div>
        </div>}
        {state.kind === 'create' || state.kind === 'rename' ? <label className="block"><span className="text-xs font-black uppercase tracking-[.12em] text-slate-500">Nombre</span><input ref={inputRef} value={name} onChange={event => onName(taskLocationViewNameDraft(event.target.value))} onKeyDown={event => { if (event.key === 'Enter' && name.trim() && !busy) { event.preventDefault(); onSubmit() } }} placeholder="Ej. Mapa del proyecto" className="mt-2 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm text-slate-800 outline-none transition focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100" /></label> : <div className={`rounded-2xl border px-4 py-3 ${state.kind === 'trash' ? 'border-rose-100 bg-rose-50' : 'border-emerald-100 bg-emerald-50'}`}><p className={`text-sm font-black ${state.kind === 'trash' ? 'text-rose-900' : 'text-emerald-900'}`}>{state.view.resource.whiteboard.name}</p><p className={`mt-1 text-xs leading-5 ${state.kind === 'trash' ? 'text-rose-700' : 'text-emerald-700'}`}>{state.kind === 'trash' ? 'No se eliminará inmediatamente: quedará sujeta a la retención de Pizarras.' : 'La copia tendrá permisos heredados de la misma Lista o Carpeta.'}</p></div>}
        {state.kind === 'create' && <TaskLocationViewVisibilityFields scopeType={scopeType} scopeID={scopeID} canManageAccess={canManageAccess} mode={visibilityMode} selected={visibilityMembers} onMode={onVisibilityMode} onSelected={onVisibilityMembers} disabled={busy} />}
        {error && <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800">{error}</p>}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" disabled={busy} onClick={onClose} className="min-h-11 rounded-xl px-4 text-sm font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-40">Cancelar</button><button type="button" disabled={busy || ((state.kind === 'create' || state.kind === 'rename') && !name.trim()) || state.kind === 'create' && visibilityMode === 'restricted' && visibilityMembers.length === 0} onClick={onSubmit} className={`flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-black text-white disabled:opacity-40 ${state.kind === 'trash' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{state.kind === 'create' ? 'Añadir pizarra' : state.kind === 'rename' ? 'Guardar nombre' : state.kind === 'duplicate' ? error ? 'Reintentar duplicación' : 'Duplicar pizarra' : 'Mover a Papelera'}</button></div>
      </div>
    </div>
  </div>, document.body)
}

export default function TaskLocationViewBar({
  builtinView,
  activeLocationView,
  locationViews,
  availableWidth,
  locationLabel,
  locationContextKey,
  scopeType,
  scopeID,
  parentAccessRevision,
  featureEnabled,
  canCreate,
  canManageAccess,
  loading = false,
  onSelectBuiltin,
  onSelectLocation,
  onCreate,
  onRename,
  onDuplicate,
  onTrash,
  onPrepareAccessChange,
  onAccessChanged,
}: TaskLocationViewBarProps) {
  const [modal, setModal] = useState<ModalState>(null)
  const [menu, setMenu] = useState<MenuState>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [overflowPosition, setOverflowPosition] = useState({ top: 0, left: 0 })
  const [name, setName] = useState('')
  const [visibilityMode, setVisibilityMode] = useState<TaskLocationViewVisibilityMode>('inherit')
  const [visibilityMembers, setVisibilityMembers] = useState<TaskLocationViewSelectedMember[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const barRef = useRef<HTMLDivElement>(null)
  const overflowButtonRef = useRef<HTMLButtonElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const surfaceGenerationRef = useRef(0)
  const locationContextKeyRef = useRef(locationContextKey)
  const [measuredWidth, setMeasuredWidth] = useState(0)
  const layoutWidth = measuredWidth > 0 ? measuredWidth : availableWidth
  const split = useMemo(() => splitTaskLocationViewTabs(locationViews, activeLocationView?.id || null, taskLocationViewTabCapacity(layoutWidth)), [activeLocationView?.id, layoutWidth, locationViews])

  useEffect(() => {
    const element = barRef.current
    if (!element) return
    const measure = () => setMeasuredWidth(Math.round(element.getBoundingClientRect().width))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const closeMenu = useCallback((restoreFocus = true) => {
    if (restoreFocus) menuButtonRef.current?.focus({ preventScroll: true })
    setMenu(null)
  }, [])

  useEffect(() => {
    const contextChanged = locationContextKeyRef.current !== locationContextKey
    locationContextKeyRef.current = locationContextKey
    const targetSnapshot = modal && 'view' in modal ? modal.view : menu?.view
    const canonicalTarget = targetSnapshot ? locationViews.find(view => view.id === targetSnapshot.id) : undefined
    const targetMissing = Boolean(targetSnapshot && !canonicalTarget)
    const authorityChanged = Boolean(targetSnapshot && canonicalTarget && (
      !canonicalTarget.capabilities.can_manage
      || modal?.kind === 'access' && !canonicalTarget.capabilities.can_manage_access
      || canonicalTarget.access_revision !== targetSnapshot.access_revision
    ))
    const createRevoked = modal?.kind === 'create' && (!canCreate || visibilityMode === 'restricted' && !canManageAccess)
    if (featureEnabled && !contextChanged && !targetMissing && !authorityChanged && !createRevoked) return
    surfaceGenerationRef.current += 1
    setMenu(null)
    setOverflowOpen(false)
    setModal(null)
    setName('')
    setVisibilityMode('inherit')
    setVisibilityMembers([])
    setError('')
    setBusy(false)
  }, [canCreate, canManageAccess, featureEnabled, locationContextKey, locationViews, menu?.view.id, modal, visibilityMode])

  useEffect(() => {
    if (!menu && !overflowOpen) return
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (menu) closeMenu()
      if (overflowOpen) {
        setOverflowOpen(false)
        overflowButtonRef.current?.focus({ preventScroll: true })
      }
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [closeMenu, menu, overflowOpen])

  useEffect(() => {
    if (!overflowOpen) return
    requestAnimationFrame(() => document.getElementById('task-location-view-overflow')?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true }))
  }, [overflowOpen])

  useEffect(() => {
    if (!menu) return
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [menu])

  useEffect(() => {
    if (!menu && !overflowOpen) return
    const closeForViewportChange = () => {
      setMenu(null)
      setOverflowOpen(false)
    }
    window.addEventListener('resize', closeForViewportChange)
    document.addEventListener('scroll', closeForViewportChange, true)
    window.visualViewport?.addEventListener('resize', closeForViewportChange)
    window.visualViewport?.addEventListener('scroll', closeForViewportChange)
    return () => {
      window.removeEventListener('resize', closeForViewportChange)
      document.removeEventListener('scroll', closeForViewportChange, true)
      window.visualViewport?.removeEventListener('resize', closeForViewportChange)
      window.visualViewport?.removeEventListener('scroll', closeForViewportChange)
    }
  }, [menu, overflowOpen])

  const toggleOverflow = () => {
    if (overflowOpen) { setOverflowOpen(false); return }
    const rect = overflowButtonRef.current?.getBoundingClientRect()
    if (rect) {
      const width = Math.min(352, window.innerWidth - 24)
      setOverflowPosition({
        top: Math.min(rect.bottom + 8, Math.max(12, window.innerHeight - 432)),
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
      })
    }
    setOverflowOpen(true)
  }

  const openMenu = (view: TaskLocationView, element: HTMLButtonElement) => {
    const rect = element.getBoundingClientRect()
    menuButtonRef.current = element
    setMenu({ view, top: Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 220)), left: Math.max(12, Math.min(rect.right - 224, window.innerWidth - 236)) })
  }

  const openModal = (next: Exclude<ModalState, null>) => {
    if (menu) closeMenu()
    setOverflowOpen(false)
    setError('')
    setName(next.kind === 'rename' ? next.view.resource.whiteboard.name : '')
    if (next.kind === 'create') {
      setVisibilityMode('inherit')
      setVisibilityMembers([])
    }
    setModal(next)
  }

  const submit = async () => {
    if (!modal || modal.kind === 'access' || busy) return
    const generation = surfaceGenerationRef.current
    const normalized = taskLocationViewName(name)
    if ((modal.kind === 'create' || modal.kind === 'rename') && !normalized) return
    if (modal.kind === 'create' && visibilityMode === 'restricted' && visibilityMembers.length === 0) return
    setBusy(true)
    setError('')
    const failure = modal.kind === 'create'
      ? await onCreate(normalized, modal.operationID, visibilityMode,
        visibilityMode === 'restricted' ? visibilityMembers.map(member => member.user_id) : [], parentAccessRevision)
      : modal.kind === 'rename'
        ? await onRename(modal.view, normalized, modal.operationID)
        : modal.kind === 'duplicate'
          ? await onDuplicate(modal.view, modal.operationID)
        : await onTrash(modal.view, modal.operationID)
    if (generation !== surfaceGenerationRef.current) return
    setBusy(false)
    if (failure) { setError(failure); return }
    setModal(null)
  }

  const duplicate = async (view: TaskLocationView) => {
    if (busy) return
    const generation = surfaceGenerationRef.current
    const attempt = createTaskLocationViewOperationAttempt('duplicate', view.id)
    closeMenu()
    setBusy(true)
    const failure = await onDuplicate(view, attempt.operationID)
    if (generation !== surfaceGenerationRef.current) return
    setBusy(false)
    if (failure) {
      setError(failure)
      setModal({ kind: 'duplicate', view, operationID: attempt.operationID })
    }
  }

  return <>
    <div ref={barRef} data-task-view-tabs className="flex min-w-0 flex-1 items-center overflow-hidden rounded-xl bg-slate-100 p-1">
      <div className="flex min-w-0 shrink-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{BUILTIN_VIEWS.map(option => { const Icon = option.icon; const active = !activeLocationView && builtinView === option.id; const hideLabel = layoutWidth < 520 || (layoutWidth < 900 && (Boolean(activeLocationView) || option.id !== builtinView)); return <button key={option.id} type="button" onClick={() => onSelectBuiltin(option.id)} aria-pressed={active} title={hideLabel ? option.label : undefined} className={`flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition ${layoutWidth >= 900 ? 'sm:px-3' : ''} ${active ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}><Icon className="h-3.5 w-3.5" /><span className={hideLabel ? 'sr-only' : ''}>{option.label}</span></button> })}</div>
      {(featureEnabled || locationViews.length > 0) && <span className="mx-1 h-6 w-px shrink-0 bg-slate-200" />}
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">{split.visible.map(view => { const active = activeLocationView?.id === view.id; const hideName = layoutWidth < 520; const menuOpen = menu?.view.id === view.id; return <div key={view.id} className={`group flex min-w-0 shrink items-center rounded-lg ${active ? 'bg-white text-emerald-800 shadow-sm' : 'text-slate-500 hover:bg-white/70 hover:text-slate-800'}`}><button type="button" onClick={() => onSelectLocation(view)} aria-pressed={active} title={`${view.resource.whiteboard.name} · ${taskLocationViewBreadcrumb(view)}${view.visibility_mode === 'restricted' ? ' · Restringida' : ''}`} className="flex min-h-9 min-w-0 items-center gap-1.5 px-2.5 text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"><PenTool className="h-3.5 w-3.5 shrink-0 text-emerald-600" /><span className={`${hideName ? 'sr-only' : 'max-w-32 truncate'}`}>{view.resource.whiteboard.name}</span>{view.visibility_mode === 'restricted' && <LockKeyhole aria-label="Pizarra restringida" className="h-3 w-3 shrink-0 text-violet-500" />}</button>{active && view.capabilities.can_manage && <button type="button" onClick={event => { if (menuOpen) closeMenu(); else openMenu(view, event.currentTarget) }} aria-label={`Acciones de ${view.resource.whiteboard.name}`} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? 'task-location-view-actions' : undefined} className="flex h-9 w-8 shrink-0 items-center justify-center rounded-r-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"><MoreHorizontal className="h-3.5 w-3.5" /></button>}</div> })}
        {split.overflow.length > 0 && <div className="relative shrink-0"><button ref={overflowButtonRef} type="button" onClick={toggleOverflow} aria-label={`Más (${split.overflow.length})`} aria-haspopup="menu" aria-expanded={overflowOpen} className="flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-bold text-slate-500 hover:bg-white">{layoutWidth < 430 ? <><MoreHorizontal aria-hidden="true" className="h-3.5 w-3.5" /><span aria-hidden="true">{split.overflow.length}</span></> : <><span aria-hidden="true">Más ({split.overflow.length})</span><ChevronDown aria-hidden="true" className="h-3.5 w-3.5" /></>}</button></div>}
      </div>
      {featureEnabled && <button type="button" disabled={!canCreate || loading || busy} onClick={() => openModal({ kind: 'create', operationID: createTaskLocationViewOperationAttempt('create').operationID })} title={!canCreate ? 'Necesitas Administrar en esta Lista o Carpeta y acceso al módulo Pizarras.' : `Añadir una vista a ${locationLabel}`} className="ml-auto flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-transparent px-2.5 text-xs font-black text-emerald-700 transition hover:border-emerald-200 hover:bg-white disabled:cursor-not-allowed disabled:text-slate-300"><Plus className="h-3.5 w-3.5" /><span className={layoutWidth < 780 ? 'sr-only' : ''}>Vista</span></button>}
      {loading && <Loader2 className="mx-2 h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" aria-label="Actualizando vistas" />}
    </div>

    {overflowOpen && typeof document !== 'undefined' && createPortal(<><button type="button" tabIndex={-1} aria-label="Cerrar vistas adicionales" onClick={() => { setOverflowOpen(false); overflowButtonRef.current?.focus({ preventScroll: true }) }} className="fixed inset-0 cursor-default" style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.workspacePopover - 1 }} /><div id="task-location-view-overflow" role="menu" aria-label="Vistas adicionales" onKeyDown={event => { const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')); const index = items.indexOf(document.activeElement as HTMLButtonElement); if (event.key === 'Escape') { event.preventDefault(); setOverflowOpen(false); overflowButtonRef.current?.focus({ preventScroll: true }) } else if (event.key === 'Tab') { event.preventDefault(); items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus() } else if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1 + items.length) % items.length]?.focus() } else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus() } else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus() } else if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus() } }} className="fixed max-h-[min(420px,calc(100dvh-1.5rem))] w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl" style={{ ...overflowPosition, zIndex: OPERATIONAL_OVERLAY_LAYERS.workspacePopover }}>{split.overflow.map(view => <button key={view.id} role="menuitem" type="button" onClick={() => { setOverflowOpen(false); onSelectLocation(view) }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><PenTool className="h-4 w-4 shrink-0 text-emerald-600" /><span className="min-w-0 flex-1"><span className="flex items-center gap-1.5 truncate text-sm font-bold text-slate-800">{view.resource.whiteboard.name}{view.visibility_mode === 'restricted' && <LockKeyhole aria-label="Restringida" className="h-3 w-3 shrink-0 text-violet-500" />}</span><span className="block truncate text-[10px] text-slate-400">{taskLocationViewBreadcrumb(view)}</span></span>{activeLocationView?.id === view.id && <Check className="h-4 w-4 text-emerald-600" />}</button>)}</div></>, document.body)}

    {menu && typeof document !== 'undefined' && createPortal(<><button type="button" tabIndex={-1} aria-label="Cerrar acciones de vista" onClick={() => closeMenu()} className="fixed inset-0 cursor-default" style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.workspacePopover - 1 }} /><div ref={menuRef} id="task-location-view-actions" role="menu" aria-label={`Acciones de ${menu.view.resource.whiteboard.name}`} onKeyDown={event => { const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')); const index = items.indexOf(document.activeElement as HTMLButtonElement); if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu() } else if (event.key === 'Tab') { event.preventDefault(); items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus() } else if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1 + items.length) % items.length]?.focus() } else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus() } else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus() } else if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus() } }} style={{ top: menu.top, left: menu.left, zIndex: OPERATIONAL_OVERLAY_LAYERS.workspacePopover }} className="fixed w-56 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl">{menu.view.capabilities.can_manage_access && <button type="button" role="menuitem" onClick={() => openModal({ kind: 'access', view: menu.view })} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-violet-700 hover:bg-violet-50"><LockKeyhole className="h-4 w-4" />Privacidad</button>}<button type="button" role="menuitem" onClick={() => openModal({ kind: 'rename', view: menu.view, operationID: createTaskLocationViewOperationAttempt('rename', menu.view.id).operationID })} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50"><PenLine className="h-4 w-4 text-slate-400" />Cambiar nombre</button><button type="button" role="menuitem" onClick={() => void duplicate(menu.view)} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50"><Copy className="h-4 w-4 text-slate-400" />Duplicar</button><button type="button" role="menuitem" onClick={() => openModal({ kind: 'trash', view: menu.view, operationID: createTaskLocationViewOperationAttempt('trash', menu.view.id).operationID })} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-rose-700 hover:bg-rose-50"><Trash2 className="h-4 w-4" />Mover a Papelera</button></div></>, document.body)}

    {modal && modal.kind !== 'access' && typeof document !== 'undefined' && <ViewDialog state={modal} locationLabel={locationLabel} busy={busy} error={error} name={name} scopeType={scopeType} scopeID={scopeID} canManageAccess={canManageAccess} visibilityMode={visibilityMode} visibilityMembers={visibilityMembers} onName={setName} onVisibilityMode={setVisibilityMode} onVisibilityMembers={setVisibilityMembers} onClose={() => { if (!busy) setModal(null) }} onSubmit={() => void submit()} />}
    {modal?.kind === 'access' && typeof document !== 'undefined' && <TaskLocationViewAccessDialog view={modal.view} onBeforeSave={onPrepareAccessChange} onClose={() => setModal(null)} onSaved={policy => onAccessChanged(modal.view.id, policy)} />}
  </>
}
