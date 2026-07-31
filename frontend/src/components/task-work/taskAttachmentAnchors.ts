import type { TaskAttachmentAnchor } from '@/types/task'

export function normalizedAttachmentPoint(kind: 'image' | 'pdf', rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, clientX: number, clientY: number, page?: number): TaskAttachmentAnchor {
  const clamp = (value: number) => Math.max(0, Math.min(1, value))
  return { kind, page: kind === 'pdf' ? page : undefined, x: clamp((clientX - rect.left) / Math.max(1, rect.width)), y: clamp((clientY - rect.top) / Math.max(1, rect.height)) }
}

export function textAttachmentAnchor(text: string, offset: number, quote: string): TaskAttachmentAnchor {
  const safeOffset = Math.max(0, Math.min(text.length, offset))
  return { kind: 'text', line: text.slice(0, safeOffset).split('\n').length, offset: safeOffset, quote: quote.slice(0, 500) }
}
