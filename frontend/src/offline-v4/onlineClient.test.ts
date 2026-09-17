// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from 'jose'
import { BrowserOnlineClient, wireSigningKey, limitUTF8, normalizeSelection, batchSyncOperations, syncRequestBody, SYNC_BODY_BUDGET_BYTES, SYNC_BATCH_OPERATIONS } from './onlineClient'
import { createSigningKey, sha256Hex } from './crypto'
import type { BrowserProfile, GrantIdentity, Operation } from './types'

const origin = 'https://clarin.test'
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' } }) }
describe('browser-only API boundary', () => {
  it('retains the global WebIDL fetch receiver when using the default browser transport', async () => {
    const nativeFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(response({ enabled: true }))
    })
    try {
      await expect(new BrowserOnlineClient(origin).request('/api/offline/v4/runtime/availability')).resolves.toEqual({ enabled: true })
      expect(nativeFetch).toHaveBeenCalledOnce()
    } finally { nativeFetch.mockRestore() }
  })
  it('uses cookies for online enrollment but omits all online credentials during proof sync', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({ ok: true })), api = new BrowserOnlineClient(origin, fetcher)
    await api.request('/api/offline/v4/grants', undefined, { token: 'cookie-session' })
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'include', cache: 'no-store', redirect: 'error' })
    expect((fetcher.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty('Authorization')
    await api.request('/api/offline/v4/sync', { grant_id: 'grant' }, { headers: { 'X-Clarin-Browser-Proof': 'proof' } })
    expect(fetcher.mock.calls[1][1]).toMatchObject({ credentials: 'omit', cache: 'no-store' })
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('cookie-session')
  })
  it('does not treat Cloudflare HTML as an authenticated response and preserves real authorization denials', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('<html>Challenge</html>', { status: 403, headers: { 'Content-Type': 'text/html' } })), api = new BrowserOnlineClient(origin, fetcher)
    await expect(api.request('/api/offline/v4/sync', {})).rejects.toMatchObject({ status: 403, infrastructure: true })
    fetcher.mockResolvedValue(response({ error: 'offline_access_denied' }, 403))
    await expect(api.request('/api/offline/v4/sync', {})).rejects.toMatchObject({ status: 403, code: 'offline_access_denied', infrastructure: false })
  })
  it('binds both signatures to exact request bytes, origin, nonce, grant, method and path', async () => {
    const profileKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']), grantKeys = await createSigningKey()
    const profile: BrowserProfile = { browser_id: crypto.randomUUID(), private_key: profileKeys.privateKey, public_jwk: await crypto.subtle.exportKey('jwk', profileKeys.publicKey) as BrowserProfile['public_jwk'], created_at: new Date().toISOString() }
    const api = new BrowserOnlineClient(origin), body = { text: '<á & 日本語>', count: 1 }, path = '/api/offline/v4/sync', nonce = { challenge_id: crypto.randomUUID(), nonce: 'nonce', expires_at: new Date(Date.now() + 120000).toISOString() }, grantID = crypto.randomUUID()
    const proofs = await api.proof(profile, grantKeys.private_jwk, 'sync', path, body, nonce, grantID)
    const claims = decodeJwt(proofs['X-Clarin-Browser-Proof'])
    expect(claims).toMatchObject({ version: 4, purpose: 'sync', path, method: 'POST', aud: origin, browser_profile_id: profile.browser_id, grant_id: grantID, nonce: nonce.nonce, body_sha256: await sha256Hex(JSON.stringify(body)) })
    expect(Number(claims.exp) - Number(claims.iat)).toBe(120)
    expect(decodeProtectedHeader(proofs['X-Clarin-Browser-Proof'])).toEqual({ alg: 'ES256', typ: 'clarin-offline-v4-proof+jwt' })
    await expect(jwtVerify(proofs['X-Clarin-Browser-Proof'], profileKeys.publicKey, { audience: origin })).resolves.toBeDefined()
    await expect(jwtVerify(proofs['X-Clarin-Grant-Proof'], await importJWK(grantKeys.public_jwk, 'ES256'), { audience: origin })).resolves.toBeDefined()
    expect(decodeJwt(proofs['X-Clarin-Grant-Proof']).jti).not.toBe(claims.jti)
  })
  it('publishes only the strict public JWK contract, never private or optional implementation fields', async () => {
    const keys = await createSigningKey(), result = wireSigningKey({ ...keys.public_jwk, ext: true, key_ops: ['verify'] }, 'grant-id')
    expect(Object.keys(result).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y'])
    expect(() => wireSigningKey(keys.private_jwk, 'grant-id')).toThrow()
  })
  it('normalizes the selection_id wire contract and rejects conflicting aliases or foreign grants', async () => {
    const selected = { selection_id: 'selection-a', grant_id: 'grant-a', resource_id: 'list-a', resource_type: 'task_list', module: 'tasks' as const, head_version: 2 }
    expect(normalizeSelection(selected, 'grant-a')).toMatchObject({ selection_id: 'selection-a', readiness: 'preparing', byte_size: 0 })
    expect(normalizeSelection({ ...selected, selection_id: undefined, id: 'selection-a' }, 'grant-a').selection_id).toBe('selection-a')
    expect(() => normalizeSelection({ ...selected, id: 'selection-b' }, 'grant-a')).toThrow()
    expect(() => normalizeSelection(selected, 'grant-b')).toThrow()
    const fetcher = vi.fn<typeof fetch>(async () => response({ items: [selected], selection_revision: 2 }))
    expect((await new BrowserOnlineClient(origin, fetcher).selection('grant-a', 'cookie-session')).items[0].selection_id).toBe('selection-a')
  })
  it('honors backend byte limits for Unicode browser labels without cutting a code point', () => {
    expect(new TextEncoder().encode(limitUTF8('á'.repeat(100), 80))).toHaveLength(80)
    expect(limitUTF8('á'.repeat(100), 80)).toHaveLength(40)
    expect(limitUTF8('😀'.repeat(100), 81)).toHaveLength(40)
    expect(new TextEncoder().encode(limitUTF8('日本語'.repeat(100), 160)).length).toBeLessThanOrEqual(160)
  })
})

describe('bounded exact UTF-8 sync batches', () => {
  const browserID = '00000000-0000-4000-8000-000000000001', grantID = '00000000-0000-4000-8000-000000000002'
  const challenge = { challenge_id: '00000000-0000-4000-8000-000000000003', nonce: 'N'.repeat(43), expires_at: new Date().toISOString() }
  const operation = (description: string): Operation => ({ protocol_version: 4, browser_id: browserID, grant_id: grantID, user_id: crypto.randomUUID(), account_id: crypto.randomUUID(), operation_id: crypto.randomUUID(), action: 'tasks.create', selection_id: crypto.randomUUID(), resource_id: crypto.randomUUID(), selection_revision: 1, credential_epoch: 1, authority_epoch: 1, base_version: 0, payload: { title: 'Tarea', description }, occurred_at: new Date().toISOString() })
  const body = (operations: Operation[]) => syncRequestBody(browserID, grantID, 1, operations, [], challenge)
  const size = (operations: Operation[]) => new TextEncoder().encode(JSON.stringify(body(operations))).byteLength
  it.each([
    ['ASCII', 'A'.repeat(200000)],
    ['Unicode', '😀日本語á'.repeat(13333)],
    ['JSON escaping', '\n'.repeat(200000)],
  ])('splits long %s payloads by complete wire bytes without rewriting or dropping operations', (_label, description) => {
    const operations = Array.from({ length: 12 }, () => operation(description))
    expect(size(operations)).toBeGreaterThan(2 * 1024 * 1024)
    const batches = batchSyncOperations(browserID, grantID, 1, operations)
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat()).toEqual(operations)
    expect(batches.flat().every((item, index) => item === operations[index])).toBe(true)
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(SYNC_BATCH_OPERATIONS)
      expect(size(batch)).toBeLessThanOrEqual(SYNC_BODY_BUDGET_BYTES)
      expect(body(batch).operations.every(item => item.browser_profile_id === browserID && !('browser_id' in item))).toBe(true)
    }
    expect(batchSyncOperations(browserID, grantID, 1, operations)).toEqual(batches)
  })
  it('keeps the operation-count limit and one authority sync for an empty queue', () => {
    const operations = Array.from({ length: 101 }, () => operation('small'))
    expect(batchSyncOperations(browserID, grantID, 1, operations).map(batch => batch.length)).toEqual([50, 50, 1])
    expect(batchSyncOperations(browserID, grantID, 1, [])).toEqual([[]])
  })
  it('counts the full envelope at the exact byte boundary and rejects a single oversized item before upload', () => {
    const exact = operation(''), padding = SYNC_BODY_BUDGET_BYTES - size([exact])
    exact.payload = { title: 'Tarea', description: 'X'.repeat(padding) }
    expect(size([exact])).toBe(SYNC_BODY_BUDGET_BYTES)
    expect(batchSyncOperations(browserID, grantID, 1, [exact])).toEqual([[exact]])
    expect(batchSyncOperations(browserID, grantID, 1, [exact, operation('')])).toHaveLength(2)
    const oversized = { ...exact, payload: { title: 'Tarea', description: 'X'.repeat(padding + 1) } }
    expect(() => batchSyncOperations(browserID, grantID, 1, [operation(''), oversized])).toThrowError(expect.objectContaining({ code: 'operation_too_large' }))
    expect((oversized.payload as { description: string }).description).toHaveLength(padding + 1)
  })
  it('checks the actual challenge envelope before signing or transmitting an oversized request', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(challenge)), api = new BrowserOnlineClient(origin, fetcher)
    const proof = vi.spyOn(api, 'proof')
    await expect(api.sync({ browser_id: browserID } as BrowserProfile, { grant_id: grantID } as GrantIdentity, { kty: 'EC' }, 1, [operation('😀'.repeat(600000))], [])).rejects.toMatchObject({ code: 'sync_request_too_large' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(String(fetcher.mock.calls[0][0])).toMatch(/\/sync\/challenge$/)
    expect(proof).not.toHaveBeenCalled()
  })
})
