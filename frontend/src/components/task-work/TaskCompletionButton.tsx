'use client'

import { Check, Loader2, X } from 'lucide-react'
import type { Task, TaskWorkflowStatus } from '@/types/task'
import { taskCompletionTransition, taskStatusCategory } from './taskStatusTransition'

interface Props {
  task: Pick<Task, 'status' | 'status_id' | 'status_detail'>
  statuses: TaskWorkflowStatus[]
  onChange: (statusID: string) => void | Promise<void>
  disabled?: boolean
  pending?: boolean
  compact?: boolean
  className?: string
}

export default function TaskCompletionButton({ task, statuses, onChange, disabled = false, pending = false, compact = false, className = '' }: Props) {
  const category = taskStatusCategory(task, statuses)
  const transition = taskCompletionTransition(task, statuses)
  const actionLabel = transition?.action === 'reopen' ? 'Reabrir tarea' : 'Marcar como finalizada'
  const unavailable = disabled || pending || !transition
  const terminal = category === 'done' || category === 'cancelled'

  return <button
    type="button"
    data-task-completion-control
    aria-label={disabled ? 'Solo lectura' : actionLabel}
    title={disabled ? 'Solo lectura' : transition ? actionLabel : 'El workflow no tiene un estado compatible'}
    disabled={unavailable}
    onPointerDown={event => event.stopPropagation()}
    onClick={event => {
      event.stopPropagation()
      if (transition) void onChange(transition.target.id)
    }}
    className={`group/completion inline-flex shrink-0 items-center justify-center rounded-full border outline-none transition duration-150 focus-visible:ring-4 focus-visible:ring-emerald-100 disabled:cursor-not-allowed ${compact ? 'h-8 w-8 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11' : 'h-11 w-11'} ${category === 'done' ? 'border-emerald-500 bg-emerald-500 text-white shadow-sm shadow-emerald-200' : category === 'cancelled' ? 'border-slate-400 bg-slate-500 text-white' : 'border-slate-300 bg-white text-transparent hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-600'} ${disabled ? 'opacity-55' : ''} ${className}`}
  >
    {pending ? <Loader2 className={`${compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} animate-spin text-current`} /> : category === 'cancelled' ? <X className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} /> : <Check className={`${compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} ${terminal ? '' : 'opacity-0 transition-opacity group-hover/completion:opacity-100 group-focus-visible/completion:opacity-100'}`} />}
  </button>
}
