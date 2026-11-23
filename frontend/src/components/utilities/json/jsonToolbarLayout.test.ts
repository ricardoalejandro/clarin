import { describe, expect, it } from 'vitest'
import { fineUtilityPointer, jsonToolbarLayout } from './jsonToolbarLayout'

describe('JSON toolbar measured capacity', () => {
  it('reserves the pinned controls and keeps history together at the exact boundary', () => {
    expect(jsonToolbarLayout(280, true, 'strict', false).visible).toEqual([])
    expect(jsonToolbarLayout(281, true, 'strict', false).visible).toEqual([['undo', 'redo']])
    expect(jsonToolbarLayout(320, false, 'strict', false).visible).toEqual([])
    expect(jsonToolbarLayout(360, false, 'strict', false).visible).toEqual([])
    expect(jsonToolbarLayout(361, false, 'strict', false).visible).toEqual([['undo', 'redo']])
  })

  it('promotes a stable prefix without dropping or duplicating an action', () => {
    for (const fine of [false, true]) for (const format of ['strict', 'jsonc', 'xml'] as const) for (const split of [false, true]) {
      let previous: string[] = []
      for (const width of [0, 264, 320, 375, 480, 640, 727, 832, 1024, 1440]) {
        const plan = jsonToolbarLayout(width, fine, format, split)
        const promoted = plan.visible.flat()
        const all = [...promoted, ...plan.overflow]
        expect(new Set(all).size).toBe(all.length)
        expect(promoted.slice(0, previous.length)).toEqual(previous)
        expect(all.includes('panel')).toBe(!split)
        expect(all.includes('compare')).toBe(split)
        expect(all.includes('smart')).toBe(format !== 'xml')
        if (promoted.length) expect(plan.used).toBeLessThanOrEqual(width)
        previous = promoted
      }
    }
  })

  it('responds to the editor width and allows all promoted operations at 727 desktop pixels', () => {
    expect(jsonToolbarLayout(727, true, 'strict', true).overflow).toEqual([])
    expect(jsonToolbarLayout(640, false, 'strict', true).overflow.length).toBeGreaterThan(0)
    expect(jsonToolbarLayout(Number.NaN, true, 'strict', true).visible).toEqual([])
  })

  it('retains touch targets on hybrid devices', () => {
    expect(fineUtilityPointer(true, false)).toBe(true)
    expect(fineUtilityPointer(true, true)).toBe(false)
    expect(fineUtilityPointer(false, false)).toBe(false)
  })
})
