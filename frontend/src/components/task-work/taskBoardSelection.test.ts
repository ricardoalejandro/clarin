import { describe, expect, it } from 'vitest'
import { convergenceLimit, selectionAfterToggle, selectionForDrag, taskStackLayers, uniqueBulkItems } from './taskBoardSelection'

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
})
