'use client'

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check, Loader2, Plus, Search, UserRound, X } from 'lucide-react'
import type { TaskAccountUser } from './TaskEditorModal'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'

interface Props {
  users: TaskAccountUser[]
  value: string[]
  ownerID: string
  onChange: (userIDs: string[]) => void
  disabled?: boolean
  pending?: boolean
  emptyLabel?: string
}

const initials = (user?: TaskAccountUser) => (user?.display_name || user?.username || '?').trim().slice(0, 2).toUpperCase()

export default function TaskCollaboratorPicker({ users, value, ownerID, onChange, disabled, pending, emptyLabel = 'Sin colaboradores adicionales.' }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useDebouncedValue(query)
  const [highlighted, setHighlighted] = useState(0)
  const [style, setStyle] = useState<CSSProperties>({})
  const selected = useMemo(() => value.map(id => users.find(user => user.id === id)).filter((user): user is TaskAccountUser => Boolean(user) && user!.id !== ownerID), [ownerID, users, value])
  const available = useMemo(() => {
    const selectedIDs = new Set(selected.map(user => user.id))
    const needle = debouncedQuery.trim().toLocaleLowerCase('es')
    return users.filter(user => user.id !== ownerID && !selectedIDs.has(user.id) && (!needle || `${user.display_name} ${user.username} ${user.role || ''}`.toLocaleLowerCase('es').includes(needle)))
  }, [debouncedQuery, ownerID, selected, users])

  useEffect(() => { setHighlighted(0) }, [debouncedQuery, open])
  useEffect(() => {
    if (!open) return
    const position = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(Math.max(300, rect.width), window.innerWidth - 24)
      const roomBelow = window.innerHeight - rect.bottom
      const openAbove = roomBelow < 340 && rect.top > roomBelow
      setStyle({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width, ...(openAbove ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])

  const close = (restoreFocus = true) => {
    setOpen(false)
    setQuery('')
    setDebouncedQuery('')
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const add = (userID: string) => { onChange([...selected.map(user => user.id), userID]); close() }
  const remove = (userID: string) => onChange(selected.filter(user => user.id !== userID).map(user => user.id))

  return <div data-task-collaborator-picker>
    <div className="flex flex-wrap items-center gap-2">
      {selected.map(user => <span key={user.id} className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 py-1 pl-1.5 pr-1 text-xs font-semibold text-emerald-800"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-[9px] font-black text-emerald-700 shadow-sm">{initials(user)}</span><span className="max-w-40 truncate">{user.display_name || user.username}</span><button type="button" disabled={disabled || pending} onClick={() => remove(user.id)} aria-label={`Quitar a ${user.display_name || user.username}`} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-emerald-600 hover:bg-emerald-100 disabled:opacity-40"><X className="h-3.5 w-3.5" /></button></span>)}
      {!selected.length && <span className="text-xs text-slate-400">{emptyLabel}</span>}
      <button ref={triggerRef} type="button" disabled={disabled || pending || users.filter(user => user.id !== ownerID).length === selected.length} onClick={() => setOpen(current => !current)} aria-haspopup="listbox" aria-expanded={open} className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-dashed border-slate-300 bg-white px-3 text-xs font-semibold text-slate-600 transition hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-40">{pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Añadir colaborador</button>
    </div>
    {open && typeof document !== 'undefined' && createPortal(<>
      <button type="button" aria-label="Cerrar colaboradores" data-task-picker-backdrop className="fixed inset-0 cursor-default" style={{ zIndex: TASK_OVERLAY_LAYERS.pickerBackdrop }} onMouseDown={() => close(false)} />
      <div data-task-collaborator-picker-portal style={{ ...style, zIndex: TASK_OVERLAY_LAYERS.picker }} className="fixed overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/15">
        <div className="relative border-b border-slate-100 p-2.5"><Search className="absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input ref={inputRef} value={query} onChange={event => { const next = event.target.value; setQuery(next); if (!next) setDebouncedQuery('') }} onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
          if (event.key === 'ArrowDown') { event.preventDefault(); setHighlighted(index => Math.min(available.length - 1, index + 1)) }
          if (event.key === 'ArrowUp') { event.preventDefault(); setHighlighted(index => Math.max(0, index - 1)) }
          if (event.key === 'Enter' && available[highlighted]) { event.preventDefault(); add(available[highlighted].id) }
        }} placeholder="Buscar por nombre, usuario o rol…" className="w-full rounded-xl bg-slate-50 py-2.5 pl-10 pr-10 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-emerald-200" />{query !== debouncedQuery && <Loader2 aria-label="Esperando para buscar" className="absolute right-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-emerald-500" />}</div>
        <div role="listbox" aria-label="Añadir colaborador" className="max-h-64 overflow-y-auto p-1.5">{available.map((user, index) => <button key={user.id} type="button" role="option" aria-selected={false} onMouseEnter={() => setHighlighted(index)} onClick={() => add(user.id)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ${highlighted === index ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-black text-slate-600">{initials(user)}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-700">{user.display_name || user.username}</span><span className="block truncate text-[10px] text-slate-400">@{user.username}{user.role ? ` · ${user.role}` : ''}</span></span><Check className="h-4 w-4 text-transparent" /></button>)}{!available.length && <div className="px-4 py-8 text-center"><UserRound className="mx-auto h-6 w-6 text-slate-300" /><p className="mt-2 text-xs text-slate-400">No hay más usuarios disponibles.</p></div>}</div>
      </div>
    </>, document.body)}
  </div>
}
