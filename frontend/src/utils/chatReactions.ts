import type { Message, Reaction } from '@/types/chat'

export const SELF_REACTION_ACTOR = '__clarin_self__'

export type ReactionMutation = {
  targetMessageId: string
  senderJid?: string
  senderName?: string
  emoji: string
  isFromMe: boolean
  removed?: boolean
  id?: string
  timestamp?: string
  operationId?: string
  provider?: Reaction['provider']
}

export type PendingReactionOperation = {
  operationId: string
  sequence: number
  desiredEmoji: string
  targetMessageId: string
  previousReactions: Reaction[]
  startedAt: string
  confirmedByRealtime?: boolean
}

export type QueuedReactionOperation = Omit<PendingReactionOperation, 'previousReactions' | 'confirmedByRealtime'>

export type ReactionIntentQueue = {
  inFlight?: PendingReactionOperation
  queued?: QueuedReactionOperation
}

type EnqueueReactionIntentInput = Omit<QueuedReactionOperation, 'desiredEmoji'> & {
  desiredEmoji: string
}

type SettleReactionIntentResult = {
  reactions?: Reaction[]
  queue: ReactionIntentQueue
  nextRequest?: PendingReactionOperation
  ignored?: boolean
  rolledBack?: boolean
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
      // Prefer the newest canonical timestamp when both sides provide one;
      // otherwise array order remains the backwards-compatible tiebreaker.
      const existingTimestamp = Date.parse(deduped[existingIndex].timestamp || '')
      const candidateTimestamp = Date.parse(reaction.timestamp || '')
      if (!Number.isFinite(existingTimestamp) || !Number.isFinite(candidateTimestamp) || candidateTimestamp >= existingTimestamp) {
        deduped[existingIndex] = reaction
      }
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
    timestamp: mutation.timestamp,
    operation_id: mutation.operationId,
    provider: mutation.provider,
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

function applyOwnIntent(reactions: Reaction[], operation: Pick<PendingReactionOperation, 'targetMessageId' | 'desiredEmoji' | 'operationId' | 'startedAt'>): Reaction[] {
  return applyReactionMutation(reactions, {
    targetMessageId: operation.targetMessageId,
    senderJid: SELF_REACTION_ACTOR,
    senderName: 'Tú',
    emoji: operation.desiredEmoji,
    isFromMe: true,
    removed: operation.desiredEmoji === '',
    operationId: operation.operationId,
    timestamp: operation.startedAt,
    provider: 'whatsapp_web',
  })
}

export function enqueueReactionIntent(
  reactions: Reaction[] | undefined,
  queue: ReactionIntentQueue | undefined,
  input: EnqueueReactionIntentInput,
): { reactions: Reaction[]; queue: ReactionIntentQueue; request?: PendingReactionOperation } {
  const current = dedupeReactions(reactions)
  const nextVisible = applyOwnIntent(current, input)

  if (queue?.inFlight) {
    return {
      reactions: nextVisible,
      queue: { ...queue, queued: input },
    }
  }

  const request: PendingReactionOperation = {
    ...input,
    previousReactions: current,
  }
  return {
    reactions: nextVisible,
    queue: { inFlight: request },
    request,
  }
}

export function settleReactionIntent(
  queue: ReactionIntentQueue | undefined,
  operationId: string,
  succeeded: boolean,
  canonicalMutation?: ReactionMutation,
  preservePendingBaseline = false,
): SettleReactionIntentResult {
  const inFlight = queue?.inFlight
  if (!inFlight || inFlight.operationId !== operationId) {
    return { queue: queue || {}, ignored: true }
  }

  const confirmed = succeeded || inFlight.confirmedByRealtime === true
  const settledBase = confirmed
    ? preservePendingBaseline
      ? dedupeReactions(inFlight.previousReactions)
      : applyReactionMutation(inFlight.previousReactions, canonicalMutation || {
          targetMessageId: inFlight.targetMessageId,
          senderJid: SELF_REACTION_ACTOR,
          senderName: 'Tú',
          emoji: inFlight.desiredEmoji,
          isFromMe: true,
          removed: inFlight.desiredEmoji === '',
          operationId: inFlight.operationId,
          timestamp: inFlight.startedAt,
          provider: 'whatsapp_web',
        })
    : dedupeReactions(inFlight.previousReactions)

  if (!queue?.queued) {
    return {
      reactions: settledBase,
      queue: {},
      rolledBack: !confirmed,
    }
  }

  const settledOwnEmoji = settledBase.find(reaction => reaction.is_from_me)?.emoji || ''
  if (settledOwnEmoji === queue.queued.desiredEmoji) {
    return {
      reactions: settledBase,
      queue: {},
      rolledBack: !confirmed,
    }
  }

  const nextRequest: PendingReactionOperation = {
    ...queue.queued,
    previousReactions: settledBase,
  }
  return {
    reactions: applyOwnIntent(settledBase, nextRequest),
    queue: { inFlight: nextRequest },
    nextRequest,
    rolledBack: !confirmed,
  }
}

export function updateMessageReactionProjection(
  messages: Message[],
  targetMessageId: string,
  updater: Reaction[] | ((reactions: Reaction[] | undefined) => Reaction[]),
): Message[] {
  return messages.map(message => {
    if (message.message_id !== targetMessageId && message.id !== targetMessageId) return message
    const reactions = typeof updater === 'function' ? updater(message.reactions) : updater
    return { ...message, reactions }
  })
}

export function mergeCanonicalReactionSnapshot(
  localReactions: Reaction[] | undefined,
  canonicalReactions: Reaction[] | undefined,
  hasPendingOwnIntent: boolean,
): Reaction[] {
  // Omitted reactions mean this payload is a partial message update, not an
  // authoritative reaction snapshot. An explicit [] is canonical removal.
  if (canonicalReactions === undefined) return dedupeReactions(localReactions)
  const canonical = dedupeReactions(canonicalReactions)
  if (!hasPendingOwnIntent) return canonical

  const localOwn = dedupeReactions(localReactions).find(reaction => reaction.is_from_me)
  const withoutCanonicalOwn = canonical.filter(reaction => !reaction.is_from_me)
  return localOwn ? [...withoutCanonicalOwn, localOwn] : withoutCanonicalOwn
}

export function normalizeAuthoritativeMessageReactions(message: Message): Message {
  // Backend omits empty slices for compact JSON. Every HTTP message payload is
  // nevertheless authoritative, so omission means the canonical empty set.
  return { ...message, reactions: message.reactions ?? [] }
}

export function reconcilePendingReactionBaseline(
  queue: ReactionIntentQueue | undefined,
  canonicalReactions: Reaction[] | undefined,
): ReactionIntentQueue {
  // A missing field belongs to a partial message payload. An explicit array is
  // a complete server snapshot and must become the rollback baseline, while
  // the optimistic own reaction remains only in the rendered projection.
  if (!queue?.inFlight || canonicalReactions === undefined) return queue || {}
  return {
    ...queue,
    inFlight: {
      ...queue.inFlight,
      previousReactions: dedupeReactions(canonicalReactions),
    },
  }
}

export function applyReactionToPendingBaseline(
  queue: ReactionIntentQueue | undefined,
  mutation: ReactionMutation,
): ReactionIntentQueue {
  if (!queue?.inFlight) return queue || {}
  return {
    ...queue,
    inFlight: {
      ...queue.inFlight,
      previousReactions: applyReactionMutation(queue.inFlight.previousReactions, mutation),
    },
  }
}

export function markReactionRealtimeConfirmation(
  queue: ReactionIntentQueue | undefined,
  operationId: string | undefined,
): ReactionIntentQueue {
  if (!queue?.inFlight || !operationId || queue.inFlight.operationId !== operationId) return queue || {}
  return {
    ...queue,
    inFlight: { ...queue.inFlight, confirmedByRealtime: true },
  }
}

export function shouldApplyReactionEvent(
  lastTimestamp: string | undefined,
  eventTimestamp: string | undefined,
): boolean {
  if (!lastTimestamp || !eventTimestamp) return true
  const previous = Date.parse(lastTimestamp)
  const incoming = Date.parse(eventTimestamp)
  if (!Number.isFinite(previous) || !Number.isFinite(incoming)) return true
  return incoming >= previous
}
