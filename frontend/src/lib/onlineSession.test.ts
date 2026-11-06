import { describe, expect, it } from 'vitest'
import { parseOnlineSession, sessionDeadline } from './onlineSession'

const session = {
  scope: 'opaque', account_id: 'account', idle_timeout_minutes: 10,
  server_now: '2026-11-05T09:00:00Z', idle_expires_at: '2026-11-05T09:10:00Z', absolute_expires_at: '2026-11-06T09:00:00Z',
}

describe('online session deadline', () => {
  it('projects the server deadline onto the local clock', () => {
    expect(parseOnlineSession(session)).toEqual(session)
    expect(sessionDeadline(session, 30_000)).toEqual({ at: 630_000, reason: 'idle' })
    expect(sessionDeadline({ ...session, absolute_expires_at: '2026-11-05T09:01:00Z' }, 30_000)).toEqual({ at: 90_000, reason: 'expired' })
  })

  it('rejects incomplete and invalid snapshots', () => {
    expect(parseOnlineSession({ ...session, idle_timeout_minutes: 4 })).toBeNull()
    expect(parseOnlineSession({ ...session, idle_expires_at: 'invalid' })).toBeNull()
    expect(parseOnlineSession({ ...session, scope: '' })).toBeNull()
  })
})
