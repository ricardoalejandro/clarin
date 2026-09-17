'use client'

import { createPortal } from 'react-dom'
import { useRef, type RefObject } from 'react'
import { X } from 'lucide-react'
import { WHITEBOARD_OVERLAY_LAYERS } from '@/lib/whiteboardFocusMode'
import { useWhiteboardDialogFocus } from './useWhiteboardDialogFocus'

export default function WhiteboardModal({
  title,
  description,
  onClose,
  children,
  wide = false,
  initialFocusRef,
}: {
  title: string
  description: string
  onClose: () => void
  children: React.ReactNode
  wide?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useWhiteboardDialogFocus(dialogRef, onClose, initialFocusRef)

  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center bg-slate-950/55 p-3 backdrop-blur-sm sm:p-5" style={{ zIndex: WHITEBOARD_OVERLAY_LAYERS.dialog }} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="whiteboard-modal-title" aria-describedby="whiteboard-modal-description" className={`flex max-h-[min(760px,calc(100dvh-1.5rem))] w-full flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl outline-none ${wide ? 'max-w-3xl' : 'max-w-lg'}`}>
        <header className="flex shrink-0 items-start gap-4 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id="whiteboard-modal-title" className="text-lg font-black text-slate-900">{title}</h2>
            <p id="whiteboard-modal-description" className="mt-1 text-sm leading-5 text-slate-500">{description}</p>
          </div>
          <button type="button" data-whiteboard-dialog-close onClick={onClose} aria-label="Cerrar" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
