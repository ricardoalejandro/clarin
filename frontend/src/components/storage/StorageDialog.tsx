'use client'
import { useId, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'

export function StorageDialog({ title, description, children, footer, onClose, busy = false, wide = false, initialFocusRef }: { title: string; description?: string; children: ReactNode; footer?: ReactNode; onClose: () => void; busy?: boolean; wide?: boolean; initialFocusRef?: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  useAccessibleDialog(true, ref, () => { if (!busy) onClose() }, initialFocusRef || closeRef)
  return createPortal(<div className="fixed inset-0 flex items-center justify-center bg-slate-950/50 p-2 backdrop-blur-[2px] sm:p-4" style={{ zIndex: OPERATIONAL_OVERLAY_LAYERS.dialog }} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined} aria-busy={busy} tabIndex={-1} className={`flex max-h-[calc(100dvh-16px)] w-full min-w-0 flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl outline-none sm:max-h-[calc(100dvh-32px)] ${wide ? 'max-w-4xl' : 'max-w-xl'}`}>
      <header className="flex shrink-0 items-start gap-3 border-b border-slate-200 px-4 py-4 sm:px-6"><div className="min-w-0 flex-1"><h2 id={`${id}-title`} className="break-words text-lg font-semibold text-slate-900">{title}</h2>{description && <p id={`${id}-description`} className="mt-1 text-sm leading-5 text-slate-500">{description}</p>}</div><button ref={closeRef} onClick={onClose} disabled={busy} aria-label="Cerrar ventana" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40"><X className="h-5 w-5" /></button></header>
      <div className="min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-6">{children}</div>
      {footer && <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 p-4 sm:px-6">{footer}</footer>}
    </div>
  </div>, document.body)
}
