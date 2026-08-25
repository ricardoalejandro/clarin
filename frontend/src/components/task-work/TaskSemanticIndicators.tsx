'use client'

import { Circle, Flag } from 'lucide-react'
import { TASK_PRIORITY_CONFIG, type TaskPriority, type TaskWorkflowStatus } from '@/types/task'

interface IndicatorProps {
  compact?: boolean
  className?: string
}

export function TaskPriorityIndicator({
  priority,
  compact = false,
  className = '',
}: IndicatorProps & { priority?: TaskPriority | null }) {
  const normalizedPriority: TaskPriority = priority && priority in TASK_PRIORITY_CONFIG ? priority : 'medium'
  const semantics = TASK_PRIORITY_CONFIG[normalizedPriority]
  const label = `Prioridad: ${semantics.label}`

  return <span
    role="img"
    data-task-priority={normalizedPriority}
    aria-label={label}
    title={label}
    className={`inline-flex min-w-0 shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-semibold leading-none ${semantics.bg} ${semantics.color} ${className}`}
  >
    <Flag className="h-3 w-3 shrink-0" aria-hidden="true" />
    <span className={compact ? 'sr-only' : ''}>{semantics.label}</span>
  </span>
}

export function TaskStatusIndicator({
  status,
  compact = false,
  className = '',
}: IndicatorProps & { status?: TaskWorkflowStatus | null }) {
  const name = status?.name?.trim() || 'Sin estado'
  const label = `Estado: ${name}`

  return <span
    role="img"
    data-task-status={status?.id || 'none'}
    aria-label={label}
    title={label}
    className={`inline-flex min-w-0 shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[10px] font-semibold leading-none text-slate-600 ${className}`}
  >
    <Circle
      className="h-2.5 w-2.5 shrink-0 fill-current"
      style={{ color: status?.color || '#94A3B8' }}
      aria-hidden="true"
    />
    <span className={compact ? 'sr-only' : 'max-w-28 truncate'}>{name}</span>
  </span>
}
