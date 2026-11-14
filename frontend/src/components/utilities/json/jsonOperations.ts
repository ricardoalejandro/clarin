import { createScanner, printParseErrorCode, visit } from 'jsonc-parser'
import { jsonrepair } from 'jsonrepair'
import { BoundedDocumentText, DocumentLimitError, indentationLines } from './boundedDocumentText'
import { DOCUMENT_DEPTH_LIMIT, JSON_INPUT_LIMIT, JSON_OUTPUT_LIMIT, JSON_REPAIR_LIMIT, measureDocument, segmentDocumentText, utf8ByteLength, type DocumentMetrics } from './jsonLimits'
import { processXml } from './xmlOperations'

const MAX_ACTIVE_JSON_KEYS = 250_000
const SMART_COLUMNS = 100
const EXPANDED_WIDTH = SMART_COLUMNS + 1
const PACKABLE_GROUP = 1 << 7
const WIDTH_MASK = PACKABLE_GROUP - 1

export type JsonMode = 'strict' | 'jsonc'
export type JsonOperation = 'validate' | 'format' | 'smart' | 'minify' | 'escape' | 'unescape' | 'repair'
export type JsonResult =
  | { ok: false; message: string; line?: number; column?: number; xmlSigned?: boolean }
  | { ok: true; message: string; warnings: string[]; text?: string; extension?: 'json' | 'jsonc' | 'txt' | 'xml'; changedSource?: string; metrics?: DocumentMetrics; xmlEncoding?: string; xmlSigned?: boolean }

export interface JsonRequest {
  operation: JsonOperation
  source: string
  mode: JsonMode
  indent: '2' | '4' | 'tab'
  language?: 'json' | 'xml'
  xmlSpacing?: 'safe' | 'structure'
}

export type DocumentFileResult =
  | { ok: true; source: string; metrics: DocumentMetrics; syntaxHint?: JsonMode | 'xml'; xmlEncoding?: string }
  | { ok: false; message: string }

export type DocumentWorkerRequest =
  | ({ kind: 'transform' } & JsonRequest)
  | { kind: 'read-file'; file: File }
  | { kind: 'measure'; source: string }

export type DocumentWorkerResponse =
  | { kind: 'transform'; result: JsonResult }
  | { kind: 'read-file'; result: DocumentFileResult }
  | { kind: 'measure'; metrics: DocumentMetrics }

const errorLabels: Partial<Record<ReturnType<typeof printParseErrorCode>, string>> = {
  InvalidSymbol: 'Símbolo inesperado',
  InvalidNumberFormat: 'Número inválido',
  PropertyNameExpected: 'Falta un nombre de propiedad entre comillas',
  ValueExpected: 'Falta un valor',
  ColonExpected: 'Falta «:»',
  CommaExpected: 'Falta «,»',
  CloseBraceExpected: 'Falta «}»',
  CloseBracketExpected: 'Falta «]»',
  EndOfFileExpected: 'Hay contenido después del valor JSON',
  InvalidCommentToken: 'El modo JSON estricto no admite comentarios',
  UnexpectedEndOfComment: 'Comentario sin cerrar',
  UnexpectedEndOfString: 'Cadena sin cerrar',
  UnexpectedEndOfNumber: 'Número incompleto',
  InvalidUnicode: 'Escape Unicode inválido',
  InvalidEscapeCharacter: 'Secuencia de escape inválida',
  InvalidCharacter: 'Carácter inválido en una cadena',
}

function checkDepth(source: string) {
  const scanner = createScanner(source, true)
  let depth = 0
  for (scanner.scan(); scanner.getTokenLength() > 0; scanner.scan()) {
    const tokenStart = source[scanner.getTokenOffset()]
    if (tokenStart === '{' || tokenStart === '[') depth++
    if (tokenStart === '}' || tokenStart === ']') depth = Math.max(0, depth - 1)
    if (depth > DOCUMENT_DEPTH_LIMIT) throw depthError()
  }
}

function depthError() { return new DocumentLimitError(`El documento supera el límite de ${DOCUMENT_DEPTH_LIMIT} niveles.`) }

class JsonSyntaxError extends Error {
  constructor(message: string, readonly line: number, readonly column: number) { super(message) }
}

function validate(source: string, mode: JsonMode) {
  let depth = 0
  let keysTracked = 0
  let truncatedDuplicates = false
  let hasDuplicateKeys = false
  let hasWideNumbers = false
  const objects: Set<string>[] = []
  const enter = () => { if (++depth > DOCUMENT_DEPTH_LIMIT) throw depthError() }
  visit(source, {
    onError(error, _offset, _length, startLine, startCharacter) {
      const line = startLine + 1
      const column = startCharacter + 1
      const label = errorLabels[printParseErrorCode(error)] ?? 'Sintaxis inválida'
      throw new JsonSyntaxError(`${label} en la línea ${line}, columna ${column}.`, line, column)
    },
    onObjectBegin() { enter(); objects.push(new Set()) },
    onObjectEnd() { depth--; keysTracked -= objects.pop()?.size ?? 0 },
    onArrayBegin: enter,
    onArrayEnd() { depth-- },
    onObjectProperty(name) {
      if (hasDuplicateKeys) return
      const keys = objects.at(-1)
      if (keys?.has(name)) { hasDuplicateKeys = true; return }
      if (keysTracked >= MAX_ACTIVE_JSON_KEYS) { truncatedDuplicates = true; return }
      keys?.add(name)
      keysTracked++
    },
    onLiteralValue(value, offset, length) {
      if (hasWideNumbers || typeof value !== 'number') return
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) { hasWideNumbers = true; return }
      if (length > 16) {
        const significand = source.slice(offset, offset + length).split(/[eE]/, 1)[0]
        hasWideNumbers = significand.replace(/\D/g, '').length > 16
      }
    },
  }, { disallowComments: mode === 'strict', allowTrailingComma: mode === 'jsonc' })

  const warnings: string[] = []
  if (hasDuplicateKeys) warnings.push('Hay claves repetidas. Se conservan y algunos lectores solo usan la última.')
  else if (truncatedDuplicates) warnings.push('Se acotó la revisión de claves repetidas por la cantidad de propiedades. Se conservaron todas las claves originales.')
  if (hasWideNumbers) warnings.push('Hay números que pueden perder precisión en otros lectores. Aquí se conserva su representación original.')
  return warnings
}

type TokenKind = 'open' | 'close' | 'comma' | 'colon' | 'line-comment' | 'block-comment' | 'value'

function tokenKind(source: string, offset: number): TokenKind {
  switch (source[offset]) {
    case '{': case '[': return 'open'
    case '}': case ']': return 'close'
    case ',': return 'comma'
    case ':': return 'colon'
    case '/': return source[offset + 1] === '/' ? 'line-comment' : 'block-comment'
    default: return 'value'
  }
}

function separator(previous: TokenKind | undefined, next: TokenKind, newline: string) {
  if (!previous) return ''
  if (previous === 'line-comment') return newline
  if (previous === 'open' && next === 'close') return ''
  if (next === 'comma' || next === 'colon') return ''
  if (previous === 'open' || previous === 'comma' || next === 'close') return newline
  if (previous === 'colon' || previous === 'block-comment' || next === 'line-comment' || next === 'block-comment') return ' '
  return ''
}

function inlineSeparator(previous: TokenKind | undefined, next: TokenKind) {
  if (!previous || previous === 'open' || next === 'close' || next === 'comma' || next === 'colon') return ''
  return previous === 'comma' || previous === 'colon' || previous === 'block-comment' || next === 'block-comment' ? ' ' : ''
}

function jsonTokens(source: string, consume: (kind: TokenKind, start: number, length: number) => void) {
  const scanner = createScanner(source, false)
  for (scanner.scan(); scanner.getTokenLength() > 0; scanner.scan()) {
    const start = scanner.getTokenOffset()
    if (!' \t\r\n'.includes(source[start])) consume(tokenKind(source, start), start, scanner.getTokenLength())
  }
}

interface SmartWidthFrame {
  start: number
  width: number
  previous: TokenKind
  packable: boolean
  entryStart?: number
  entryWidth: number
}

function smartWidths(source: string) {
  // Index group and scalar entry widths by their first token. The high bit marks
  // groups whose entries can share a line. A byte per source code unit bounds memory.
  const widths = new Uint8Array(source.length)
  const stack: SmartWidthFrame[] = []
  let previousClosed: number | undefined
  jsonTokens(source, (kind, start, length) => {
    const parent = stack[stack.length - 1]
    if (kind === 'comma' && previousClosed !== undefined) {
      const entry = widths[previousClosed]
      widths[previousClosed] = (entry & PACKABLE_GROUP) | Math.min(EXPANDED_WIDTH, (entry & WIDTH_MASK) + 1)
    }
    previousClosed = undefined
    if (kind === 'open') {
      if (parent) {
        parent.width += inlineSeparator(parent.previous, kind).length
        parent.packable = false
      }
      stack.push({ start, width: 1, previous: 'open', packable: true, entryWidth: 0 })
      return
    }
    if (!parent) return
    if (kind === 'close') {
      stack.pop()
      const width = Math.min(EXPANDED_WIDTH, parent.width + 1)
      widths[parent.start] = width | (parent.packable ? PACKABLE_GROUP : 0)
      if (parent.packable && parent.entryStart !== undefined) widths[parent.entryStart] = parent.entryWidth
      previousClosed = parent.start
      const outer = stack[stack.length - 1]
      if (outer) { outer.width = Math.min(EXPANDED_WIDTH, outer.width + width); outer.previous = 'close' }
      return
    }
    const tokenWidth = inlineSeparator(parent.previous, kind).length + length
    const forcesLineBreak = kind === 'line-comment' || (kind === 'block-comment' && length <= SMART_COLUMNS && /[\t\n\r]/.test(source.slice(start, start + length)))
    parent.width = forcesLineBreak ? EXPANDED_WIDTH : Math.min(EXPANDED_WIDTH, parent.width + tokenWidth)
    parent.previous = kind
    if (kind === 'line-comment' || kind === 'block-comment') parent.packable = false
    if (!parent.packable) return
    if (kind === 'comma') {
      if (parent.entryStart !== undefined) widths[parent.entryStart] = Math.min(EXPANDED_WIDTH, parent.entryWidth + 1)
      parent.entryStart = undefined
    } else if (parent.entryStart === undefined) {
      parent.entryStart = start
      parent.entryWidth = Math.min(EXPANDED_WIDTH, length)
    } else {
      parent.entryWidth = Math.min(EXPANDED_WIDTH, parent.entryWidth + tokenWidth)
    }
  })
  return widths
}

function writeJson(source: string, indent: JsonRequest['indent'] | undefined, smart: boolean) {
  const output = new BoundedDocumentText()
  const lines = indent ? indentationLines(indent) : undefined
  const widths = smart ? smartWidths(source) : undefined
  const layouts: ('inline' | 'packed' | 'multiline')[] = []
  let previous: TokenKind | undefined
  let depth = 0
  let column = 0

  function append(text: string, canContainNewline = false) {
    output.append(text)
    if (!widths || !text) return
    const lastBreak = canContainNewline ? Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) : -1
    if (lastBreak >= 0) {
      const lastLine = text.slice(lastBreak + 1)
      column = indent === 'tab' && lastLine.startsWith('\t') ? lastLine.length + lastLine.match(/^\t+/)![0].length * 3 : lastLine.length
    } else column = Math.min(EXPANDED_WIDTH, column + text.length)
  }

  jsonTokens(source, (kind, offset, length) => {
    const parentLayout = layouts[layouts.length - 1]
    if (kind === 'close') depth--
    if (lines) {
      const entryWidth = widths?.[offset] ?? 0
      const fitsPackedLine = parentLayout === 'packed' && previous === 'comma' && kind === 'value' && entryWidth > 0 && column + 1 + entryWidth <= SMART_COLUMNS
      const gap = parentLayout === 'inline' || fitsPackedLine ? inlineSeparator(previous, kind) : separator(previous, kind, lines[depth])
      append(gap, gap[0] === '\n')
    }
    if (kind === 'open') {
      if (widths) {
        const group = widths[offset]
        const fits = (group & WIDTH_MASK) <= SMART_COLUMNS - column
        const expanded = (group & PACKABLE_GROUP) ? 'packed' : 'multiline'
        layouts.push(parentLayout === 'inline' || fits ? 'inline' : expanded)
      }
      depth++
    }
    append(source.slice(offset, offset + length), kind === 'block-comment')
    if (!lines && kind === 'line-comment') append('\n')
    if (kind === 'close' && widths) layouts.pop()
    previous = kind
  })
  return output.finish()
}

function escapeJson(source: string) {
  const output = new BoundedDocumentText()
  output.append('"')
  for (const segment of segmentDocumentText(source)) output.append(JSON.stringify(segment).slice(1, -1))
  output.append('"')
  return output.finish()
}

function excerptBeforeChange(before: string, after: string) {
  let start = 0
  const sharedLength = Math.min(before.length, after.length)
  while (start < sharedLength && before[start] === after[start]) start++
  let end = before.length
  let afterEnd = after.length
  while (end > start && afterEnd > start && before[end - 1] === after[afterEnd - 1]) {
    end--
    afterEnd--
  }
  const excerptLimit = 1800
  return end - start > excerptLimit ? `${before.slice(start, start + excerptLimit)}\n[…]` : before.slice(start, end)
}

export function processJson(request: JsonRequest): JsonResult {
  const { source, mode, indent, operation, language } = request
  const bytes = source.length <= JSON_INPUT_LIMIT ? utf8ByteLength(source) : source.length
  if (bytes > JSON_INPUT_LIMIT) return { ok: false, message: 'La entrada supera el límite de 25 MiB.' }
  if (language === 'xml') return processXml(request)
  if (operation === 'repair' && bytes > JSON_REPAIR_LIMIT) return { ok: false, message: 'Reparar admite documentos de hasta 2 MiB.' }
  try {
    if (operation === 'escape') {
      const text = escapeJson(source)
      return { ok: true, message: 'Cadena JSON generada.', warnings: [], text, extension: 'json', metrics: measureDocument(text) }
    }

    if (operation === 'unescape') {
      let text: unknown
      if (source.trimStart().startsWith('"')) {
        try { text = JSON.parse(source) } catch { /* A full JSON string is required. */ }
      }
      return typeof text === 'string'
        ? { ok: true, message: 'Se quitó una capa de escape.', warnings: [], text, extension: 'txt', metrics: measureDocument(text) }
        : { ok: false, message: 'Ingresa una cadena JSON completa entre comillas dobles. Para fragmentos mal formados, prueba Reparar.' }
    }

    if (operation === 'repair') checkDepth(source)
    const content = operation === 'repair' ? jsonrepair(source) : source
    const resultMode = operation === 'repair' ? 'strict' : mode
    const warnings = validate(content, resultMode)
    if (operation === 'validate') return { ok: true, message: mode === 'strict' ? 'JSON válido.' : 'JSON con comentarios válido.', warnings }

    const text = operation === 'repair' ? content : writeJson(content, operation === 'format' || operation === 'smart' ? indent : undefined, operation === 'smart')
    const metrics = measureDocument(text)
    if (metrics.bytes > JSON_OUTPUT_LIMIT) return { ok: false, message: 'El resultado supera el límite de 50 MiB.' }

    const message = operation === 'repair'
      ? text === source ? 'El documento ya es JSON válido.' : 'Propuesta de reparación. Revisa los cambios antes de aplicarla.'
      : operation === 'smart' ? 'Formato inteligente aplicado.' : operation === 'format' ? 'Formato aplicado.' : 'Documento compactado.'
    return { ok: true, message, warnings, text, extension: resultMode === 'strict' ? 'json' : 'jsonc', metrics,
      changedSource: operation === 'repair' && text !== source ? excerptBeforeChange(source, text) : undefined }
  } catch (error) {
    if (error instanceof JsonSyntaxError) return { ok: false, message: error.message, line: error.line, column: error.column }
    if (error instanceof DocumentLimitError) return { ok: false, message: error.message }
    return { ok: false, message: operation === 'repair' ? 'No se pudo proponer una reparación segura. Revisa la sintaxis del original.' : 'No se pudo procesar este documento.' }
  }
}
