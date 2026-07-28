'use client'

import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Diamond, Link2, ZoomIn, ZoomOut } from 'lucide-react'
import { Task, TaskGanttData } from '@/types/task'

interface Props {
  data: TaskGanttData
  onOpen: (task: Task) => void
  onMove: (task: Task, startAt: Date, dueAt: Date) => Promise<void>
}

const DAY = 86_400_000
const ROW = 46
const LABEL = 270

function startOfDay(value: Date) {
  const copy = new Date(value)
  copy.setHours(0, 0, 0, 0)
  return copy
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * DAY)
}

export default function TaskGanttView({ data, onOpen, onMove }: Props) {
  const [cellWidth, setCellWidth] = useState(32)
  const [moving, setMoving] = useState<string | null>(null)
  const tasks = useMemo(() => [...data.tasks].sort((a, b) => {
    const ad = new Date(a.start_at || a.due_at || a.created_at).getTime()
    const bd = new Date(b.start_at || b.due_at || b.created_at).getTime()
    return ad - bd
  }), [data.tasks])
  const taskIndex = useMemo(() => new Map(tasks.map((task, index) => [task.id, index])), [tasks])
  const dated = tasks.flatMap(task => [task.start_at, task.due_at].filter(Boolean).map(value => new Date(value!)))
  const today = startOfDay(new Date())
  const minDate = startOfDay(new Date(Math.min(today.getTime(), ...(dated.length ? dated.map(date => date.getTime()) : [today.getTime()])) - 3 * DAY))
  const maxDate = startOfDay(new Date(Math.max(addDays(today, 28).getTime(), ...(dated.length ? dated.map(date => date.getTime()) : [today.getTime()])) + 8 * DAY))
  const dayCount = Math.max(35, Math.ceil((maxDate.getTime() - minDate.getTime()) / DAY) + 1)
  const days = Array.from({ length: dayCount }, (_, index) => addDays(minDate, index))
  const critical = new Set(data.critical_task_ids || [])

  const datesFor = (task: Task) => {
    const due = task.due_at ? new Date(task.due_at) : addDays(today, 1)
    const start = task.start_at ? new Date(task.start_at) : addDays(due, -1)
    return { start, due: due > start ? due : addDays(start, 1) }
  }

  const drag = (event: React.PointerEvent, task: Task, mode: 'move' | 'start' | 'end') => {
    event.preventDefault()
    event.stopPropagation()
    const initialX = event.clientX
    const initial = datesFor(task)
    setMoving(task.id)
    const finish = async (up: PointerEvent) => {
      window.removeEventListener('pointerup', finish)
      const delta = Math.round((up.clientX - initialX) / cellWidth)
      setMoving(null)
      if (!delta) return
      let start = initial.start
      let due = initial.due
      if (mode === 'move') { start = addDays(start, delta); due = addDays(due, delta) }
      if (mode === 'start') start = addDays(start, delta)
      if (mode === 'end') due = addDays(due, delta)
      if (due <= start) return
      await onMove(task, start, due)
    }
    window.addEventListener('pointerup', finish, { once: true })
  }

  if (!tasks.length) return <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-sm text-slate-400">Añade fechas de inicio y entrega para construir tu cronograma.</div>

  return <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
      <div><h3 className="text-sm font-bold text-slate-800">Cronograma del proyecto</h3><p className="text-[11px] text-slate-400">Arrastra una barra para moverla; usa sus extremos para cambiar la duración.</p></div>
      <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1"><button onClick={() => setCellWidth(value => Math.max(22, value - 5))} className="rounded-md p-1.5 text-slate-500 hover:bg-white"><ZoomOut className="h-4 w-4" /></button><span className="w-12 text-center text-[10px] font-semibold text-slate-500">{cellWidth}px</span><button onClick={() => setCellWidth(value => Math.min(58, value + 5))} className="rounded-md p-1.5 text-slate-500 hover:bg-white"><ZoomIn className="h-4 w-4" /></button></div>
    </div>
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="relative" style={{ width: LABEL + dayCount * cellWidth, minHeight: 44 + tasks.length * ROW }}>
        <div className="sticky top-0 z-30 flex h-11 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="sticky left-0 z-40 flex shrink-0 items-center border-r border-slate-200 bg-white px-4 text-[11px] font-bold uppercase tracking-wider text-slate-400" style={{ width: LABEL }}>Tarea</div>
          {days.map(day => { const weekend = day.getDay() === 0 || day.getDay() === 6; const current = day.toDateString() === today.toDateString(); return <div key={day.toISOString()} className={`flex shrink-0 flex-col items-center justify-center border-r border-slate-100 text-[9px] ${weekend ? 'bg-slate-50 text-slate-400' : 'text-slate-500'} ${current ? '!bg-emerald-50 !text-emerald-700' : ''}`} style={{ width: cellWidth }}><span className="font-semibold uppercase">{day.toLocaleDateString('es', { weekday: 'narrow' })}</span><span className="font-bold">{day.getDate()}</span></div> })}
        </div>

        <div className="absolute bottom-0 left-0 top-11" style={{ marginLeft: LABEL, width: dayCount * cellWidth }}>
          {days.map((day, index) => <div key={day.toISOString()} className={`absolute bottom-0 top-0 border-r border-slate-100 ${day.getDay() === 0 || day.getDay() === 6 ? 'bg-slate-50/80' : ''}`} style={{ left: index * cellWidth, width: cellWidth }} />)}
          <div className="absolute bottom-0 top-0 z-10 w-px bg-rose-400" style={{ left: ((today.getTime() - minDate.getTime()) / DAY) * cellWidth }}><span className="absolute -top-0.5 -translate-x-1/2 rounded-b bg-rose-500 px-1.5 py-0.5 text-[8px] font-bold text-white">HOY</span></div>
          <svg className="pointer-events-none absolute inset-0 z-10 overflow-visible" width={dayCount * cellWidth} height={tasks.length * ROW}>
            <defs><marker id="task-gantt-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" /></marker></defs>
            {data.dependencies.map(dep => { const from = tasks[taskIndex.get(dep.predecessor_task_id) ?? -1]; const to = tasks[taskIndex.get(dep.successor_task_id) ?? -1]; if (!from || !to) return null; const fromDates = datesFor(from); const toDates = datesFor(to); const x1 = ((startOfDay(fromDates.due).getTime() - minDate.getTime()) / DAY + 1) * cellWidth; const x2 = ((startOfDay(toDates.start).getTime() - minDate.getTime()) / DAY) * cellWidth; const y1 = (taskIndex.get(from.id)! + .5) * ROW; const y2 = (taskIndex.get(to.id)! + .5) * ROW; const middle = Math.max(x1 + 10, (x1 + x2) / 2); return <path key={dep.id} d={`M ${x1} ${y1} H ${middle} V ${y2} H ${x2}`} fill="none" stroke="#94a3b8" strokeWidth="1.25" markerEnd="url(#task-gantt-arrow)" /> })}
          </svg>
        </div>

        <div className="relative z-20">
          {tasks.map((task, index) => { const { start, due } = datesFor(task); const left = ((startOfDay(start).getTime() - minDate.getTime()) / DAY) * cellWidth; const duration = Math.max(1, Math.ceil((due.getTime() - start.getTime()) / DAY)); const width = Math.max(cellWidth, duration * cellWidth); const isCritical = critical.has(task.id); const isDone = task.status_detail?.category === 'done'; return <div key={task.id} className="relative flex border-b border-slate-100" style={{ height: ROW }}>
            <button onClick={() => onOpen(task)} className="sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r border-slate-200 bg-white px-3 text-left hover:bg-slate-50" style={{ width: LABEL }}>
              {task.is_milestone ? <Diamond className="h-3.5 w-3.5 fill-violet-500 text-violet-500" /> : <span className="h-2 w-2 rounded-full" style={{ backgroundColor: task.status_detail?.color || '#64748b' }} />}
              <span className={`min-w-0 flex-1 truncate text-xs font-medium ${isDone ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{task.title}</span>
              {data.dependencies.some(dep => dep.successor_task_id === task.id) && <Link2 className="h-3 w-3 text-slate-300" />}
            </button>
            <div className="relative" style={{ width: dayCount * cellWidth }}>
              {task.is_milestone ? <button onClick={() => onOpen(task)} onPointerDown={event => drag(event, task, 'move')} className="absolute top-1/2 z-20 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-sm bg-violet-500 shadow-md" style={{ left }} title={task.title} /> : <div onClick={() => onOpen(task)} onPointerDown={event => drag(event, task, 'move')} className={`group absolute top-2.5 z-20 h-6 cursor-grab overflow-hidden rounded-md shadow-sm transition ${moving === task.id ? 'opacity-60 ring-2 ring-emerald-300' : 'hover:-translate-y-px hover:shadow-md'} ${isCritical ? 'bg-rose-500' : isDone ? 'bg-emerald-500' : 'bg-slate-700'}`} style={{ left, width }}>
                <div className="absolute inset-y-0 left-0 bg-white/20" style={{ width: `${task.progress || 0}%` }} />
                <button onPointerDown={event => drag(event, task, 'start')} className="absolute inset-y-0 left-0 z-30 w-2 cursor-ew-resize bg-black/0 hover:bg-white/30" aria-label="Cambiar inicio" />
                <span className="pointer-events-none relative block truncate px-3 py-1 text-[10px] font-semibold text-white">{task.title}</span>
                <button onPointerDown={event => drag(event, task, 'end')} className="absolute inset-y-0 right-0 z-30 w-2 cursor-ew-resize bg-black/0 hover:bg-white/30" aria-label="Cambiar entrega" />
              </div>}
            </div>
          </div> })}
        </div>
      </div>
    </div>
    <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-[10px] text-slate-400"><span>{tasks.length} tareas · {data.dependencies.length} dependencias</span><span className="flex gap-3"><span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-rose-500" /> Ruta crítica</span><span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-emerald-500" /> Completada</span></span></div>
  </div>
}
