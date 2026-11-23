'use client'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { OPERATIONAL_OVERLAY_LAYERS, useOperationalOverlayPortal } from '@/components/operational-window/OperationalOverlayContext'

export default function ConversationMenu({ anchor, children, label = 'Acciones de la conversación', onClose }: { anchor: RefObject<HTMLButtonElement | null>; children: ReactNode; label?: string; onClose?: () => void }) {
  const root = useRef<HTMLDivElement>(null)
  const portal = useOperationalOverlayPortal()
  const [position, setPosition] = useState({ top: 8, left: 8, maxHeight: 400 })
  useEffect(() => {
    if (!onClose) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) onClose() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [anchor, onClose])
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect(); if (!rect || !root.current) return
      const viewport = window.visualViewport, left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0, width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight
      const menuHeight = Math.min(root.current.scrollHeight, height - 16)
      setPosition({ top: Math.max(top + 8, rect.bottom + menuHeight + 8 <= top + height ? rect.bottom + 4 : rect.top - menuHeight - 4), left: Math.max(left + 8, Math.min(rect.right - 256, left + width - 264)), maxHeight: height - 16 })
    }
    place(); root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true); window.visualViewport?.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); window.visualViewport?.removeEventListener('resize', place) }
  }, [anchor])
  return createPortal(<div ref={root} data-chat-overlay="conversation-menu" role="menu" aria-label={label} style={{ ...position, width: 'min(256px, calc(100vw - 16px))', zIndex: portal ? OPERATIONAL_OVERLAY_LAYERS.menu : 80 }} className="fixed overflow-y-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl" onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
    if (event.key === 'Escape' && onClose) { event.preventDefault(); event.stopPropagation(); onClose(); anchor.current?.focus(); return }
    if (event.key === 'Tab' && onClose) { onClose(); anchor.current?.focus(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault(); const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []), index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
  }}>{children}</div>, portal || document.body)
}
