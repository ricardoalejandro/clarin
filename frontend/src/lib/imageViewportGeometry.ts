export type ImageViewportTransform = { scale: number; x: number; y: number }
export type ImageViewportGeometry = { viewportWidth: number; viewportHeight: number; contentWidth: number; contentHeight: number; rotation?: number }

const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback
export function imageScaleLimits(minimum = 1, maximum = 5) {
  const min = Math.max(.01, finite(minimum, 1))
  return { min, max: Math.max(min, finite(maximum, 5)) }
}
export function imagePanBounds(geometry: ImageViewportGeometry, scale: number) {
  const angle = finite(geometry.rotation ?? 0) * Math.PI / 180
  const width = Math.abs(Math.cos(angle)) * finite(geometry.contentWidth) + Math.abs(Math.sin(angle)) * finite(geometry.contentHeight)
  const height = Math.abs(Math.sin(angle)) * finite(geometry.contentWidth) + Math.abs(Math.cos(angle)) * finite(geometry.contentHeight)
  return { x: Math.max(0, (width * scale - finite(geometry.viewportWidth)) / 2), y: Math.max(0, (height * scale - finite(geometry.viewportHeight)) / 2) }
}
export function clampImageViewport(value: ImageViewportTransform, geometry: ImageViewportGeometry, minimum = 1, maximum = 5): ImageViewportTransform {
  const limits = imageScaleLimits(minimum, maximum)
  const scale = Math.max(limits.min, Math.min(limits.max, finite(value.scale, 1)))
  const bounds = imagePanBounds(geometry, scale)
  return { scale, x: Math.max(-bounds.x, Math.min(bounds.x, finite(value.x))), y: Math.max(-bounds.y, Math.min(bounds.y, finite(value.y))) }
}
export function zoomImageViewportAt(value: ImageViewportTransform, requestedScale: number, point: { x: number; y: number }, geometry: ImageViewportGeometry, minimum = 1, maximum = 5) {
  const limits = imageScaleLimits(minimum, maximum)
  const scale = Math.max(limits.min, Math.min(limits.max, finite(requestedScale, value.scale)))
  const ratio = scale / Math.max(.01, value.scale)
  return clampImageViewport({ scale, x: point.x - (point.x - value.x) * ratio, y: point.y - (point.y - value.y) * ratio }, geometry, limits.min, limits.max)
}
export function pinchImageViewport(start: ImageViewportTransform, startDistance: number, distance: number, startMidpoint: { x: number; y: number }, midpoint: { x: number; y: number }, geometry: ImageViewportGeometry, minimum = 1, maximum = 5) {
  const limits = imageScaleLimits(minimum, maximum)
  const scale = Math.max(limits.min, Math.min(limits.max, start.scale * Math.max(1, distance) / Math.max(1, startDistance)))
  const ratio = scale / Math.max(.01, start.scale)
  return clampImageViewport({ scale, x: midpoint.x - (startMidpoint.x - start.x) * ratio, y: midpoint.y - (startMidpoint.y - start.y) * ratio }, geometry, limits.min, limits.max)
}
