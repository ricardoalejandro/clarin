'use client'

import { useState } from 'react'
import {
  Activity,
  BarChart3,
  ChevronDown,
  CircleAlert,
  Clock3,
  FileDown,
  ListChecks,
  MessageCircleQuestion,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'

export interface ErosQuickTaskParameter {
  name: string
  label: string
  type: string
  default?: unknown
  options?: unknown[]
}

export interface ErosQuickTask {
  key: string
  title: string
  description: string
  icon?: string
  category?: string
  parameters?: ErosQuickTaskParameter[]
  defaults?: Record<string, unknown>
  input_schema?: Record<string, unknown>
}

interface Props {
  tasks: ErosQuickTask[]
  loading: boolean
  disabled?: boolean
  onRun: (task: ErosQuickTask) => void
}

const iconByTask: Record<string, typeof Sparkles> = {
  lead_cycle_summary: BarChart3,
  lead_operational_search: Search,
  lead_unmanaged: CircleAlert,
  lead_followup_priority: Activity,
  chat_unanswered: MessageCircleQuestion,
  task_overdue: Clock3,
  lead_data_quality: ShieldCheck,
  performance_overview: BarChart3,
  export_current_result: FileDown,
}

const categoryIcon: Record<string, typeof Sparkles> = {
  leads: Search,
  chats: MessageCircleQuestion,
  tasks: ListChecks,
  reports: BarChart3,
  export: FileDown,
}

export default function ErosQuickTasks({ tasks, loading, disabled, onRun }: Props) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? tasks : tasks.slice(0, 4)

  if (loading) {
    return (
      <div className="mt-4 grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Cargando tareas rápidas">
        {[0, 1, 2, 3].map(index => (
          <div key={index} className="h-[68px] animate-pulse rounded-xl border border-slate-200 bg-white/70" />
        ))}
      </div>
    )
  }

  if (tasks.length === 0) return null

  return (
    <div className="mt-4 w-full max-w-2xl">
      <div className="mb-2 flex items-center justify-between px-0.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Acciones frecuentes</p>
        <span className="text-[10px] text-slate-400">Lectura y exportación</span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {visible.map(task => {
          const Icon = iconByTask[task.key] || categoryIcon[task.category || ''] || Sparkles
          return (
            <button
              key={task.key}
              type="button"
              disabled={disabled}
              onClick={() => onRun(task)}
              className="group flex min-w-0 items-start gap-2.5 rounded-xl border border-slate-200/80 bg-white/90 p-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 transition-colors group-hover:bg-emerald-100">
                <Icon size={16} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-slate-700">{task.title}</span>
                <span className="mt-0.5 line-clamp-2 block text-[10px] leading-4 text-slate-500">{task.description}</span>
              </span>
            </button>
          )
        })}
      </div>
      {tasks.length > 4 && (
        <button
          type="button"
          onClick={() => setExpanded(value => !value)}
          className="mx-auto mt-2 flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
          aria-expanded={expanded}
        >
          {expanded ? 'Ver menos' : `Ver todas (${tasks.length})`}
          <ChevronDown size={13} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
