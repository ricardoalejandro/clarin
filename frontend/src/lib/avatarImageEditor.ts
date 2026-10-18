import { encodeAvatarCanvas } from './avatarImageExport'

export interface AvatarImageTransform {
  zoom: number; offsetX: number; offsetY: number; rotation: number
  flipX: boolean; flipY: boolean; brightness: number; contrast: number
}

export const initialAvatarTransform: AvatarImageTransform = {
  zoom: 1, offsetX: 0, offsetY: 0, rotation: 0, flipX: false, flipY: false, brightness: 100, contrast: 100,
}

export function avatarCanvasDisplacement(delta: { x: number; y: number }, canvas: { width: number; height: number }, displayed: { width: number; height: number }) {
  if (![delta.x, delta.y, canvas.width, canvas.height, displayed.width, displayed.height].every(Number.isFinite)
    || canvas.width <= 0 || canvas.height <= 0 || displayed.width <= 0 || displayed.height <= 0) return null
  return { x: delta.x * canvas.width / displayed.width, y: delta.y * canvas.height / displayed.height }
}

export function drawAvatarImage(canvas: HTMLCanvasElement, image: HTMLImageElement, transform: AvatarImageTransform) {
  const context = canvas.getContext('2d')
  if (!context) return
  const size = canvas.width
  context.clearRect(0, 0, size, size)
  context.fillStyle = '#e2e8f0'
  context.fillRect(0, 0, size, size)
  context.save()
  context.translate(size / 2 + transform.offsetX, size / 2 + transform.offsetY)
  context.rotate(transform.rotation * Math.PI / 180)
  context.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1)
  context.filter = `brightness(${transform.brightness}%) contrast(${transform.contrast}%)`
  const quarterTurn = Math.abs(transform.rotation / 90) % 2 === 1
  const baseScale = Math.max(size / (quarterTurn ? image.naturalHeight : image.naturalWidth), size / (quarterTurn ? image.naturalWidth : image.naturalHeight))
  const width = image.naturalWidth * baseScale * transform.zoom
  const height = image.naturalHeight * baseScale * transform.zoom
  context.drawImage(image, -width / 2, -height / 2, width, height)
  context.restore()
}

/** This path never decodes the original bitmap: reject oversized pixel counts first. */
export function avatarImageDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mime === 'image/png' && bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)
    && String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR') {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (mime === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) break
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) break
      const length = view.getUint16(offset)
      if (length < 2 || offset + length > bytes.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) }
      }
      offset += length
    }
  }
  throw new Error('No se pudo leer la imagen. Selecciona un JPEG o PNG válido.')
}

export async function validateProgramAvatarFile(file: File) {
  if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 20 * 1024 * 1024 || !file.size) {
    throw new Error('Usa una imagen JPEG o PNG de hasta 20 MiB.')
  }
  const dimensions = avatarImageDimensions(new Uint8Array(await file.arrayBuffer()), file.type)
  if (dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width * dimensions.height > 40_000_000) {
    throw new Error('La imagen debe tener como máximo 40 megapíxeles.')
  }
  return dimensions
}

export async function exportCompactAvatar(canvas: HTMLCanvasElement, signal?: AbortSignal) {
  for (const quality of [.86, .82, .78, .74, .7, .66, .62, .58, .54, .5]) {
    const blob = await encodeAvatarCanvas(canvas, quality, signal)
    if (blob.size <= 250 * 1024) return blob
  }
  throw new Error('No se pudo reducir la imagen a 250 KiB. Prueba con otra foto.')
}
