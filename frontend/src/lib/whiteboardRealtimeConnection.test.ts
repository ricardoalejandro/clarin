import { describe, expect, it } from 'vitest'
import {
  WhiteboardCollabTicketError,
  classifyWhiteboardCollabTicketFailure,
  whiteboardEffectiveAccessAtLevel,
  whiteboardGuestAccessAtLevel,
  whiteboardPermissionChangeFeedback,
  whiteboardRealtimeAccessLevel,
  whiteboardCollabTicketError,
  whiteboardRealtimeConnectionNotice,
  whiteboardRealtimeIssueAfterAccessRevalidation,
  whiteboardRealtimeIssueFromEvent,
  whiteboardRealtimeIssueFromUnknown,
} from './whiteboardRealtimeConnection'

describe('whiteboard realtime authorization', () => {
  it('separates a member session expiry from a canonical revocation', () => {
    expect(classifyWhiteboardCollabTicketFailure({ audience: 'member', status: 401 })).toMatchObject({
      kind: 'session_expired',
      retryable: false,
    })
    expect(classifyWhiteboardCollabTicketFailure({ audience: 'member', status: 403 })).toMatchObject({
      kind: 'access_revoked',
      retryable: false,
    })
    expect(classifyWhiteboardCollabTicketFailure({ audience: 'member', status: 404 })).toMatchObject({
      kind: 'access_revoked',
      retryable: false,
    })
  })

  it('treats infrastructure and network ticket failures as recoverable', () => {
    expect(classifyWhiteboardCollabTicketFailure({ audience: 'member', status: 503 })).toMatchObject({
      kind: 'authorization_unavailable',
      retryable: true,
    })
    expect(whiteboardRealtimeIssueFromUnknown(new TypeError('Failed to fetch'))).toMatchObject({
      kind: 'authorization_unavailable',
      retryable: true,
    })
  })

  it('keeps guest expiry local to the shared session', () => {
    expect(classifyWhiteboardCollabTicketFailure({ audience: 'guest', status: 401 })).toMatchObject({
      kind: 'access_revoked',
      retryable: false,
    })
    expect(whiteboardRealtimeIssueFromEvent({ event: 'error', code: 'session_expired' }, 'guest')).toMatchObject({
      kind: 'access_revoked',
      retryable: false,
    })
  })

  it('classifies only explicit realtime authorization outcomes', () => {
    expect(whiteboardRealtimeIssueFromEvent({ event: 'access.revoked' }, 'member')).toMatchObject({
      kind: 'access_revoked',
      retryable: false,
    })
    expect(whiteboardRealtimeIssueFromEvent({ event: 'access.revoked', code: 'work_access_changed' }, 'member')).toBeNull()
    expect(whiteboardRealtimeIssueFromEvent({ event: 'error', code: 'authorization_unavailable' }, 'member')).toMatchObject({
      kind: 'authorization_unavailable',
      retryable: true,
    })
    expect(whiteboardRealtimeIssueFromEvent({ event: 'error', code: 'presence_unavailable' }, 'member')).toMatchObject({
      kind: 'authorization_unavailable',
      retryable: true,
    })
    expect(whiteboardRealtimeIssueFromEvent({ event: 'error', code: 'permission_changed' }, 'member')).toBeNull()
    expect(whiteboardRealtimeIssueFromEvent({ event: 'error', code: 'whiteboard_internal_error' }, 'member')).toBeNull()
  })

  it('preserves typed ticket details for the connection manager', () => {
    const error = whiteboardCollabTicketError({
      audience: 'member',
      status: 503,
      code: 'authorization_unavailable',
      message: 'Autorización temporalmente no disponible',
    })
    expect(error).toBeInstanceOf(WhiteboardCollabTicketError)
    expect(error).toMatchObject({ status: 503, code: 'authorization_unavailable' })
    expect(error.issue).toMatchObject({ kind: 'authorization_unavailable', retryable: true })
  })

  it('shows a non-blocking notice only after a room was open or an explicit issue exists', () => {
    expect(whiteboardRealtimeConnectionNotice({ connection: 'connecting', hasOpened: false, issue: null })).toBeNull()
    expect(whiteboardRealtimeConnectionNotice({ connection: 'closed', hasOpened: true, issue: null })).toMatchObject({
      busy: false,
      warning: true,
    })
    expect(whiteboardRealtimeConnectionNotice({
      connection: 'connecting',
      hasOpened: false,
      issue: { kind: 'authorization_unavailable', message: 'Temporal', retryable: true },
    })).toEqual({
      message: 'Temporal Tus cambios permanecen en pantalla.',
      busy: true,
      warning: true,
    })
    expect(whiteboardRealtimeConnectionNotice({
      connection: 'open',
      hasOpened: true,
      issue: null,
    })).toBeNull()
  })

  it('keeps pending edits visible when edit permission is downgraded', () => {
    expect(whiteboardPermissionChangeFeedback({ canEdit: false, hasPendingChanges: true, online: true })).toEqual({
      notice: 'Tu permiso cambió a solo lectura. Tus cambios locales permanecen en pantalla, pero no pueden guardarse mientras no recuperes edición.',
      saveState: 'error',
    })
    expect(whiteboardPermissionChangeFeedback({ canEdit: true, hasPendingChanges: true, online: true })).toEqual({
      notice: null,
      saveState: 'pending',
    })
  })

  it('applies the permission_changed access payload before REST reconciliation', () => {
    expect(whiteboardRealtimeAccessLevel({ access: 'comment' })).toBe('comment')
    expect(whiteboardRealtimeAccessLevel({ access: 'owner' })).toBeNull()
    expect(whiteboardEffectiveAccessAtLevel({
      level: 'manage',
      can_view: true,
      can_comment: true,
      can_edit: true,
      can_manage_access: true,
      can_delete: true,
    }, 'comment')).toMatchObject({
      level: 'comment',
      can_view: true,
      can_comment: true,
      can_edit: false,
      can_manage_access: false,
      can_delete: false,
    })
    expect(whiteboardGuestAccessAtLevel('comment')).toBe('view')
    expect(whiteboardGuestAccessAtLevel('edit')).toBe('edit')
  })
  it.each(['member', 'guest'] as const)('treats %s throttling as recoverable and bounds legacy metadata', audience => {
    const issue = whiteboardRealtimeIssueFromEvent({ event: 'error', code: 'rate_limited', data: { event: 'cursor.update', scope: 'connection', retry_after_ms: 125.2 } }, audience)
    expect(issue).toMatchObject({ kind: 'rate_limited', retryable: true, rateLimit: { event: 'cursor.update', scope: 'connection', retry_after_ms: 126 } })
    expect(whiteboardRealtimeConnectionNotice({ connection: 'open', hasOpened: true, issue })).toMatchObject({ busy: true, warning: true })
    expect(whiteboardRealtimeIssueFromEvent({ event: 'error', code: 'rate_limited' }, audience)?.rateLimit?.retry_after_ms).toBe(1_000)
    expect(whiteboardRealtimeIssueFromEvent({ event: 'error', code: 'rate_limited', data: { retry_after_ms: Infinity } }, audience)?.rateLimit?.retry_after_ms).toBe(1_000)
  })

  it('does not treat permission metadata revalidation as rate recovery', () => {
    const rate = whiteboardRealtimeIssueFromEvent({ event: 'error', code: 'rate_limited' }, 'member')
    expect(whiteboardRealtimeIssueAfterAccessRevalidation(rate)).toBe(rate)
    expect(whiteboardRealtimeIssueAfterAccessRevalidation({ kind: 'authorization_unavailable', message: 'Temporal', retryable: true })).toBeNull()
    expect(whiteboardRealtimeIssueAfterAccessRevalidation(null)).toBeNull()
  })

})
