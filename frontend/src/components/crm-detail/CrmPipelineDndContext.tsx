'use client'

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core'
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import OperationalDragOverlay from '@/components/drag-interaction/OperationalDragOverlay'
import { crmPipelineDropDecision, fallbackOperationalOperationId } from '@/components/drag-interaction/operationalDragStack'

export type CrmPipelineStageDescriptor = { id: string; name: string; color?: string }
export type CrmPipelineDragData = {
  kind: 'crm-pipeline-card'
  entityId: string
  label: string
  count: number
  singular: string
  plural: string
  sourceStageId?: string | null
  onCommit: (stageId: string, operationId: string) => void
}

type Props = {
  children: ReactNode
  stages: CrmPipelineStageDescriptor[]
  onSessionChange?: (entityId: string | null, stageId: string | null) => void
  disabled?: boolean
}

type GatherGhost = { id: string; label: string; left: number; top: number; width: number; height: number; dx: number; dy: number }

export function nextCrmPipelineKeyboardStage(stageIds: string[], currentStageId: string | null | undefined, direction: -1 | 1) {
  if (!stageIds.length) return null
  const currentIndex = currentStageId ? stageIds.indexOf(currentStageId) : -1
  if (currentIndex < 0) return direction > 0 ? stageIds[0] : stageIds[stageIds.length - 1]
  return stageIds[Math.max(0, Math.min(stageIds.length - 1, currentIndex + direction))]
}

const crmPipelineKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const direction = event.code === 'ArrowRight' || event.code === 'ArrowDown'
    ? 1
    : event.code === 'ArrowLeft' || event.code === 'ArrowUp'
      ? -1
      : null
  if (!direction) return undefined

  const stages: Array<{ stageId: string; left: number; top: number }> = []
  context.droppableContainers.getEnabled().forEach(container => {
    const stageId = container.data.current?.stageId as string | undefined
    const rect = context.droppableRects.get(container.id)
    if (stageId && rect) stages.push({ stageId, left: rect.left, top: rect.top })
  })
  stages.sort((first, second) => first.left - second.left || first.top - second.top)
  const currentStageId = context.over?.data.current?.stageId as string | undefined
    || context.active?.data.current?.sourceStageId as string | undefined
  const nextStageId = nextCrmPipelineKeyboardStage(stages.map(stage => stage.stageId), currentStageId, direction)
  const target = stages.find(stage => stage.stageId === nextStageId)
  if (!target) return undefined
  event.preventDefault()
  return { x: target.left, y: target.top }
}

function operationId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : fallbackOperationalOperationId()
}

export default function CrmPipelineDndContext({ children, stages, onSessionChange, disabled = false }: Props) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 520, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: crmPipelineKeyboardCoordinates }),
  )
  const [active, setActive] = useState<CrmPipelineDragData | null>(null)
  const [overStageId, setOverStageId] = useState<string | null>(null)
  const [gatherGhosts, setGatherGhosts] = useState<GatherGhost[]>([])
  const gatherTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (gatherTimerRef.current) clearTimeout(gatherTimerRef.current) }, [])

  const reset = (_event?: DragCancelEvent | DragEndEvent) => {
    setActive(null)
    setOverStageId(null)
    setGatherGhosts([])
    onSessionChange?.(null, null)
  }

  const start = (event: DragStartEvent) => {
    const data = event.active.data.current as CrmPipelineDragData | undefined
    if (!data || data.kind !== 'crm-pipeline-card') return
    setActive(data)
    setOverStageId(data.sourceStageId || null)
    onSessionChange?.(data.entityId, data.sourceStageId || null)

    if (data.count > 1 && typeof document !== 'undefined') {
      const activeRect = document.querySelector<HTMLElement>(`[data-crm-pipeline-card="${CSS.escape(data.entityId)}"]`)?.getBoundingClientRect()
      if (activeRect) {
        const ghosts = Array.from(document.querySelectorAll<HTMLElement>('[data-crm-pipeline-card][data-crm-selected="true"]'))
          .filter(node => node.dataset.crmPipelineCard !== data.entityId)
          .slice(0, 8)
          .map(node => {
            const rect = node.getBoundingClientRect()
            return { id: node.dataset.crmPipelineCard || '', label: node.dataset.crmPipelineLabel || 'Elemento seleccionado', left: rect.left, top: rect.top, width: rect.width, height: Math.min(rect.height, 88), dx: activeRect.left - rect.left, dy: activeRect.top - rect.top }
          })
        setGatherGhosts(ghosts)
        gatherTimerRef.current = setTimeout(() => { setGatherGhosts([]); gatherTimerRef.current = null }, 180)
      }
    }
  }

  const over = (event: DragOverEvent) => {
    const stageId = event.over?.data.current?.stageId as string | undefined
    const next = stageId || null
    setOverStageId(next)
    if (active) onSessionChange?.(active.entityId, next)
  }

  const end = (event: DragEndEvent) => {
    const data = event.active.data.current as CrmPipelineDragData | undefined
    const targetStageId = event.over?.data.current?.stageId as string | undefined
    if (data && data.kind === 'crm-pipeline-card' && crmPipelineDropDecision(data.sourceStageId, targetStageId)) {
      data.onCommit(targetStageId!, operationId())
    }
    reset(event)
  }

  const destination = stages.find(stage => stage.id === overStageId)
  return <>
    <DndContext
      sensors={disabled ? [] : sensors}
      collisionDetection={closestCenter}
      autoScroll
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={start}
      onDragOver={over}
      onDragEnd={end}
      onDragCancel={reset}
      accessibility={{ announcements: {
        onDragStart: ({ active: activeItem }) => `Se inició el movimiento de ${String(activeItem.id)}.`,
        onDragOver: ({ over: target }) => target ? `Destino ${String(target.id)}.` : 'Fuera de una etapa.',
        onDragEnd: ({ over: target }) => target ? `Movimiento terminado en ${String(target.id)}.` : 'Movimiento cancelado.',
        onDragCancel: () => 'Movimiento cancelado sin cambios.',
      } }}
    >
      {children}
      <DragOverlay dropAnimation={{ duration: 180, easing: 'ease-out' }} style={{ zIndex: 160 }}>
        {active ? <OperationalDragOverlay label={active.label} count={active.count} singular={active.singular} plural={active.plural} destination={destination?.name} destinationColor={destination?.color} /> : null}
      </DragOverlay>
    </DndContext>
    {gatherGhosts.length > 0 && typeof document !== 'undefined' && createPortal(<div className="pointer-events-none fixed inset-0 z-[159] motion-reduce:hidden" aria-hidden="true">{gatherGhosts.map(ghost => <div key={ghost.id} data-operational-gather-ghost className="fixed overflow-hidden rounded-xl border border-emerald-300 bg-white px-3 py-2 shadow-xl" style={{ left: ghost.left, top: ghost.top, width: ghost.width, height: ghost.height, '--task-gather-x': `${ghost.dx}px`, '--task-gather-y': `${ghost.dy}px` } as CSSProperties}><span className="line-clamp-2 text-sm font-semibold text-slate-700">{ghost.label}</span></div>)}</div>, document.body)}
  </>
}

export function useCrmPipelineStageDrop(stageId: string, disabled = false) {
  return useDroppable({ id: `crm-stage:${stageId}`, data: { kind: 'crm-pipeline-stage', stageId }, disabled })
}
