'use client'

import { createPortal } from 'react-dom'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useDraggable } from '@dnd-kit/core'
import {
  Archive,
  BriefcaseBusiness,
  Copy,
  Folder,
  GripVertical,
  MoreHorizontal,
  Network,
  RotateCcw,
  Settings2,
  Trash2,
} from 'lucide-react'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'
import {
  formatWhiteboardPurgeEligibility,
  whiteboardCatalogPresentation,
  type WhiteboardManagerLayout,
  type WhiteboardSummary,
  type WhiteboardViewMode,
} from '@/lib/whiteboards'

export type WhiteboardCatalogMenuAction = 'settings' | 'move' | 'duplicate' | 'archive' | 'restore' | 'purge'

interface WhiteboardCatalogItemProps {
  whiteboard: WhiteboardSummary
  view: WhiteboardViewMode
  layout: WhiteboardManagerLayout
  busy: boolean
  onOpen: () => void
  onMove: () => void
  purgeEligibleAt: string | null
  canPurge: boolean
  canDuplicate: boolean
  canMove: boolean
  canDrag: boolean
  onMenuAction: (action: WhiteboardCatalogMenuAction) => void
}

function WhiteboardThumbnail({ whiteboard, className, onOpen }: {
  whiteboard: WhiteboardSummary
  className: string
  onOpen: () => void
}) {
  return <button
    type="button"
    onClick={onOpen}
    data-whiteboard-slot="thumbnail"
    className={`relative flex shrink-0 items-center justify-center overflow-hidden border border-slate-200 bg-slate-50 text-emerald-700 shadow-sm outline-none transition-colors hover:border-emerald-200 hover:bg-emerald-50/40 focus-visible:ring-2 focus-visible:ring-emerald-500 ${className}`}
    aria-label={`Abrir ${whiteboard.name}`}
  >
    {whiteboard.thumbnail_url
      ? <img src={whiteboard.thumbnail_url} alt="" className="absolute inset-0 h-full w-full object-contain" />
      : <Network className="h-5 w-5" />}
  </button>
}

function CatalogBadge({ label }: { label: 'Clarin Work' | 'Compartida' | null }) {
  if (!label) return null
  return <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-black ${label === 'Clarin Work' ? 'bg-violet-50 text-violet-700' : 'bg-sky-50 text-sky-700'}`}>
    {label}
  </span>
}

function WhiteboardLocation({
  whiteboard,
  presentation,
  busy,
  canMove,
  onMove,
  className = '',
}: {
  whiteboard: WhiteboardSummary
  presentation: ReturnType<typeof whiteboardCatalogPresentation>
  busy: boolean
  canMove: boolean
  onMove: () => void
  className?: string
}) {
  const baseClassName = `flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-2.5 text-left text-xs font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500 ${className}`

  if (presentation.archived) {
    return <span className={`${baseClassName} cursor-default bg-slate-50 text-slate-500`}>
      {presentation.work ? <BriefcaseBusiness className="h-3.5 w-3.5 shrink-0" /> : <Folder className="h-3.5 w-3.5 shrink-0" />}
      <span className="truncate">{presentation.work ? 'Ubicación original' : presentation.folderLabel}</span>
    </span>
  }
  if (presentation.workLocationHref) {
    return <a
      href={presentation.workLocationHref}
      aria-label={presentation.workLocationAriaLabel || undefined}
      aria-disabled={busy}
      onClick={event => { if (busy) event.preventDefault() }}
      className={`${baseClassName} bg-violet-50 text-violet-700 hover:bg-violet-100 ${busy ? 'pointer-events-none opacity-40' : ''}`}
    >
      <BriefcaseBusiness className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">Abrir ubicación</span>
    </a>
  }
  if (presentation.work) {
    return <span className={`${baseClassName} cursor-default bg-slate-50 text-slate-500`}>
      <BriefcaseBusiness className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">Ubicación original</span>
    </span>
  }
  if (canMove) {
    return <button
      type="button"
      disabled={busy}
      onClick={onMove}
      className={`${baseClassName} bg-slate-50 text-slate-600 hover:bg-emerald-50 hover:text-emerald-800 disabled:opacity-40`}
      aria-label={`Cambiar carpeta de ${whiteboard.name}. Carpeta actual: ${presentation.folderLabel}`}
    >
      <Folder className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{presentation.folderLabel}</span>
    </button>
  }
  return <span className={`${baseClassName} cursor-default text-slate-500`}>
    <Folder className="h-3.5 w-3.5 shrink-0 text-slate-400" />
    <span className="truncate">{presentation.folderLabel}</span>
  </span>
}

function WhiteboardActionsMenu({
  whiteboard,
  busy,
  canMove,
  canConfigure,
  canDuplicate,
  canManage,
  canPurge,
  purgeReady,
  purgeEligibleAt,
  onAction,
}: {
  whiteboard: WhiteboardSummary
  busy: boolean
  canMove: boolean
  canConfigure: boolean
  canDuplicate: boolean
  canManage: boolean
  canPurge: boolean
  purgeReady: boolean
  purgeEligibleAt: string | null
  onAction: (action: WhiteboardCatalogMenuAction) => void
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0, width: 224 })
  const archived = Boolean(whiteboard.archived_at)
  const hasActions = archived
    ? canManage || canPurge
    : canConfigure || canMove || canDuplicate || canManage

  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }, [])

  useEffect(() => {
    if (!open) return
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(224, window.innerWidth - 24)
      const estimatedHeight = menuRef.current?.offsetHeight || 224
      const below = rect.bottom + 8
      const top = below + estimatedHeight <= window.innerHeight - 12
        ? below
        : Math.max(12, rect.top - estimatedHeight - 8)
      const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))
      setPosition({ top, left, width })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true }))
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  const choose = (action: WhiteboardCatalogMenuAction) => {
    close(false)
    onAction(action)
  }

  if (!hasActions) return <span aria-hidden="true" className="block h-11 w-11 shrink-0" />

  return <>
    <button ref={triggerRef} type="button" disabled={busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-400 outline-none transition hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40" aria-label={`Más acciones de ${whiteboard.name}`}><MoreHorizontal className="h-4 w-4" /></button>
    {open && typeof document !== 'undefined' && createPortal(<>
      <button type="button" aria-label="Cerrar acciones de pizarra" onMouseDown={() => close()} className="fixed inset-0 cursor-default" style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.workspacePopover - 1 }} />
      <div ref={menuRef} role="menu" aria-label={`Acciones de ${whiteboard.name}`} style={{ ...position, zIndex: OPERATIONAL_OVERLAY_LAYERS.workspacePopover }} onKeyDown={event => {
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        if (event.key === 'Escape') { event.preventDefault(); close() }
        else if (event.key === 'ArrowDown') { event.preventDefault(); items[(current + 1 + items.length) % items.length]?.focus() }
        else if (event.key === 'ArrowUp') { event.preventDefault(); items[(current - 1 + items.length) % items.length]?.focus() }
        else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus() }
        else if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus() }
        else if (event.key === 'Tab') close(false)
      }} className="fixed rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-900/15 outline-none">
        {!archived && canConfigure && <button type="button" role="menuitem" onClick={() => choose('settings')} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-700 hover:bg-emerald-50 hover:text-emerald-800"><Settings2 className="h-4 w-4 text-emerald-600" />Configurar</button>}
        {!archived && canMove && <button type="button" role="menuitem" onClick={() => choose('move')} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-600 hover:bg-emerald-50 hover:text-emerald-800"><Folder className="h-4 w-4 text-emerald-600" />Cambiar carpeta</button>}
        {!archived && canDuplicate && <button type="button" role="menuitem" onClick={() => choose('duplicate')} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-600 hover:bg-slate-50"><Copy className="h-4 w-4 text-slate-400" />Duplicar</button>}
        {!archived && canManage && <button type="button" role="menuitem" onClick={() => choose('archive')} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-600 hover:bg-slate-50"><Archive className="h-4 w-4 text-slate-400" />Mover a Papelera</button>}
        {archived && canManage && <button type="button" role="menuitem" onClick={() => choose('restore')} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-emerald-700 hover:bg-emerald-50"><RotateCcw className="h-4 w-4" />Restaurar</button>}
        {archived && canPurge && <button type="button" role="menuitem" disabled={!purgeReady} onClick={() => choose('purge')} title={purgeReady ? 'Eliminar definitivamente' : formatWhiteboardPurgeEligibility(purgeEligibleAt)} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-35"><Trash2 className="h-4 w-4" />Eliminar definitivamente</button>}
      </div>
    </>, document.body)}
  </>
}

export default function WhiteboardCatalogItem({
  whiteboard,
  view,
  layout,
  busy,
  onOpen,
  onMove,
  purgeEligibleAt,
  canPurge,
  canDuplicate,
  canMove,
  canDrag,
  onMenuAction,
}: WhiteboardCatalogItemProps) {
  const presentation = whiteboardCatalogPresentation(whiteboard, purgeEligibleAt)
  const canManage = Boolean(whiteboard.effective_access.can_delete || whiteboard.effective_access.can_manage_access)
  const canConfigure = !presentation.work && whiteboard.effective_access.can_manage_access
  const purgeReady = Boolean(purgeEligibleAt && Date.parse(purgeEligibleAt) <= Date.now())
  const drag = useDraggable({
    id: `whiteboard:${whiteboard.id}`,
    data: { type: 'whiteboard', whiteboardID: whiteboard.id, sourceFolderID: whiteboard.folder_id || null },
    disabled: presentation.archived || !canDrag || busy,
  })
  const articleStyle: CSSProperties = { opacity: drag.isDragging ? 0.32 : 1 }
  const dragHandle = !presentation.archived && canMove
    ? <button
      ref={drag.setActivatorNodeRef}
      type="button"
      disabled={busy || !canDrag}
      {...drag.attributes}
      {...drag.listeners}
      className="flex h-11 w-11 shrink-0 touch-none items-center justify-center rounded-lg text-slate-300 outline-none transition hover:bg-emerald-50 hover:text-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-500 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:fine)]:cursor-grab"
      aria-label={canDrag ? `Arrastrar ${whiteboard.name} a una carpeta` : `No hay otra carpeta disponible para ${whiteboard.name}`}
      title={canDrag ? 'Arrastrar a una carpeta' : 'Crea una carpeta para habilitar el arrastre'}
    ><GripVertical className="h-4 w-4" /></button>
    : <span aria-hidden="true" className="block h-11 w-11 shrink-0" />
  const actions = <WhiteboardActionsMenu
    whiteboard={whiteboard}
    busy={busy}
    canMove={canMove}
    canConfigure={canConfigure}
    canDuplicate={canDuplicate}
    canManage={canManage}
    canPurge={canPurge}
    purgeReady={purgeReady}
    purgeEligibleAt={purgeEligibleAt}
    onAction={onMenuAction}
  />
  const metadata = <span className="truncate">{presentation.archived
    ? presentation.purgeLabel
    : <>{presentation.updatedLabel}{presentation.contextLabel === presentation.actorLabel ? '' : ` · ${presentation.actorLabel}`}</>}
  </span>

  if (view === 'list') {
    const columns = layout === 'wide'
      ? 'grid-cols-[44px_64px_minmax(0,1fr)_116px_minmax(148px,200px)_44px]'
      : layout === 'compact'
        ? 'grid-cols-[44px_64px_minmax(0,1fr)_minmax(148px,180px)_44px]'
        : 'grid-cols-[44px_64px_minmax(0,1fr)_44px]'
    return <article
      ref={drag.setNodeRef}
      data-whiteboard-id={whiteboard.id}
      data-whiteboard-view="list"
      role="listitem"
      style={articleStyle}
      className={`group grid min-w-0 ${columns} items-center border-b border-slate-100 bg-white py-2.5 transition-[opacity,background-color] last:border-b-0 hover:bg-slate-50/80 ${layout === 'narrow' ? 'gap-x-2 px-2' : 'gap-x-3 px-3 sm:px-4'}`}
    >
      <span data-whiteboard-slot="drag" className="flex h-11 w-11 items-center justify-center">{dragHandle}</span>
      <WhiteboardThumbnail whiteboard={whiteboard} onOpen={onOpen} className="h-11 w-16 rounded-lg" />
      <button type="button" onClick={onOpen} data-whiteboard-slot="identity" className="min-h-11 min-w-0 rounded-lg py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
        <span className="block truncate text-sm font-black text-slate-800">{whiteboard.name}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <CatalogBadge label={presentation.badge} />
          <span title={presentation.contextLabel} className="min-w-0 truncate text-xs text-slate-500">{presentation.contextLabel}</span>
        </span>
        {layout !== 'wide' && <span className="mt-0.5 block truncate text-[11px] text-slate-400">{metadata}</span>}
      </button>
      {layout === 'wide' && <span data-whiteboard-slot="updated" className="flex min-w-0 flex-col text-right text-xs text-slate-500">
        {presentation.archived
          ? <span title={presentation.purgeLabel || undefined} className="line-clamp-2 text-[10px] font-semibold leading-4 text-slate-500">{presentation.purgeLabel}</span>
          : <><span className="font-semibold">{presentation.updatedLabel}</span>{presentation.contextLabel !== presentation.actorLabel && <span className="mt-0.5 truncate text-[10px] text-slate-400">{presentation.actorLabel}</span>}</>}
      </span>}
      <span data-whiteboard-slot="location" className={layout === 'narrow' ? 'col-start-2 col-end-5 mt-1 min-w-0' : 'min-w-0'}>
        <WhiteboardLocation whiteboard={whiteboard} presentation={presentation} busy={busy} canMove={canMove} onMove={onMove} className="w-full" />
      </span>
      <span data-whiteboard-slot="actions" className={`${layout === 'narrow' ? 'col-start-4 row-start-1' : ''} flex h-11 w-11 items-center justify-center`}>{actions}</span>
    </article>
  }

  if (view === 'compact') {
    return <article ref={drag.setNodeRef} data-whiteboard-id={whiteboard.id} data-whiteboard-view="compact" role="listitem" style={articleStyle} className="group grid min-h-[142px] min-w-0 grid-cols-[clamp(104px,34%,144px)_minmax(0,1fr)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-[opacity,border-color,box-shadow] duration-200 hover:border-emerald-200 hover:shadow-md motion-reduce:transition-none">
      <WhiteboardThumbnail whiteboard={whiteboard} onOpen={onOpen} className="h-full w-full rounded-none border-0 border-r border-slate-100 shadow-none" />
      <div className="flex min-w-0 flex-col p-3">
        <div className="flex min-w-0 items-start gap-1">
          <button type="button" onClick={onOpen} className="min-h-11 min-w-0 flex-1 rounded-lg py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
            <span className="line-clamp-2 text-sm font-black leading-5 text-slate-800">{whiteboard.name}</span>
          </button>
          <span data-whiteboard-slot="drag" className="flex h-11 w-11 items-center justify-center">{dragHandle}</span>
          <span data-whiteboard-slot="actions" className="flex h-11 w-11 items-center justify-center">{actions}</span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2"><CatalogBadge label={presentation.badge} /><p title={presentation.contextLabel} className="min-w-0 truncate text-[11px] text-slate-500">{presentation.contextLabel}</p></div>
        <p className="mt-1 truncate text-[10px] text-slate-400">{metadata}</p>
        <div className="mt-auto pt-2"><WhiteboardLocation whiteboard={whiteboard} presentation={presentation} busy={busy} canMove={canMove} onMove={onMove} className="w-full" /></div>
      </div>
    </article>
  }

  return <article ref={drag.setNodeRef} data-whiteboard-id={whiteboard.id} data-whiteboard-view="grid" role="listitem" style={articleStyle} className="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-[opacity,border-color,box-shadow] duration-200 hover:border-emerald-200 hover:shadow-md motion-reduce:transition-none">
    <WhiteboardThumbnail whiteboard={whiteboard} onOpen={onOpen} className="aspect-[16/10] w-full rounded-none border-0 border-b border-slate-100 shadow-none" />
    <div className="flex min-h-[150px] min-w-0 flex-col p-3">
      <div className="flex min-w-0 items-start gap-1">
        <button type="button" onClick={onOpen} className="min-h-11 min-w-0 flex-1 rounded-lg py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
          <span className="block truncate text-sm font-black text-slate-800">{whiteboard.name}</span>
        </button>
        <span data-whiteboard-slot="drag" className="flex h-11 w-11 items-center justify-center">{dragHandle}</span>
        <span data-whiteboard-slot="actions" className="flex h-11 w-11 items-center justify-center">{actions}</span>
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-2"><CatalogBadge label={presentation.badge} /><p title={presentation.contextLabel} className="min-w-0 truncate text-[11px] text-slate-500">{presentation.contextLabel}</p></div>
      <p className="mt-1 truncate text-[10px] text-slate-400">{metadata}</p>
      <div className="mt-auto pt-3"><WhiteboardLocation whiteboard={whiteboard} presentation={presentation} busy={busy} canMove={canMove} onMove={onMove} className="w-full" /></div>
    </div>
  </article>
}
