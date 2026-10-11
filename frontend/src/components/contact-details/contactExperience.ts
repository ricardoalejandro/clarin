/** The breakpoint is the usable panel width, never the browser width. */
export const CONTACT_FIELDS_TWO_COLUMNS_WIDTH = 420

export function contactFieldColumns(width: number): 1 | 2 {
  return width >= CONTACT_FIELDS_TWO_COLUMNS_WIDTH ? 2 : 1
}

export function hasContactNoteDraft(newNote: string, editedNote: string, originalNote?: string): boolean {
  return Boolean(newNote.trim()) || (originalNote !== undefined && editedNote !== originalNote)
}

export function clearSubmittedNote(current: string, submitted: string): string {
  return current === submitted ? '' : current
}

export function contactTagForeground(color?: string): '#0F172A' | '#FFFFFF' {
  const hex = /^#[0-9a-f]{6}$/i.test(color || '') ? color! : '#64748B'
  const channels = [1, 3, 5].map(index => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
  })
  const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
  return luminance > .179 ? '#0F172A' : '#FFFFFF'
}

export function contactTagMenuPosition(rect: { left: number; top: number; bottom: number; width: number }, viewport: { left: number; top: number; width: number; height: number }) {
  const gap = 6
  const edge = 8
  const width = Math.min(Math.max(rect.width, 240), Math.max(0, viewport.width - edge * 2))
  const below = Math.max(0, viewport.top + viewport.height - rect.bottom - gap - edge)
  const above = Math.max(0, rect.top - viewport.top - gap - edge)
  const flip = below < 180 && above > below
  const maxHeight = Math.min(280, Math.max(0, viewport.height - edge * 2), flip ? above : below)
  const top = Math.max(viewport.top + edge, Math.min(flip ? rect.top - gap - maxHeight : rect.bottom + gap, viewport.top + viewport.height - edge - maxHeight))
  return { left: Math.max(viewport.left + edge, Math.min(rect.left, viewport.left + viewport.width - width - edge)), top, width, maxHeight }
}
