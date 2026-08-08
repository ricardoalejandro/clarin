export interface OperationalDragStackLayer {
  index: number
  x: number
  y: number
  rotation: number
  opacity: number
}

export function operationalDragStackLayers(selectedCount: number): OperationalDragStackLayer[] {
  const visible = Math.min(3, Math.max(1, selectedCount))
  const rotations = [0, -2.2, 2.6]
  return Array.from({ length: visible }, (_, index) => ({
    index,
    x: index * 6,
    y: index * 6,
    rotation: rotations[index],
    opacity: 1 - index * 0.08,
  })).reverse()
}

export function crmPipelineDropDecision(sourceStageId: string | null | undefined, targetStageId: string | null | undefined) {
  return Boolean(targetStageId && targetStageId !== sourceStageId)
}

/** UUID-shaped fallback for browsers that do not expose crypto.randomUUID. */
export function fallbackOperationalOperationId(random: () => number = Math.random) {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const value = Math.floor(random() * 16)
    return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16)
  })
}
