import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentSyncIntakeKey, grantBootstrap, localGrantLeaseActivationBundle, onlineGrants } from './onlineClient'

afterEach(() => vi.restoreAllMocks())

describe('offline v3 authenticated API client', () => {
  it('rejects an HTML/Cloudflare response even when its status is successful', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>challenge</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }))

    await expect(onlineGrants()).rejects.toMatchObject({
      code: 'untrusted_server_response',
      infrastructure: true,
    })
  })

  it('selects only the advertised P-256 sync intake key', async () => {
    const selected = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', use: 'enc', alg: 'ECDH-ES+A256KW', kid: 'intake-v3' }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      keys: [{ ...selected, kid: 'old' }, selected],
      key_id: 'intake-v3',
      key_version: 3,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' },
    }))

    await expect(currentSyncIntakeKey()).resolves.toEqual(selected)
  })

  it('fails closed when the advertised intake key is not an encryption key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', use: 'sig', alg: 'ES256', kid: 'wrong' }],
      key_id: 'wrong',
      key_version: 3,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' },
    }))

    await expect(currentSyncIntakeKey()).rejects.toMatchObject({ code: 'invalid_sync_intake_key' })
  })

  it('reauthenticates the current password before issuing a local bootstrap', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      grant_bootstrap: 'signed.bootstrap', expires_at: '2026-09-14T01:00:00Z', grant: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' } }))

    await grantBootstrap('11111111-1111-4111-8111-111111111111', 'ricardo', 'same-current-password')

    expect(fetchSpy).toHaveBeenCalledWith('/api/offline/v3/grants/11111111-1111-4111-8111-111111111111/bootstrap', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ login: 'ricardo', password: 'same-current-password' }),
      cache: 'no-store',
    }))
  })

  it('strips server-only lease metadata before calling the strict local bridge', () => {
    const local = localGrantLeaseActivationBundle({
      lease: 'lease.jwt',
      service_descriptor: 'descriptor.jwt',
      signer_public_keys: { keys: [], key_version: 3 },
      selections: [],
      server_time: '2026-09-14T00:00:00Z',
      expires_at: '2026-09-17T00:00:00Z',
      lease_expires_at: '2026-09-17T00:00:00Z',
      selection_revision: 4,
      selection_digest: 'a'.repeat(64),
      grant: { display_user: 'Ricardo', account_name: 'Cuenta piloto' } as never,
    })

    expect(local).toMatchObject({ display_user: 'Ricardo', display_account: 'Cuenta piloto' })
    expect(Object.keys(local).sort()).toEqual(['display_account', 'display_user', 'lease', 'selections', 'server_time', 'service_descriptor', 'signer_public_keys'])
  })
})
