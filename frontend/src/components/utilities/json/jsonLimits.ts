export const JSON_INPUT_LIMIT = 25 * 1024 * 1024
export const JSON_OUTPUT_LIMIT = 50 * 1024 * 1024
export const JSON_REPAIR_LIMIT = 2 * 1024 * 1024
export const DOCUMENT_DEPTH_LIMIT = 160

export interface DocumentMetrics {
  bytes: number
  lines: number
  longestLine: number
}

function highSurrogate(code: number) { return code >= 0xd800 && code <= 0xdbff }
function lowSurrogate(code: number) { return code >= 0xdc00 && code <= 0xdfff }

export function utf8ByteLength(text: string) {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code <= 0x7f) bytes++
    else if (code <= 0x7ff) bytes += 2
    else if (highSurrogate(code) && lowSurrogate(text.charCodeAt(index + 1))) { bytes += 4; index++ }
    else bytes += 3
  }
  return bytes
}

export function measureDocument(text: string): DocumentMetrics {
  let lines = 1
  let longestLine = 0
  let lineStart = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code !== 10 && code !== 13) continue
    longestLine = Math.max(longestLine, index - lineStart)
    if (code === 13 && text.charCodeAt(index + 1) === 10) index++
    lineStart = index + 1
    lines++
  }
  return { bytes: utf8ByteLength(text), lines, longestLine: Math.max(longestLine, text.length - lineStart) }
}

export function fitsJsonInput(source: string) {
  return source.length <= JSON_INPUT_LIMIT && (source.length * 3 <= JSON_INPUT_LIMIT || utf8ByteLength(source) <= JSON_INPUT_LIMIT)
}

export function segmentDocumentText(source: string, limit = 32_000) {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new RangeError('Invalid segment length')
  const segments: string[] = []
  for (let start = 0; start < source.length;) {
    let end = Math.min(source.length, start + limit)
    if (highSurrogate(source.charCodeAt(end - 1)) && lowSurrogate(source.charCodeAt(end))) end--
    segments.push(source.slice(start, end))
    start = end
  }
  return segments
}

export function getXmlDeclaredEncoding(source: string) {
  // XMLDecl has a fixed attribute order. The stylesheet PI and element attributes are irrelevant.
  return /^\uFEFF?<\?xml[\t\n\r ]+version[\t\n\r ]*=[\t\n\r ]*(['"])[^'"]+\1[\t\n\r ]+encoding[\t\n\r ]*=[\t\n\r ]*(['"])([A-Za-z][A-Za-z0-9._-]*)\2/.exec(source)?.[3]
}
