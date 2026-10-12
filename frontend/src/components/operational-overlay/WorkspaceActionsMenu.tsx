'use client'

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { OPERATIONAL_OVERLAY_LAYERS } from './operationalOverlayLayers'
import { workspaceMenuPosition, type WorkspaceMenuPosition } from './workspaceMenuPosition'

export default function WorkspaceActionsMenu({ anchor, id, label, compact = false, onClose, children }: {
  anchor: HTMLElement | null; id: string; label: string; compact?: boolean; onClose: () => void; children: ReactNode
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [position, setPosition] = useState<WorkspaceMenuPosition | null>(null)

  useLayoutEffect(() => {
    if (!anchor) { closeRef.current(); return }
    const close = (restoreFocus = false) => {
      closeRef.current()
      if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true })
    }
    const reposition = () => {
      if (!anchor.isConnected) { close(); return }
      if (compact) return
      const viewport = window.visualViewport
      const next = workspaceMenuPosition(anchor.getBoundingClientRect(), { width: 224, height: menuRef.current?.scrollHeight || 280 }, {
        left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0, width: viewport?.width || window.innerWidth, height: viewport?.height || window.innerHeight,
      })
      if (!next) { close(); return }
      setPosition(current => current && Object.keys(next).every(key => current[key as keyof WorkspaceMenuPosition] === next[key as keyof WorkspaceMenuPosition]) ? current : next)
    }
    const outside = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) close()
    }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
      if (!menuRef.current?.contains(event.target as Node)) return
      if (event.key === 'Tab') { close(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const items = Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
      if (!items.length) return
      event.preventDefault()
      const current = items.indexOf(document.activeElement as HTMLButtonElement)
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
      items[index].focus()
    }
    reposition()
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true }))
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(reposition) : null
    if (menuRef.current) observer?.observe(menuRef.current)
    observer?.observe(anchor)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('mousedown', outside, true)
    document.addEventListener('keydown', keyboard, true)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    window.visualViewport?.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('scroll', reposition)
    return () => {
      cancelAnimationFrame(frame); observer?.disconnect()
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', keyboard, true)
      window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true)
      window.visualViewport?.removeEventListener('resize', reposition); window.visualViewport?.removeEventListener('scroll', reposition)
    }
  }, [anchor, compact])

  if (!anchor || typeof document === 'undefined') return null
  return createPortal(<div ref={menuRef} id={id} role="menu" aria-label={label} data-workspace-actions-menu data-presentation={compact ? 'sheet' : 'popover'}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
    className={compact ? 'fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] max-h-[80dvh] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-2xl outline-none' : 'fixed overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-900/15 outline-none'}
    style={compact ? { zIndex: OPERATIONAL_OVERLAY_LAYERS.workspacePopover } : { left: position?.left ?? 0, top: position?.top ?? 0, width: position?.width ?? 224, maxHeight: position?.maxHeight ?? 280, visibility: position ? 'visible' : 'hidden', zIndex: OPERATIONAL_OVERLAY_LAYERS.workspacePopover }}>
    {compact && <p className="truncate px-3 py-2 text-xs font-semibold text-slate-500">{label}</p>}
    {children}
  </div>, document.body)
}
