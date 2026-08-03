'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, Diamond, Link2, ZoomIn, ZoomOut } from 'lucide-react'
import { Task, TaskGanttData } from '@/types/task'
import { taskGanttCellWidth, taskGanttVisibleRange, type TaskGanttScale } from './taskGanttScale'
import { TaskSelectPicker } from './TaskSelectPicker'
import { canEditTask } from './taskPermissionActions'

interface Props {
  data: TaskGanttData
  onOpen: (task: Task) => void
  onMove: (task: Task, startAt: Date, dueAt: Date, rescheduleDependencies: boolean) => Promise<void>
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
  const [scale, setScale] = useState<TaskGanttScale>('flexible')
  const [rescheduleDependencies, setRescheduleDependencies] = useState(false)
  const effectiveCellWidth = taskGanttCellWidth(scale, cellWidth)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollMetrics, setScrollMetrics] = useState({ left: 0, width: 1200 })
  const [moving, setMoving] = useState<string | null>(null)
  const [dragPreview, setDragPreview] = useState<{ taskId: string; mode: 'move' | 'start' | 'end'; delta: number } | null>(null)
  const suppressOpenUntilRef = useRef(0)
  const tasks = useMemo(() => data.tasks.filter(task => {
    if (!task.start_at || !task.due_at) return false
    return Number.isFinite(new Date(task.start_at).getTime()) && Number.isFinite(new Date(task.due_at).getTime())
  }).sort((a, b) => {
    const ad = new Date(a.start_at!).getTime()
    const bd = new Date(b.start_at!).getTime()
    return ad - bd
  }), [data.tasks])
  const taskIndex = useMemo(() => new Map(tasks.map((task, index) => [task.id, index])), [tasks])
  const dated = tasks.flatMap(task => [task.start_at, task.due_at].filter(Boolean).map(value => new Date(value!)))
  const today = startOfDay(new Date())
  const minDate = startOfDay(new Date(Math.min(today.getTime(), ...(dated.length ? dated.map(date => date.getTime()) : [today.getTime()])) - 3 * DAY))
  const maxDate = startOfDay(new Date(Math.max(addDays(today, 28).getTime(), ...(dated.length ? dated.map(date => date.getTime()) : [today.getTime()])) + 8 * DAY))
  const dayCount = Math.max(35, Math.ceil((maxDate.getTime() - minDate.getTime()) / DAY) + 1)
  const days = Array.from({ length: dayCount }, (_, index) => addDays(minDate, index))
  const visibleRange = taskGanttVisibleRange(scrollMetrics.left, scrollMetrics.width, LABEL, effectiveCellWidth, dayCount)
  const visibleDays = days.slice(visibleRange.start, visibleRange.end)
  const critical = new Set(data.critical_task_ids || [])
  const hasEditableTasks = tasks.some(canEditTask)

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const update = () => setScrollMetrics({ left: node.scrollLeft, width: node.clientWidth })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const datesFor = (task: Task) => {
    return { start: new Date(task.start_at!), due: new Date(task.due_at!) }
  }

  const openTask = (task: Task) => {
    if (Date.now() >= suppressOpenUntilRef.current) onOpen(task)
  }

  const drag = (event: React.PointerEvent, task: Task, mode: 'move' | 'start' | 'end') => {
    if (!canEditTask(task)) return
    event.preventDefault()
    event.stopPropagation()
    const initialX = event.clientX
    const initial = datesFor(task)
    setMoving(task.id)
    setDragPreview({ taskId: task.id, mode, delta: 0 })
    const cleanup = () => {
      window.removeEventListener('pointermove', preview)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
      setMoving(null)
      setDragPreview(null)
    }
    const preview = (pointer: PointerEvent) => {
      const delta = Math.round((pointer.clientX - initialX) / effectiveCellWidth)
      setDragPreview({ taskId: task.id, mode, delta })
    }
    const cancel = () => {
      suppressOpenUntilRef.current = Date.now() + 250
      cleanup()
    }
    const finish = async (up: PointerEvent) => {
      const travelled = Math.abs(up.clientX - initialX)
      if (travelled >= 3) suppressOpenUntilRef.current = Date.now() + 250
      const delta = Math.round((up.clientX - initialX) / effectiveCellWidth)
      cleanup()
      if (!delta) return
      let start = initial.start
      let due = initial.due
      if (mode === 'move') { start = addDays(start, delta); due = addDays(due, delta) }
      if (mode === 'start') start = addDays(start, delta)
      if (mode === 'end') due = addDays(due, delta)
      if (due < start) return
      await onMove(task, start, due, rescheduleDependencies)
    }
    window.addEventListener('pointermove', preview)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
  }

  if (!tasks.length) return <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-400"><div><p className="font-semibold text-slate-600">Aún no hay tareas programadas</p><p className="mt-1">Añade fecha de inicio y entrega para construir el cronograma.</p>{data.unscheduled_count > 0 && <p className="mt-3 text-xs font-medium text-amber-600">{data.unscheduled_count} {data.unscheduled_count === 1 ? 'tarea necesita' : 'tareas necesitan'} ambas fechas.</p>}</div></div>

  return <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
      <div><div className="flex items-center gap-2"><h3 className="text-sm font-bold text-slate-800">Cronograma del proyecto</h3>{data.unscheduled_count > 0 && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">{data.unscheduled_count} sin programar</span>}</div><p className="text-[11px] text-slate-400">{hasEditableTasks ? 'Arrastra las barras editables; usa sus extremos para cambiar la duración.' : 'Cronograma en modo de solo lectura.'}</p></div>
      <div className="flex flex-wrap items-center justify-end gap-2"><label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-[10px] font-bold text-slate-500"><input type="checkbox" checked={rescheduleDependencies} disabled={!hasEditableTasks} onChange={event => setRescheduleDependencies(event.target.checked)} className="accent-emerald-600 disabled:opacity-40" />Reprogramar dependencias</label><TaskSelectPicker value={scale} options={([['day','Día'],['week','Semana'],['month','Mes'],['quarter','Trimestre'],['year','Año'],['flexible','Flexible']] as const).map(([value,label]) => ({ value, label, leading: <CalendarDays className="h-4 w-4" /> }))} onChange={value => setScale(value as TaskGanttScale)} label="Escala de Gantt" className="!min-h-9 !w-40 !py-1" /><div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1"><button aria-label="Alejar Gantt" onClick={() => { setScale('flexible'); setCellWidth(value => Math.max(8, value - 8)) }} className="rounded-md p-1.5 text-slate-500 hover:bg-white"><ZoomOut className="h-4 w-4" /></button><span className="w-12 text-center text-[10px] font-semibold text-slate-500">{effectiveCellWidth}px</span><button aria-label="Acercar Gantt" onClick={() => { setScale('flexible'); setCellWidth(value => Math.min(120, value + 8)) }} className="rounded-md p-1.5 text-slate-500 hover:bg-white"><ZoomIn className="h-4 w-4" /></button></div></div>
    </div>
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" onScroll={event => setScrollMetrics({ left: event.currentTarget.scrollLeft, width: event.currentTarget.clientWidth })} onWheel={event => { if (!(event.ctrlKey || event.metaKey)) return; event.preventDefault(); setScale('flexible'); setCellWidth(value => Math.max(8, Math.min(120, value + (event.deltaY < 0 ? 6 : -6)))) }}>
      <div className="relative" style={{ width: LABEL + dayCount * effectiveCellWidth, minHeight: 44 + tasks.length * ROW }}>
        <div className="sticky top-0 z-30 flex h-11 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="sticky left-0 z-40 flex shrink-0 items-center border-r border-slate-200 bg-white px-4 text-[11px] font-bold uppercase tracking-wider text-slate-400" style={{ width: LABEL }}>Tarea</div>
          <div className="shrink-0" style={{ width: visibleRange.start * effectiveCellWidth }} />{visibleDays.map(day => { const weekend = day.getDay() === 0 || day.getDay() === 6; const current = day.toDateString() === today.toDateString(); return <div key={day.toISOString()} className={`flex shrink-0 flex-col items-center justify-center overflow-hidden border-r border-slate-100 text-[9px] ${weekend ? 'bg-slate-50 text-slate-400' : 'text-slate-500'} ${current ? '!bg-emerald-50 !text-emerald-700' : ''}`} style={{ width: effectiveCellWidth }}><span className="font-semibold uppercase">{effectiveCellWidth >= 18 ? day.toLocaleDateString('es', { weekday: 'narrow' }) : ''}</span><span className="font-bold">{effectiveCellWidth >= 8 ? day.getDate() : ''}</span></div> })}<div className="shrink-0" style={{ width: Math.max(0, dayCount - visibleRange.end) * effectiveCellWidth }} />
        </div>

        <div className="absolute bottom-0 left-0 top-11" style={{ marginLeft: LABEL, width: dayCount * effectiveCellWidth }}>
          {visibleDays.map((day, visibleIndex) => { const index = visibleRange.start + visibleIndex; return <div key={day.toISOString()} className={`absolute bottom-0 top-0 border-r border-slate-100 ${day.getDay() === 0 || day.getDay() === 6 ? 'bg-slate-50/80' : ''}`} style={{ left: index * effectiveCellWidth, width: effectiveCellWidth }} /> })}
          <div className="absolute bottom-0 top-0 z-10 w-px bg-rose-400" style={{ left: ((today.getTime() - minDate.getTime()) / DAY) * effectiveCellWidth }}><span className="absolute -top-0.5 -translate-x-1/2 rounded-b bg-rose-500 px-1.5 py-0.5 text-[8px] font-bold text-white">HOY</span></div>
          <svg className="pointer-events-none absolute inset-0 z-10 overflow-visible" width={dayCount * effectiveCellWidth} height={tasks.length * ROW}>
            <defs><marker id="task-gantt-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" /></marker></defs>
            {data.dependencies.map(dep => { const from = tasks[taskIndex.get(dep.predecessor_task_id) ?? -1]; const to = tasks[taskIndex.get(dep.successor_task_id) ?? -1]; if (!from || !to) return null; const fromDates = datesFor(from); const toDates = datesFor(to); const x1 = ((startOfDay(fromDates.due).getTime() - minDate.getTime()) / DAY + 1) * effectiveCellWidth; const x2 = ((startOfDay(toDates.start).getTime() - minDate.getTime()) / DAY) * effectiveCellWidth; const y1 = (taskIndex.get(from.id)! + .5) * ROW; const y2 = (taskIndex.get(to.id)! + .5) * ROW; const middle = Math.max(x1 + 10, (x1 + x2) / 2); return <path key={dep.id} d={`M ${x1} ${y1} H ${middle} V ${y2} H ${x2}`} fill="none" stroke="#94a3b8" strokeWidth="1.25" markerEnd="url(#task-gantt-arrow)" /> })}
          </svg>
        </div>

        <div className="relative z-20">
          {tasks.map((task, index) => { let { start, due } = datesFor(task); if (dragPreview?.taskId === task.id) { if (dragPreview.mode === 'move' || dragPreview.mode === 'start') start = addDays(start, dragPreview.delta); if (dragPreview.mode === 'move' || dragPreview.mode === 'end') due = addDays(due, dragPreview.delta) } const left = ((startOfDay(start).getTime() - minDate.getTime()) / DAY) * effectiveCellWidth; const duration = Math.max(1, Math.ceil((due.getTime() - start.getTime()) / DAY)); const width = Math.max(effectiveCellWidth, duration * effectiveCellWidth); const isCritical = critical.has(task.id); const isDone = task.status_detail?.category === 'done'; const invalidPreview = due < start; const editable = canEditTask(task); return <div key={task.id} className="relative flex border-b border-slate-100" style={{ height: ROW }}>
            <button onClick={() => openTask(task)} className="sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r border-slate-200 bg-white px-3 text-left hover:bg-slate-50" style={{ width: LABEL }}>
              {task.is_milestone ? <Diamond className="h-3.5 w-3.5 fill-violet-500 text-violet-500" /> : <span className="h-2 w-2 rounded-full" style={{ backgroundColor: task.status_detail?.color || '#64748b' }} />}
              <span className={`min-w-0 flex-1 truncate text-xs font-medium ${isDone ? 'text-slate-400 line-through' : 'text-slate-700'}`}>{task.title}</span>
              {data.dependencies.some(dep => dep.successor_task_id === task.id) && <Link2 className="h-3 w-3 text-slate-300" />}
            </button>
            <div className="relative" style={{ width: dayCount * effectiveCellWidth }}>
              {task.is_milestone ? <button onClick={() => openTask(task)} onPointerDown={editable ? event => drag(event, task, 'move') : undefined} className={`absolute top-1/2 z-20 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-sm bg-violet-500 shadow-md ${editable ? 'cursor-grab' : 'cursor-pointer opacity-80'}`} style={{ left }} title={editable ? task.title : `${task.title} · solo lectura`} /> : <div onClick={() => openTask(task)} onPointerDown={editable ? event => drag(event, task, 'move') : undefined} className={`group absolute top-2.5 z-20 h-6 overflow-hidden rounded-md shadow-sm transition ${editable ? 'cursor-grab' : 'cursor-pointer opacity-80'} ${moving === task.id ? `opacity-75 ring-2 ${invalidPreview ? 'ring-rose-300' : 'ring-emerald-300'}` : 'hover:-translate-y-px hover:shadow-md'} ${isCritical || invalidPreview ? 'bg-rose-500' : isDone ? 'bg-emerald-500' : 'bg-slate-700'}`} style={{ left, width }}>
                <div className="absolute inset-y-0 left-0 bg-white/20" style={{ width: `${task.progress || 0}%` }} />
                {editable && <button onPointerDown={event => drag(event, task, 'start')} className="absolute inset-y-0 left-0 z-30 w-2.5 cursor-ew-resize border-l-2 border-white/80 bg-white/15 hover:bg-white/35" aria-label="Cambiar inicio" />}
                <span className="pointer-events-none relative block truncate px-3 py-1 text-[10px] font-semibold text-white">{task.title}</span>
                {editable && <button onPointerDown={event => drag(event, task, 'end')} className="absolute inset-y-0 right-0 z-30 w-2.5 cursor-ew-resize border-r-2 border-white/80 bg-white/15 hover:bg-white/35" aria-label="Cambiar entrega" />}
                {dragPreview?.taskId === task.id && <span className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded-xl bg-slate-950 px-3 py-2 text-[10px] font-bold text-white shadow-xl">{start.toLocaleDateString('es')} → {due.toLocaleDateString('es')} · {duration} días</span>}
              </div>}
            </div>
          </div> })}
        </div>
      </div>
    </div>
    <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-[10px] text-slate-400"><span>{tasks.length} programadas · {data.unscheduled_count} sin programar · {data.dependencies.length} dependencias</span><span className="flex gap-3"><span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-rose-500" /> Ruta crítica</span><span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-emerald-500" /> Completada</span></span></div>
  </div>
}
