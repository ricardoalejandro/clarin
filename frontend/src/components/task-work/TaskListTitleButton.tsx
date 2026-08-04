'use client'

import type { MouseEvent } from 'react'

export function taskListTitleAction({ editable, selectionMode, ctrlKey, metaKey, shiftKey }: {
  editable: boolean
  selectionMode: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): 'open' | 'select' {
  return editable && (selectionMode || ctrlKey || metaKey || shiftKey) ? 'select' : 'open'
}

interface Props {
  title: string
  metadata: string
  done: boolean
  editable: boolean
  selectionMode: boolean
  onOpen: () => void
  onSelect: (shift: boolean) => void
}

export default function TaskListTitleButton({ title, metadata, done, editable, selectionMode, onOpen, onSelect }: Props) {
  const click = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const action = taskListTitleAction({ editable, selectionMode, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey })
    if (action === 'select') {
      event.preventDefault()
      onSelect(event.shiftKey)
      return
    }
    onOpen()
  }

  return <button
    type="button"
    data-task-title-button
    aria-label={`Abrir tarea ${title}`}
    onClick={click}
    className="group/title min-w-0 flex-1 cursor-pointer rounded-lg py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2"
  >
    <span data-task-title-text className={`block truncate text-sm font-semibold decoration-emerald-200 decoration-2 underline-offset-2 transition-colors motion-reduce:transition-none group-hover/title:text-emerald-700 group-hover/title:underline group-focus-visible/title:text-emerald-700 group-focus-visible/title:underline ${done ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{title}</span>
    <span className="block truncate text-[10px] leading-4 text-slate-400">{metadata}</span>
  </button>
}
