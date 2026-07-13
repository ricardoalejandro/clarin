'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Loader2, Megaphone, Search, UsersRound } from 'lucide-react'
import type { WhatsAppGroupOption } from '@/types/report'

interface Props {
  groups: WhatsAppGroupOption[]
  value: string
  onChange: (group: WhatsAppGroupOption) => void
  loading?: boolean
  disabled?: boolean
}

const kindLabels: Record<WhatsAppGroupOption['kind'], string> = {
  group: 'Grupo',
  community: 'Comunidad',
  announcement: 'Anuncios',
}

export default function WhatsAppGroupSelector({ groups, value, onChange, loading = false, disabled = false }: Props) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const selected = groups.find(group => group.id === value)
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es')
    if (!term) return groups
    return groups.filter(group => group.name.toLocaleLowerCase('es').includes(term))
  }, [groups, search])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    requestAnimationFrame(() => searchRef.current?.focus())
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  useEffect(() => {
    setActiveIndex(0)
  }, [search, groups])

  const select = (group: WhatsAppGroupOption) => {
    onChange(group)
    setOpen(false)
    setSearch('')
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      setOpen(false)
      return
    }
    if (!open && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      setOpen(true)
      return
    }
    if (!open || filtered.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(index => Math.min(filtered.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(index => Math.max(0, index - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      select(filtered[Math.min(activeIndex, filtered.length - 1)])
    }
  }

  return (
    <div ref={rootRef} className="relative" onKeyDown={handleKeyDown}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls="whatsapp-group-options"
        disabled={disabled || loading}
        onClick={() => setOpen(current => !current)}
        className="w-full min-h-[58px] flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-left shadow-sm transition hover:border-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 disabled:cursor-not-allowed disabled:bg-slate-50"
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <UsersRound className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className={`truncate text-sm font-semibold ${selected ? 'text-slate-800' : 'text-slate-400'}`}>
            {loading ? 'Cargando grupos…' : selected?.name || 'Selecciona un grupo de WhatsApp'}
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            {selected ? `${selected.participant_count} integrantes · ${kindLabels[selected.kind]}` : 'Busca por nombre entre todos los grupos disponibles'}
          </p>
        </div>
        <ChevronDown className={`h-5 w-5 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-40 mt-2 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/15">
          <div className="sticky top-0 z-10 border-b border-slate-100 bg-white p-3">
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                ref={searchRef}
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Buscar grupo…"
                className="h-10 w-full bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400"
              />
            </div>
          </div>
          <div id="whatsapp-group-options" role="listbox" className="max-h-[380px] overflow-y-auto p-2">
            {filtered.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-slate-400">No se encontraron grupos</div>
            ) : filtered.map((group, index) => (
              <button
                key={group.id}
                type="button"
                role="option"
                aria-selected={group.id === value}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(group)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition ${index === activeIndex ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}
              >
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${group.kind === 'announcement' ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-500'}`}>
                  {group.kind === 'announcement' ? <Megaphone className="h-5 w-5" /> : <UsersRound className="h-5 w-5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-slate-800">{group.name}</span>
                    {group.suspended && <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600">Suspendido</span>}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-400">{group.participant_count} integrantes · {kindLabels[group.kind]}</p>
                </div>
                {group.id === value && <Check className="h-5 w-5 shrink-0 text-emerald-600" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
