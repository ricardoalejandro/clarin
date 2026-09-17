'use client'

import { Loader2, Search, X } from 'lucide-react'

interface ProgramAttendanceSearchBarProps {
  value: string
  pending: boolean
  resultCount: number
  totalCount: number
  disabled?: boolean
  onChange: (value: string) => void
  onClear: () => void
}

export default function ProgramAttendanceSearchBar({
  value,
  pending,
  resultCount,
  totalCount,
  disabled = false,
  onChange,
  onClear,
}: ProgramAttendanceSearchBarProps) {
  return (
    <div className="flex w-full min-w-0 items-center gap-2" data-testid="program-attendance-search-bar">
      <div className="relative min-w-0 flex-1">
        <label htmlFor="program-attendance-search" className="sr-only">Buscar participante por nombre o teléfono</label>
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input
          id="program-attendance-search"
          type="search"
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder="Buscar participante por nombre o teléfono"
          autoComplete="off"
          enterKeyHint="search"
          disabled={disabled}
          className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-24 text-sm text-slate-800 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-70"
          aria-describedby="program-attendance-search-status"
        />
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
          {pending ? (
            <span id="program-attendance-search-status" className="flex h-9 items-center gap-1 px-2 text-[11px] font-semibold text-slate-400" aria-live="polite">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              <span className="hidden min-[420px]:inline">Buscando…</span>
              <span className="sr-only">Buscando participantes</span>
            </span>
          ) : (
            <span id="program-attendance-search-status" className="px-2 text-[11px] font-semibold tabular-nums text-slate-400" aria-live="polite">
              {resultCount} de {totalCount}
            </span>
          )}
          {value && (
            <button
              type="button"
              onClick={onClear}
              disabled={disabled}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Limpiar búsqueda de asistencia"
              title="Limpiar búsqueda"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
