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
  let result = value
  while (result) {
    const last = result.at(-1)!
    if (/[.,;:!?…'’”]/u.test(last)) { result = result.slice(0, -1); continue }
    const opening = ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[last]
    if (opening && result.split(last).length > result.split(opening).length) { result = result.slice(0, -1); continue }
    break
  }
  return result
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
