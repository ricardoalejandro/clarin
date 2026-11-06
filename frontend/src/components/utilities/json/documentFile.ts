import { getXmlDeclaredEncoding, JSON_INPUT_LIMIT, measureDocument } from './jsonLimits'
import type { DocumentFileResult } from './jsonOperations'

export async function readDocumentFile(file: File): Promise<DocumentFileResult> {
  if (file.size > JSON_INPUT_LIMIT) return { ok: false, message: 'El archivo supera el límite de 25 MiB.' }
  let buffer: ArrayBuffer
  try {
    buffer = await file.arrayBuffer()
  } catch {
    return { ok: false, message: 'No se pudo leer el archivo local. Puedes elegirlo de nuevo.' }
  }
  if (buffer.byteLength > JSON_INPUT_LIMIT) return { ok: false, message: 'El archivo supera el límite de 25 MiB.' }

  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return { ok: false, message: 'El archivo no es texto UTF-8 válido. Guárdalo en UTF-8 y vuelve a abrirlo.' }
  }
  const name = file.name.toLowerCase()
  const syntaxHint = name.endsWith('.xml') ? 'xml'
    : name.endsWith('.jsonc') ? 'jsonc'
    : name.endsWith('.json') ? 'strict'
    : source.trimStart().startsWith('<') ? 'xml' : undefined
  return { ok: true, source, syntaxHint, metrics: measureDocument(source), xmlEncoding: syntaxHint === 'xml' ? getXmlDeclaredEncoding(source) : undefined }
}
