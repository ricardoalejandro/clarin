export interface WebLink { start: number; end: number; text: string; href: string }

/** Only explicit web destinations; never interpret markup or repair arbitrary schemes. */
export function safeWebHref(value: unknown): string | null {
  if (typeof value !== 'string' || !value || /[\s\p{Cc}\p{Cf}<>"\\]/u.test(value)) return null
  const candidate = /^www\./i.test(value) ? `https://${value}` : value
  if (!/^https?:\/\//i.test(candidate)) return null
  try {
    const url = new URL(candidate)
    if (!url.hostname || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return null
    return url.href
  } catch { return null }
}

function trimEnd(value: string): string {
  let parentheses = 0, brackets = 0, braces = 0
  for (const character of value) {
    if (character === '(') parentheses++
    else if (character === ')') parentheses--
    else if (character === '[') brackets++
    else if (character === ']') brackets--
    else if (character === '{') braces++
    else if (character === '}') braces--
  }
  let end = value.length
  while (end) {
    const last = value[end - 1]
    if (/[.,;:!?…'’”]/u.test(last)) { end--; continue }
    if (last === ')' && parentheses < 0) { parentheses++; end--; continue }
    if (last === ']' && brackets < 0) { brackets++; end--; continue }
    if (last === '}' && braces < 0) { braces++; end--; continue }
    break
  }
  return value.slice(0, end)
}

/** Offsets preserve original copy/whitespace while href uses the URL parser's canonical form. */
export function findWebLinks(text: string): WebLink[] {
  const links: WebLink[] = []
  const starts = /https?:\/\/|www\./gi
  let match: RegExpExecArray | null
  while ((match = starts.exec(text))) {
    const start = match.index
    if (start && /[\p{L}\p{N}_@/]/u.test(text[start - 1])) continue
    let end = starts.lastIndex
    while (end < text.length && !/[\s<>"`“”‘’]/u.test(text[end])) end++
    const value = trimEnd(text.slice(start, end))
    const href = safeWebHref(value)
    if (href) links.push({ start, end: start + value.length, text: value, href })
    starts.lastIndex = end
  }
  return links
}
