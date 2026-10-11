export type DocumentImageIssueReason = 'unavailable' | 'unauthorized' | 'forbidden' | 'timeout' | 'load-failed'

export interface DocumentImageIssue {
  readonly name: string
  readonly reason: DocumentImageIssueReason
}

export const DOCUMENT_IMAGE_ISSUE_LIMIT = 8

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const generatedPrefix = new RegExp(`^(?:${UUID}|[0-9a-f]{32,64})[_-]`, 'i')
const generatedName = new RegExp(`^(?:${UUID}|[0-9a-f]{32,64})(?:[._-]|$)`, 'i')

/** Display only the filename, never its account path, origin or signed query. */
export function documentImageResourceName(source: string): string {
  if (/^data:/i.test(source)) return 'Imagen incrustada'
  if (/^blob:/i.test(source)) return 'Imagen local'
  let pathname: string
  try {
    pathname = new URL(source, 'https://document.invalid/').pathname
  } catch {
    return 'Imagen'
  }
  let filename = pathname.split('/').pop() || ''
  try { filename = decodeURIComponent(filename.replace(/%(?![a-f0-9]{2})/gi, '%25')) } catch { return 'Imagen' }
  // Encoded separators and query delimiters must not reintroduce path or token text.
  filename = filename.split(/[?#]/, 1)[0].split(/[\\/]/).pop() || ''
  filename = filename.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim()
  while (generatedPrefix.test(filename)) filename = filename.replace(generatedPrefix, '')
  if (!filename || generatedName.test(filename) || /^\.[a-z0-9]+$/i.test(filename)) return 'Imagen'
  filename = filename.replace(/\s+/g, ' ')
  const characters = Array.from(filename)
  return characters.length > 100 ? `${characters.slice(0, 99).join('')}…` : filename
}

export function documentImageIssueReasonLabel(reason: DocumentImageIssueReason): string {
  switch (reason) {
    case 'unavailable': return 'El archivo no está disponible o no tienes acceso desde esta cuenta.'
    case 'unauthorized': return 'La sesión no permite acceder a esta imagen.'
    case 'forbidden': return 'No tienes permiso para acceder a esta imagen.'
    case 'timeout': return 'La imagen tardó demasiado en responder.'
    case 'load-failed': return 'No se pudo leer la imagen. Revisa la conexión o el archivo.'
  }
}

/** Carries safe UI diagnostics only; raw transport errors and URLs stay out. */
export class DocumentImageLoadError extends Error {
  readonly issues: readonly DocumentImageIssue[]
  readonly incomplete: boolean

  constructor(issues: readonly DocumentImageIssue[], incomplete = false) {
    super(issues.length === 1 && !incomplete
      ? 'No se pudo cargar una imagen de la plantilla.'
      : 'No se pudieron cargar algunas imágenes de la plantilla.')
    this.name = 'DocumentImageLoadError'
    this.issues = Object.freeze(issues.slice(0, DOCUMENT_IMAGE_ISSUE_LIMIT).map(issue => Object.freeze({
      name: documentImageResourceName(issue.name), reason: issue.reason,
    })))
    this.incomplete = incomplete || issues.length > DOCUMENT_IMAGE_ISSUE_LIMIT
  }
}
