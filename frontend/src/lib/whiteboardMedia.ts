const SVG_MIME_TYPE = 'image/svg+xml'
const MAX_RASTER_DIMENSION = 4096
const MAX_RASTER_PIXELS = 16_000_000
const MAX_WHITEBOARD_IMAGE_BYTES = 10 * 1024 * 1024
const ALLOWED_WHITEBOARD_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  SVG_MIME_TYPE,
])

export interface WhiteboardBinaryFile {
  id: string
  dataURL: string
  mimeType: string
  created: number
  lastRetrieved?: number
}

export function isSvgWhiteboardFile(value: unknown): value is WhiteboardBinaryFile {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<WhiteboardBinaryFile>
  return file.mimeType === SVG_MIME_TYPE || Boolean(file.dataURL?.toLocaleLowerCase('en').startsWith('data:image/svg+xml'))
}

export function decodeSvgDataURL(dataURL: string) {
  const comma = dataURL.indexOf(',')
  if (comma < 0 || !dataURL.slice(0, comma).toLocaleLowerCase('en').includes('image/svg+xml')) {
    throw new Error('El recurso SVG no tiene un formato válido.')
  }
  const metadata = dataURL.slice(0, comma)
  const payload = dataURL.slice(comma + 1)
  try {
    return /;base64(?:;|$)/i.test(metadata) ? atob(payload) : decodeURIComponent(payload)
  } catch {
    throw new Error('No se pudo leer el recurso SVG.')
  }
}

export function validateWhiteboardImageDataURL(dataURL: unknown, declaredMimeType?: unknown) {
  if (typeof dataURL !== 'string') throw new Error('El recurso importado no contiene una imagen local válida.')
  const comma = dataURL.indexOf(',')
  if (comma < 0 || !dataURL.toLocaleLowerCase('en').startsWith('data:')) {
    throw new Error('Las Pizarras sólo aceptan imágenes integradas; no se permiten recursos remotos.')
  }
  const metadata = dataURL.slice(5, comma)
  const mimeType = (metadata.split(';')[0] || '').trim().toLocaleLowerCase('en')
  if (!ALLOWED_WHITEBOARD_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error('El recurso importado usa un tipo de imagen no permitido.')
  }
  if (typeof declaredMimeType === 'string' && declaredMimeType.trim() && declaredMimeType.toLocaleLowerCase('en') !== mimeType) {
    throw new Error('El tipo declarado del recurso importado no coincide con su contenido.')
  }
  const payload = dataURL.slice(comma + 1)
  let size: number
  if (/(?:^|;)base64(?:;|$)/i.test(metadata)) {
    if (!/^[a-z0-9+/]*={0,2}$/i.test(payload)) throw new Error('El recurso importado tiene una codificación inválida.')
    size = Math.max(0, Math.floor(payload.length * 3 / 4) - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0))
  } else {
    try {
      size = new TextEncoder().encode(decodeURIComponent(payload)).byteLength
    } catch {
      throw new Error('El recurso importado tiene una codificación inválida.')
    }
  }
  if (size > MAX_WHITEBOARD_IMAGE_BYTES) throw new Error('El recurso importado supera el máximo de 10 MB.')
  return { mimeType, size }
}

function isUnsafeReference(value: string) {
  const normalized = value.trim().toLocaleLowerCase('en')
  if (/^url\(\s*#[^)]+\s*\)$/i.test(normalized)) return false
  if (/url\s*\(/i.test(normalized)) return true
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/.test(normalized) && !normalized.startsWith('data:image/')
}

function isUnsafeSvgLocationAttribute(name: string, value: string) {
  if (name !== 'href' && name !== 'xlink:href' && name !== 'src') return false
  const normalized = value.trim().toLocaleLowerCase('en')
  return !normalized.startsWith('#') && !normalized.startsWith('data:image/')
}

export function sanitizeWhiteboardSvg(markup: string) {
  const documentNode = new DOMParser().parseFromString(markup, SVG_MIME_TYPE)
  if (documentNode.querySelector('parsererror') || documentNode.documentElement.tagName.toLocaleLowerCase('en') !== 'svg') {
    throw new Error('El SVG importado no es válido.')
  }

  documentNode.querySelectorAll('script, foreignObject, iframe, object, embed, audio, video').forEach(node => node.remove())
  documentNode.querySelectorAll('*').forEach(node => {
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLocaleLowerCase('en')
      const value = attribute.value
      if (name.startsWith('on') || isUnsafeSvgLocationAttribute(name, value) || isUnsafeReference(value)) {
        node.removeAttribute(attribute.name)
        continue
      }
      if (name === 'style' && /(?:url\s*\(|@import|expression\s*\()/i.test(value)) {
        node.removeAttribute(attribute.name)
      }
    }
  })
  documentNode.querySelectorAll('style').forEach(node => {
    if (/(?:url\s*\(|@import|expression\s*\()/i.test(node.textContent || '')) node.remove()
  })
  return new XMLSerializer().serializeToString(documentNode.documentElement)
}

export function referencedWhiteboardFileIDs(elements: readonly unknown[]) {
  const fileIDs = new Set<string>()
  for (const value of elements) {
    if (!value || typeof value !== 'object') continue
    const element = value as Record<string, unknown>
    if (element.type !== 'image' || element.isDeleted === true) continue
    if (typeof element.fileId !== 'string' || !element.fileId.trim()) continue
    fileIDs.add(element.fileId)
  }
  return Array.from(fileIDs)
}

export async function blobToDataURL(blob: Blob, signal?: AbortSignal) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const abort = () => {
      reader.abort()
      cleanup()
      reject(new DOMException('La carga del recurso fue cancelada.', 'AbortError'))
    }
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    reader.onerror = () => {
      cleanup()
      reject(new Error('No se pudo leer el recurso de la pizarra.'))
    }
    reader.onabort = () => {
      cleanup()
      reject(new DOMException('La carga del recurso fue cancelada.', 'AbortError'))
    }
    reader.onload = () => {
      cleanup()
      resolve(String(reader.result || ''))
    }
    reader.readAsDataURL(blob)
  })
}

export function dataURLToBlob(dataURL: string) {
  const validated = validateWhiteboardImageDataURL(dataURL)
  const comma = dataURL.indexOf(',')
  const metadata = dataURL.slice(0, comma)
  const payload = dataURL.slice(comma + 1)
  let bytes: Uint8Array
  if (/;base64(?:;|$)/i.test(metadata)) {
    const decoded = atob(payload)
    bytes = Uint8Array.from(decoded, character => character.charCodeAt(0))
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload))
  }
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new Blob([buffer], { type: validated.mimeType })
}

function svgDimensions(markup: string) {
  const documentNode = new DOMParser().parseFromString(markup, SVG_MIME_TYPE)
  const root = documentNode.documentElement
  const viewBox = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
  const rawWidth = Number.parseFloat(root.getAttribute('width') || '') || (viewBox.length === 4 ? viewBox[2] : 1024)
  const rawHeight = Number.parseFloat(root.getAttribute('height') || '') || (viewBox.length === 4 ? viewBox[3] : 1024)
  const safeWidth = Math.max(1, Math.min(MAX_RASTER_DIMENSION, Math.round(rawWidth)))
  const safeHeight = Math.max(1, Math.min(MAX_RASTER_DIMENSION, Math.round(rawHeight)))
  const scale = Math.min(1, Math.sqrt(MAX_RASTER_PIXELS / (safeWidth * safeHeight)))
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  }
}

export async function rasterizeSvgWhiteboardFile(file: WhiteboardBinaryFile): Promise<WhiteboardBinaryFile> {
  const sanitized = sanitizeWhiteboardSvg(decodeSvgDataURL(file.dataURL))
  const dimensions = svgDimensions(sanitized)
  const source = URL.createObjectURL(new Blob([sanitized], { type: SVG_MIME_TYPE }))
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image()
      nextImage.onload = () => resolve(nextImage)
      nextImage.onerror = () => reject(new Error('No se pudo convertir el SVG a una imagen segura.'))
      nextImage.src = source
    })
    const canvas = document.createElement('canvas')
    canvas.width = dimensions.width
    canvas.height = dimensions.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('El navegador no permite convertir este SVG.')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('No se pudo generar el PNG seguro.')), 'image/png')
    })
    return { ...file, dataURL: await blobToDataURL(png), mimeType: 'image/png' }
  } finally {
    URL.revokeObjectURL(source)
  }
}

export async function rasterizeWhiteboardFiles(files: Record<string, unknown>) {
  const renderableFiles: Record<string, unknown> = {}
  let filteredMetadataOnly = false
  for (const [id, value] of Object.entries(files)) {
    if (!value || typeof value !== 'object') throw new Error('El archivo importado contiene un recurso inválido.')
    const file = value as Partial<WhiteboardBinaryFile>
    if (file.dataURL === undefined || file.dataURL === null || file.dataURL === '') {
      filteredMetadataOnly = true
      continue
    }
    validateWhiteboardImageDataURL(file.dataURL, file.mimeType)
    renderableFiles[id] = value
  }
  if (!Object.values(renderableFiles).some(isSvgWhiteboardFile)) return filteredMetadataOnly ? renderableFiles : files
  const entries = await Promise.all(Object.entries(renderableFiles).map(async ([id, value]) => {
    if (!isSvgWhiteboardFile(value)) return [id, value] as const
    return [id, await rasterizeSvgWhiteboardFile(value)] as const
  }))
  return Object.fromEntries(entries) as Record<string, unknown>
}
