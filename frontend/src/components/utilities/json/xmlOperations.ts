import { SaxesParser, type SaxesTagNS } from 'saxes'
import { BoundedDocumentText, DocumentLimitError, indentationLines } from './boundedDocumentText'
import { DOCUMENT_DEPTH_LIMIT, measureDocument } from './jsonLimits'
import type { JsonRequest, JsonResult } from './jsonOperations'

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'
const SIGNATURE_NAMESPACE = 'http://www.w3.org/2000/09/xmldsig#'

type XmlToken =
  | { kind: 'open' | 'close'; start: number; end: number; tag: SaxesTagNS }
  | { kind: 'cdata' | 'other'; start: number; end: number }

class XmlSyntaxError extends Error {
  constructor(message: string, readonly line: number, readonly column: number) {
    super(`${message} en la línea ${line}, columna ${column}.`)
  }
}

function xmlSpace(char: number) { return char === 32 || char === 9 || char === 10 || char === 13 }

function whitespaceGap(source: string, start: number, end: number) {
  for (let index = start; index < end; index++) if (!xmlSpace(source.charCodeAt(index))) return false
  return true
}

function xmlErrorLabel(message: string) {
  if (message.includes('unbound namespace prefix')) return 'Prefijo de espacio de nombres sin declarar'
  if (message.includes('duplicate attribute')) return 'Atributo repetido'
  if (message.includes('undefined entity')) return 'Entidad XML no admitida o sin declarar'
  if (message.includes('unexpected close tag') || message.includes('unmatched closing tag')) return 'Etiqueta de cierre inesperada'
  if (message.includes('unclosed tag')) return 'Etiqueta sin cerrar'
  if (message.includes('one root')) return 'El XML debe tener un solo elemento raíz'
  if (message.includes('root element')) return 'Falta un elemento raíz válido'
  return 'Sintaxis XML inválida'
}

function readXml(source: string, onToken?: (token: XmlToken, afterPrevious: number) => void) {
  const parser = new SaxesParser({ xmlns: true, fragment: false, defaultXMLVersion: '1.0', forceXMLVersion: true })
  let cursor = 0
  let depth = 0
  let xmlEncoding: string | undefined
  let signed = false
  const fail = (label: string): never => { throw new XmlSyntaxError(label, parser.line, Math.max(1, parser.columnIndex)) }

  function emit(kind: XmlToken['kind'], tag?: SaxesTagNS, terminator?: string) {
    if (!onToken) return
    const start = source.indexOf('<', cursor)
    // Saxes reports comments before consuming the closing >. Find each opaque token's
    // terminator from its lexical start, so any < characters inside it remain text.
    const marker = terminator && start >= 0 ? source.indexOf(terminator, start + 2) : -1
    const end = terminator ? marker < 0 ? -1 : marker + terminator.length : parser.position
    if (start < 0 || end <= start || source[end - 1] !== '>') fail('No se pudo ubicar un fragmento XML')
    if (tag && (kind === 'open' || kind === 'close')) onToken({ kind, start, end, tag }, cursor)
    else if (kind === 'cdata' || kind === 'other') onToken({ kind, start, end }, cursor)
    cursor = end
  }

  parser.on('error', error => fail(xmlErrorLabel(error.message)))
  parser.on('doctype', () => fail('Los documentos con DOCTYPE están fuera del alcance de este editor'))
  parser.on('xmldecl', declaration => {
    if (declaration.version !== '1.0') fail('Este editor admite XML 1.0')
    xmlEncoding = declaration.encoding
    emit('other', undefined, '?>')
  })
  parser.on('comment', () => emit('other', undefined, '-->'))
  parser.on('processinginstruction', () => emit('other', undefined, '?>'))
  parser.on('cdata', () => emit('cdata', undefined, ']]>'))
  parser.on('opentag', tag => {
    if (depth + 1 > DOCUMENT_DEPTH_LIMIT) throw new DocumentLimitError(`El documento supera el límite de ${DOCUMENT_DEPTH_LIMIT} niveles.`)
    if (tag.uri === SIGNATURE_NAMESPACE && tag.local === 'Signature') signed = true
    emit('open', tag)
    if (!tag.isSelfClosing) depth++
  })
  parser.on('closetag', tag => {
    if (tag.isSelfClosing) return
    depth--
    emit('close', tag)
  })
  parser.write(source).close()
  return { cursor, xmlEncoding, signed }
}

function mark(bits: Uint8Array, position: number) { bits[position >> 3] |= 1 << (position & 7) }
function marked(bits: Uint8Array, position: number) { return (bits[position >> 3] & (1 << (position & 7))) !== 0 }

function inspectXml(source: string) {
  // Two bitmaps avoid keeping a node tree or one heap object per tag for large files.
  const mixed = new Uint8Array(Math.ceil(source.length / 8))
  const children = new Uint8Array(mixed.length)
  const starts: number[] = []
  const info = readXml(source, (token, afterPrevious) => {
    const parent = starts.at(-1)
    if (parent !== undefined && (token.kind === 'cdata' || !whitespaceGap(source, afterPrevious, token.start))) mark(mixed, parent)
    if (token.kind === 'open') {
      if (parent !== undefined) mark(children, parent)
      if (!token.tag.isSelfClosing) starts.push(token.start)
    }
    if (token.kind === 'close') starts.pop()
  })
  return { mixed, children, ...info }
}

function preserveSpace(tag: SaxesTagNS, inherited: boolean) {
  const space = tag.attributes['xml:space']
  return space?.uri === XML_NAMESPACE && space.local === 'space' ? space.value !== 'default' : inherited
}

function writeTag(source: string, token: Extract<XmlToken, { tag: SaxesTagNS }>, output: BoundedDocumentText, attrIndent: string | undefined) {
  let cursor = token.start + (token.kind === 'close' ? 2 : 1) + token.tag.name.length
  output.append(source.slice(token.start, cursor))
  if (token.kind === 'open') {
    const attributeSeparator = attrIndent && Object.keys(token.tag.attributes).length > 1 ? attrIndent : ' '
    while (cursor < token.end) {
      while (xmlSpace(source.charCodeAt(cursor))) cursor++
      if (source[cursor] === '>' || source[cursor] === '/') break
      const nameStart = cursor
      while (cursor < token.end && source[cursor] !== '=' && !xmlSpace(source.charCodeAt(cursor))) cursor++
      output.append(attributeSeparator)
      output.append(source.slice(nameStart, cursor))
      while (xmlSpace(source.charCodeAt(cursor))) cursor++
      if (source[cursor++] !== '=') throw new Error('Invalid XML attribute boundary')
      while (xmlSpace(source.charCodeAt(cursor))) cursor++
      const quote = source[cursor]
      if (quote !== '"' && quote !== "'") throw new Error('Invalid XML attribute quote')
      const quoteEnd = source.indexOf(quote, cursor + 1)
      if (quoteEnd < 0 || quoteEnd >= token.end) throw new Error('Invalid XML attribute value boundary')
      output.append('=')
      output.append(source.slice(cursor, quoteEnd + 1))
      cursor = quoteEnd + 1
    }
  }
  output.append(token.kind === 'open' && token.tag.isSelfClosing ? attrIndent ? ' />' : '/>' : '>')
}

function renderXml(source: string, indent: JsonRequest['indent'] | undefined, structural: boolean, mixed: Uint8Array, children: Uint8Array) {
  const output = new BoundedDocumentText()
  const lines = indent ? indentationLines(indent) : undefined
  const stack: { start: number; mixed: boolean; preserve: boolean }[] = []
  const { cursor } = readXml(source, (token, afterPrevious) => {
    const parent = stack.at(-1)
    const depth = stack.length - (token.kind === 'close' ? 1 : 0)
    if (parent && structural && !parent.preserve && !parent.mixed && marked(children, parent.start)) {
      output.append(lines?.[depth] ?? '')
    } else if (!parent && afterPrevious > 0) {
      if (lines) output.append('\n')
    } else {
      output.append(source.slice(afterPrevious, token.start))
    }

    if (token.kind === 'open') {
      const preserve = preserveSpace(token.tag, parent?.preserve ?? false)
      const hasMixed = !!parent?.mixed || marked(mixed, token.start)
      if (preserve || hasMixed) output.append(source.slice(token.start, token.end))
      else writeTag(source, token, output, lines?.[depth + 1])
      if (!token.tag.isSelfClosing) stack.push({ start: token.start, mixed: hasMixed, preserve })
    } else if (token.kind === 'close') {
      if (parent?.preserve || parent?.mixed) output.append(source.slice(token.start, token.end))
      else writeTag(source, token, output, lines?.[depth + 1])
      stack.pop()
    } else {
      output.append(source.slice(token.start, token.end))
    }
  })
  if (lines) output.append(source.slice(cursor))
  return output.finish()
}

function encodingWarning(encoding: string | undefined) {
  return encoding && encoding.toLowerCase() !== 'utf-8' ? ['La declaración indica una codificación distinta de UTF-8. Para descargar como XML, ajusta la declaración.'] : []
}

export function processXml({ source, operation, indent, xmlSpacing }: JsonRequest): JsonResult {
  if (operation !== 'validate' && operation !== 'format' && operation !== 'minify') {
    return { ok: false, message: 'En XML están disponibles Validar, Formatear y Compactar.' }
  }
  try {
    if (operation === 'validate') {
      const { signed, xmlEncoding } = readXml(source)
      const warnings = encodingWarning(xmlEncoding)
      if (signed) warnings.push('Se detectó una firma XML. Puedes revisar y copiar el original.')
      return { ok: true, message: 'XML 1.0 bien formado.', warnings, xmlEncoding, xmlSigned: signed }
    }
    const info = inspectXml(source)
    if (info.signed) return { ok: false, message: 'Se detectó una firma XML. Para conservarla, usa Validar o copia el documento original.', xmlSigned: true }
    const structural = xmlSpacing === 'structure'
    const text = renderXml(source, operation === 'format' ? indent : undefined, structural, info.mixed, info.children)
    const warnings = encodingWarning(info.xmlEncoding)
    if (structural && text !== source) warnings.push('El modo estructural puede cambiar espacios entre elementos. Revisa los espacios si otra aplicación los interpreta como contenido.')
    const message = text === source ? 'El documento se conservó sin cambios.' : operation === 'format' ? 'Formato XML aplicado.' : 'XML compactado.'
    return { ok: true, text, extension: 'xml', message, warnings, xmlEncoding: info.xmlEncoding, metrics: measureDocument(text) }
  } catch (error) {
    if (error instanceof XmlSyntaxError) return { ok: false, message: error.message, line: error.line, column: error.column }
    if (error instanceof DocumentLimitError) return { ok: false, message: error.message }
    return { ok: false, message: 'No se pudo procesar este documento XML.' }
  }
}
