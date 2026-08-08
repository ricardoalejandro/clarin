import { operationalDragStackLayers, type OperationalDragStackLayer } from '@/components/drag-interaction/operationalDragStack'

export type TaskStackLayer = OperationalDragStackLayer

export function taskStackLayers(selectedCount: number): TaskStackLayer[] {
  return operationalDragStackLayers(selectedCount)
}

export function selectionAfterToggle(current: string[], taskID: string, orderedIDs: string[], shift: boolean, anchorID?: string) {
  if (shift && anchorID) {
    const anchor = orderedIDs.indexOf(anchorID)
    const target = orderedIDs.indexOf(taskID)
    if (anchor >= 0 && target >= 0) {
      const range = orderedIDs.slice(Math.min(anchor, target), Math.max(anchor, target) + 1)
      return Array.from(new Set([...current, ...range]))
    }
  }
  return current.includes(taskID) ? current.filter(id => id !== taskID) : [...current, taskID]
}

export function selectionForDrag(current: string[], activeID: string) {
  return current.includes(activeID) ? current : [activeID]
}

export function cardClickSelectsTask(modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) {
  return Boolean(modifiers.ctrlKey || modifiers.metaKey || modifiers.shiftKey)
}

export function touchHoldSelectsTask(selected: boolean, movement: number, tolerance = 8) {
  return !selected && movement <= tolerance
}

export function convergenceLimit(selectedIDs: string[], activeID: string) {
  return [activeID, ...selectedIDs.filter(id => id !== activeID)].slice(0, 8)
}

export function uniqueBulkItems(items: Array<{ id: string; version: number }>) {
  const seen = new Set<string>()
  return items.filter(item => item.id && item.version > 0 && !seen.has(item.id) && Boolean(seen.add(item.id)))
}
