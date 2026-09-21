import type {
  QuickReply,
  QuickReplyAttachment,
  QuickReplyComposerDraft,
  QuickReplyKind,
  QuickReplyRealtimePayload,
  QuickReplyItem,
} from '@/types/quick-reply'

export const QUICK_REPLY_PAGE_SIZE = 50

export type QuickReplyCommand = {
  query: string
  start: number
  end: number
}

export type QuickReplyComposerSelection = {
  body: string
  attachments: QuickReplyAttachment[]
}

const QUICK_REPLY_COMMAND_PATTERN = /(^|[\s\u00a0])\/([\p{L}\p{N}_-]*)$/u

export function compareQuickReplies(left: QuickReply, right: QuickReply) {
  const shortcutOrder = left.shortcut.localeCompare(right.shortcut, undefined, { sensitivity: 'base', numeric: true })
  return shortcutOrder || left.id.localeCompare(right.id)
}

export function sortQuickReplies(replies: QuickReply[]) {
  return [...replies].sort(compareQuickReplies)
}

export function mergeQuickReplyPages(current: QuickReply[], incoming: QuickReply[]) {
  const byID = new Map(current.map(reply => [reply.id, reply]))
  for (const reply of incoming) byID.set(reply.id, reply)
  return sortQuickReplies(Array.from(byID.values()))
}

export function extractQuickReplyCommand(text: string): QuickReplyCommand | null {
  const match = QUICK_REPLY_COMMAND_PATTERN.exec(text)
  if (!match || match.index === undefined) return null
  const prefix = match[1] || ''
  const start = match.index + prefix.length
  return { query: match[2] || '', start, end: text.length }
}

export function replaceQuickReplyCommand(text: string, replacement: string) {
  const command = extractQuickReplyCommand(text)
  if (!command) return text
  return `${text.slice(0, command.start)}${replacement}${text.slice(command.end)}`
}

export function getQuickReplyAttachments(reply: QuickReply): QuickReplyAttachment[] {
  if (Array.isArray(reply.attachments) && reply.attachments.length > 0) {
    return [...reply.attachments].sort((left, right) => left.position - right.position || (left.id || '').localeCompare(right.id || ''))
  }
  if (!reply.media_url) return []
  return [{
    id: 'legacy-media-0',
    media_url: reply.media_url,
    media_type: reply.media_type || 'document',
    media_filename: reply.media_filename || 'Archivo',
    caption: reply.body || '',
    position: 0,
  }]
}

export function buildQuickReplyComposerSelection(reply: QuickReply): QuickReplyComposerSelection {
  const canonicalAttachments = Array.isArray(reply.attachments) && reply.attachments.length > 0
  return {
    body: canonicalAttachments || !reply.media_url ? reply.body || '' : '',
    attachments: getQuickReplyAttachments(reply),
  }
}

export function createQuickReplyComposerDraft(reply: QuickReply): QuickReplyComposerDraft | null {
  const selection = buildQuickReplyComposerSelection(reply)
  const items = getQuickReplyItems(reply)
  if (reply.items?.length) return {
    replyId: reply.id, shortcut: reply.shortcut,
    items: items.map(item => ({ ...item, operationId: crypto.randomUUID() })),
    allAttachments: selection.attachments.map(item => ({ ...item })),
    attachments: selection.attachments, totalAttachments: selection.attachments.length, sentAttachments: 0,
  }
  if (selection.attachments.length === 0) return null
  return {
    replyId: reply.id,
    shortcut: reply.shortcut,
    attachments: selection.attachments.map(attachment => ({ ...attachment })),
    totalAttachments: selection.attachments.length,
    sentAttachments: 0,
  }
}

export function getQuickReplyItems(reply: Pick<QuickReply, 'items' | 'attachments' | 'body' | 'media_url' | 'media_type' | 'media_filename'>): QuickReplyItem[] {
  if (reply.items?.length) return reply.items.map(item => ({ ...item }))
  const attachments = getQuickReplyAttachments(reply as QuickReply)
  const items: QuickReplyItem[] = attachments.map((attachment, index) => ({
    id: attachment.id || `legacy-media-${index}`, type: 'media', attachment_id: attachment.id || `legacy-media-${index}`,
  }))
  const body = buildQuickReplyComposerSelection(reply as QuickReply).body
  if (body.trim()) items.push({ id: 'legacy-text', type: 'text', text: body })
  return items
}

export function moveQuickReplyItem(items: QuickReplyItem[], from: number, to: number) {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return items
  const next = [...items]
  next.splice(to, 0, next.splice(from, 1)[0])
  return next
}

export function quickReplyTextProjection(items: QuickReplyItem[]) {
  return items.filter(item => item.type === 'text').map(item => item.text || '').join('\n\n')
}

export function markQuickReplyAttachmentSent(draft: QuickReplyComposerDraft): QuickReplyComposerDraft {
  return {
    ...draft,
    attachments: draft.attachments.slice(1),
    sentAttachments: draft.sentAttachments + 1,
    error: undefined,
  }
}

export function markQuickReplyAttachmentFailed(draft: QuickReplyComposerDraft, tempId: string, error: string): QuickReplyComposerDraft {
  const [first, ...remaining] = draft.attachments
  if (!first) return { ...draft, error }
  return {
    ...draft,
    attachments: [{ ...first, sendTempId: tempId }, ...remaining],
    error,
  }
}

export function removeQuickReplyComposerAttachment(draft: QuickReplyComposerDraft, index: number): QuickReplyComposerDraft | null {
  const attachments = draft.attachments.filter((_, attachmentIndex) => attachmentIndex !== index)
  if (attachments.length === 0 && draft.sentAttachments === 0) return null
  return {
    ...draft,
    attachments,
    totalAttachments: draft.sentAttachments + attachments.length,
    error: undefined,
  }
}

export function quickReplyMatches(reply: QuickReply, query: string, kind: QuickReplyKind) {
  const attachments = getQuickReplyAttachments(reply)
  if (kind === 'text' && attachments.length > 0) return false
  if (kind === 'media' && attachments.length === 0) return false
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true
  return [reply.shortcut, reply.title, reply.body, ...attachments.map(item => item.caption)]
    .some(value => (value || '').toLocaleLowerCase().includes(normalizedQuery))
}

export function reconcileQuickReplyRealtime(
  current: QuickReply[],
  total: number,
  payload: QuickReplyRealtimePayload,
  query: string,
  kind: QuickReplyKind,
) {
  const targetID = payload.quick_reply_id || payload.quick_reply?.id
  if (!targetID) return { replies: current, total }
  const previous = current.find(reply => reply.id === targetID)
  const previousMatched = Boolean(previous && quickReplyMatches(previous, query, kind))

  if (payload.action === 'deleted') {
    const deletedDefinitelyMatched = previousMatched || (kind === 'all' && query.trim() === '')
    return {
      replies: current.filter(reply => reply.id !== targetID),
      total: deletedDefinitelyMatched ? Math.max(0, total - 1) : total,
    }
  }

  const canonical = payload.quick_reply
  if (!canonical) return { replies: current, total }
  const nextMatched = quickReplyMatches(canonical, query, kind)
  const withoutTarget = current.filter(reply => reply.id !== targetID)
  const totalDelta = payload.action === 'created'
    ? (nextMatched && !previousMatched ? 1 : 0)
    : previous
      ? (nextMatched && !previousMatched ? 1 : !nextMatched && previousMatched ? -1 : 0)
      : 0
  return {
    replies: nextMatched ? sortQuickReplies([...withoutTarget, canonical]) : withoutTarget,
    total: Math.max(0, total + totalDelta),
  }
}

export function isValidQuickReplyShortcut(shortcut: string) {
  const normalized = shortcut.trim().replace(/^\//, '')
  return normalized.length > 0
    && Array.from(normalized).length <= 100
    && /^[\p{L}\p{N}_-]+$/u.test(normalized)
}
