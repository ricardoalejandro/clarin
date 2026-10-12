import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { actionChangeFreedrawMode, actionChangeStrokeWidth } from '../actions/actionProperties'
import { getDefaultAppState } from '../appState'
import { newElement, newFreeDrawElement } from '../element/newElement'
import { getClarinStrokePreset, resolveClarinStrokeWidth } from '../element/clarinStrokeWidth'
import { getClarinExportBounds } from '../scene/clarinExportBounds'
import { getCommonBounds } from '../element/bounds'
import { getExportSize } from '../scene/export'
import { getFreedrawOutlinePoints } from '../renderer/renderElement'
import { pointFrom } from '@excalidraw/math'
import type { AppState } from '../types'
import type { ExcalidrawElement, StrokeVariability } from '../element/types'

afterEach(cleanup)
const stroke = (id: string, strokeWidth: number, variability: StrokeVariability = 'constant') => ({ ...newFreeDrawElement({
  id, type: 'freedraw', x: 0, y: 0, width: 1000, height: 0, strokeWidth,
  points: Array.from({ length: 201 }, (_, index) => pointFrom(index * 5, 0)),
  pressures: [], simulatePressure: true,
  strokeOptions: { variability, streamline: 0.5 },
}), lastCommittedPoint: pointFrom(1000, 0) })
const state = (elements: ExcalidrawElement[] = []): AppState => ({
  ...getDefaultAppState(), width: 1024, height: 768, offsetTop: 0, offsetLeft: 0,
  selectedElementIds: Object.fromEntries(elements.map(element => [element.id, true])),
})

describe('Clarin semantic stroke presets', () => {
  it('keeps the three original values and makes constant free draw distinctly wider', () => {
    const constant = { type: 'freedraw', strokeOptions: { variability: 'constant' as const } }
    expect([1, 2, 4, 'wide'].map(preset => resolveClarinStrokeWidth(preset as 1 | 2 | 4 | 'wide', constant))).toEqual([1, 2, 4, 16])
    expect(resolveClarinStrokeWidth('wide', { type: 'rectangle' })).toBe(8)
    expect(resolveClarinStrokeWidth('wide', { type: 'freedraw' })).toBe(8)
    expect(resolveClarinStrokeWidth('wide', { type: 'freedraw', strokeOptions: { variability: 'variable' } })).toBe(8)
    const diameter = (element: ReturnType<typeof stroke>) => {
      const ys = getFreedrawOutlinePoints(element).map(point => point[1])
      return Math.max(...ys) - Math.min(...ys)
    }
    expect(diameter(stroke('new', 16))).toBeCloseTo(44.8)
    expect(diameter(stroke('new', 16))).toBeGreaterThan(diameter(stroke('legacy', 4, 'variable')))
  })

  it('changes a mixed selection in one history action without touching unselected elements', async () => {
    const constant = stroke('constant', 8)
    const variable = stroke('variable', 4, 'variable')
    const rectangle = newElement({ id: 'rect', type: 'rectangle', x: 0, y: 0, strokeWidth: 1 })
    const unselected = stroke('other', 2)
    const selected = [constant, variable, rectangle]
    const result = await actionChangeStrokeWidth.perform([...selected, unselected] as never, state(selected), 'wide', {} as never)
    expect(result).toMatchObject({ captureUpdate: 'IMMEDIATELY' })
    if (!result?.elements) throw new Error('Expected width mutation')
    expect(result.elements.map(element => element.strokeWidth)).toEqual([16, 8, 8, 2])
    expect(result.elements[3]).toBe(unselected)
    expect(selected.map(element => element.strokeWidth)).toEqual([8, 4, 1])
  })

  it('does not rewrite historical widths when pressure mode changes', async () => {
    const historical = stroke('legacy-eight', 8)
    expect(getClarinStrokePreset(8, historical)).toBeNull()
    const result = await actionChangeFreedrawMode.perform([historical] as never, state([historical]), 'variable', {} as never)
    if (!result?.elements) throw new Error('Expected pressure mutation')
    expect(result.elements[0].strokeWidth).toBe(8)
    expect(getClarinStrokePreset(8, result.elements[0])).toBe('wide')
    expect(historical.strokeOptions.variability).toBe('constant')
  })

  it('shows legacy width as custom and gives Amplio its own visible icon and semantic click', () => {
    const historical = stroke('legacy-eight', 8)
    const onChange = vi.fn()
    const Panel = actionChangeStrokeWidth.PanelComponent!
    render(<Panel elements={[historical] as never} appState={state([historical])} updateData={onChange} app={{} as never} appProps={{}} />)
    expect(screen.getByRole('status')).toHaveTextContent('Grosor personalizado: 8')
    const wide = screen.getByRole('radio', { name: 'Amplio' })
    expect(wide).not.toBeChecked()
    expect(wide.parentElement?.querySelector('svg path')).toHaveAttribute('stroke-width', '5.5')
    expect(screen.getByTestId('strokeWidth-extraBold').parentElement?.querySelector('svg path')).toHaveAttribute('stroke-width', '3.75')
    fireEvent.click(wide)
    expect(onChange).toHaveBeenCalledExactlyOnceWith('wide')
  })

  it('shows a shared semantic preset for mixed constant and variable numeric widths', () => {
    const elements = [stroke('constant', 16), stroke('variable', 8, 'variable')]
    const Panel = actionChangeStrokeWidth.PanelComponent!
    render(<Panel elements={elements as never} appState={state(elements)} updateData={vi.fn()} app={{} as never} appProps={{}} />)
    expect(screen.getByRole('radio', { name: 'Amplio' })).toBeChecked()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('export ink bounds', () => {
  it.each([8, 16])('includes the complete ink of a constant %i stroke without changing selection bounds', width => {
    const element = stroke(`wide-${width}`, width)
    const before = JSON.stringify(element)
    expect(getCommonBounds([element])).toEqual([0, 0, 1000, 0])
    const bounds = getClarinExportBounds([element])
    expect(bounds[1]).toBeCloseTo(-width * 1.4)
    expect(bounds[3]).toBeCloseTo(width * 1.4)
    expect(getExportSize([element], 10, 1)[1]).toBe(Math.ceil(width * 2.8 + 20))
    expect(getCommonBounds([element])).toEqual([0, 0, 1000, 0])
    expect(JSON.stringify(element)).toBe(before)
  })

  it('rotates the ink around the same center as rendering', () => {
    const element = { ...stroke('rotated', 16), angle: Math.PI / 2 }
    const bounds = getClarinExportBounds([element])
    expect(bounds[0]).toBeCloseTo(500 - 22.4)
    expect(bounds[2]).toBeCloseTo(500 + 22.4)
    expect(bounds[1]).toBeLessThan(-500)
    expect(bounds[3]).toBeGreaterThan(490)
  })

  it('includes taps and variable pressure outlines, preserving frame crop dimensions', () => {
    const tap = { ...stroke('tap', 16), points: [pointFrom(0, 0)] }
    expect(getClarinExportBounds([tap])[3]).toBeGreaterThan(20)
    const variable = stroke('variable', 8, 'variable')
    const bounds = getClarinExportBounds([variable])
    for (const [x, y] of getFreedrawOutlinePoints(variable)) {
      expect(x).toBeGreaterThanOrEqual(bounds[0])
      expect(x).toBeLessThanOrEqual(bounds[2])
      expect(y).toBeGreaterThanOrEqual(bounds[1])
      expect(y).toBeLessThanOrEqual(bounds[3])
    }
    const frame = { ...newElement({ type: 'rectangle', x: 0, y: 0, width: 100, height: 60 }), type: 'frame' } as never
    expect(getExportSize([frame], 0, 1)).toEqual([100, 60])
  })
})
