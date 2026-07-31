'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Loader2, Search, UserRound, X } from 'lucide-react'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import type { TaskAccountUser } from './TaskEditorModal'
import { TASK_OVERLAY_LAYERS } from './taskOverlayLayers'

interface Props {
  users: TaskAccountUser[]
  value: string
  onChange: (userId: string) => void
  placeholder?: string
  disabled?: boolean
  excludeIds?: string[]
  allowClear?: boolean
  className?: string
}

const initials = (user?: TaskAccountUser) => (user?.display_name || user?.username || '?').trim().slice(0, 2).toUpperCase()

export default function TaskUserCombobox({ users, value, onChange, placeholder = 'Selecciona una persona', disabled, excludeIds = [], allowClear = false, className = '' }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useDebouncedValue(query)
  const [highlighted, setHighlighted] = useState(0)
  const [style, setStyle] = useState<CSSProperties>({})
  const selected = users.find(user => user.id === value)

  const filtered = useMemo(() => {
    const blocked = new Set(excludeIds)
    const needle = debouncedQuery.trim().toLocaleLowerCase('es')
    return users.filter(user => {
      if (blocked.has(user.id)) return false
      if (!needle) return true
      return `${user.display_name} ${user.username} ${user.role || ''}`.toLocaleLowerCase('es').includes(needle)
    })
  }, [debouncedQuery, excludeIds, users])

  useEffect(() => { setHighlighted(0) }, [debouncedQuery, open])
  useEffect(() => {
    if (!open) return
    const position = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(Math.max(280, rect.width), window.innerWidth - 24)
      const roomBelow = window.innerHeight - rect.bottom
      const openAbove = roomBelow < 330 && rect.top > roomBelow
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
  const choose = (id: string) => { onChange(id); close() }

  return <>
    <button ref={triggerRef} type="button" disabled={disabled} onClick={() => setOpen(current => !current)} aria-haspopup="listbox" aria-expanded={open} className={`flex w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left text-sm outline-none transition hover:border-slate-300 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 disabled:opacity-50 ${className}`}>
      {selected ? <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[10px] font-bold text-emerald-700">{initials(selected)}</span> : <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100"><UserRound className="h-3.5 w-3.5 text-slate-400" /></span>}
      <span className={`min-w-0 flex-1 truncate ${selected ? 'font-semibold text-slate-700' : 'text-slate-400'}`}>{selected ? selected.display_name || selected.username : placeholder}</span>
      {selected && allowClear && <span role="button" tabIndex={-1} onClick={event => { event.stopPropagation(); onChange('') }} className="rounded p-1 text-slate-300 hover:bg-slate-100 hover:text-slate-600"><X className="h-3.5 w-3.5" /></span>}
      <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && typeof document !== 'undefined' && createPortal(<>
      <button type="button" aria-label="Cerrar selector" data-task-picker-backdrop className="fixed inset-0 cursor-default" style={{ zIndex: TASK_OVERLAY_LAYERS.pickerBackdrop }} onMouseDown={() => close(false)} />
      <div data-task-user-combobox-portal style={{ ...style, zIndex: TASK_OVERLAY_LAYERS.picker }} onKeyDown={event => {
        if (event.key !== 'Tab') return
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])'))
        if (!focusable.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }} className="fixed overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/15">
        <div className="relative border-b border-slate-100 p-2.5"><Search className="absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input ref={inputRef} value={query} onChange={event => { const next = event.target.value; setQuery(next); if (!next) setDebouncedQuery('') }} onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
          if (event.key === 'ArrowDown') { event.preventDefault(); setHighlighted(index => Math.min(filtered.length - 1, index + 1)) }
          if (event.key === 'ArrowUp') { event.preventDefault(); setHighlighted(index => Math.max(0, index - 1)) }
          if (event.key === 'Enter' && filtered[highlighted]) { event.preventDefault(); choose(filtered[highlighted].id) }
        }} placeholder="Escribe un nombre o usuario…" className="w-full rounded-xl bg-slate-50 py-2.5 pl-10 pr-10 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-emerald-200" />{query !== debouncedQuery && <Loader2 aria-label="Esperando para buscar" className="absolute right-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-emerald-500" />}</div>
        <div role="listbox" className="max-h-64 overflow-y-auto p-1.5">
          {filtered.map((user, index) => <button key={user.id} type="button" role="option" aria-selected={user.id === value} onMouseEnter={() => setHighlighted(index)} onClick={() => choose(user.id)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ${index === highlighted ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-bold text-slate-600">{initials(user)}</span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-700">{user.display_name || user.username}</span><span className="block truncate text-[11px] text-slate-400">@{user.username}{user.role ? ` · ${user.role}` : ''}</span></span>
            {user.id === value && <Check className="h-4 w-4 text-emerald-600" />}
          </button>)}
          {!filtered.length && <div className="px-4 py-8 text-center"><UserRound className="mx-auto h-6 w-6 text-slate-300" /><p className="mt-2 text-xs text-slate-400">No encontramos usuarios.</p></div>}
        </div>
      </div>
    </>, document.body)}
  </>
}
