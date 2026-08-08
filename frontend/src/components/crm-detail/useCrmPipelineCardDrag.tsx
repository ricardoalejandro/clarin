'use client'

import { useDraggable } from '@dnd-kit/core'
import { useCallback, useRef } from 'react'
import type { CrmPipelineDragData } from './CrmPipelineDndContext'

export type CrmPipelineStageOption = { id: string; name: string }

type Options = {
  entityId: string
  label: string
  count?: number
  singular?: string
  plural?: string
  currentStageId?: string | null
  stages: CrmPipelineStageOption[]
  disabled?: boolean
  onSessionChange?: (entityId: string | null, targetStageId: string | null) => void
  onCommit: (targetStageId: string, operationId?: string) => void
}

export default function useCrmPipelineCardDrag({ entityId, label, count = 1, singular = 'elemento', plural = 'elementos', currentStageId, disabled = false, onCommit }: Options) {
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit
  const commit = useCallback((targetStageId: string, operationId: string) => commitRef.current(targetStageId, operationId), [])
  const data: CrmPipelineDragData = {
    kind: 'crm-pipeline-card',
    entityId,
    label,
    count,
    singular,
    plural,
    sourceStageId: currentStageId,
    onCommit: commit,
  }
  const draggable = useDraggable({ id: `crm-card:${entityId}`, data, disabled })

  return {
    active: draggable.isDragging,
    isDragging: draggable.isDragging,
    setNodeRef: draggable.setNodeRef,
    setActivatorNodeRef: draggable.setActivatorNodeRef,
    listeners: draggable.listeners,
    attributes: draggable.attributes,
    overlay: null,
    consumeSuppressedClick: () => false,
    instructions: 'Usa el control de arrastre. Con teclado pulsa Espacio, navega y confirma con Espacio; Escape cancela.',
  }
}
