export const DOCUMENT_MAX_BYTES = 2 * 1024 * 1024
export const DOCUMENT_MAX_OBJECTS = 1000
export const DOCUMENT_MAX_DEPTH = 10
export const DOCUMENT_MAX_JSON_DEPTH = 64
const objectTypes = new Set(['rect', 'circle', 'ellipse', 'triangle', 'line', 'path', 'polygon', 'polyline', 'text', 'itext', 'i-text', 'textbox', 'dynamictext', 'image', 'group'])
export function validDocumentAssetURL(raw: unknown): boolean {
  if (raw === '') return true
  if (typeof raw !== 'string' || /[\0\r\n]/.test(raw)) return false
  if (/^data:/i.test(raw)) return /^data:image\/(png|jpeg|webp|gif);base64,/i.test(raw)
  try {
    const url = new URL(raw, 'https://document.invalid')
    return !url.username && !url.password && ['https:', 'http:'].includes(url.protocol) && (/^https?:\/\//i.test(raw) || raw.startsWith('/api/media/file/'))
  } catch { return false }
}
export function validateDocumentCanvas(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'El diseño debe ser un objeto JSON válido.'
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > DOCUMENT_MAX_BYTES) return 'El diseño supera el límite de 2 MiB.' } catch { return 'El diseño no es JSON válido.' }
  const root = value as Record<string, unknown>
  if (root.version !== undefined && root.version !== 2 && root.version !== 3) return 'Versión de diseño no compatible.'
  let count = 0
  function visit(node: unknown, depth: number, key = '', object = false, hierarchy = 0): string | null {
    if (node && typeof node === 'object') {
      if (depth > DOCUMENT_MAX_JSON_DEPTH) return 'El diseño supera 64 niveles JSON.'
      if (Array.isArray(node)) { for (const child of node) { const error = visit(child, depth + 1, '', key === 'objects' || key === 'elements', hierarchy); if (error) return error } }
      else {
        const record = node as Record<string, unknown>
        if (object && (String(record.type).toLowerCase() === 'group' || key === 'clipPath')) hierarchy++
        if (hierarchy > DOCUMENT_MAX_DEPTH) return 'El diseño admite hasta 10 niveles de grupos o recortes.'
        if (object && (++count > DOCUMENT_MAX_OBJECTS || !objectTypes.has(String(record.type).toLowerCase()))) return count > DOCUMENT_MAX_OBJECTS ? 'El diseño admite hasta 1000 objetos.' : 'El diseño contiene un tipo de objeto no compatible.'
        for (const [k, child] of Object.entries(record)) {
          if (k === 'source' && record.type === 'pattern' && typeof child === 'string' && !validDocumentAssetURL(child)) return 'La dirección del recurso no es válida.'
          if (['__proto__', 'constructor', 'prototype'].includes(k)) return 'El diseño contiene propiedades no válidas.'
          const error = visit(child, depth + 1, k, ['clipPath', 'backgroundImage', 'overlayImage'].includes(k), hierarchy); if (error) return error
        }
      }
    } else if (typeof node === 'number' && (!Number.isFinite(node) || Math.abs(node) > 1e7)) return 'El diseño contiene una medida fuera de rango.'
    else if (typeof node === 'string' && ['src', 'imageUrl'].includes(key) && !validDocumentAssetURL(node)) return 'La dirección del recurso no es válida.'
    return null
  }
  return visit(value, 1)
}
export function validateDocumentTemplate(payload: { name?: unknown; description?: unknown; page_width: unknown; page_height: unknown; canvas_json: unknown; page_orientation?: unknown }): string | null {
  if (payload.name !== undefined && (typeof payload.name !== 'string' || !payload.name.trim() || Array.from(payload.name.trim()).length > 200)) return 'El nombre debe contener entre 1 y 200 caracteres.'
  if (payload.description !== undefined && (typeof payload.description !== 'string' || Array.from(payload.description).length > 2000)) return 'La descripción admite hasta 2000 caracteres.'
  if ([payload.page_width, payload.page_height].some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 10 || n > 2000)) return 'Las dimensiones deben estar entre 10 y 2000 mm.'
  if (payload.page_orientation !== undefined && !['portrait', 'landscape'].includes(String(payload.page_orientation))) return 'Orientación de página no válida.'
  return validateDocumentCanvas(payload.canvas_json)
}
