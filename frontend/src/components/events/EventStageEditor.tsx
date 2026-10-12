'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDown, ArrowUp, GripVertical, MoreHorizontal, Plus, Trash2, Undo2 } from 'lucide-react'
import { TaskColorPicker } from '@/components/task-work/TaskContainerAppearance'
import { TaskSelectPicker } from '@/components/task-work/TaskSelectPicker'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'
import { moveEventStage, type EventStageDraft } from './eventConfiguration'

const iconButton = 'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-30'
function StageRow({ stage, index, active, disabled, reducedMotion, target, onChange, onMove, onDelete }: {
  stage: EventStageDraft; index: number; active: EventStageDraft[]; disabled: boolean; reducedMotion: boolean; target: boolean
  onChange: (patch: Partial<EventStageDraft>) => void; onMove: (target: string) => void; onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const sortable = useSortable({ id: stage.key, disabled, transition: { duration: reducedMotion ? 0 : 180, easing: 'ease-out' } })
  const duplicate = active.filter(item => item.name.trim().toLocaleLowerCase('es') === stage.name.trim().toLocaleLowerCase('es')).length > 1
  const options = useMemo(() => active.map((item, position) => ({ value: item.key, label: 'Posición ' + (position + 1), description: item.name, leading: <span className="h-3 w-3 rounded-full" style={{ backgroundColor: item.color }} /> })), [active])
  return <div ref={sortable.setNodeRef} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }} className={'rounded-xl border bg-white ' + (sortable.isDragging ? 'border-emerald-300 opacity-25' : target ? 'border-emerald-400 ring-2 ring-emerald-100' : 'border-slate-200')}>
    <div className="flex min-h-16 items-center gap-1.5 p-2">
      <button ref={sortable.setActivatorNodeRef} type="button" disabled={disabled} className={iconButton + ' cursor-grab touch-none active:cursor-grabbing'} aria-label={'Mover ' + (stage.name || 'etapa') + ', posición ' + (index + 1)} {...sortable.attributes} {...sortable.listeners}><GripVertical className="h-4 w-4" /></button>
      <span className="hidden w-5 shrink-0 text-center text-xs tabular-nums text-slate-400 sm:block">{index + 1}</span>
      <div className="w-11 shrink-0"><TaskColorPicker compact value={stage.color} onChange={color => onChange({ color })} label={'Color de ' + stage.name} disabled={disabled} /></div>
      <div className="min-w-0 flex-1">
        <input aria-label={'Nombre de etapa ' + (index + 1)} value={stage.name} onChange={event => onChange({ name: event.target.value })} disabled={disabled} maxLength={80} aria-invalid={!stage.name.trim() || duplicate} placeholder="Nombre de la etapa" className="min-h-11 w-full rounded-lg border border-transparent bg-slate-50 px-3 text-sm font-medium text-slate-900 outline-none focus:border-emerald-400 focus:bg-white focus:ring-2 focus:ring-emerald-100 disabled:opacity-60" />
        {duplicate && <p className="px-2 text-xs text-rose-600">Nombre repetido</p>}
      </div>
      <span className="hidden shrink-0 px-2 text-xs tabular-nums text-slate-500 sm:block" title="Participaciones actuales e históricas">{stage.id ? stage.count : 'Nueva'}</span>
      <button type="button" aria-label={'Opciones de ' + (stage.name || 'etapa')} aria-expanded={expanded} disabled={disabled} className={iconButton} onClick={() => setExpanded(value => !value)}><MoreHorizontal className="h-4 w-4" /></button>
    </div>
    {expanded && <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/50 px-3 py-2">
      <div className="min-w-[160px] flex-1"><TaskSelectPicker value={stage.key} options={options} label={'Mover ' + stage.name + ' a posición'} onChange={onMove} disabled={disabled} searchable={active.length > 10} /></div>
      <button type="button" className={iconButton} disabled={disabled || index === 0} aria-label={'Subir ' + stage.name} onClick={() => onMove(active[index - 1].key)}><ArrowUp className="h-4 w-4" /></button>
      <button type="button" className={iconButton} disabled={disabled || index === active.length - 1} aria-label={'Bajar ' + stage.name} onClick={() => onMove(active[index + 1].key)}><ArrowDown className="h-4 w-4" /></button>
      <button type="button" className={iconButton + ' text-rose-600 hover:bg-rose-50'} disabled={disabled || active.length <= 1} aria-label={'Eliminar ' + stage.name} onClick={onDelete}><Trash2 className="h-4 w-4" /></button>
    </div>}
  </div>
}

export default function EventStageEditor({ stages, onChange, disabled = false }: { stages: EventStageDraft[]; onChange: (stages: EventStageDraft[]) => void; disabled?: boolean }) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [reducedMotion, setReducedMotion] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches)
    update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const [announcement, setAnnouncement] = useState('')
  const active = useMemo(() => stages.filter(stage => !stage.deleted), [stages])
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 520, tolerance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const update = (key: string, patch: Partial<EventStageDraft>) => onChange(stages.map(stage => stage.key === key ? { ...stage, ...patch } : stage))
  const move = (key: string, target: string) => {
    onChange(moveEventStage(stages, key, target))
    setAnnouncement('Etapa movida a la posición ' + (active.findIndex(stage => stage.key === target) + 1) + '. Guarda para aplicar.')
  }
  const finishDrag = ({ active: dragged, over }: DragEndEvent) => { setDragging(null); setTarget(null); if (over) move(String(dragged.id), String(over.id)) }
  const overlay = active.find(stage => stage.key === dragging)
  const positions = useMemo(() => active.map(stage => ({ value: stage.key, label: stage.name || 'Etapa sin nombre', leading: <span className="h-3 w-3 rounded-full" style={{ backgroundColor: stage.color }} />, badge: stage.id ? String(stage.count) : 'Nueva' })), [active])
  return <div className="space-y-4">
    <div><h3 className="text-base font-semibold text-slate-900">Recorrido de los participantes</h3><p className="mt-1 text-sm text-slate-500">Arrastra desde el asa o elige una posición en las opciones de la etapa.</p></div>
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={({ active }) => setDragging(String(active.id))} onDragOver={({ over }) => setTarget(over ? String(over.id) : null)} onDragCancel={() => { setDragging(null); setTarget(null); setAnnouncement('Movimiento cancelado.') }} onDragEnd={finishDrag} accessibility={{ screenReaderInstructions: { draggable: 'Pulsa Espacio para tomar la etapa, flechas para moverla, Espacio para soltar o Escape para cancelar.' } }}>
      <SortableContext items={active.map(stage => stage.key)} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">{active.map((stage, index) => <StageRow key={stage.key} stage={stage} index={index} active={active} disabled={disabled} reducedMotion={reducedMotion} target={target === stage.key && dragging !== stage.key} onChange={patch => update(stage.key, patch)} onMove={target => move(stage.key, target)} onDelete={() => {
          if (!stage.id) onChange(stages.filter(item => item.key !== stage.key))
          else update(stage.key, { deleted: true, moveTo: undefined })
        }} />)}</div>
      </SortableContext>
      {typeof document !== 'undefined' && createPortal(<DragOverlay zIndex={OPERATIONAL_OVERLAY_LAYERS.dragOverlay} dropAnimation={reducedMotion ? null : { duration: 180, easing: 'ease-out' }}>{overlay && <div className="flex min-h-16 w-full items-center gap-3 rounded-xl border border-emerald-300 bg-white px-4 shadow-xl"><GripVertical className="h-4 w-4 text-slate-400" /><span className="h-3 w-3 rounded-full" style={{ backgroundColor: overlay.color }} /><span className="min-w-0 flex-1 truncate text-sm font-semibold">{overlay.name}</span>{target && <span className="text-xs text-emerald-700">Posición {active.findIndex(stage => stage.key === target) + 1}</span>}</div>}</DragOverlay>, document.body)}
    </DndContext>
    <button type="button" disabled={disabled || active.length >= 200} onClick={() => {
      const key = 'draft-' + crypto.randomUUID()
      onChange([...stages, { key, name: '', color: '#3B82F6', count: 0 }])
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="Nombre de etapa ' + (active.length + 1) + '"]')?.focus())
    }} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 text-sm font-medium text-slate-600 hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-40"><Plus className="h-4 w-4" />Agregar etapa</button>
    {stages.filter(stage => stage.deleted).map(stage => <div key={stage.key} className="rounded-xl border border-amber-200 bg-amber-50 p-3">
      <div className="mb-3 flex items-start justify-between gap-2"><div><h4 className="text-sm font-semibold text-slate-800">Eliminar «{stage.name}» al guardar</h4><p className="mt-1 text-xs text-slate-600">{stage.count} participaciones actuales e históricas se trasladarán al destino elegido.</p></div><button type="button" disabled={disabled} onClick={() => update(stage.key, { deleted: false, moveTo: undefined })} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-slate-600 hover:bg-white"><Undo2 className="h-4 w-4" />Deshacer</button></div>
      <TaskSelectPicker value={stage.moveTo || ''} options={positions} label={'Destino para participantes de ' + stage.name} placeholder="Elegir etapa de destino" onChange={moveTo => update(stage.key, { moveTo })} disabled={disabled} searchable={active.length > 10} />
    </div>)}
    <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
  </div>
}
