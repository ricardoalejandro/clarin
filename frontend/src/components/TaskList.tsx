'use client'

import { useState } from 'react'
import { Task } from '@/types/task'
import TaskInlineCard from './TaskInlineCard'

interface Props {
  tasks: Task[]
  loading?: boolean
  onComplete: (taskId: string) => void
  onDelete: (taskId: string) => void
  onUpdate: (taskId: string, fields: Record<string, unknown>) => void
  onOpenFullEdit: (task: Task) => void
  onToggleStar?: (taskId: string) => void
  compact?: boolean
  maxItems?: number
  showMore?: () => void
  remainingCount?: number
}

export default function TaskList({ tasks, loading, onComplete, onDelete, onUpdate, onOpenFullEdit, onToggleStar, compact, maxItems, showMore, remainingCount }: Props) {
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <div className="animate-spin rounded-full h-5 w-5 border-2 border-emerald-200 border-t-emerald-600" />
      </div>
    )
  }

  if (!tasks || tasks.length === 0) {
    return (
      <p className="text-xs text-slate-400 text-center py-4">Sin tareas pendientes</p>
    )
  }

  const displayed = maxItems ? tasks.slice(0, maxItems) : tasks

  return (
    <div className="space-y-1.5">
      {displayed.map(task => (
        <TaskInlineCard
          key={task.id}
          task={task}
          isExpanded={expandedTaskId === task.id}
          onExpand={() => setExpandedTaskId(task.id)}
          onCollapse={() => setExpandedTaskId(null)}
          onComplete={onComplete}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onOpenFullEdit={onOpenFullEdit}
          onToggleStar={onToggleStar}
          compact={compact}
        />
      ))}

      {showMore && remainingCount && remainingCount > 0 && (
        <button
          onClick={showMore}
          className="w-full py-2 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 rounded-xl transition font-medium"
        >
          Mostrar más ({remainingCount} restantes)
        </button>
      )}
    </div>
  )
}
