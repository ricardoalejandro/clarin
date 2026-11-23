import type { DocumentFormat } from './editorWorkspaceState'
import { isStructuredFormat } from './documentFormats'

export type JsonToolbarAction = 'undo' | 'redo' | 'open' | 'copy' | 'download' | 'smart' | 'minify' | 'wrap' | 'panel' | 'compare'

/** Match utility-density.css, including touch screens with a fine primary pointer. */
export function fineUtilityPointer(fine: boolean, coarse: boolean) {
  return fine && !coarse
}

export function jsonToolbarLayout(width: number, fine: boolean, format: DocumentFormat, split: boolean) {
  const size = fine ? 32 : 44
  const groups: JsonToolbarAction[][] = [
    ['undo', 'redo'],
    ['open', 'copy', 'download'],
    ...(isStructuredFormat(format) ? [format === 'xml' ? ['minify'] as JsonToolbarAction[] : ['smart', 'minify'] as JsonToolbarAction[]] : []),
    ['wrap'],
    split ? ['compare'] : ['panel'],
  ]
  // Eight pixels of outer padding, fixed syntax, three pinned actions and More.
  let used = 8 + (fine ? 64 : 72) + 4 * size + 8
  const visible: JsonToolbarAction[][] = []
  const overflow: JsonToolbarAction[] = []
  let full = false
  for (const group of groups) {
    // Each group owns its separating border/padding and the outer two-pixel gap.
    const cost = group.length * (size + 2) + 5
    if (!full && Number.isFinite(width) && used + cost <= Math.floor(width)) {
      visible.push(group)
      used += cost
    } else {
      full = true
      overflow.push(...group)
    }
  }
  return { visible, overflow, used, size, syntaxWidth: fine ? 64 : 72 }
}
