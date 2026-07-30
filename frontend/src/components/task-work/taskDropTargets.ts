export interface TaskDropPoint {
  x: number
  y: number
}

export interface TaskDropRect {
  left: number
  right: number
  top: number
  bottom: number
}

export interface TaskExternalDropTarget {
  type: 'list' | 'folder'
  id: string
  label: string
  color?: string
}

export interface MeasuredTaskDropTarget extends TaskExternalDropTarget {
  rect: TaskDropRect
}

function contains(point: TaskDropPoint, rect: TaskDropRect, tolerance = 0) {
  return point.x >= rect.left - tolerance && point.x <= rect.right + tolerance
    && point.y >= rect.top - tolerance && point.y <= rect.bottom + tolerance
}

function area(rect: TaskDropRect) {
  return Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top)
}

export function resolveTaskDropTarget(
  point: TaskDropPoint,
  targets: MeasuredTaskDropTarget[],
  previous?: TaskExternalDropTarget | null,
  hysteresis = 10,
): TaskExternalDropTarget | null {
  const matches = targets
    .filter(target => contains(point, target.rect))
    .sort((left, right) => Number(left.type !== 'list') - Number(right.type !== 'list') || area(left.rect) - area(right.rect))
  if (previous) {
    const retained = targets.find(target => target.type === previous.type && target.id === previous.id && contains(point, target.rect, hysteresis))
    // A folder normally surrounds its rows. Keep the last concrete list while the
    // pointer crosses the narrow gap around that row, but yield immediately to a
    // different concrete list.
    if (retained && (!matches[0] || (previous.type === 'list' && matches[0].type === 'folder'))) {
      const { rect: _rect, ...target } = retained
      return target
    }
  }
  if (matches[0]) {
    const { rect: _rect, ...target } = matches[0]
    return target
  }
  return null
}

export function taskDropAutoScrollDelta(pointerY: number, rect: Pick<TaskDropRect, 'top' | 'bottom'>, edge = 48, maximum = 14) {
  if (pointerY < rect.top || pointerY > rect.bottom) return 0
  if (pointerY < rect.top + edge) return -Math.max(2, Math.round(maximum * (1 - (pointerY - rect.top) / edge)))
  if (pointerY > rect.bottom - edge) return Math.max(2, Math.round(maximum * (1 - (rect.bottom - pointerY) / edge)))
  return 0
}

export function sameTaskDropTarget(left?: TaskExternalDropTarget | null, right?: TaskExternalDropTarget | null) {
  return left?.type === right?.type && left?.id === right?.id && left?.label === right?.label && left?.color === right?.color
}
