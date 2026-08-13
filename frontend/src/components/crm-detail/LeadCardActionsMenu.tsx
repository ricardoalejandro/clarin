'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArchiveRestore, CheckCircle2, MoreHorizontal, Trash2, XCircle } from 'lucide-react'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'

const DESKTOP_MENU_WIDTH = 192
const VIEWPORT_MARGIN = 8
const MENU_GAP = 8
const COMPACT_MENU_QUERY = '(max-width: 1023px), (hover: none), (pointer: coarse)'

export type LeadCardLifecycleAction = 'won' | 'lost' | 'reopen'

export type LeadCardMenuAnchor = {
  left: number
  right: number
  top: number
  bottom: number
}

export type LeadCardMenuViewport = {
  left: number
  top: number
  width: number
  height: number
}

export type LeadCardMenuPosition = {
  left: number
  top: number
  width: number
  maxHeight: number
  placement: 'top' | 'bottom'
}

export function leadCardMenuPosition(
  anchor: LeadCardMenuAnchor,
  menu: { width: number; height: number },
  viewport: LeadCardMenuViewport,
): LeadCardMenuPosition | null {
  const viewportRight = viewport.left + viewport.width
  const viewportBottom = viewport.top + viewport.height
  if (anchor.bottom < viewport.top || anchor.top > viewportBottom || anchor.right < viewport.left || anchor.left > viewportRight) return null

  const width = Math.min(menu.width, Math.max(1, viewport.width - VIEWPORT_MARGIN * 2))
  const viewportMaxHeight = Math.max(1, viewport.height - VIEWPORT_MARGIN * 2)
  const desiredHeight = Math.min(Math.max(1, menu.height), viewportMaxHeight)
  const spaceBelow = Math.max(0, viewportBottom - VIEWPORT_MARGIN - MENU_GAP - anchor.bottom)
  const spaceAbove = Math.max(0, anchor.top - MENU_GAP - (viewport.top + VIEWPORT_MARGIN))
  const placement = spaceBelow >= desiredHeight || spaceBelow >= spaceAbove ? 'bottom' : 'top'
  const maxHeight = Math.max(1, placement === 'bottom' ? spaceBelow : spaceAbove)
  const height = Math.min(desiredHeight, maxHeight)
  const preferredTop = placement === 'bottom' ? anchor.bottom + MENU_GAP : anchor.top - MENU_GAP - height
  const minTop = viewport.top + VIEWPORT_MARGIN
  const maxTop = Math.max(minTop, viewportBottom - VIEWPORT_MARGIN - height)
  const preferredLeft = anchor.right - width
  const minLeft = viewport.left + VIEWPORT_MARGIN
  const maxLeft = Math.max(minLeft, viewportRight - VIEWPORT_MARGIN - width)

  return {
    left: Math.round(Math.max(minLeft, Math.min(preferredLeft, maxLeft))),
    top: Math.round(Math.max(minTop, Math.min(preferredTop, maxTop))),
    width: Math.round(width),
    maxHeight: Math.round(maxHeight),
    placement,
  }
}

function currentViewport(): LeadCardMenuViewport {
  const viewport = window.visualViewport
  return {
    left: viewport?.offsetLeft || 0,
    top: viewport?.offsetTop || 0,
    width: viewport?.width || window.innerWidth,
    height: viewport?.height || window.innerHeight,
  }
}

function compactMenuMatches() {
  if (typeof window === 'undefined') return false
  return typeof window.matchMedia === 'function'
    ? window.matchMedia(COMPACT_MENU_QUERY).matches
    : window.innerWidth < 1024
}

interface LeadCardActionsMenuProps {
  leadName?: string | null
  status: string
  onLifecycleAction: (mode: LeadCardLifecycleAction) => void
  onDelete: () => void
}

export default function LeadCardActionsMenu({ leadName, status, onLifecycleAction, onDelete }: LeadCardActionsMenuProps) {
  const [open, setOpen] = useState(false)
  const [compact, setCompact] = useState(false)
  const [position, setPosition] = useState<LeadCardMenuPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const label = leadName || 'lead'
  const isClosed = status === 'won' || status === 'lost'

  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    setPosition(null)
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }, [])

  const reposition = useCallback(() => {
    if (compactMenuMatches()) {
      setCompact(true)
      setPosition(null)
      return
    }
    setCompact(false)
    const trigger = triggerRef.current
    if (!trigger) return
    const anchor = trigger.getBoundingClientRect()
    const estimatedHeight = isClosed ? 106 : 148
    const measured = menuRef.current?.getBoundingClientRect()
    const next = leadCardMenuPosition(
      anchor,
      { width: DESKTOP_MENU_WIDTH, height: measured?.height || estimatedHeight },
      currentViewport(),
    )
    if (!next) {
      close(false)
      return
    }
    setPosition(next)
  }, [close, isClosed])

  useLayoutEffect(() => {
    if (!open) return
    reposition()
    const frame = window.requestAnimationFrame(reposition)
    return () => window.cancelAnimationFrame(frame)
  }, [open, reposition])

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true }))
    const outside = (event: MouseEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      close(false)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }
    const media = typeof window.matchMedia === 'function' ? window.matchMedia(COMPACT_MENU_QUERY) : null
    const mediaChanged = () => reposition()
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', keydown)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    window.visualViewport?.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('scroll', reposition)
    media?.addEventListener?.('change', mediaChanged)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', keydown)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      window.visualViewport?.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('scroll', reposition)
      media?.removeEventListener?.('change', mediaChanged)
    }
  }, [close, open, reposition])

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    const current = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      if (event.key === 'Home') items[0]?.focus()
      else if (event.key === 'End') items.at(-1)?.focus()
      else items[(current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }
  }

  const runLifecycleAction = (mode: LeadCardLifecycleAction) => {
    close(false)
    onLifecycleAction(mode)
  }

  const runDelete = () => {
    close(false)
    onDelete()
  }

  const menu = open && typeof document !== 'undefined' ? createPortal(
    <div
      ref={menuRef}
      id={menuId}
      data-lead-card-actions-menu
      data-presentation={compact ? 'sheet' : 'popover'}
      role="menu"
      aria-label={`Acciones de ${label}`}
      onClick={event => event.stopPropagation()}
      onKeyDown={onMenuKeyDown}
      className={compact
        ? 'fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] max-h-[70vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-2xl outline-none'
        : 'fixed overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-900/15 outline-none'}
      style={compact
        ? { zIndex: OPERATIONAL_OVERLAY_LAYERS.workspacePopover }
        : {
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            width: position?.width ?? DESKTOP_MENU_WIDTH,
            maxHeight: position?.maxHeight ?? 320,
            visibility: position ? 'visible' : 'hidden',
            zIndex: OPERATIONAL_OVERLAY_LAYERS.workspacePopover,
          }}
    >
      {compact && <p className="px-3 py-2 text-xs font-semibold text-slate-500">Acciones de {label}</p>}
      {isClosed ? (
        <button type="button" role="menuitem" onClick={() => runLifecycleAction('reopen')} className={`flex w-full items-center text-left font-semibold text-blue-700 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${compact ? 'min-h-11 gap-3 rounded-xl px-3 text-sm' : 'min-h-10 gap-2 rounded-lg px-3 text-xs'}`}>
          <ArchiveRestore className="h-4 w-4" /> Reabrir lead
        </button>
      ) : (
        <>
          <button type="button" role="menuitem" onClick={() => runLifecycleAction('won')} className={`flex w-full items-center text-left font-semibold text-emerald-700 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${compact ? 'min-h-11 gap-3 rounded-xl px-3 text-sm' : 'min-h-10 gap-2 rounded-lg px-3 text-xs'}`}>
            <CheckCircle2 className="h-4 w-4" /> Marcar como ganado
          </button>
          <button type="button" role="menuitem" onClick={() => runLifecycleAction('lost')} className={`flex w-full items-center text-left font-semibold text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${compact ? 'min-h-11 gap-3 rounded-xl px-3 text-sm' : 'min-h-10 gap-2 rounded-lg px-3 text-xs'}`}>
            <XCircle className="h-4 w-4" /> Marcar como perdido
          </button>
        </>
      )}
      <div className="my-1 border-t border-slate-100" />
      <button type="button" role="menuitem" onClick={runDelete} className={`flex w-full items-center text-left font-semibold text-slate-700 hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${compact ? 'min-h-11 gap-3 rounded-xl px-3 text-sm' : 'min-h-10 gap-2 rounded-lg px-3 text-xs'}`}>
        <Trash2 className="h-4 w-4" /> Mover a papelera
      </button>
    </div>,
    document.body,
  ) : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-no-crm-drag
        onClick={event => {
          event.stopPropagation()
          if (open) close(false)
          else {
            setCompact(compactMenuMatches())
            setOpen(true)
          }
        }}
        className="touch-action-visible inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 opacity-100 transition-all hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 lg:h-10 lg:w-10 lg:opacity-0 lg:focus:opacity-100 lg:group-hover:opacity-100"
        aria-label={`Acciones de ${label}`}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {menu}
    </>
  )
}
