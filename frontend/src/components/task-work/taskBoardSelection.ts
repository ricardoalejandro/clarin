export interface TaskStackLayer {
  index: number
  x: number
  y: number
  rotation: number
  opacity: number
}

export function taskStackLayers(selectedCount: number): TaskStackLayer[] {
  const visible = Math.min(3, Math.max(1, selectedCount))
  const rotations = [0, -2.2, 2.6]
  return Array.from({ length: visible }, (_, index) => ({
    index,
    x: index * 6,
    y: index * 6,
    rotation: rotations[index],
    opacity: 1 - index * 0.08,
  })).reverse()
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

export function convergenceLimit(selectedIDs: string[], activeID: string) {
  return [activeID, ...selectedIDs.filter(id => id !== activeID)].slice(0, 8)
}

export function uniqueBulkItems(items: Array<{ id: string; version: number }>) {
  const seen = new Set<string>()
  return items.filter(item => item.id && item.version > 0 && !seen.has(item.id) && Boolean(seen.add(item.id)))
}
