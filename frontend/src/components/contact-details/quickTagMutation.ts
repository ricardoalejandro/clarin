import type { ContactProfileAvailableTag } from '@/types/contact-profile'

export type QuickTagMutationSnapshot = {
  previous: ContactProfileAvailableTag[]
  next: ContactProfileAvailableTag[]
  pendingId: string
}

export function beginQuickTagMutation(
  previous: ContactProfileAvailableTag[],
  next: ContactProfileAvailableTag[],
): QuickTagMutationSnapshot {
  const previousIds = new Set(previous.map(tag => tag.id))
  const nextIds = new Set(next.map(tag => tag.id))
  const changed = next.find(tag => !previousIds.has(tag.id)) || previous.find(tag => !nextIds.has(tag.id))
  return { previous, next, pendingId: changed?.id || '__all__' }
}

export function rollbackQuickTagMutation(snapshot: QuickTagMutationSnapshot) {
  return { tags: snapshot.previous, retry: snapshot.next }
}

export function reconcileQuickTagMutation(
  snapshot: QuickTagMutationSnapshot,
  canonical?: ContactProfileAvailableTag[] | null,
) {
  return canonical || snapshot.next
}
