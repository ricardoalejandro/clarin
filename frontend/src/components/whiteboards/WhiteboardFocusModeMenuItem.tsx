'use client'

import { Maximize2, Minimize2 } from 'lucide-react'
import {
  WHITEBOARD_FOCUS_ARIA_SHORTCUTS,
  WHITEBOARD_FOCUS_SHORTCUT_LABEL,
} from '@/lib/whiteboardFocusMode'

export default function WhiteboardFocusModeMenuItem({
  active,
  autoFocus,
  onToggle,
}: {
  active: boolean
  autoFocus?: boolean
  onToggle: () => void
}) {
  const Icon = active ? Minimize2 : Maximize2
  const label = active ? 'Volver a vista normal' : 'Maximizar pizarra'

  return <button
    type="button"
    role="menuitem"
    autoFocus={autoFocus}
    data-whiteboard-focus-action={active ? 'restore' : 'maximize'}
    aria-keyshortcuts={WHITEBOARD_FOCUS_ARIA_SHORTCUTS}
    onClick={onToggle}
    className="whiteboard-more-item"
  >
    <Icon className="h-4 w-4 shrink-0" />
    <span className="min-w-0 flex-1">{label}</span>
    <kbd className="shrink-0 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-1 text-[9px] font-black text-slate-400">{WHITEBOARD_FOCUS_SHORTCUT_LABEL}</kbd>
  </button>
}
