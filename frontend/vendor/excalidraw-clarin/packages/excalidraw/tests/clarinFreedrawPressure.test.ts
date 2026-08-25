import { describe, expect, it, vi } from 'vitest'
import { actionClearCanvas } from '../actions/actionCanvas'
import {
  actionChangeFreedrawMode,
  getFormValue,
} from '../actions/actionProperties'
import { getDefaultAppState } from '../appState'
import { restoreElements } from '../data/restore'
import { getFreedrawStrokeOptions } from '../element/freedraw'
import { newFreeDrawElement } from '../element/newElement'
import type {
  ExcalidrawFreeDrawElement,
  StrokeVariability,
} from '../element/types'
import type { AppState } from '../types'
import { pointFrom } from '@excalidraw/math'
import { KEYS, shouldAllowInputLikeElementKeydown } from '../keys'

const makeFreedraw = (
  id: string,
  variability: StrokeVariability,
): ExcalidrawFreeDrawElement =>
  newFreeDrawElement({
    id,
    type: 'freedraw',
    x: 0,
    y: 0,
    width: 24,
    height: 12,
    points: [pointFrom(0, 0), pointFrom(12, 6), pointFrom(24, 12)],
    pressures: [0.1, 0.5, 0.9],
    simulatePressure: false,
    strokeOptions: { variability, streamline: 0.5 },
  })

const makeAppState = (
  selectedElementIds: AppState['selectedElementIds'] = {},
): AppState => ({
  ...getDefaultAppState(),
  width: 1024,
  height: 768,
  offsetTop: 0,
  offsetLeft: 0,
  selectedElementIds,
})

describe('Clarin freedraw pressure backport', () => {
  it('leaves Space and arrow activation to input-like controls', () => {
    expect(shouldAllowInputLikeElementKeydown(KEYS.SPACE, false, true)).toBe(true)
    expect(shouldAllowInputLikeElementKeydown(KEYS.ARROW_RIGHT, false, true)).toBe(true)
    expect(shouldAllowInputLikeElementKeydown(KEYS.SPACE, false, false)).toBe(false)
    expect(shouldAllowInputLikeElementKeydown('a', true, true)).toBe(true)
    expect(shouldAllowInputLikeElementKeydown(KEYS.ESCAPE, true, true)).toBe(false)
  })

  it('defaults the editor preference to constant while constructors stay legacy-safe', () => {
    expect(getDefaultAppState().currentItemStrokeVariability).toBe('constant')
    expect(newFreeDrawElement({
      type: 'freedraw',
      x: 0,
      y: 0,
      points: [pointFrom(0, 0), pointFrom(10, 10)],
      pressures: [],
      simulatePressure: true,
    }).strokeOptions).toEqual({ variability: 'variable', streamline: 0.5 })
  })

  it('keeps every pointer constant by default and applies precise streamline to touch and pen', () => {
    expect(getFreedrawStrokeOptions('mouse', 'constant')).toEqual({
      variability: 'constant',
      streamline: 0.5,
    })
    expect(getFreedrawStrokeOptions('touch', 'constant')).toEqual({
      variability: 'constant',
      streamline: 0.2,
    })
    expect(getFreedrawStrokeOptions('pen', 'constant')).toEqual({
      variability: 'constant',
      streamline: 0.2,
    })
    expect(getFreedrawStrokeOptions('pen', 'variable')).toEqual({
      variability: 'variable',
      streamline: 0.2,
    })
  })

  it('restores missing and invalid options as variable and preserves valid options', () => {
    const legacy = makeFreedraw('legacy', 'constant') as any
    delete legacy.strokeOptions
    const invalid = {
      ...makeFreedraw('invalid', 'constant'),
      strokeOptions: { variability: 'unexpected', streamline: 'bad' },
    } as any
    const valid = {
      ...makeFreedraw('valid', 'constant'),
      strokeOptions: { variability: 'constant', streamline: 0.2 },
    } as any

    const [restoredLegacy, restoredInvalid, restoredValid] = restoreElements(
      [legacy, invalid, valid],
      null,
    ) as ExcalidrawFreeDrawElement[]

    expect(restoredLegacy.strokeOptions).toEqual({
      variability: 'variable',
      streamline: 0.5,
    })
    expect(restoredInvalid.strokeOptions).toEqual({
      variability: 'variable',
      streamline: 0.5,
    })
    expect(restoredValid.strokeOptions).toEqual({
      variability: 'constant',
      streamline: 0.2,
    })
  })

  it('shows a neutral mixed value and changes all selected strokes in one action', async () => {
    const constant = makeFreedraw('constant', 'constant')
    const variable = makeFreedraw('variable', 'variable')
    const state = makeAppState({ constant: true, variable: true })

    const mixed = getFormValue<StrokeVariability | null>(
      [constant, variable],
      state,
      element => element.type === 'freedraw'
        ? element.strokeOptions.variability
        : null,
      element => element.type === 'freedraw',
      hasSelection => hasSelection ? null : state.currentItemStrokeVariability,
    )
    expect(mixed).toBeNull()

    const result = await actionChangeFreedrawMode.perform(
      [constant, variable],
      state,
      'constant',
      {} as never,
    )
    expect(result).not.toBe(false)
    if (!result) {
      throw new Error('changeFreedrawMode must return an action result')
    }
    const changed = result.elements as ExcalidrawFreeDrawElement[]
    expect(changed.map(element => element.strokeOptions.variability)).toEqual([
      'constant',
      'constant',
    ])
    expect(changed.map(element => element.pressures)).toEqual([
      constant.pressures,
      variable.pressures,
    ])
    expect(changed.map(element => element.points)).toEqual([
      constant.points,
      variable.points,
    ])
    expect(changed.map(element => element.simulatePressure)).toEqual([
      constant.simulatePressure,
      variable.simulatePressure,
    ])
    expect(changed.map(element => element.strokeOptions.streamline)).toEqual([
      constant.strokeOptions.streamline,
      variable.strokeOptions.streamline,
    ])
    expect(changed.every((element, index) => element.version > [constant, variable][index].version)).toBe(true)
    expect(result.appState?.currentItemStrokeVariability).toBe('constant')
    expect(result.captureUpdate).toBe('IMMEDIATELY')
  })

  it('does not reset the pressure preference when clearing the canvas', async () => {
    const stroke = makeFreedraw('stroke', 'variable')
    const state = {
      ...makeAppState({ stroke: true }),
      currentItemStrokeVariability: 'variable' as const,
    }
    const clear = vi.fn()
    const result = await actionClearCanvas.perform(
      [stroke],
      state,
      null,
      { imageCache: { clear } } as never,
    )
    expect(result).not.toBe(false)
    if (!result) {
      throw new Error('clearCanvas must return an action result')
    }
    expect(clear).toHaveBeenCalledOnce()
    expect(result.appState?.currentItemStrokeVariability).toBe('variable')
  })
})
