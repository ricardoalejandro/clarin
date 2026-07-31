'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Minimize2, Move, PanelRight, X, type LucideIcon } from 'lucide-react'
import useTaskWindow, { type TaskWindowMode, type TaskWindowResizeEdge } from './useTaskWindow'
import { taskWindowVisualState } from './taskInteractionVisuals'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'

const RESIZE_HANDLES: Record<TaskWindowResizeEdge, string> = {
  n: 'left-3 right-3 top-0 h-2 cursor-n-resize',
  e: 'bottom-3 right-0 top-3 w-2 cursor-e-resize',
  s: 'bottom-0 left-3 right-3 h-2 cursor-s-resize',
  w: 'bottom-3 left-0 top-3 w-2 cursor-w-resize',
  ne: 'right-0 top-0 h-4 w-4 cursor-ne-resize',
  nw: 'left-0 top-0 h-4 w-4 cursor-nw-resize',
  se: 'bottom-0 right-0 h-4 w-4 cursor-se-resize',
  sw: 'bottom-0 left-0 h-4 w-4 cursor-sw-resize',
}

interface Props {
  open: boolean
  storageKey: string
  title: string
  eyebrow: string
  description?: string
  icon?: LucideIcon
  defaultMode?: Exclude<TaskWindowMode, 'maximized'>
  defaultWidth?: number
  defaultHeight?: number
  minWidth?: number
  minHeight?: number
  align?: 'center' | 'right'
  busy?: boolean
  onRequestClose: () => void
  children: ReactNode
  footer?: ReactNode
  headerActions?: ReactNode
  contentClassName?: string
  dataAttribute?: string
}

function isTemporaryOverlayOpen() {
  return Boolean(document.querySelector(
    '[data-task-picker-backdrop], [data-task-destructive-dialog], [data-task-color-picker], [data-task-icon-picker]',
  ))
}

export default function TaskWorkWindowShell({
  open,
  storageKey,
  title,
  eyebrow,
  description,
  icon: Icon,
  defaultMode = 'floating',
  defaultWidth = 920,
  defaultHeight = 760,
  minWidth = 520,
  minHeight = 480,
  align = 'center',
  busy = false,
  onRequestClose,
  children,
  footer,
  headerActions,
  contentClassName = 'min-h-0 flex-1 overflow-y-auto',
  dataAttribute = 'task-work-window',
}: Props) {
  const windowState = useTaskWindow({ storageKey, defaultMode, defaultWidth, defaultHeight, minWidth, minHeight, align })
  const panelRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onRequestClose)
  const busyRef = useRef(busy)
  closeRef.current = onRequestClose
  busyRef.current = busy

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) return
      const activeElement = document.activeElement
      if (activeElement instanceof HTMLElement && panel.contains(activeElement)) return
      panel.focus({ preventScroll: true })
    })
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented || busyRef.current || isTemporaryOverlayOpen()) return
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !windowState.isModal || isTemporaryOverlayOpen() || !panelRef.current) return
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
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
    window.addEventListener('keydown', keyboard)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', keyboard)
      previousFocusRef.current?.focus({ preventScroll: true })
      previousFocusRef.current = null
    }
  }, [open, windowState.isModal])

  if (!open || typeof document === 'undefined') return null
  const visual = taskWindowVisualState(windowState.effectiveMode, windowState.isMobile)
  const rounded = windowState.effectiveMode === 'maximized' || windowState.isMobile
    ? 'rounded-none sm:rounded-2xl'
    : windowState.effectiveMode === 'docked'
      ? 'rounded-l-3xl'
      : 'rounded-3xl'

  return createPortal(
    <div
      data-task-work-window-shell
      data-window-kind={dataAttribute}
      data-window-mode={windowState.effectiveMode}
      data-backdrop-mode={visual.blocksWorkspace ? 'modal' : windowState.effectiveMode}
      style={{ ...visual.backdropStyle, zIndex: TASK_OVERLAY_LAYERS.window }}
      className={`fixed inset-0 transition-[background-color,backdrop-filter] duration-200 ${visual.blocksWorkspace ? '' : 'pointer-events-none'}`}
      onMouseDown={event => {
        if (visual.blocksWorkspace && event.target === event.currentTarget && !busy) onRequestClose()
      }}
    >
      <section
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal={visual.blocksWorkspace}
        aria-label={title}
        aria-busy={busy}
        style={windowState.panelStyle}
        className={`pointer-events-auto fixed flex flex-col overflow-hidden border border-white/80 bg-white shadow-[0_32px_90px_rgba(15,23,42,0.30)] ring-1 ring-slate-900/10 outline-none ${rounded}`}
      >
        {windowState.effectiveMode === 'floating' && (Object.entries(RESIZE_HANDLES) as Array<[TaskWindowResizeEdge, string]>).map(([edge, classes]) => (
          <div key={edge} aria-hidden className={`absolute z-30 ${classes}`} onPointerDown={event => windowState.beginResize(edge, event)} />
        ))}
        <header
          onPointerDown={windowState.beginDrag}
          onDoubleClick={event => {
            if (!(event.target as HTMLElement).closest('button,a,input,textarea,select,[data-no-window-drag]')) windowState.toggleMaximized()
          }}
          className={`relative z-20 flex shrink-0 select-none items-start gap-3 border-b border-slate-100 bg-white px-5 py-4 sm:px-6 ${windowState.effectiveMode === 'floating' ? 'cursor-move' : ''}`}
        >
          {Icon && <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700"><Icon className="h-5 w-5" /></span>}
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-black uppercase tracking-[.18em] text-emerald-600">{eyebrow}</p>
            <h2 className="mt-1 truncate text-lg font-black text-slate-900 sm:text-xl">{title}</h2>
            {description && <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">{description}</p>}
          </div>
          <div data-no-window-drag className="flex shrink-0 items-center gap-1">
            {headerActions}
            {!windowState.isMobile && <>
              <button type="button" title="Acoplar a la derecha" aria-label="Acoplar a la derecha" onClick={() => windowState.setMode('docked')} className={`flex h-9 w-9 items-center justify-center rounded-xl transition ${windowState.effectiveMode === 'docked' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'}`}><PanelRight className="h-4 w-4" /></button>
              <button type="button" title="Ventana flotante" aria-label="Ventana flotante" onClick={() => windowState.setMode('floating')} className={`flex h-9 w-9 items-center justify-center rounded-xl transition ${windowState.effectiveMode === 'floating' ? 'bg-emerald-50 text-emerald-700' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'}`}><Move className="h-4 w-4" /></button>
              <button type="button" title={windowState.effectiveMode === 'maximized' ? 'Restaurar' : 'Maximizar'} aria-label={windowState.effectiveMode === 'maximized' ? 'Restaurar' : 'Maximizar'} onClick={windowState.toggleMaximized} className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">{windowState.effectiveMode === 'maximized' ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</button>
            </>}
            <button type="button" disabled={busy} aria-label={`Cerrar ${title}`} onClick={onRequestClose} className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"><X className="h-5 w-5" /></button>
          </div>
        </header>
        <div className={contentClassName}>{children}</div>
        {footer && <footer data-no-window-drag className="relative z-20 shrink-0 border-t border-slate-100 bg-slate-50/85 px-5 py-3 backdrop-blur sm:px-6">{footer}</footer>}
      </section>
    </div>,
    document.body,
  )
}
