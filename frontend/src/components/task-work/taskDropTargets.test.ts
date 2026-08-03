import { describe, expect, it } from 'vitest'
import {
  measureTaskNavigationTargets,
  pointerFromTaskDragActivator,
  resolveTaskDropTarget,
  taskDropAutoScrollDelta,
  taskExternalListDropNeedsWrite,
  type MeasuredTaskDropTarget,
} from './taskDropTargets'

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

  it('measures the same declarative list/folder targets used by Board and Lista', () => {
    const root = document.createElement('div')
    const folder = document.createElement('div')
    folder.dataset.taskDropFolder = 'folder-a'
    folder.dataset.taskDropLabel = 'Operaciones'
    folder.getBoundingClientRect = () => ({ left: 0, right: 240, top: 10, bottom: 180, width: 240, height: 170, x: 0, y: 10, toJSON: () => ({}) })
    const list = document.createElement('div')
    list.dataset.taskDropList = 'list-a'
    list.dataset.taskDropLabel = 'Pendientes'
    list.getBoundingClientRect = () => ({ left: 24, right: 230, top: 70, bottom: 106, width: 206, height: 36, x: 24, y: 70, toJSON: () => ({}) })
    root.append(folder, list)

    expect(measureTaskNavigationTargets(root)).toEqual([
      expect.objectContaining({ type: 'folder', id: 'folder-a', label: 'Operaciones' }),
      expect.objectContaining({ type: 'list', id: 'list-a', label: 'Pendientes' }),
    ])
  })

  it('uses the real activator pointer and avoids a write when every task already belongs to the list', () => {
    const event = new MouseEvent('mousedown', { clientX: 91, clientY: 143 })
    expect(pointerFromTaskDragActivator(event)).toEqual({ x: 91, y: 143 })
    expect(taskExternalListDropNeedsWrite(['list-a', 'list-a'], 'list-a')).toBe(false)
    expect(taskExternalListDropNeedsWrite(['list-a', 'list-b'], 'list-a')).toBe(true)
  })
})
