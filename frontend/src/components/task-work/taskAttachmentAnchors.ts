import type { TaskAttachmentAnchor } from '@/types/task'

export function normalizedAttachmentPoint(kind: 'image' | 'pdf', rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, clientX: number, clientY: number, page?: number): TaskAttachmentAnchor {
  const clamp = (value: number) => Math.max(0, Math.min(1, value))
  return { kind, page: kind === 'pdf' ? page : undefined, x: clamp((clientX - rect.left) / Math.max(1, rect.width)), y: clamp((clientY - rect.top) / Math.max(1, rect.height)) }
}

export function textAttachmentAnchor(text: string, offset: number, quote: string): TaskAttachmentAnchor {
  const safeOffset = Math.max(0, Math.min(text.length, offset))
  return { kind: 'text', line: text.slice(0, safeOffset).split('\n').length, offset: safeOffset, quote: quote.slice(0, 500) }
}

export function emptyAttachmentAnchor(kind?: string): TaskAttachmentAnchor {
  if (kind === 'pdf' || kind === 'word_pdf') return { kind: 'pdf' }
  if (kind === 'text') return { kind: 'text' }
  return { kind: 'image' }
}

export function hasUsableAttachmentAnchor(anchor: TaskAttachmentAnchor) {
  if (anchor.kind === 'image') return Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
  if (anchor.kind === 'pdf') return Number.isFinite(anchor.page) && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
  return Number.isFinite(anchor.line) && Number.isFinite(anchor.offset) && Boolean(anchor.quote?.trim())
}
