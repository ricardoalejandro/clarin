import { describe, expect, it } from 'vitest'
import { resolveTaskDropTarget, taskDropAutoScrollDelta, type MeasuredTaskDropTarget } from './taskDropTargets'

const targets: MeasuredTaskDropTarget[] = [
  { type: 'folder', id: 'folder', label: 'NTTDATA', rect: { left: 0, right: 240, top: 0, bottom: 180 } },
  { type: 'list', id: 'list', label: 'Generales', rect: { left: 24, right: 230, top: 60, bottom: 96 } },
]

describe('task navigation drop targets', () => {
  it('prefers the concrete list over its containing folder', () => {
    expect(resolveTaskDropTarget({ x: 100, y: 72 }, targets)).toMatchObject({ type: 'list', id: 'list' })
    expect(resolveTaskDropTarget({ x: 12, y: 28 }, targets)).toMatchObject({ type: 'folder', id: 'folder' })
  })

  it('uses hysteresis without inventing a distant target', () => {
    const previous = { type: 'list' as const, id: 'list', label: 'Generales' }
    expect(resolveTaskDropTarget({ x: 100, y: 101 }, targets, previous, 8)).toMatchObject({ id: 'list' })
    expect(resolveTaskDropTarget({ x: 300, y: 300 }, targets, previous, 8)).toBeNull()
  })

  it('scrolls only near the navigation edges', () => {
    const rect = { top: 100, bottom: 500 }
    expect(taskDropAutoScrollDelta(110, rect)).toBeLessThan(0)
    expect(taskDropAutoScrollDelta(300, rect)).toBe(0)
    expect(taskDropAutoScrollDelta(492, rect)).toBeGreaterThan(0)
  })
})
