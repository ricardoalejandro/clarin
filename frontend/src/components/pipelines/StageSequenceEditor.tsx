'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type ScreenReaderInstructions,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Eye,
  EyeOff,
  GripVertical,
  LockKeyhole,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react'
import { STAGE_COLORS, createStageKey, normalizeDraftPositions, normalizeName, type StageDraft } from './pipeline-contracts'

interface StageSequenceEditorProps {
  stages: StageDraft[]
  onChange: (stages: StageDraft[]) => void
  onRequestDelete: (stage: StageDraft) => void
  disabled?: boolean
  hiddenStageIds?: Set<string>
  onToggleVisibility?: (stageId: string) => void
  onAnnouncement?: (message: string) => void
}

interface SortableStageRowProps {
  stage: StageDraft
  index: number
  total: number
  duplicate: boolean
  disabled: boolean
  hidden?: boolean
  onChange: (patch: Partial<StageDraft>) => void
  onDelete: () => void
  onMove: (direction: -1 | 1) => void
  onToggleVisibility?: () => void
}

const buttonClass = 'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-35'

function ColorPicker({ value, onChange, disabled, label }: { value: string; onChange: (color: string) => void; disabled: boolean; label: string }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [open])
  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white transition hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:opacity-50"
        onClick={() => setOpen(value => !value)}
        disabled={disabled}
        aria-label={`Elegir color para ${label || 'la etapa'}`}
        aria-expanded={open}
      >
        <span className="h-5 w-5 rounded-full ring-2 ring-white shadow-[0_0_0_1px_rgba(15,23,42,0.18)]" style={{ backgroundColor: value }} />
      </button>
      {open && !disabled && (
        <div className="absolute -left-14 top-full z-30 mt-2 w-72 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl sm:left-0" role="group" aria-label="Paleta de colores">
          <p className="mb-2 text-xs font-semibold text-slate-600">Color de la etapa</p>
          <div className="grid grid-cols-7 gap-2">
            {STAGE_COLORS.map(color => (
              <button
                key={color}
                type="button"
                onClick={() => { onChange(color); setOpen(false); triggerRef.current?.focus() }}
                className={`h-8 w-8 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 ${value === color ? 'ring-2 ring-slate-900 ring-offset-2' : 'hover:scale-110'}`}
                style={{ backgroundColor: color }}
                aria-label={`Usar color ${color}`}
                aria-pressed={value === color}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function SortableStageRow({ stage, index, total, duplicate, disabled, hidden, onChange, onDelete, onMove, onToggleVisibility }: SortableStageRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: stage.key, disabled })
  const style = { transform: CSS.Transform.toString(transform), transition }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group rounded-2xl border bg-white p-3 shadow-sm transition-shadow ${duplicate || !stage.name.trim() ? 'border-red-300 ring-1 ring-red-100' : 'border-slate-200'} ${isDragging ? 'z-30 shadow-xl ring-2 ring-emerald-300' : 'hover:shadow-md'} ${hidden ? 'opacity-60' : ''}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className={`${buttonClass} cursor-grab touch-none active:cursor-grabbing`}
          disabled={disabled}
          aria-label={`Mover ${stage.name || 'etapa'}; posición ${index + 1} de ${total}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-5 w-5" aria-hidden="true" />
        </button>
        <span className="hidden w-7 shrink-0 text-center text-xs font-semibold tabular-nums text-slate-400 sm:block">{index + 1}</span>
        <ColorPicker value={stage.color} onChange={color => onChange({ color })} disabled={disabled} label={stage.name} />
        <div className="min-w-0 flex-1">
          <label htmlFor={`stage-name-${stage.key}`} className="sr-only">Nombre de la etapa {index + 1}</label>
          <input
            id={`stage-name-${stage.key}`}
            value={stage.name}
            onChange={event => onChange({ name: event.target.value })}
            maxLength={80}
            disabled={disabled}
            className="h-11 w-full rounded-xl border border-transparent bg-slate-50 px-3 text-sm font-semibold text-slate-800 outline-none transition placeholder:text-slate-400 hover:bg-slate-100 focus:border-emerald-400 focus:bg-white focus:ring-2 focus:ring-emerald-100 disabled:opacity-60"
            placeholder="Nombre de la etapa"
            aria-invalid={duplicate || !stage.name.trim()}
          />
          {(duplicate || !stage.name.trim()) && <p className="mt-1 text-xs font-medium text-red-600">{duplicate ? 'Este nombre está repetido.' : 'Escribe un nombre.'}</p>}
        </div>
        {stage.lead_count > 0 && (
          <span className="hidden shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold tabular-nums text-slate-600 md:inline-flex" aria-label={`${stage.lead_count} oportunidades`}>
            {stage.lead_count}
          </span>
        )}
        <div className="hidden items-center sm:flex">
          <button type="button" className={buttonClass} onClick={() => onMove(-1)} disabled={disabled || index === 0} aria-label={`Subir ${stage.name}`}>
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" className={buttonClass} onClick={() => onMove(1)} disabled={disabled || index === total - 1} aria-label={`Bajar ${stage.name}`}>
            <ArrowDown className="h-4 w-4" aria-hidden="true" />
          </button>
          {stage.id && onToggleVisibility && (
            <button type="button" className={buttonClass} onClick={onToggleVisibility} disabled={disabled} aria-label={hidden ? `Mostrar ${stage.name} en el Kanban` : `Ocultar ${stage.name} del Kanban`} aria-pressed={hidden}>
              {hidden ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
            </button>
          )}
          <button type="button" className={`${buttonClass} hover:bg-red-50 hover:text-red-600`} onClick={onDelete} disabled={disabled} aria-label={`Eliminar ${stage.name}`}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="mt-2 flex justify-end gap-1 border-t border-slate-100 pt-2 sm:hidden">
        <button type="button" className={buttonClass} onClick={() => onMove(-1)} disabled={disabled || index === 0} aria-label={`Subir ${stage.name}`}><ArrowUp className="h-4 w-4" /></button>
        <button type="button" className={buttonClass} onClick={() => onMove(1)} disabled={disabled || index === total - 1} aria-label={`Bajar ${stage.name}`}><ArrowDown className="h-4 w-4" /></button>
        {stage.id && onToggleVisibility && (
          <button type="button" className={buttonClass} onClick={onToggleVisibility} disabled={disabled} aria-label={hidden ? `Mostrar ${stage.name} en el Kanban` : `Ocultar ${stage.name} del Kanban`} aria-pressed={hidden}>
            {hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
        <button type="button" className={`${buttonClass} hover:bg-red-50 hover:text-red-600`} onClick={onDelete} disabled={disabled} aria-label={`Eliminar ${stage.name}`}><Trash2 className="h-4 w-4" /></button>
      </div>
    </div>
  )
}

function TerminalStageRow({ stage, disabled, duplicate, onChange }: { stage: StageDraft; disabled: boolean; duplicate: boolean; onChange: (patch: Partial<StageDraft>) => void }) {
  const won = stage.stage_type === 'won'
  return (
    <div className={`rounded-2xl border bg-white p-3 shadow-sm ${duplicate || !stage.name.trim() ? 'border-red-300' : won ? 'border-emerald-200' : 'border-red-200'}`}>
      <div className="flex min-w-0 items-center gap-2">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${won ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
          {won ? <CheckCircle2 className="h-5 w-5" aria-hidden="true" /> : <XCircle className="h-5 w-5" aria-hidden="true" />}
        </div>
        <ColorPicker value={stage.color} onChange={color => onChange({ color })} disabled={disabled} label={stage.name} />
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-1.5">
            <span className={`text-[10px] font-bold uppercase tracking-widest ${won ? 'text-emerald-700' : 'text-red-700'}`}>{won ? 'Resultado ganado' : 'Resultado perdido'}</span>
            <LockKeyhole className="h-3 w-3 text-slate-400" aria-label="Etapa protegida" />
          </div>
          <label htmlFor={`stage-name-${stage.key}`} className="sr-only">Nombre de la etapa {won ? 'ganada' : 'perdida'}</label>
          <input
            id={`stage-name-${stage.key}`}
            value={stage.name}
            onChange={event => onChange({ name: event.target.value })}
            maxLength={80}
            disabled={disabled}
            className="h-11 w-full rounded-xl border border-transparent bg-slate-50 px-3 text-sm font-semibold text-slate-800 outline-none transition hover:bg-slate-100 focus:border-emerald-400 focus:bg-white focus:ring-2 focus:ring-emerald-100 disabled:opacity-60"
            aria-invalid={duplicate || !stage.name.trim()}
          />
        </div>
        {stage.lead_count > 0 && <span className="hidden rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold tabular-nums text-slate-600 sm:inline-flex">{stage.lead_count}</span>}
      </div>
      {(duplicate || !stage.name.trim()) && <p className="mt-1 pl-[108px] text-xs font-medium text-red-600">{duplicate ? 'Este nombre está repetido.' : 'Escribe un nombre.'}</p>}
    </div>
  )
}

export default function StageSequenceEditor({ stages, onChange, onRequestDelete, disabled = false, hiddenStageIds, onToggleVisibility, onAnnouncement }: StageSequenceEditorProps) {
  const activeStages = stages.filter(stage => stage.stage_type === 'active')
  const terminalStages = stages.filter(stage => stage.stage_type !== 'active')
  const normalizedNames = stages.map(stage => normalizeName(stage.name))
  const duplicateKeys = useMemo(() => new Set(stages.filter((stage, index) => {
    const normalized = normalizedNames[index]
    return normalized && normalizedNames.indexOf(normalized) !== normalizedNames.lastIndexOf(normalized)
  }).map(stage => stage.key)), [stages, normalizedNames])
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const stageNameByKey = (key: string | number) => activeStages.find(stage => stage.key === String(key))?.name || 'Etapa'
  const dndAnnouncements: Announcements = {
    onDragStart: ({ active }) => `${stageNameByKey(active.id)} seleccionada para mover.`,
    onDragOver: ({ active, over }) => over
      ? `${stageNameByKey(active.id)} sobre la posición ${activeStages.findIndex(stage => stage.key === String(over.id)) + 1} de ${activeStages.length}.`
      : `${stageNameByKey(active.id)} está fuera de una posición válida.`,
    onDragEnd: ({ active, over }) => over
      ? `${stageNameByKey(active.id)} movida a la posición ${activeStages.findIndex(stage => stage.key === String(over.id)) + 1} de ${activeStages.length}.`
      : `${stageNameByKey(active.id)} no se movió.`,
    onDragCancel: ({ active }) => `Movimiento de ${stageNameByKey(active.id)} cancelado.`,
  }
  const screenReaderInstructions: ScreenReaderInstructions = {
    draggable: 'Para mover una etapa, presiona Espacio. Usa las flechas para cambiar su posición. Presiona Espacio otra vez para soltarla o Escape para cancelar.',
  }

  const updateStage = (key: string, patch: Partial<StageDraft>) => {
    onChange(normalizeDraftPositions(stages.map(stage => stage.key === key ? { ...stage, ...patch } : stage)))
  }

  const moveStage = (key: string, direction: -1 | 1) => {
    const oldIndex = activeStages.findIndex(stage => stage.key === key)
    const newIndex = oldIndex + direction
    if (oldIndex < 0 || newIndex < 0 || newIndex >= activeStages.length) return
    const reordered = arrayMove(activeStages, oldIndex, newIndex)
    onChange(normalizeDraftPositions([...reordered, ...terminalStages]))
    onAnnouncement?.(`${activeStages[oldIndex].name} movida a la posición ${newIndex + 1} de ${activeStages.length}.`)
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const oldIndex = activeStages.findIndex(stage => stage.key === active.id)
    const newIndex = activeStages.findIndex(stage => stage.key === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const reordered = arrayMove(activeStages, oldIndex, newIndex)
    onChange(normalizeDraftPositions([...reordered, ...terminalStages]))
    onAnnouncement?.(`${activeStages[oldIndex].name} movida a la posición ${newIndex + 1} de ${activeStages.length}.`)
  }

  const addStage = () => {
    const position = activeStages.length
    const next: StageDraft = {
      key: createStageKey(),
      name: `Nueva etapa${position > 0 ? ` ${position + 1}` : ''}`,
      color: STAGE_COLORS[position % STAGE_COLORS.length],
      stage_type: 'active',
      position,
      lead_count: 0,
    }
    onChange(normalizeDraftPositions([...activeStages, next, ...terminalStages]))
    onAnnouncement?.(`${next.name} agregada en la posición ${position + 1}.`)
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="active-stages-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 id="active-stages-heading" className="text-sm font-bold text-slate-900">Etapas activas</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-slate-500">Ordénalas según el recorrido real de una oportunidad.</p>
          </div>
          <button
            type="button"
            onClick={addStage}
            disabled={disabled}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 text-sm font-semibold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> Agregar etapa
          </button>
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd} accessibility={{ announcements: dndAnnouncements, screenReaderInstructions }}>
          <SortableContext items={activeStages.map(stage => stage.key)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2.5">
              {activeStages.map((stage, index) => (
                <SortableStageRow
                  key={stage.key}
                  stage={stage}
                  index={index}
                  total={activeStages.length}
                  duplicate={duplicateKeys.has(stage.key)}
                  disabled={disabled}
                  hidden={stage.id ? hiddenStageIds?.has(stage.id) : false}
                  onChange={patch => updateStage(stage.key, patch)}
                  onDelete={() => onRequestDelete(stage)}
                  onMove={direction => moveStage(stage.key, direction)}
                  onToggleVisibility={stage.id && onToggleVisibility ? () => onToggleVisibility(stage.id!) : undefined}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </section>

      <section aria-labelledby="terminal-stages-heading">
        <div className="mb-3">
          <h3 id="terminal-stages-heading" className="text-sm font-bold text-slate-900">Resultados del pipeline</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-slate-500">Estas etapas cierran la oportunidad y alimentan tus resultados. Puedes renombrarlas, pero no eliminarlas.</p>
        </div>
        <div className="grid gap-2.5 lg:grid-cols-2">
          {terminalStages.map(stage => (
            <TerminalStageRow key={stage.key} stage={stage} disabled={disabled} duplicate={duplicateKeys.has(stage.key)} onChange={patch => updateStage(stage.key, patch)} />
          ))}
        </div>
      </section>
    </div>
  )
}
