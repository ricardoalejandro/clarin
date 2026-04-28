/**
 * Snap Guides for Fabric.js Canvas
 * Calculates snap positions during object movement/resize.
 */

import type { Canvas, FabricObject } from 'fabric'
import { SNAP_THRESHOLD } from './constants'

export interface SnapGuide {
  position: number
  orientation: 'horizontal' | 'vertical'
}

export interface DistanceLabel {
  /** Axis of the measurement: 'h' = horizontal gap (left↔right), 'v' = vertical gap (top↔bottom) */
  axis: 'h' | 'v'
  /** Start point (scene coords) */
  x1: number
  y1: number
  /** End point (scene coords) */
  x2: number
  y2: number
  /** Pixel distance (rounded) */
  distance: number
}

interface SnapResult {
  x?: number
  y?: number
  guides: SnapGuide[]
}

export interface UserGuide {
  orientation: 'h' | 'v'
  position: number
}

/**
 * Calculate snap targets for a moving object.
 * Returns adjusted position and active guides to display.
 *
 * Snap matching rules (matches professional editors like Figma/Illustrator):
 * - Object center ↔ page center, object center
 * - Object edges ↔ page edges, object edges
 * - Any reference point ↔ user guides
 */
export function calculateSnap(
  canvas: Canvas,
  movingObj: FabricObject,
  threshold = SNAP_THRESHOLD,
  userGuides: UserGuide[] = [],
): SnapResult {
  const zoom = canvas.getZoom()
  const adjThreshold = threshold / zoom
  const vpt = canvas.viewportTransform!

  // Moving object bounds in scene coordinates (from bounding rect)
  const movBR = movingObj.getBoundingRect()
  const brLeft = (movBR.left - vpt[4]) / zoom
  const brTop = (movBR.top - vpt[5]) / zoom
  const brW = movBR.width / zoom
  const brH = movBR.height / zoom

  // Offset between obj.left/top and bounding rect left/top
  const leftOffset = (movingObj.left ?? 0) - brLeft
  const topOffset = (movingObj.top ?? 0) - brTop

  const brCenterX = brLeft + brW / 2
  const brCenterY = brTop + brH / 2
  const brRight = brLeft + brW
  const brBottom = brTop + brH

  // Page dimensions (document area)
  const pageW = (canvas as any).__pageWidth || canvas.getWidth()
  const pageH = (canvas as any).__pageHeight || canvas.getHeight()

  let snapX: number | undefined
  let snapY: number | undefined
  let minDistX = adjThreshold + 1
  let minDistY = adjThreshold + 1
  let bestGuideX: SnapGuide | undefined
  let bestGuideY: SnapGuide | undefined

  // Snap target with type: 'edge' for edges, 'center' for centers, 'guide' for user guides
  type SnapTarget = { pos: number; type: 'edge' | 'center' | 'guide' }

  const targetsX: SnapTarget[] = [
    { pos: 0, type: 'edge' },
    { pos: pageW / 2, type: 'center' },
    { pos: pageW, type: 'edge' },
  ]
  const targetsY: SnapTarget[] = [
    { pos: 0, type: 'edge' },
    { pos: pageH / 2, type: 'center' },
    { pos: pageH, type: 'edge' },
  ]

  // Other objects: edges and centers
  const objects = canvas.getObjects().filter(o => o !== movingObj && o.visible && !(o as any).__isPage)
  for (const o of objects) {
    const b = o.getBoundingRect()
    const oL = (b.left - vpt[4]) / zoom
    const oT = (b.top - vpt[5]) / zoom
    const oW = b.width / zoom
    const oH = b.height / zoom
    targetsX.push(
      { pos: oL, type: 'edge' },
      { pos: oL + oW / 2, type: 'center' },
      { pos: oL + oW, type: 'edge' },
    )
    targetsY.push(
      { pos: oT, type: 'edge' },
      { pos: oT + oH / 2, type: 'center' },
      { pos: oT + oH, type: 'edge' },
    )
  }

  // User guides match any reference point
  for (const g of userGuides) {
    if (g.orientation === 'v') targetsX.push({ pos: g.position, type: 'guide' })
    else targetsY.push({ pos: g.position, type: 'guide' })
  }

  // Object reference points with type
  type ObjRef = { pos: number; offset: number; type: 'edge' | 'center' }

  const objXRefs: ObjRef[] = [
    { pos: brLeft, offset: 0, type: 'edge' },
    { pos: brCenterX, offset: brW / 2, type: 'center' },
    { pos: brRight, offset: brW, type: 'edge' },
  ]
  const objYRefs: ObjRef[] = [
    { pos: brTop, offset: 0, type: 'edge' },
    { pos: brCenterY, offset: brH / 2, type: 'center' },
    { pos: brBottom, offset: brH, type: 'edge' },
  ]

  // Match X: only same-type or guide targets
  for (const target of targetsX) {
    for (const ref of objXRefs) {
      // Type matching: centers snap to centers, edges snap to edges, guides snap to any
      if (target.type !== 'guide' && target.type !== ref.type) continue
      const dist = Math.abs(ref.pos - target.pos)
      if (dist < adjThreshold && dist < minDistX) {
        minDistX = dist
        snapX = target.pos - ref.offset + leftOffset
        bestGuideX = { position: target.pos, orientation: 'vertical' }
      }
    }
  }

  // Match Y: only same-type or guide targets
  for (const target of targetsY) {
    for (const ref of objYRefs) {
      if (target.type !== 'guide' && target.type !== ref.type) continue
      const dist = Math.abs(ref.pos - target.pos)
      if (dist < adjThreshold && dist < minDistY) {
        minDistY = dist
        snapY = target.pos - ref.offset + topOffset
        bestGuideY = { position: target.pos, orientation: 'horizontal' }
      }
    }
  }

  const guides: SnapGuide[] = []
  if (bestGuideX) guides.push(bestGuideX)
  if (bestGuideY) guides.push(bestGuideY)

  return { x: snapX, y: snapY, guides }
}


/**
 * Calculate distance labels (Figma-style "12px" between adjacent objects).
 * Returns up to 4 distance lines (left/right/top/bottom) from the moving
 * object to the nearest object that overlaps along the perpendicular axis.
 * All coordinates in scene space.
 */
export function calculateDistances(
  canvas: Canvas,
  movingObj: FabricObject,
): DistanceLabel[] {
  const zoom = canvas.getZoom()
  const vpt = canvas.viewportTransform!

  const toScene = (o: FabricObject) => {
    const b = o.getBoundingRect()
    return {
      left: (b.left - vpt[4]) / zoom,
      top: (b.top - vpt[5]) / zoom,
      right: (b.left - vpt[4]) / zoom + b.width / zoom,
      bottom: (b.top - vpt[5]) / zoom + b.height / zoom,
    }
  }

  const m = toScene(movingObj)
  const others = canvas.getObjects()
    .filter(o => o !== movingObj && o.visible && !(o as any).__isPage && !(o as any).__isMarginOverlay)

  const results: DistanceLabel[] = []

  // LEFT: nearest object whose right edge < m.left AND overlaps in Y
  let bestLeft: { gap: number; o: ReturnType<typeof toScene> } | null = null
  // RIGHT: nearest object whose left edge > m.right AND overlaps in Y
  let bestRight: { gap: number; o: ReturnType<typeof toScene> } | null = null
  // TOP: nearest object whose bottom < m.top AND overlaps in X
  let bestTop: { gap: number; o: ReturnType<typeof toScene> } | null = null
  // BOTTOM: nearest object whose top > m.bottom AND overlaps in X
  let bestBottom: { gap: number; o: ReturnType<typeof toScene> } | null = null

  for (const other of others) {
    const s = toScene(other)
    const overlapsY = !(s.bottom < m.top || s.top > m.bottom)
    const overlapsX = !(s.right < m.left || s.left > m.right)

    if (overlapsY) {
      if (s.right <= m.left) {
        const gap = m.left - s.right
        if (!bestLeft || gap < bestLeft.gap) bestLeft = { gap, o: s }
      } else if (s.left >= m.right) {
        const gap = s.left - m.right
        if (!bestRight || gap < bestRight.gap) bestRight = { gap, o: s }
      }
    }
    if (overlapsX) {
      if (s.bottom <= m.top) {
        const gap = m.top - s.bottom
        if (!bestTop || gap < bestTop.gap) bestTop = { gap, o: s }
      } else if (s.top >= m.bottom) {
        const gap = s.top - m.bottom
        if (!bestBottom || gap < bestBottom.gap) bestBottom = { gap, o: s }
      }
    }
  }

  if (bestLeft && bestLeft.gap > 0.5) {
    const yMid = (Math.max(m.top, bestLeft.o.top) + Math.min(m.bottom, bestLeft.o.bottom)) / 2
    results.push({ axis: 'h', x1: bestLeft.o.right, y1: yMid, x2: m.left, y2: yMid, distance: Math.round(bestLeft.gap) })
  }
  if (bestRight && bestRight.gap > 0.5) {
    const yMid = (Math.max(m.top, bestRight.o.top) + Math.min(m.bottom, bestRight.o.bottom)) / 2
    results.push({ axis: 'h', x1: m.right, y1: yMid, x2: bestRight.o.left, y2: yMid, distance: Math.round(bestRight.gap) })
  }
  if (bestTop && bestTop.gap > 0.5) {
    const xMid = (Math.max(m.left, bestTop.o.left) + Math.min(m.right, bestTop.o.right)) / 2
    results.push({ axis: 'v', x1: xMid, y1: bestTop.o.bottom, x2: xMid, y2: m.top, distance: Math.round(bestTop.gap) })
  }
  if (bestBottom && bestBottom.gap > 0.5) {
    const xMid = (Math.max(m.left, bestBottom.o.left) + Math.min(m.right, bestBottom.o.right)) / 2
    results.push({ axis: 'v', x1: xMid, y1: m.bottom, x2: xMid, y2: bestBottom.o.top, distance: Math.round(bestBottom.gap) })
  }

  return results
}
