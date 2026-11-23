import { getXmlDeclaredEncoding, JSON_INPUT_LIMIT, measureDocument } from './jsonLimits'
import type { DocumentFileResult } from './jsonOperations'
import { formatFromFileName } from './documentFormats'

export const DOCUMENT_ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'windows-1252', 'iso-8859-1'] as const
export type DocumentEncoding = typeof DOCUMENT_ENCODINGS[number]

/** Original files are opaque bytes; the editable panel is the normalized UTF-8 text. */
export function originalDocumentAsset(file: Blob) {
  return new Blob([file], { type: 'application/octet-stream' })
}

function normalizedEncoding(label: string | undefined): DocumentEncoding | undefined {
  const value = label?.trim().toLowerCase().replaceAll('_', '-')
  if (value === 'utf8' || value === 'utf-8') return 'utf-8'
  if (value === 'utf-16' || value === 'utf-16le') return 'utf-16le'
  if (value === 'utf-16be') return 'utf-16be'
  if (value === 'windows-1252' || value === 'cp1252') return 'windows-1252'
  if (value === 'iso-8859-1' || value === 'latin1') return 'iso-8859-1'
}

function detectEncoding(bytes: Uint8Array) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8' as const
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le' as const
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be' as const
  if (bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f && bytes[3] === 0) return 'utf-16le' as const
  if (bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f) return 'utf-16be' as const
}

function decode(bytes: Uint8Array<ArrayBuffer>, encoding: DocumentEncoding) {
  // WHATWG aliases ISO-8859-1 to Windows-1252. Preserve the real ISO mapping.
  if (encoding === 'iso-8859-1') {
    const blocks: string[] = []
    for (let at = 0; at < bytes.length; at += 16_384) blocks.push(String.fromCharCode(...bytes.subarray(at, at + 16_384)))
    return blocks.join('')
  }
  return new TextDecoder(encoding, { fatal: true }).decode(bytes)
}

/** Validate the whole file without retaining a second decoded large document. */
function hasNonAsciiUtf8(bytes: Uint8Array<ArrayBuffer>) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let nonAscii = false
  try {
    for (let at = 0; at < bytes.length; at += 65_536) {
      const block = decoder.decode(bytes.subarray(at, at + 65_536), { stream: true })
      nonAscii ||= /[^\x00-\x7f]/.test(block)
    }
    return /[^\x00-\x7f]/.test(decoder.decode()) || nonAscii
  } catch { return false }
}

function legacyCandidate(bytes: Uint8Array) {
  // This is an offered choice, never an automatic fallback for invalid UTF-8.
  // Avoid suggesting a text encoding for obvious binary/control data.
  return bytes.some(byte => byte >= 0x80) && !bytes.some(byte => byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13)
    ? 'windows-1252' as const : undefined
}

export async function readDocumentFile(file: File, selectedEncoding?: string): Promise<DocumentFileResult> {
  if (file.size > JSON_INPUT_LIMIT) return { ok: false, message: 'El archivo supera el límite de 60 MiB.' }
  let buffer: ArrayBuffer
  try { buffer = await file.arrayBuffer() } catch { return { ok: false, message: 'No se pudo leer el archivo local. Puedes elegirlo de nuevo.' } }
  if (buffer.byteLength > JSON_INPUT_LIMIT) return { ok: false, message: 'El archivo supera el límite de 60 MiB.' }
  const bytes = new Uint8Array(buffer)
  const detected = detectEncoding(bytes)
  const explicit = normalizedEncoding(selectedEncoding)
  if (selectedEncoding && !explicit) return { ok: false, message: 'La codificación seleccionada no está admitida.' }
  const header = new TextDecoder('windows-1252').decode(bytes.subarray(0, 1024))
  const declaredInBytes = getXmlDeclaredEncoding(header)
  const declared = normalizedEncoding(declaredInBytes)
  const encoding = explicit ?? detected ?? declared ?? 'utf-8'
  if (!explicit && declaredInBytes && !declared) return { ok: false, encodingConflict: true, message: `El XML declara ${declaredInBytes}. Selecciona explícitamente una codificación compatible.` }
  if (!explicit && !detected && (declared === 'windows-1252' || declared === 'iso-8859-1') && hasNonAsciiUtf8(bytes)) {
    return { ok: false, encodingConflict: true, suggestedEncoding: 'utf-8', message: `El XML declara ${declaredInBytes}, pero sus bytes también forman texto UTF-8 válido con caracteres no ASCII. Elige la codificación del archivo; UTF-8 es una opción para revisar.` }
  }
  let source: string
  try { source = decode(bytes, encoding) } catch {
    const suggestedEncoding = encoding === 'utf-8' && !detected ? legacyCandidate(bytes) : undefined
    return { ok: false, encodingConflict: true, ...(suggestedEncoding ? { suggestedEncoding } : {}), message: `El archivo no es texto ${encoding.toUpperCase()} válido. Selecciona su codificación para abrirlo sin reemplazar caracteres.${suggestedEncoding ? ' Puedes probar WINDOWS-1252 si coincide con el origen del archivo.' : ''}` }
  }
  const declaration = getXmlDeclaredEncoding(source)
  const actualDeclared = normalizedEncoding(declaration)
  const genericUtf16 = /^utf-16$/i.test(declaration ?? '') && /^utf-16/.test(encoding)
  const declarationConflict = declaration && (!actualDeclared || actualDeclared !== encoding && !genericUtf16)
  if (!explicit && declarationConflict) return { ok: false, encodingConflict: true, suggestedEncoding: encoding, message: `La firma del archivo indica ${encoding.toUpperCase()} y la declaración XML indica ${declaration}. Elige la codificación correcta.` }
  if (source.includes('\u0000')) return { ok: false, message: 'El archivo contiene datos binarios o caracteres nulos. Se conservó el documento anterior.' }
  const syntaxHint = formatFromFileName(file.name)
  const metrics = measureDocument(source)
  if (metrics.bytes > JSON_INPUT_LIMIT) return { ok: false, message: 'El texto decodificado supera el límite de 60 MiB UTF-8. Se conservó el documento anterior.' }
  const warnings: string[] = []
  if (explicit && detected && explicit !== detected) warnings.push(`La codificación elegida (${encoding.toUpperCase()}) difiere de la firma del archivo (${detected.toUpperCase()}). Revisa los caracteres; el original se conserva.`)
  if (explicit && declarationConflict) warnings.push(`Se abrió como ${encoding.toUpperCase()}, aunque el XML declara ${declaration}. La declaración se conserva hasta la exportación editada.`)
  if (source.includes('\uFFFD')) warnings.push('El archivo ya contiene caracteres de sustitución (�). Pueden corresponder a texto perdido antes de abrirlo; cambiar la codificación no permite recuperar con certeza esos caracteres. El original se conserva.')
  return { ok: true, source, syntaxHint, metrics, xmlEncoding: syntaxHint === 'xml' ? declaration : undefined, ...(encoding !== 'utf-8' ? { encoding, converted: true } : {}), ...(warnings.length ? { warnings } : {}) }
}

export function prepareUtf8XmlDownload(source: string, signed: boolean) {
  const declared = getXmlDeclaredEncoding(source)
  if (!declared || /^utf-8$/i.test(declared)) return { ok: true as const, source }
  if (signed) return { ok: false as const, message: 'El XML firmado conserva su declaración original. Descarga el archivo original para no alterar su firma.' }
  return { ok: true as const, source: source.replace(/^(\uFEFF?<\?xml\s[^?]*?\bencoding\s*=\s*)(['"])[^'"]+\2/i, '$1$2UTF-8$2') }
}
