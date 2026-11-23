export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_PIXELS = 16_000_000
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3)
const IMAGE_SIZE_ERROR = 'El archivo debe pesar entre 1 byte y 10 MiB.'
const IMAGE_TYPE_ERROR = 'Usa una imagen válida en formato PNG, JPG o WebP.'

type ImageType = typeof IMAGE_TYPES[number]
type ImageInfo = { type: ImageType; width: number; height: number }
export type LocalImage = ImageInfo & { blob: Blob; name: string }

function marker(bytes: Uint8Array, offset: number, text: string) {
  return Array.from(text).every((character, index) => bytes[offset + index] === character.charCodeAt(0))
}

function jpegDimensions(bytes: Uint8Array, view: DataView) {
  const frameMarkers = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]
  for (let offset = 2; offset + 3 < bytes.length;) {
    if (bytes[offset++] !== 0xff) break
    while (bytes[offset] === 0xff) offset += 1
    const segment = bytes[offset++]
    if (segment === 0xd9 || segment === 0xda || offset + 2 > bytes.length) break
    const length = view.getUint16(offset)
    if (length < 2 || offset + length > bytes.length) break
    if (length >= 8 && frameMarkers.includes(segment)) {
      return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) }
    }
    offset += length
  }
  return null
}

function webpDimensions(bytes: Uint8Array, view: DataView) {
  const chunkSize = view.getUint32(16, true)
  if (view.getUint32(4, true) + 8 > bytes.length || chunkSize > bytes.length - 20) return null
  if (marker(bytes, 12, 'VP8X') && chunkSize === 10) {
    const uint24 = (offset: number) => bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16)
    return { width: 1 + uint24(24), height: 1 + uint24(27) }
  }
  if (marker(bytes, 12, 'VP8L') && chunkSize >= 5 && bytes[20] === 0x2f) {
    const dimensions = view.getUint32(21, true)
    return { width: 1 + (dimensions & 0x3fff), height: 1 + ((dimensions >>> 14) & 0x3fff) }
  }
  if (marker(bytes, 12, 'VP8 ') && chunkSize >= 10 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
  }
  return null
}

function assertDimensions(width: number, height: number) {
  if (width < 1 || height < 1) throw new Error(IMAGE_TYPE_ERROR)
  if (width * height > MAX_IMAGE_PIXELS) throw new Error('La imagen supera el límite de 16 megapíxeles.')
}

export function inspectImageBytes(bytes: Uint8Array): ImageInfo {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error(IMAGE_SIZE_ERROR)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let info: ImageInfo | null = null
  if (bytes.length >= 33 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(8) === 13 && marker(bytes, 12, 'IHDR')) {
    info = { type: 'image/png', width: view.getUint32(16), height: view.getUint32(20) }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const dimensions = jpegDimensions(bytes, view)
    if (dimensions) info = { type: 'image/jpeg', ...dimensions }
  } else if (bytes.length >= 25 && marker(bytes, 0, 'RIFF') && marker(bytes, 8, 'WEBP')) {
    const dimensions = webpDimensions(bytes, view)
    if (dimensions) info = { type: 'image/webp', ...dimensions }
  }
  if (!info) throw new Error(IMAGE_TYPE_ERROR)
  assertDimensions(info.width, info.height)
  return info
}

export function readImageBase64(input: string) {
  // Leave room for line wrapping without copying arbitrarily large strings.
  if (input.length > MAX_BASE64_LENGTH + 1024 * 1024) throw new Error(IMAGE_SIZE_ERROR)
  const value = input.trim()
  const prefix = /^data:(image\/(?:png|jpeg|webp));base64,/i.exec(value)
  if (!prefix && /^data:/i.test(value)) throw new Error('Usa una Data URL Base64 de una imagen PNG, JPG o WebP.')
  const data = value.slice(prefix?.[0].length ?? 0).replace(/\s/g, '')
  if (data.length > MAX_BASE64_LENGTH) throw new Error(IMAGE_SIZE_ERROR)
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1) {
    throw new Error('Introduce un texto Base64 válido.')
  }
  let decoded: string
  try {
    decoded = atob(data)
  } catch {
    throw new Error('Introduce un texto Base64 válido.')
  }
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = decoded.charCodeAt(index)
  const info = inspectImageBytes(bytes)
  if (prefix && prefix[1].toLowerCase() !== info.type) throw new Error('El formato declarado en la Data URL no coincide con la imagen.')
  return { bytes, info }
}

export function imageExtension(type: ImageType) {
  return type === 'image/jpeg' ? 'jpg' : type.slice('image/'.length)
}

function readBlob<T extends string | ArrayBuffer>(blob: Blob, mode: 'bytes' | 'data-url', signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const reader = new FileReader()
    const abort = () => reader.abort()
    reader.onload = () => resolve(reader.result as T)
    reader.onerror = () => reject(new Error('No pudimos leer la imagen. Vuelve a seleccionarla.'))
    reader.onabort = () => reject(signal.reason)
    reader.onloadend = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    if (mode === 'bytes') reader.readAsArrayBuffer(blob)
    else reader.readAsDataURL(blob)
  })
}

export function loadLocalImage(blob: Blob, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const image = new Image()
    const url = URL.createObjectURL(blob)
    const cleanup = () => {
      URL.revokeObjectURL(url)
      image.onload = image.onerror = null
      signal.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      image.removeAttribute('src')
      reject(signal.reason)
    }
    image.onload = () => {
      cleanup()
      try {
        assertDimensions(image.naturalWidth, image.naturalHeight)
        resolve(image)
      } catch (error) {
        reject(error)
      }
    }
    image.onerror = () => {
      cleanup()
      reject(new Error('La imagen está dañada o no se puede abrir en este navegador.'))
    }
    signal.addEventListener('abort', abort, { once: true })
    image.src = url
  })
}

export async function validateLocalImage(file: File, signal: AbortSignal): Promise<LocalImage> {
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error(IMAGE_SIZE_ERROR)
  const bytes = await readBlob<ArrayBuffer>(file, 'bytes', signal)
  signal.throwIfAborted()
  const info = inspectImageBytes(new Uint8Array(bytes))
  const blob = file.slice(0, file.size, info.type)
  const image = await loadLocalImage(blob, signal)
  return { type: info.type, width: image.naturalWidth, height: image.naturalHeight, blob, name: file.name || `imagen.${imageExtension(info.type)}` }
}

export async function decodeImageBase64(input: string, signal: AbortSignal): Promise<LocalImage> {
  const { bytes, info } = readImageBase64(input)
  const blob = new Blob([bytes], { type: info.type })
  const image = await loadLocalImage(blob, signal)
  return { type: info.type, width: image.naturalWidth, height: image.naturalHeight, blob, name: `imagen.${imageExtension(info.type)}` }
}

export function encodeImageBase64(blob: Blob, signal: AbortSignal) {
  return readBlob<string>(blob, 'data-url', signal)
}
