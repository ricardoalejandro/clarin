import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  approveRequestV5,
  OfflineAPIErrorV5,
  offlineRequestV5,
  offlineV5ApprovalConflict,
  offlineV5FailureAllowsFallback,
  offlineV5RequestIsPending,
  replaceSelectionV5,
  revokeGrantV5,
} from './online'

function response(body: unknown, status = 200, trusted = true) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(trusted ? { 'X-Clarin-Response': '1' } : {}),
    },
  })
}

afterEach(() => vi.restoreAllMocks())

describe('Offline v5 online administration client', () => {
  it('sends module authorization instead of legacy read/write claims', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ grants: [] }))
    await approveRequestV5('request/unsafe', [{ account_id: 'account-a', modules: ['tasks', 'contacts'], max_resources: 20, quota_bytes: 5 * 1024 ** 3 }])
    expect(request).toHaveBeenCalledWith('/api/admin/offline-v5/enrollment-requests/request%2Funsafe/approve', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ accounts: [{ account_id: 'account-a', modules: ['tasks', 'contacts'], max_resources: 20, quota_bytes: 5 * 1024 ** 3 }] }),
    }))
  })

  it('preserves exact resource identity and optimistic selection revision', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ items: [], selection_revision: 2 }))
    await replaceSelectionV5('grant-a', 1, [{ module: 'whiteboards', resource_type: 'whiteboard', resource_id: 'board-a', label: 'ignored label' }])
    expect(request).toHaveBeenCalledWith('/api/offline/v5/grants/grant-a/selection', expect.objectContaining({
      body: JSON.stringify({ selection_revision: 1, items: [{ module: 'whiteboards', resource_type: 'whiteboard', resource_id: 'board-a' }] }),
    }))
  })

  it('revokes only the exact grant and rejects untrusted proxy responses', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ revoked_count: 1 }))
    await revokeGrantV5('grant-a')
    expect(request.mock.calls[0]?.[0]).toBe('/api/admin/offline-v5/grants/grant-a/revoke')
    request.mockResolvedValueOnce(response({ success: true }, 200, false))
    await expect(offlineRequestV5('/api/offline/v5/grants')).rejects.toMatchObject({ code: 'untrusted_response' })
  })

  it('offers fallback only for infrastructure failures, never trusted authentication denials', () => {
    expect(offlineV5FailureAllowsFallback(new OfflineAPIErrorV5(0, 'network_unavailable', 'offline'))).toBe(true)
    expect(offlineV5FailureAllowsFallback(new OfflineAPIErrorV5(502, 'http_502', 'gateway'))).toBe(true)
    expect(offlineV5FailureAllowsFallback(new OfflineAPIErrorV5(403, 'forbidden', 'denied'))).toBe(false)
    expect(offlineV5FailureAllowsFallback(new OfflineAPIErrorV5(401, 'unauthorized', 'denied'))).toBe(false)
  })

  it('classifies approval conflicts and reconciles only while the exact request remains pending', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ error: 'offline_state_conflict' }, 409))
    const failure = await approveRequestV5('request-a', [{
      account_id: 'account-a', modules: ['contacts'], max_resources: 20, quota_bytes: 5 * 1024 ** 3,
    }]).catch(error => error)

    expect(failure).toMatchObject({ status: 409, code: 'offline_state_conflict' })
    expect(failure.message).toContain('actualizará el estado')
    expect(offlineV5ApprovalConflict(failure)).toBe(true)
    expect(offlineV5ApprovalConflict(new OfflineAPIErrorV5(409, 'offline_replay_rejected', 'replay'))).toBe(false)
    expect(offlineV5RequestIsPending([{ id: 'request-a', browser_profile_id: 'profile-a', user_id: 'user-a', state: 'requested' }], 'request-a')).toBe(true)
    expect(offlineV5RequestIsPending([{ id: 'request-a', browser_profile_id: 'profile-a', user_id: 'user-a', state: 'approved' }], 'request-a')).toBe(false)
    expect(offlineV5RequestIsPending([{ id: 'request-b', browser_profile_id: 'profile-a', user_id: 'user-a', state: 'requested' }], 'request-a')).toBe(false)
  })
})
