import { describe, expect, it } from 'vitest'
import { clampImageViewport, imagePanBounds, imageScaleLimits, pinchImageViewport, zoomImageViewportAt } from './imageViewportGeometry'
const geometry = { viewportWidth: 400, viewportHeight: 300, contentWidth: 400, contentHeight: 200 }
describe('image viewport geometry', () => {
  it('bounds scale, invalid values and pan without moving a fitting image', () => {
    expect(clampImageViewport({ scale: NaN, x: Infinity, y: 300 }, geometry)).toEqual({ scale: 1, x: 0, y: 0 })
    expect(clampImageViewport({ scale: 50, x: 5000, y: -5000 }, geometry, .5, 4)).toEqual({ scale: 4, x: 600, y: -250 })
    expect(imageScaleLimits(-1, -2)).toEqual({ min: .01, max: .01 })
  })
  it('keeps the content under the zoom point, subject to its finite bounds', () => {
    const next = zoomImageViewportAt({ scale: 1, x: 0, y: 0 }, 2, { x: 100, y: 40 }, geometry)
    expect(next).toEqual({ scale: 2, x: -100, y: -40 })
    expect((100 - next.x) / next.scale).toBe(100)
    expect((40 - next.y) / next.scale).toBe(40)
    expect(zoomImageViewportAt(next, 1, { x: 100, y: 40 }, geometry)).toEqual({ scale: 1, x: 0, y: 0 })
  })
  it('uses a moving pinch midpoint and clamps a pinch at both scale limits', () => {
    expect(pinchImageViewport({ scale: 1, x: 0, y: 0 }, 100, 200, { x: 0, y: 0 }, { x: 20, y: 10 }, geometry)).toEqual({ scale: 2, x: 20, y: 10 })
    expect(pinchImageViewport({ scale: 1, x: 0, y: 0 }, 100, 1, { x: 0, y: 0 }, { x: 0, y: 0 }, geometry, 1, 5).scale).toBe(1)
    expect(pinchImageViewport({ scale: 1, x: 0, y: 0 }, 1, 1000, { x: 0, y: 0 }, { x: 0, y: 0 }, geometry, 1, 5).scale).toBe(5)
  })
  it('accounts for rotated dimensions and a smaller viewport after resize', () => {
    const bounds = imagePanBounds({ ...geometry, rotation: 90 }, 2)
    expect(bounds.x).toBeCloseTo(0)
    expect(bounds.y).toBeCloseTo(250)
    expect(clampImageViewport({ scale: 2, x: 200, y: 200 }, geometry)).toEqual({ scale: 2, x: 200, y: 50 })
  })
})
