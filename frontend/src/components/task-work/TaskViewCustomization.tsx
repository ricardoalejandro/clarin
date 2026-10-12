'use client'

import { useState } from 'react'
import { Check, SlidersHorizontal } from 'lucide-react'
import type { TaskGroupBy, TaskGroupDirection } from '@/types/task'
import type { TaskSubtaskDisplayMode } from './taskListSubtasks'
import { TASK_GROUP_LABELS } from './taskWorkspaceChrome'
import TaskWorkWindowShell from './TaskWorkWindowShell'

interface Props {
  groupBy: TaskGroupBy
  direction: TaskGroupDirection
  collapsedGroupKeys: string[]
  subtaskMode: TaskSubtaskDisplayMode
  storageScope?: string
  compact?: boolean
  onGrouping: (group: TaskGroupBy, direction: TaskGroupDirection, collapsed: string[]) => void
  onSubtasks: (mode: TaskSubtaskDisplayMode) => void
}

export default function TaskViewCustomization(props: Props) {
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState(props.groupBy)
  const [direction, setDirection] = useState(props.direction)
  const [subtasks, setSubtasks] = useState(props.subtaskMode)
  const summary = `${TASK_GROUP_LABELS[props.groupBy]} · subtareas ${props.subtaskMode === 'expanded' ? 'expandidas' : 'contraídas'}`
  const chooseClass = (active: boolean) => `flex min-h-11 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${active ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`
  return <>
    <button type="button" aria-label="Personalizar vista" aria-haspopup="dialog" aria-expanded={open} title={`Personalizar vista: ${summary}`} onClick={() => { setGroup(props.groupBy); setDirection(props.direction); setSubtasks(props.subtaskMode); setOpen(true) }} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-left text-xs text-slate-600 hover:bg-slate-50"><SlidersHorizontal className="h-3.5 w-3.5" /><span><span className={props.compact ? 'sr-only' : 'block font-semibold'}>Personalizar vista</span><span className="block text-[10px] text-slate-500">{props.compact ? TASK_GROUP_LABELS[props.groupBy] : summary}</span></span></button>
    <TaskWorkWindowShell open={open} onRequestClose={() => setOpen(false)} title="Personalizar vista" eyebrow="Lista" icon={SlidersHorizontal} storageKey="clarin:tasks:view-customization" storageScope={props.storageScope} defaultWidth={540} defaultHeight={600} minWidth={360} minHeight={480} description="Organiza la lista a tu manera. Los cambios se aplican juntos." footer={<div className="flex justify-end gap-2"><button type="button" onClick={() => setOpen(false)} className="min-h-10 rounded-lg px-4 text-sm text-slate-600 hover:bg-white">Cancelar</button><button type="button" onClick={() => { props.onGrouping(group, direction, group === props.groupBy ? props.collapsedGroupKeys : []); props.onSubtasks(subtasks); setOpen(false) }} className="min-h-10 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700">Aplicar</button></div>}>
      <div className="space-y-6 p-5">
        <fieldset><legend className="mb-3 text-sm font-semibold text-slate-800">Agrupación</legend><div className="grid grid-cols-2 gap-2">{(Object.entries(TASK_GROUP_LABELS) as Array<[TaskGroupBy, string]>).map(([value, label]) => <button key={value} type="button" aria-pressed={group === value} onClick={() => setGroup(value)} className={chooseClass(group === value)}>{label}{group === value && <Check className="h-3.5 w-3.5" />}</button>)}</div></fieldset>
        <fieldset><legend className="mb-3 text-sm font-semibold text-slate-800">Orden de los grupos</legend><div className="grid grid-cols-2 gap-2">{(['asc', 'desc'] as const).map(value => <button key={value} type="button" aria-pressed={direction === value} onClick={() => setDirection(value)} className={chooseClass(direction === value)}>{value === 'asc' ? 'Ascendente' : 'Descendente'}</button>)}</div></fieldset>
        <fieldset><legend className="mb-3 text-sm font-semibold text-slate-800">Subtareas</legend><div className="grid grid-cols-2 gap-2">{(['collapsed', 'expanded'] as const).map(value => <button key={value} type="button" aria-pressed={subtasks === value} onClick={() => setSubtasks(value)} className={chooseClass(subtasks === value)}>{value === 'collapsed' ? 'Contraídas' : 'Expandidas'}</button>)}</div></fieldset>
      </div>
    </TaskWorkWindowShell>
  </>
}
