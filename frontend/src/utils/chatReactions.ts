import { Reaction } from '@/types/chat'

export const SELF_REACTION_ACTOR = '__clarin_self__'

type ReactionMutation = {
  targetMessageId: string
  senderJid?: string
  senderName?: string
  emoji: string
  isFromMe: boolean
  removed?: boolean
  id?: string
}

export function getReactionActorKey(reaction: Pick<Reaction, 'id' | 'sender_jid' | 'sender_name' | 'emoji' | 'is_from_me'>): string {
  if (reaction.is_from_me) return SELF_REACTION_ACTOR
  if (reaction.sender_jid) return `jid:${reaction.sender_jid}`
  if (reaction.sender_name) return `name:${reaction.sender_name}`
  return `unknown:${reaction.id || reaction.emoji}`
}

export function dedupeReactions(reactions: Reaction[] = []): Reaction[] {
  const deduped: Reaction[] = []
  const actorIndexes = new Map<string, number>()

  for (const reaction of reactions) {
    const actorKey = getReactionActorKey(reaction)
    const existingIndex = actorIndexes.get(actorKey)
    if (existingIndex === undefined) {
      actorIndexes.set(actorKey, deduped.length)
      deduped.push(reaction)
    } else {
      // The latest event for an actor is authoritative.
      deduped[existingIndex] = reaction
    }
  }

  return deduped
}

export function applyReactionMutation(reactions: Reaction[] | undefined, mutation: ReactionMutation): Reaction[] {
  const current = dedupeReactions(reactions)
  const actorKey = mutation.isFromMe
    ? SELF_REACTION_ACTOR
    : getReactionActorKey({
        id: mutation.id || '',
        sender_jid: mutation.senderJid || '',
        sender_name: mutation.senderName,
        emoji: mutation.emoji,
        is_from_me: false,
      })
  const firstActorIndex = current.findIndex(reaction => getReactionActorKey(reaction) === actorKey)
  const withoutActor = current.filter(reaction => getReactionActorKey(reaction) !== actorKey)

  if (mutation.removed || !mutation.emoji) return withoutActor

  const nextReaction: Reaction = {
    id: mutation.id || '',
    target_message_id: mutation.targetMessageId,
    sender_jid: mutation.senderJid || (mutation.isFromMe ? SELF_REACTION_ACTOR : ''),
    sender_name: mutation.senderName,
    emoji: mutation.emoji,
    is_from_me: mutation.isFromMe,
  }

  if (firstActorIndex >= 0) {
    withoutActor.splice(Math.min(firstActorIndex, withoutActor.length), 0, nextReaction)
    return withoutActor
  }

  return [...withoutActor, nextReaction]
}

export function hasOwnReaction(reactions: Reaction[] | undefined, emoji: string): boolean {
  return dedupeReactions(reactions).some(reaction => reaction.is_from_me && reaction.emoji === emoji)
}
