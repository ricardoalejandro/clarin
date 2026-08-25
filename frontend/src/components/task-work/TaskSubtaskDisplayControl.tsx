'use client'

import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import type { TaskSubtaskDisplayMode } from './taskListSubtasks'

interface Props {
  mode: TaskSubtaskDisplayMode
  onChange: (mode: TaskSubtaskDisplayMode) => void
  compact?: boolean
}

export default function TaskSubtaskDisplayControl({ mode, onChange, compact = false }: Props) {
  return <div role="group" aria-label="Visualización de subtareas" className="flex h-11 shrink-0 items-center rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
    {!compact && <span className="px-2 text-[11px] font-bold text-slate-500">Subtareas</span>}
    <button
      type="button"
      aria-label="Contraer todas las subtareas"
      aria-pressed={mode === 'collapsed'}
      title="Contraer todas"
      onClick={() => onChange('collapsed')}
      className={`flex h-9 min-w-9 items-center justify-center rounded-lg px-2 outline-none transition focus:ring-2 focus:ring-emerald-400 ${mode === 'collapsed' ? 'bg-slate-100 text-slate-800 shadow-sm' : 'text-slate-400 hover:bg-slate-50 hover:text-slate-600'}`}
    ><ChevronsDownUp className="h-4 w-4" /><span className="sr-only">Contraer todas</span></button>
    <button
      type="button"
      aria-label="Expandir todas las subtareas"
      aria-pressed={mode === 'expanded'}
      title="Expandir todas"
      onClick={() => onChange('expanded')}
      className={`flex h-9 min-w-9 items-center justify-center rounded-lg px-2 outline-none transition focus:ring-2 focus:ring-emerald-400 ${mode === 'expanded' ? 'bg-emerald-50 text-emerald-700 shadow-sm' : 'text-slate-400 hover:bg-slate-50 hover:text-slate-600'}`}
    ><ChevronsUpDown className="h-4 w-4" /><span className="sr-only">Expandir todas</span></button>
  </div>
}
