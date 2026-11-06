export interface OnlineSession {
  scope: string
  account_id: string
  idle_timeout_minutes: number
  server_now: string
  idle_expires_at: string
  absolute_expires_at: string
}

export function parseOnlineSession(value: unknown): OnlineSession | null {
  if (!value || typeof value !== 'object') return null
  const session = value as Partial<OnlineSession>
  if (typeof session.scope !== 'string' || !session.scope || typeof session.account_id !== 'string' || !session.account_id) return null
  if (typeof session.idle_timeout_minutes !== 'number' || !Number.isInteger(session.idle_timeout_minutes) || session.idle_timeout_minutes < 5 || session.idle_timeout_minutes > 1440) return null
  const timestamps = [session.server_now, session.idle_expires_at, session.absolute_expires_at]
  if (timestamps.some(timestamp => typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)))) return null
  return session as OnlineSession
}

export function sessionDeadline(session: OnlineSession, receivedAt: number) {
  const idle = Date.parse(session.idle_expires_at)
  const absolute = Date.parse(session.absolute_expires_at)
  return {
    at: receivedAt + Math.min(idle, absolute) - Date.parse(session.server_now),
    reason: idle < absolute ? 'idle' as const : 'expired' as const,
  }
}
