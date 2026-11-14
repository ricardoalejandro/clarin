export type Panel = 'a' | 'b'
export type DocumentFormat = 'strict' | 'jsonc' | 'xml'

export const DIFF_LIMIT = 5 * 1024 * 1024
export const DIFF_LINES = 100_000
export const LARGE_DOCUMENT = 8 * 1024 * 1024
export const LONG_LINE = 100_000
export const PANEL_BREAKPOINT = 832
export const DEFAULT_FONT = 14
export const MIN_FONT = 10
export const MAX_FONT = 70
export const TRAM_LENGTH = 24_000

export function otherPanel(panel: Panel): Panel {
  return panel === 'a' ? 'b' : 'a'
}

export function visiblePanels(active: Panel, split: boolean, width: number): readonly Panel[] {
  return split && width >= PANEL_BREAKPOINT ? ['a', 'b'] : [active]
}

export function canCompare(documents: readonly { bytes: number; lines: number; longestLine: number }[]) {
  return documents.every(document => document.bytes <= DIFF_LIMIT && document.lines <= DIFF_LINES && document.longestLine <= LONG_LINE)
}

export function adjustFont(font: number, delta: number) {
  return Math.max(MIN_FONT, Math.min(MAX_FONT, font + delta))
}

export function fontZoomPercent(font: number) {
  return Math.round(font * 100 / DEFAULT_FONT)
}

export function documentWrapOptions(enabled: boolean, chunk: number | null) {
  return {
    wordWrap: chunk !== null ? 'bounded' : enabled ? 'on' : 'off',
    scrollbar: { horizontal: enabled || chunk !== null ? 'hidden' : 'auto', alwaysConsumeMouseWheel: false },
  } as const
}

export function acceptsEditorZoom(event: Pick<WheelEvent, 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'cancelable' | 'deltaY'>, focused: boolean) {
  return focused && event.cancelable && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.deltaY !== 0
}

export function documentLanguage(format: DocumentFormat, reduced: boolean) {
  return reduced ? 'plaintext' : format === 'xml' ? 'xml' : 'json'
}

export function repairPreview(original: string, proposal: string) {
  let start = 0
  while (start < original.length && start < proposal.length && original[start] === proposal[start]) start++
  let beforeEnd = original.length
  let afterEnd = proposal.length
  while (beforeEnd > start && afterEnd > start && original[beforeEnd - 1] === proposal[afterEnd - 1]) {
    beforeEnd--
    afterEnd--
  }
  const from = Math.max(0, start - 30)
  const excerpt = (text: string, end: number) => {
    const until = Math.min(end + 30, start + 600, text.length)
    return (from ? '…' : '') + text.slice(from, until) + (until < text.length ? '…' : '')
  }
  return { before: excerpt(original, beforeEnd), after: excerpt(proposal, afterEnd) }
}

export function tramRange(length: number, index: number, codeAt: (index: number) => number) {
  const safeBoundary = (offset: number) => {
    if (offset <= 0 || offset >= length) return offset
    const code = codeAt(offset)
    return code >= 0xdc00 && code <= 0xdfff ? offset - 1 : offset
  }
  return {
    start: safeBoundary(index * TRAM_LENGTH),
    end: safeBoundary(Math.min((index + 1) * TRAM_LENGTH, length)),
  }
}
