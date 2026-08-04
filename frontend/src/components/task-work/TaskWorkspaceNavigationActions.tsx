'use client'

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, Inbox, Settings2, Share2, SlidersHorizontal, Trash2 } from 'lucide-react'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'

type ScopeType = 'all' | 'environment' | 'shared' | 'folder' | 'list' | 'trash'

interface ScopeProps {
  collapsed: boolean
  environmentName: string
  scopeType: ScopeType
  onAll: () => void
  onShared: () => void
}

export function TaskWorkspaceScopeSwitch({ collapsed, environmentName, scopeType, onAll, onShared }: ScopeProps) {
  const allSelected = scopeType === 'all' || scopeType === 'environment'
  if (collapsed) {
    return <div className="space-y-1" role="group" aria-label={`Alcance en ${environmentName}`}>
      <button type="button" aria-pressed={allSelected} aria-label="Todo el Entorno" title={`Todas las tareas visibles de ${environmentName}`} onClick={onAll} className={`flex h-11 w-full items-center justify-center rounded-xl transition ${allSelected ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50'}`}><Inbox className="h-4 w-4" /></button>
      <button type="button" aria-pressed={scopeType === 'shared'} aria-label="Compartidas conmigo" title={`Recursos compartidos contigo dentro de ${environmentName}`} onClick={onShared} className={`flex h-11 w-full items-center justify-center rounded-xl transition ${scopeType === 'shared' ? 'bg-violet-50 text-violet-700' : 'text-slate-500 hover:bg-slate-50'}`}><Share2 className="h-4 w-4" /></button>
    </div>
  }
  return <div data-task-scope-switch className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1" role="group" aria-label={`Alcance en ${environmentName}`}>
    <button type="button" aria-pressed={allSelected} aria-label="Todo el Entorno" title={`Todas las tareas visibles de ${environmentName}`} onClick={onAll} className={`flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-bold transition ${allSelected ? 'bg-white text-emerald-700 shadow-sm ring-1 ring-slate-200/70' : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'}`}><Inbox className="h-3.5 w-3.5 shrink-0" /><span className="truncate">Todo</span></button>
    <button type="button" aria-pressed={scopeType === 'shared'} aria-label="Compartidas conmigo" title={`Recursos compartidos contigo dentro de ${environmentName}`} onClick={onShared} className={`flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-bold transition ${scopeType === 'shared' ? 'bg-white text-violet-700 shadow-sm ring-1 ring-slate-200/70' : 'text-slate-500 hover:bg-white/70 hover:text-slate-700'}`}><Share2 className="h-3.5 w-3.5 shrink-0" /><span className="truncate">Compartidas</span></button>
  </div>
}

interface ManagementProps {
  collapsed: boolean
  canManage: boolean
  trashSelected: boolean
  onTrash: () => void
  onManage: () => void
}

export function TaskWorkspaceManagementActions({ collapsed, canManage, trashSelected, onTrash, onManage }: ManagementProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties>({})

  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }, [])

  useEffect(() => {
    if (!open) return
    const position = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(220, window.innerWidth - 24)
      const left = Math.max(12, Math.min(rect.right + 8, window.innerWidth - width - 12))
      const top = Math.max(12, Math.min(rect.bottom - 96, window.innerHeight - 112))
      setStyle({ left, top, width })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true }))
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])

  if (!collapsed) {
    return <div data-task-management-actions className="grid grid-cols-2 gap-1">
      <button type="button" disabled={!canManage} onClick={onTrash} title={canManage ? 'Papelera' : 'Papelera requiere Administrar'} className={`flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl px-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-35 ${trashSelected ? 'bg-slate-100 text-slate-800' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}><Trash2 className="h-3.5 w-3.5 shrink-0" /><span className="truncate">Papelera</span></button>
      <button type="button" disabled={!canManage} onClick={onManage} title="Administrar Entorno" className="flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl px-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-50 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-30"><Settings2 className="h-3.5 w-3.5 shrink-0" /><span className="truncate">Administrar</span></button>
    </div>
  }

  return <>
    <button ref={triggerRef} type="button" disabled={!canManage} aria-haspopup="menu" aria-expanded={open} aria-label="Gestión del Entorno" title={canManage ? 'Gestión del Entorno' : 'Gestión requiere Administrar'} onClick={() => setOpen(value => !value)} className={`flex h-11 w-full items-center justify-center rounded-xl transition disabled:cursor-not-allowed disabled:opacity-30 ${trashSelected ? 'bg-slate-100 text-slate-800' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}><SlidersHorizontal className="h-4 w-4" /></button>
    {open && typeof document !== 'undefined' && createPortal(<>
      <button type="button" aria-label="Cerrar gestión" className="fixed inset-0 cursor-default" style={{ zIndex: TASK_OVERLAY_LAYERS.workspacePopover - 1 }} onMouseDown={() => close()} />
      <div ref={menuRef} role="menu" aria-label="Gestión del Entorno" style={{ ...style, zIndex: TASK_OVERLAY_LAYERS.workspacePopover }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close() } }} className="fixed rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-900/15">
        <button type="button" role="menuitem" onClick={() => { onTrash(); close(false) }} className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold ${trashSelected ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:bg-slate-50'}`}><Trash2 className="h-4 w-4" /><span className="flex-1">Papelera</span><ChevronRight className="h-3.5 w-3.5 text-slate-300" /></button>
        <button type="button" role="menuitem" onClick={() => { onManage(); close(false) }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-600 hover:bg-slate-50"><Settings2 className="h-4 w-4" /><span className="flex-1">Administrar Entorno</span><ChevronRight className="h-3.5 w-3.5 text-slate-300" /></button>
      </div>
    </>, document.body)}
  </>
}
