import { describe, expect, it } from 'vitest'
import { crmPipelineDropDecision, fallbackOperationalOperationId, operationalDragStackLayers } from './operationalDragStack'

describe('operational drag visuals', () => {
  it('renders at most three converging layers', () => {
    expect(operationalDragStackLayers(1)).toHaveLength(1)
    expect(operationalDragStackLayers(8)).toHaveLength(3)
    expect(operationalDragStackLayers(8).map(layer => layer.index).sort()).toEqual([0, 1, 2])
  })

  it('does not write for an outside or same-stage drop', () => {
    expect(crmPipelineDropDecision('stage-a', null)).toBe(false)
    expect(crmPipelineDropDecision('stage-a', 'stage-a')).toBe(false)
    expect(crmPipelineDropDecision('stage-a', 'stage-b')).toBe(true)
  })

  it('creates a backend-valid UUID when randomUUID is unavailable', () => {
    expect(fallbackOperationalOperationId(() => 0.5)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
