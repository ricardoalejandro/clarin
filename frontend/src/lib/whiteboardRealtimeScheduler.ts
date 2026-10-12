export const WHITEBOARD_REALTIME_EPHEMERAL_INTERVAL_MS = 50
export const WHITEBOARD_REALTIME_CONTROL_INTERVAL_MS = 1_000

/** One latest value and one deadline per socket channel, including overdue timers. */
export function createWhiteboardRealtimeScheduler<T>(input: {
  intervalMS: number
  send: (value: T) => boolean
  merge?: (previous: T, next: T) => T
  now?: () => number
}) {
  const now = input.now || (() => performance.now())
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let pending: T | undefined
  let latest: T | undefined
  let lastSentAt = Number.NEGATIVE_INFINITY
  let blockedUntil = Number.NEGATIVE_INFINITY
  let closed = false

  const cancelTimer = () => {
    generation += 1
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const flush = (): void => {
    cancelTimer()
    if (closed || pending === undefined) return
    const remaining = Math.max(lastSentAt + input.intervalMS, blockedUntil) - now()
    if (remaining > 0) {
      const scheduledGeneration = generation
      timer = setTimeout(() => {
        if (scheduledGeneration === generation) flush()
      }, Math.ceil(remaining))
      return
    }
    const value = pending
    pending = undefined
    if (input.send(value)) lastSentAt = now()
  }

  const reset = () => {
    cancelTimer()
    pending = undefined
    latest = undefined
    lastSentAt = Number.NEGATIVE_INFINITY
    blockedUntil = Number.NEGATIVE_INFINITY
  }

  return {
    enqueue(value: T) {
      if (closed) return false
      pending = pending !== undefined && input.merge ? input.merge(pending, value) : value
      latest = pending
      flush()
      return true
    },
    defer(retryAfterMS: number) {
      if (closed) return
      blockedUntil = Math.max(blockedUntil, now() + retryAfterMS)
      // The server may have rejected the final position after the pointer stopped.
      pending ??= latest
      flush()
    },
    reset,
    close() {
      closed = true
      reset()
    },
  }
}
