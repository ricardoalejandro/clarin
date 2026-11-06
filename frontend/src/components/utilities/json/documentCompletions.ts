import { createScanner } from 'jsonc-parser'

const jsonLiterals = ['true', 'false', 'null']

export function jsonLiteralCompletions(prefix: string) {
  const partial = /[a-z]+$/.exec(prefix)?.[0] ?? ''
  const preceding = prefix.slice(0, prefix.length - partial.length)
  const scanner = createScanner(preceding, false)
  const parents: string[] = []
  let previous = ''
  for (scanner.scan(); scanner.getTokenLength() > 0; scanner.scan()) {
    if (scanner.getTokenError() !== 0) return []
    const offset = scanner.getTokenOffset()
    const first = preceding[offset]
    if (preceding.startsWith('//', offset) && scanner.getPosition() === preceding.length) return []
    if (' \t\r\n'.includes(first) || first === '/') continue
    if (first === '{' || first === '[') parents.push(first)
    if (first === '}' || first === ']') parents.pop()
    previous = first
  }
  const value = !previous || previous === ':' || previous === '[' || (previous === ',' && parents.at(-1) === '[')
  return value ? jsonLiterals.filter(label => label.startsWith(partial)).map(label => ({ label, partial })) : []
}

export function xmlClosingTagCompletion(prefix: string) {
  const closing = /<\/([\p{L}\p{N}_:.\-\u00b7]*)$/u.exec(prefix)
  if (!closing) return
  const previous = prefix.slice(0, closing.index)
  const markup = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)|<(\/?)([\p{L}_:][\p{L}\p{N}_:.\-\u00b7]*)(?:"[^"]*"|'[^']*'|[^<>"'])*>/gu
  const stack: string[] = []
  let end = 0
  for (const match of previous.matchAll(markup)) {
    if (previous.slice(end, match.index).includes('<')) return
    end = match.index + match[0].length
    const [, close, name] = match
    if (!name) {
      if (!/(?:-->|\]\]>|\?>)$/.test(match[0])) return
    } else if (close) {
      if (stack.pop() !== name) return
    } else if (!match[0].endsWith('/>')) {
      stack.push(name)
    }
  }
  if (previous.slice(end).includes('<')) return
  const label = stack.at(-1)
  const partial = closing[1]
  if (label?.startsWith(partial)) return { label, partial }
}
