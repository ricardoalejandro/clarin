export interface DocumentMatch { offset: number; length: number; preview: string }
export interface DocumentSearchPage { matches: DocumentMatch[]; nextOffset: number | null }
export type SearchRequest = { kind: 'load'; source: string } | { kind: 'find'; id: number; query: string; caseSensitive: boolean; offset: number }
export interface SearchResponse extends DocumentSearchPage { id: number }

/** Literal Unicode-aware search. Escaping keeps user input out of regex syntax. */
export function findDocumentText(source: string, query: string, caseSensitive = false, offset = 0, limit = 100): DocumentSearchPage {
  if (!query || query.length > 1024 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) return { matches: [], nextOffset: null }
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu')
  expression.lastIndex = offset
  const matches: DocumentMatch[] = []
  let found: RegExpExecArray | null
  while ((found = expression.exec(source))) {
    if (matches.length === limit) return { matches, nextOffset: found.index }
    let from = Math.max(0, found.index - 36)
    let end = Math.min(source.length, found.index + found[0].length + 60)
    if (from > 0 && /[\uDC00-\uDFFF]/.test(source[from])) from--
    if (end < source.length && /[\uDC00-\uDFFF]/.test(source[end])) end++
    matches.push({ offset: found.index, length: found[0].length, preview: (from ? '…' : '') + source.slice(from, end).replace(/[\r\n\t]/g, ' ') + (end < source.length ? '…' : '') })
  }
  return { matches, nextOffset: null }
}
