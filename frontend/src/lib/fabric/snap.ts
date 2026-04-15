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
