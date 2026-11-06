import { applyEdits, createScanner, format, printParseErrorCode, visit, type ParseError } from 'jsonc-parser'
import { jsonrepair } from 'jsonrepair'
import { fitsJsonInput } from './jsonLimits'

const JSON_OUTPUT_LIMIT = 4 * 1024 * 1024
const MAX_DEPTH = 160
const encoder = new TextEncoder()

export type JsonMode = 'strict' | 'jsonc'
export type JsonOperation = 'validate' | 'format' | 'minify' | 'escape' | 'unescape' | 'repair'
export type JsonResult =
  | { ok: false; message: string }
  | { ok: true; message: string; warnings: string[]; text?: string; extension?: 'json' | 'jsonc' | 'txt'; changedSource?: string }

export interface JsonRequest {
  operation: JsonOperation
  source: string
  mode: JsonMode
  indent: '2' | '4' | 'tab'
}

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
    if (depth > MAX_DEPTH) throw new Error(`El documento supera el límite de ${MAX_DEPTH} niveles.`)
  }
}

function validate(source: string, mode: JsonMode) {
  checkDepth(source)
  let firstError: (ParseError & { line: number; column: number }) | undefined
  let hasDuplicateKeys = false
  let hasWideNumbers = false
  const objects: Set<string>[] = []
  visit(source, {
    onError(error, offset, length, startLine, startCharacter) {
      firstError ??= { error, offset, length, line: startLine + 1, column: startCharacter + 1 }
    },
    onObjectBegin() { objects.push(new Set()) },
    onObjectEnd() { objects.pop() },
    onObjectProperty(name) {
      const keys = objects.at(-1)
      if (keys?.has(name)) hasDuplicateKeys = true
      keys?.add(name)
    },
    onLiteralValue(value, offset, length) {
      if (typeof value !== 'number') return
      const significand = source.slice(offset, offset + length).split(/[eE]/, 1)[0]
      hasWideNumbers ||= !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)) || significand.replace(/\D/g, '').length > 16
    },
  }, { disallowComments: mode === 'strict', allowTrailingComma: mode === 'jsonc' })

  const warnings: string[] = []
  if (hasDuplicateKeys) warnings.push('Hay claves repetidas. Se conservan y algunos lectores solo usan la última.')
  if (hasWideNumbers) warnings.push('Hay números que pueden perder precisión en otros lectores. Aquí se conserva su representación original.')
  return { error: firstError, warnings }
}

function minify(source: string) {
  const tokens: string[] = []
  const scanner = createScanner(source, false)
  for (scanner.scan(); scanner.getTokenLength() > 0; scanner.scan()) {
    const offset = scanner.getTokenOffset()
    if (' \t\r\n'.includes(source[offset])) continue
    const token = source.slice(offset, offset + scanner.getTokenLength())
    tokens.push(token)
    if (token.startsWith('//')) tokens.push('\n')
  }
  return tokens.join('')
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

export function processJson({ source, mode, indent, operation }: JsonRequest): JsonResult {
  if (!fitsJsonInput(source)) return { ok: false, message: 'La entrada supera el límite de 2 MiB.' }
  try {
    if (operation === 'escape') {
      const text = JSON.stringify(source)
      if (encoder.encode(text).byteLength > JSON_OUTPUT_LIMIT) return { ok: false, message: 'El resultado supera el límite de 4 MiB.' }
      return { ok: true, message: 'Cadena JSON generada.', warnings: [], text, extension: 'json' }
    }

    if (operation === 'unescape') {
      let text: unknown
      try { text = JSON.parse(source) } catch { /* A full JSON string is required. */ }
      return typeof text === 'string'
        ? { ok: true, message: 'Se quitó una capa de escape.', warnings: [], text, extension: 'txt' }
        : { ok: false, message: 'Ingresa una cadena JSON completa entre comillas dobles. Para fragmentos mal formados, prueba Reparar.' }
    }

    if (operation === 'repair') checkDepth(source)
    const content = operation === 'repair' ? jsonrepair(source) : source
    const resultMode = operation === 'repair' ? 'strict' : mode
    const { error, warnings } = validate(content, resultMode)
    if (error) {
      const label = errorLabels[printParseErrorCode(error.error)] ?? 'Sintaxis inválida'
      return { ok: false, message: `${label} en la línea ${error.line}, columna ${error.column}.` }
    }
    if (operation === 'validate') return { ok: true, message: mode === 'strict' ? 'JSON válido.' : 'JSON con comentarios válido.', warnings }

    let text = content
    if (operation === 'format') {
      const edits = format(content, undefined, { insertSpaces: indent !== 'tab', tabSize: indent === '4' ? 4 : 2, eol: '\n' })
      const outputLength = edits.reduce((length, edit) => length + edit.content.length - edit.length, content.length)
      if (outputLength > JSON_OUTPUT_LIMIT) return { ok: false, message: 'El resultado supera el límite de 4 MiB. Reduce la sangría o compacta el documento.' }
      text = applyEdits(content, edits)
    }
    if (operation === 'minify') text = minify(content)
    if (encoder.encode(text).byteLength > JSON_OUTPUT_LIMIT) return { ok: false, message: 'El resultado supera el límite de 4 MiB.' }

    const message = operation === 'repair'
      ? text === source ? 'El documento ya es JSON válido.' : 'Propuesta de reparación. Revisa los cambios antes de aplicarla.'
      : operation === 'format' ? 'Formato aplicado al resultado.' : 'Resultado compactado.'
    return { ok: true, message, warnings, text, extension: resultMode === 'strict' ? 'json' : 'jsonc',
      changedSource: operation === 'repair' && text !== source ? excerptBeforeChange(source, text) : undefined }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('El documento supera el límite')) return { ok: false, message: error.message }
    return { ok: false, message: operation === 'repair' ? 'No se pudo proponer una reparación segura. Revisa la sintaxis del original.' : 'No se pudo procesar este documento.' }
  }
}
