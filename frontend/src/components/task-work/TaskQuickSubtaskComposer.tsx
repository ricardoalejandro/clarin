'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarRange, Flag, Loader2, Plus, Save, UserRound, Workflow, X } from 'lucide-react'
import type { Task, TaskPriority, TaskWorkflowStatus } from '@/types/task'
import type { TaskAccountUser } from './TaskEditorModal'
import TaskUserCombobox from './TaskUserCombobox'
import { TaskPriorityPicker, TaskStatusPicker } from './TaskPropertyPicker'
import TaskDateRangePicker from './TaskDateRangePicker'
import { preferredStatusForCategory } from './taskStatusTransition'

export interface TaskQuickSubtaskDraft {
  title: string
  statusId: string
  assignedTo: string
  priority: TaskPriority
  startAt: string
  dueAt: string
  isAllDay: boolean
}

export function createTaskQuickSubtaskDraft(parent: Pick<Task, 'assigned_to'>, statuses: TaskWorkflowStatus[]): TaskQuickSubtaskDraft {
  return {
    title: '',
    statusId: preferredStatusForCategory(statuses, 'not_started')?.id || '',
    assignedTo: parent.assigned_to,
    priority: 'medium',
    startAt: '',
    dueAt: '',
    isAllDay: false,
  }
}

interface Props {
  parent: Pick<Task, 'id' | 'assigned_to'>
  value: TaskQuickSubtaskDraft
  statuses: TaskWorkflowStatus[]
  users: TaskAccountUser[]
  onChange: (draft: TaskQuickSubtaskDraft) => void
  onSubmit: (draft: TaskQuickSubtaskDraft) => void | Promise<void>
  onCancel: () => void
  onMoreOptions?: (draft: TaskQuickSubtaskDraft) => void
  pending?: boolean
  disabled?: boolean
  error?: string
  autoFocus?: boolean
  compact?: boolean
}

export default function TaskQuickSubtaskComposer({ parent, value, statuses, users, onChange, onSubmit, onCancel, onMoreOptions, pending = false, disabled = false, error, autoFocus = false, compact = false }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [expanded, setExpanded] = useState(Boolean(value.title || value.startAt || value.dueAt))
  const canSubmit = Boolean(value.title.trim() && value.statusId && value.assignedTo && !pending && !disabled)
  const selectedStatus = useMemo(() => statuses.find(status => status.id === value.statusId), [statuses, value.statusId])

  useEffect(() => {
    if (autoFocus) {
      setExpanded(true)
      window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0)
    }
  }, [autoFocus, parent.id])

  const patch = <K extends keyof TaskQuickSubtaskDraft,>(key: K, next: TaskQuickSubtaskDraft[K]) => onChange({ ...value, [key]: next })
  const cancel = () => {
    setExpanded(false)
    onCancel()
  }

  return <div data-task-quick-subtask-composer className={`rounded-2xl border bg-white transition duration-200 ${expanded ? 'border-emerald-200 shadow-[0_12px_32px_rgba(15,23,42,0.08)] ring-4 ring-emerald-50/70' : 'border-slate-200 hover:border-slate-300'} ${compact ? 'p-2' : 'p-3'}`}>
    <div className="flex items-center gap-2">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-slate-300 bg-slate-50 text-slate-400"><Plus className="h-4 w-4" /></span>
      <input
        ref={inputRef}
        value={value.title}
        disabled={disabled || pending}
        onFocus={() => setExpanded(true)}
        onChange={event => patch('title', event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            cancel()
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            if (canSubmit) void onSubmit(value)
          }
        }}
        aria-label="Nombre de la subtarea"
        placeholder="Añadir una subtarea…"
        className="min-h-10 min-w-0 flex-1 rounded-xl border border-transparent bg-transparent px-2 text-sm font-semibold text-slate-800 outline-none placeholder:font-normal placeholder:text-slate-400 focus:border-emerald-300 focus:bg-white focus:ring-4 focus:ring-emerald-50 disabled:opacity-60"
      />
      {!expanded && onMoreOptions && <button type="button" aria-label="Crear con detalles" title="Crear con todos los campos" disabled={pending || disabled} onClick={() => onMoreOptions(value)} className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2.5 text-[11px] font-bold text-slate-600 outline-none transition hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 focus:ring-2 focus:ring-emerald-400 disabled:opacity-50"><Plus className="h-3.5 w-3.5" /><span className="hidden sm:inline">Detalles</span></button>}
      {!expanded && !onMoreOptions && <span className="hidden text-[10px] font-medium text-slate-400 sm:block">Enter para guardar</span>}
    </div>

    {expanded && <div className="mt-3 border-t border-slate-100 pt-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div><span className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400"><Workflow className="h-3 w-3" /> Estado</span><TaskStatusPicker compact value={value.statusId} statuses={statuses} disabled={disabled} pending={pending} onChange={statusId => patch('statusId', statusId)} /></div>
        <div><span className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400"><UserRound className="h-3 w-3" /> Responsable</span><TaskUserCombobox users={users} value={value.assignedTo} disabled={disabled || pending} onChange={assignedTo => patch('assignedTo', assignedTo)} className="min-h-9 py-1.5" /></div>
        <div><span className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400"><CalendarRange className="h-3 w-3" /> Fechas</span><TaskDateRangePicker label="Fecha de entrega de la subtarea" startValue={value.startAt} endValue={value.dueAt} allDay={value.isAllDay} disabled={disabled} pending={pending} onApply={range => onChange({ ...value, startAt: range.startAt, dueAt: range.endAt, isAllDay: range.isAllDay })} compact /></div>
        <div><span className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400"><Flag className="h-3 w-3" /> Prioridad</span><TaskPriorityPicker value={value.priority} disabled={disabled} pending={pending} onChange={priority => patch('priority', priority)} className="min-h-9 py-1.5" /></div>
      </div>

      {error && <p role="alert" className="mt-2 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-[10px] text-slate-400">{selectedStatus?.name || 'Selecciona un estado'} · {value.startAt || value.dueAt ? 'con fechas' : 'sin fechas'}</p>
        <div className="ml-auto flex items-center gap-1.5">
          {onMoreOptions && <button type="button" disabled={pending || disabled} onClick={() => onMoreOptions(value)} className="min-h-9 rounded-xl px-3 text-xs font-bold text-slate-600 outline-none hover:bg-slate-100 focus:ring-2 focus:ring-emerald-400 disabled:opacity-50">Crear con detalles</button>}
          <button type="button" aria-label="Cancelar subtarea" disabled={pending} onClick={cancel} className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 outline-none hover:bg-slate-100 hover:text-slate-700 focus:ring-2 focus:ring-emerald-400 disabled:opacity-50"><X className="h-4 w-4" /></button>
          <button type="button" disabled={!canSubmit} onClick={() => { void onSubmit(value) }} className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-emerald-600 px-3 text-xs font-black text-white shadow-sm shadow-emerald-200 outline-none transition hover:bg-emerald-700 focus:ring-4 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:opacity-35">{pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Guardar</button>
        </div>
      </div>
    </div>}
  </div>
}
