'use client'

import { useId, useState } from 'react'
import { MoreHorizontal, type LucideIcon } from 'lucide-react'
import WorkspaceActionsMenu from '@/components/operational-overlay/WorkspaceActionsMenu'

export interface UtilityMenuAction { id: string; label: string; icon: LucideIcon; disabled?: boolean; destructive?: boolean; onSelect: () => void }

export function UtilityActionMenu({ label, actions, className, icon: Icon = MoreHorizontal, showLabel = false }: {
  label: string; actions: UtilityMenuAction[]; className: string; icon?: LucideIcon; showLabel?: boolean
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const id = `utility-menu-${useId().replace(/:/g, '')}`
  return <>
    <button type="button" className={className} aria-label={label} aria-haspopup="menu" aria-expanded={Boolean(anchor)} aria-controls={anchor ? id : undefined}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setAnchor(event.currentTarget) } }}
      onClick={event => { const target = event.currentTarget; setAnchor(current => current ? null : target) }}><Icon size={16} aria-hidden />{showLabel && <span>{label}</span>}</button>
    {anchor && <WorkspaceActionsMenu anchor={anchor} id={id} label={label} onClose={() => setAnchor(null)}>
      {actions.map(action => <button key={action.id} type="button" role="menuitem" disabled={action.disabled}
        className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:opacity-40 ${action.destructive ? 'text-rose-700 hover:bg-rose-50' : 'text-slate-700 hover:bg-slate-100'}`}
        onClick={() => { setAnchor(null); anchor.focus({ preventScroll: true }); action.onSelect() }}><action.icon size={15} aria-hidden /><span>{action.label}</span></button>)}
    </WorkspaceActionsMenu>}
  </>
}
