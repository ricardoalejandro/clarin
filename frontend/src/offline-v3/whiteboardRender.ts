import type { OfflineWhiteboard } from './types'

// This renderer is shared by the browser-only runtime; v3 is retained as history.
export const OFFLINE_WHITEBOARD_ASSET_PATH = '/offline-v4/whiteboard-assets/'
const MAX_BINARY_BYTES = 8 * 1024 * 1024
const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('La escena de esta pizarra no es válida.')
  return value as Record<string, unknown>
}

function rasterSignature(bytes: Uint8Array, mime: string) {
  const prefix = String.fromCharCode(...Array.from(bytes.slice(0, 12)))
  if (mime === 'image/png') return prefix.startsWith('\x89PNG\r\n\x1a\n')
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (mime === 'image/gif') return prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')
  return prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP'
}

/** Render-only copy. Never rewrite the canonical scene or resolve remote URLs. */
export async function offlineWhiteboardRenderInput(board: OfflineWhiteboard) {
  if (!board.scene || !Array.isArray(board.scene.elements) || board.scene.elements.length > 50000) throw new Error('La escena de esta pizarra no está preparada.')
  if (board.editor_version && !/^0\.18\.1(?:-clarin\.[1-7])?$/.test(board.editor_version)) throw new Error('Esta versión de pizarra necesita un lector actualizado.')
  const references = new Set<string>()
  const elements = board.scene.elements.map(value => {
    const element = record(value)
    if (!element.isDeleted && element.type === 'image') {
      if (typeof element.fileId !== 'string' || !element.fileId) throw new Error('Falta una imagen referenciada por la pizarra.')
      references.add(element.fileId)
    }
    // The local viewer is not an external link/iframe surface. Removal applies
    // only to this ephemeral render copy, not to signed stored source data.
    return { ...element, link: null }
  })
  const files: Record<string, { id: string; mimeType: string; dataURL: string; created: number; lastRetrieved: number }> = {}
  let bytesTotal = 0
  for (const asset of board.assets || []) {
    if (!references.has(asset.file_id) || files[asset.file_id]) throw new Error('El manifiesto de imágenes de la pizarra no coincide.')
    if (!rasterTypes.has(asset.content_type) || !/^[a-f0-9]{64}$/.test(asset.content_hash) || !Number.isSafeInteger(asset.size_bytes) || asset.size_bytes <= 0 || asset.size_bytes > MAX_BINARY_BYTES || typeof asset.data_base64 !== 'string' || asset.data_base64.length > 12 * 1024 * 1024) throw new Error('Una imagen protegida de la pizarra no es válida.')
    let decoded: string
    try { decoded = atob(asset.data_base64) } catch { throw new Error('Una imagen protegida está dañada.') }
    bytesTotal += decoded.length
    if (decoded.length !== asset.size_bytes || bytesTotal > MAX_BINARY_BYTES) throw new Error('El tamaño de las imágenes no coincide con el manifiesto.')
    const bytes = Uint8Array.from(decoded, value => value.charCodeAt(0))
    if (!rasterSignature(bytes, asset.content_type)) throw new Error('El formato de una imagen protegida no coincide.')
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')
    if (digest !== asset.content_hash) throw new Error('Una imagen no superó la verificación de integridad.')
    files[asset.file_id] = { id: asset.file_id, mimeType: asset.content_type, dataURL: `data:${asset.content_type};base64,${asset.data_base64}`, created: 0, lastRetrieved: 0 }
  }
  if (Object.keys(files).length !== references.size) throw new Error('Esta pizarra aún no tiene todas sus imágenes descargadas.')
  const appState = board.scene.appState || board.scene.app_state || {}
  return { elements, files, appState: { ...appState, exportBackground: true, exportEmbedScene: false, exportWithDarkMode: false, viewBackgroundColor: typeof appState.viewBackgroundColor === 'string' ? appState.viewBackgroundColor : '#ffffff' } }
}

export function assertOfflineWhiteboardSVG(svg: SVGSVGElement) {
  if (svg.querySelector('script, foreignObject, iframe, object, embed, a, animate, animateMotion, animateTransform, set')) throw new Error('La vista de pizarra contiene contenido no permitido.')
  for (const element of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name)) throw new Error('La vista de pizarra contiene un controlador no permitido.')
      if (attribute.localName === 'href' && !attribute.value.startsWith('#') && !/^data:image\/(?:png|jpeg|webp|gif);base64,/.test(attribute.value)) throw new Error('La vista de pizarra intentó enlazar un recurso externo.')
      assertEmbeddedCSSURLs(attribute.value)
    }
  }
  // Font faces must already be embedded as data by the audited renderer. Do not
  // permit a missing font to silently become a live request from the SVG.
  for (const style of Array.from(svg.querySelectorAll('style'))) {
    assertEmbeddedCSSURLs(style.textContent || '')
  }
}

function assertEmbeddedCSSURLs(text: string) {
  if (/@import/i.test(text)) throw new Error('La vista de pizarra contiene una importación externa.')
  for (const match of Array.from(text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi))) {
    if (!/^(?:data:(?:font\/|application\/(?:font|x-font|octet-stream))|#)/.test(match[2].trim())) throw new Error('Las fuentes de la pizarra no están disponibles sin conexión.')
  }
}

export async function renderOfflineWhiteboard(board: OfflineWhiteboard, signal: AbortSignal): Promise<Blob> {
  const input = await offlineWhiteboardRenderInput(board)
  signal.throwIfAborted()
  window.EXCALIDRAW_ASSET_PATH = new URL(OFFLINE_WHITEBOARD_ASSET_PATH, window.location.origin).href
  const [{ exportToSvg }, { restoreClarinWhiteboardScene }] = await Promise.all([
    import('@excalidraw/excalidraw'),
    import('@/lib/whiteboardExcalidrawAdapter'),
  ])
  signal.throwIfAborted()
  const restored = restoreClarinWhiteboardScene({ ...board.scene, elements: input.elements, files: {} })
  const svg = await exportToSvg({ elements: restored.elements as never, files: input.files as never, appState: input.appState, renderEmbeddables: false, exportPadding: 24 })
  signal.throwIfAborted()
  assertOfflineWhiteboardSVG(svg)
  return new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' })
}
