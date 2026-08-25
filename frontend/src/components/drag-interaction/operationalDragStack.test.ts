import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { crmPipelineDropDecision, fallbackOperationalOperationId, operationalDragStackLayers } from './operationalDragStack'
import OperationalDragOverlay, { operationalDragOverlayWidth } from './OperationalDragOverlay'

afterEach(cleanup)

describe('operational drag visuals', () => {
  it('keeps the overlay inside the measured CRM card footprint', () => {
    expect(operationalDragOverlayWidth(256)).toBe(244)
    expect(operationalDragOverlayWidth(160)).toBe(196)
    expect(operationalDragOverlayWidth(400)).toBe(272)
    expect(operationalDragOverlayWidth()).toBe(260)
  })
  it('renders at most three converging layers', () => {
    expect(operationalDragStackLayers(1)).toHaveLength(1)
    expect(operationalDragStackLayers(8)).toHaveLength(3)
    expect(operationalDragStackLayers(8).map(layer => layer.index).sort()).toEqual([0, 1, 2])
  })

  it('preserves the default operational drag guidance and accessible name', () => {
    render(createElement(OperationalDragOverlay, {
      label: 'Seguimiento',
      singular: 'tarea',
      plural: 'tareas',
    }))

    expect(screen.getByText('Elige una etapa de destino')).toBeInTheDocument()
    expect(screen.getByLabelText('1 tarea seleccionado')).toBeInTheDocument()
  })

  it('allows a module to customize drag guidance and its accessible name', () => {
    render(createElement(OperationalDragOverlay, {
      label: 'Mapa de atención',
      singular: 'pizarra',
      plural: 'pizarras',
      idleLabel: 'Suelta en una carpeta',
      ariaLabel: 'Arrastrando la pizarra Mapa de atención',
    }))

    expect(screen.getByText('Suelta en una carpeta')).toBeInTheDocument()
    expect(screen.getByLabelText('Arrastrando la pizarra Mapa de atención')).toBeInTheDocument()
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
