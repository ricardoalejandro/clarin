'use client'

import { ArrowLeft } from 'lucide-react'
import { WHITEBOARD_FOCUS_ARIA_SHORTCUTS, WHITEBOARD_FOCUS_SHORTCUT_LABEL } from '@/lib/whiteboardFocusMode'

/** Compact editors need a visible exit even when their integrated title is absent. */
export default function WhiteboardFocusRestoreBar({
  active,
  integratedTitle,
  onRestore,
}: {
  active: boolean
  integratedTitle: boolean
  onRestore: () => void
}) {
  if (!active || integratedTitle) return null
  return <div data-whiteboard-focus-restore-bar className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-white px-2">
    <button type="button" onClick={onRestore} aria-keyshortcuts={WHITEBOARD_FOCUS_ARIA_SHORTCUTS} className="flex h-11 min-w-11 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500">
      <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>Volver a vista normal</span>
    </button>
    <kbd className="hidden shrink-0 text-[10px] text-slate-400 sm:block">{WHITEBOARD_FOCUS_SHORTCUT_LABEL}</kbd>
  </div>
}
