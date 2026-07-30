import { describe, expect, it } from 'vitest'
import { cardClickSelectsTask, convergenceLimit, selectionAfterToggle, selectionForDrag, taskStackLayers, touchHoldSelectsTask, uniqueBulkItems } from './taskBoardSelection'

describe('task board group selection', () => {
  it('selects a shift range without losing the existing selection', () => {
    expect(selectionAfterToggle(['a'], 'd', ['a', 'b', 'c', 'd'], true, 'a')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('moves only an unselected card and keeps a selected group together', () => {
    expect(selectionForDrag(['a', 'b'], 'b')).toEqual(['a', 'b'])
    expect(selectionForDrag(['a', 'b'], 'c')).toEqual(['c'])
  })

  it('renders at most three cards and eight convergence copies', () => {
    expect(taskStackLayers(12)).toHaveLength(3)
    expect(convergenceLimit(Array.from({ length: 20 }, (_, index) => String(index)), '19')).toHaveLength(8)
  })

  it('deduplicates invalid bulk rows before sending', () => {
    expect(uniqueBulkItems([{ id: 'a', version: 2 }, { id: 'a', version: 2 }, { id: 'b', version: 0 }])).toEqual([{ id: 'a', version: 2 }])
  })

  it('keeps ordinary card clicks for detail and modifiers for minimal selection', () => {
    expect(cardClickSelectsTask({})).toBe(false)
    expect(cardClickSelectsTask({ ctrlKey: true })).toBe(true)
    expect(cardClickSelectsTask({ metaKey: true })).toBe(true)
    expect(cardClickSelectsTask({ shiftKey: true })).toBe(true)
  })

  it('enters touch selection only after a stationary hold', () => {
    expect(touchHoldSelectsTask(false, 3)).toBe(true)
    expect(touchHoldSelectsTask(false, 12)).toBe(false)
    expect(touchHoldSelectsTask(true, 0)).toBe(false)
  })
})
