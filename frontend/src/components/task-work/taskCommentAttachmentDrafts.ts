import type { TaskAttachment } from '@/types/task'

export type TaskCommentAttachmentLookup = Record<string, TaskAttachment>

export function mergeCommentAttachmentDrafts(current: TaskCommentAttachmentLookup, incoming: TaskAttachment[]) {
  if (!incoming.length) return current
  return { ...current, ...Object.fromEntries(incoming.map(file => [file.id, file])) }
}

export function removeCommentAttachmentDrafts(current: TaskCommentAttachmentLookup, ids: string[]) {
  if (!ids.some(id => current[id])) return current
  const next = { ...current }
  ids.forEach(id => { delete next[id] })
  return next
}

export function resolveCommentAttachment(
  id: string,
  drafts: TaskCommentAttachmentLookup,
  taskAttachments: TaskAttachment[],
) {
  return drafts[id] || taskAttachments.find(file => file.id === id)
}
