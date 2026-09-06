'use client'

import { useEffect, useState } from 'react'
import { Cloud, CloudOff, Clock3, Loader2, ShieldAlert } from 'lucide-react'
import {
  TASK_SAVE_RELATIVE_REFRESH_MS,
  formatTaskSaveTime,
  taskSaveStatusAnnouncement,
  taskSaveStatusText,
  type TaskSaveStatusModel,
} from './taskSaveStatus'

interface Props {
  model: TaskSaveStatusModel
  compact?: boolean
  onAction?: () => void
  announce?: boolean
}

const presentation = {
  saved: { icon: Cloud, className: 'text-emerald-600' },
  readonly: { icon: Cloud, className: 'text-slate-400' },
  dirty: { icon: Clock3, className: 'text-amber-600' },
  saving: { icon: Loader2, className: 'text-emerald-600' },
  error: { icon: CloudOff, className: 'text-rose-600' },
  conflict: { icon: ShieldAlert, className: 'text-amber-700' },
  'comment-dirty': { icon: Clock3, className: 'text-amber-600' },
  'comment-publishing': { icon: Loader2, className: 'text-emerald-600' },
  'comment-error': { icon: CloudOff, className: 'text-rose-600' },
} satisfies Record<TaskSaveStatusModel['phase'], { icon: typeof Cloud; className: string }>

export default function TaskSaveStatusIndicator({ model, compact = false, onAction, announce = true }: Props) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    if (model.phase !== 'saved' && model.phase !== 'readonly') return
    const timer = window.setInterval(() => setNow(Date.now()), TASK_SAVE_RELATIVE_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [model.phase, model.updatedAt])

  const current = presentation[model.phase]
  const Icon = current.icon
  const text = taskSaveStatusText(model, now, compact)
  const time = formatTaskSaveTime(model.updatedAt, now)
  const retryable = model.phase === 'error' || model.phase === 'conflict' || model.phase === 'comment-error'
  const title = model.phase === 'saved'
    ? `${time.absolute ? `Última versión confirmada por Clarin: ${time.absolute}. ` : ''}Los cambios se guardan automáticamente.`
    : model.phase === 'readonly'
      ? time.absolute ? `Última actualización confirmada por Clarin: ${time.absolute}.` : 'Última actualización confirmada por Clarin.'
      : text
  const content = <>
    <Icon className={`h-3.5 w-3.5 shrink-0 ${model.phase === 'saving' || model.phase === 'comment-publishing' ? 'animate-spin motion-reduce:animate-none' : ''}`} />
    <span className="truncate">{text}</span>
  </>
  const className = `inline-flex max-w-full items-center gap-1.5 text-[11px] font-semibold leading-5 ${current.className}`

  return <div data-task-save-status={model.phase} className="min-w-0">
    {retryable && onAction ? <button
      type="button"
      data-no-window-drag
      onClick={onAction}
      title={title}
      className={`${className} -my-1 min-h-9 rounded-lg px-1.5 outline-none transition hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-400 [@media(pointer:coarse)]:min-h-11 ${model.phase === 'error' ? 'hover:bg-rose-50' : 'hover:bg-amber-50'}`}
    >{content}</button> : <span title={title} className={className}>{content}</span>}
    {announce && <span className="sr-only" aria-live="polite" aria-atomic="true">{taskSaveStatusAnnouncement(model)}</span>}
  </div>
}
