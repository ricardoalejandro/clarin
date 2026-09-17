// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { OfflineV5APIError, OfflineV5OnlineClient, offlineV5RequestMessage, offlineV5SelectionInput, type OfflineV5Challenge, type OfflineV5ServerGrant } from './onlineClient'
import { sha256HexBytes } from './crypto'
import { offlineV5WhiteboardAssetDescriptors } from './manifest'
import type { OfflineV5PrepareBundle, OfflineV5Snapshot } from './types'
import type { BrowserProfile } from '../offline-v4/types'

const challenge: OfflineV5Challenge = { challenge_id: 'challenge', nonce: 'nonce', expires_at: '2026-09-15T00:01:00Z' }
const profile = { browser_id: 'browser', private_key: { kty: 'EC' }, public_jwk: { kty: 'EC' }, created_at: '2026-09-15T00:00:00Z' } as unknown as BrowserProfile
const grant: OfflineV5ServerGrant = { grant_id: 'grant', browser_profile_id: 'browser', user_id: 'user', account_id: 'account', username: 'ada', account_name: 'Cuenta', state: 'approved', selection_revision: 1 }

describe('Offline v5 online request deadlines', () => {
  it('gives full snapshot preparation up to 180 seconds', async () => {
    const client = new OfflineV5OnlineClient('https://clarin.test')
    const calls: Array<{ path: string; options?: { timeoutMs?: number } }> = []
    vi.spyOn(client, 'proof').mockResolvedValue({})
    vi.spyOn(client, 'request').mockImplementation(async (path, _body, options) => {
      calls.push({ path, options })
      return (path.endsWith('/challenge') ? challenge : { manifest: {} }) as never
    })
    await client.prepare(profile, grant, { kty: 'EC' })
    expect(calls.at(-1)).toMatchObject({ path: '/api/offline/v5/grants/grant/prepare', options: { timeoutMs: 180_000 } })
  })

  it('keeps the challenge short but allows a sync response up to 120 seconds', async () => {
    const client = new OfflineV5OnlineClient('https://clarin.test')
    const calls: Array<{ path: string; options?: { timeoutMs?: number } }> = []
    vi.spyOn(client, 'proof').mockResolvedValue({})
    vi.spyOn(client, 'request').mockImplementation(async (path, _body, options) => {
      calls.push({ path, options })
      return (path.endsWith('/challenge') ? challenge : { receipts: [] }) as never
    })
    await client.sync(profile, { kty: 'EC' }, { grant_id: 'grant', browser_profile_id: 'browser', manifest_id: 'manifest', manifest_revision: 1, selection_revision: 1, operations: [], want_snapshots: [] })
    expect(calls[0].options?.timeoutMs).toBeUndefined()
    expect(calls[1]).toMatchObject({ path: '/api/offline/v5/sync', options: { timeoutMs: 120_000 } })
  })
})

describe('Offline v5 network contract', () => {
  it('checks only caller-supplied local grant IDs with a browser-profile proof', async () => {
    const client = new OfflineV5OnlineClient('https://clarin.test')
    const proof = vi.spyOn(client, 'proof').mockResolvedValue({ 'X-Clarin-Browser-Proof': 'signed' })
    const request = vi.spyOn(client, 'request').mockResolvedValue({ active_grant_ids: ['grant-a'] })

    await expect(client.activeLocalGrants(profile, ['grant-a', 'grant-b'])).resolves.toEqual(['grant-a'])
    expect(request).toHaveBeenCalledWith(
      '/api/offline/v5/grants/status',
      expect.objectContaining({ browser_profile_id: 'browser', grant_ids: ['grant-a', 'grant-b'] }),
      { timeoutMs: 3_000, headers: { 'X-Clarin-Browser-Proof': 'signed' } },
    )
    expect(proof).toHaveBeenCalledWith(profile, undefined, 'status', '/api/offline/v5/grants/status', expect.anything(), expect.objectContaining({ nonce: expect.any(String) }))

    request.mockResolvedValueOnce({ active_grant_ids: ['not-requested'] })
    await expect(client.activeLocalGrants(profile, ['grant-a'])).rejects.toMatchObject({ code: 'invalid_grant_status' })
  })

  it('accepts a signed image above the legacy 10 MB cap', () => {
    const snapshot = {
      protocol_version: 5, manifest_id: 'manifest', manifest_revision: 1, selection_id: 'selection-board', root_selection_id: 'selection-board', root_resource_id: 'board-a',
      module: 'whiteboards', resource_type: 'whiteboard', resource_id: 'board-a', dependency: false, head_version: 1, content_hash: 'a'.repeat(64), payload_json: '{}', tombstone: false, generated_at: '2026-09-15T00:00:00Z',
      payload: { asset_transport: { embedded: false, local_encrypted: true, blob_sync_enabled: false }, referenced_assets: [{ id: 'asset-large', root_resource_id: 'board-a', file_id: 'file-large', content_hash: 'b'.repeat(64), content_type: 'image/webp', size_bytes: 26 * 1024 * 1024 }] },
    } satisfies OfflineV5Snapshot
    expect(offlineV5WhiteboardAssetDescriptors(snapshot)[0].size_bytes).toBe(26 * 1024 * 1024)
  })

  it('serializes only the three fields accepted by the strict selection endpoint', async () => {
    const candidate = {
      module: 'tasks' as const,
      resource_type: 'task_list',
      resource_id: 'list-1',
      label: 'Operaciones',
      readiness: 'ready',
      head_version: 17,
      item_count: 42,
      byte_size: 4096,
    }
    expect(offlineV5SelectionInput([candidate])).toEqual([{
      module: 'tasks',
      resource_type: 'task_list',
      resource_id: 'list-1',
    }])
    expect(candidate).toHaveProperty('readiness', 'ready')

    const client = new OfflineV5OnlineClient('https://clarin.test')
    const request = vi.spyOn(client, 'request').mockResolvedValue({ items: [], selection_revision: 2 })
    await client.replaceSelection('grant/one', 1, [candidate])
    expect(request).toHaveBeenCalledWith(
      '/api/offline/v5/grants/grant%2Fone/selection',
      {
        selection_revision: 1,
        items: [{ module: 'tasks', resource_type: 'task_list', resource_id: 'list-1' }],
      },
      { method: 'PUT', authenticated: true },
    )
  })

  it('explains a rejected selection instead of blaming the password', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'invalid_offline_selection' }),
      { status: 400, headers: { 'Content-Type': 'application/json', 'X-Clarin-Response': '1' } },
    ))
    const client = new OfflineV5OnlineClient('https://clarin.test', fetcher)
    const failure = await client.request('/api/offline/v5/grants/grant/selection').catch(error => error)
    expect(failure).toBeInstanceOf(OfflineV5APIError)
    expect(failure).toMatchObject({
      status: 400,
      code: 'invalid_offline_selection',
      message: 'No se pudo guardar la selección offline. Actualízala y vuelve a intentarlo.',
    })
  })

  it('distinguishes an actually incorrect password and preserves trusted server detail', () => {
    expect(offlineV5RequestMessage(403, 'offline_reauthentication_failed')).toBe('La contraseña actual de Clarín no es correcta.')
    expect(offlineV5RequestMessage(409, 'offline_key_already_registered')).toContain('identidad offline preparada')
    expect(offlineV5RequestMessage(422, 'offline_resource_too_large')).not.toContain('selección cambió')
    expect(offlineV5RequestMessage(409, 'offline_selection_changed')).toContain('selección cambió')
    expect(offlineV5RequestMessage(400, 'invalid_offline_selection', 'Detalle confirmado por el servidor.')).toBe('Detalle confirmado por el servidor.')
  })

  it('downloads only signed whiteboard assets and rejects altered bytes', async () => {
    const bytes = new TextEncoder().encode('verified-image-bytes')
    const digest = await sha256HexBytes(bytes)
    const snapshot = {
      protocol_version: 5, manifest_id: 'manifest', manifest_revision: 1, selection_id: 'selection-board', root_selection_id: 'selection-board', root_resource_id: 'board-a',
      module: 'whiteboards', resource_type: 'whiteboard', resource_id: 'board-a', dependency: false, head_version: 1, content_hash: 'a'.repeat(64), payload_json: '{}', tombstone: false, generated_at: '2026-09-15T00:00:00Z',
      payload: { whiteboard: { id: 'board-a' }, asset_transport: { embedded: false, local_encrypted: true, blob_sync_enabled: false }, referenced_assets: [{ id: 'asset-a', root_resource_id: 'board-a', file_id: 'file-a', content_hash: digest, content_type: 'image/png', size_bytes: bytes.byteLength }] },
    } satisfies OfflineV5Snapshot
    const bundle = { snapshots: [snapshot] } as unknown as OfflineV5PrepareBundle
    const headers = { 'Content-Type': 'image/png', 'Content-Length': String(bytes.byteLength), 'X-Clarin-Response': '1' }
    const fetcher = vi.fn().mockResolvedValue(new Response(bytes.slice(), { status: 200, headers }))
    const client = new OfflineV5OnlineClient('https://clarin.test', fetcher)
    const downloaded = await client.downloadPreparedAssets(bundle)
    expect(downloaded).toHaveLength(1)
    expect(await downloaded[0].bytes.text()).toBe('verified-image-bytes')
    expect(fetcher.mock.calls[0][0].toString()).toBe('https://clarin.test/api/whiteboards/board-a/assets/asset-a')

    const altered = new OfflineV5OnlineClient('https://clarin.test', vi.fn().mockResolvedValue(new Response(new TextEncoder().encode('altered-image-content'), { status: 200, headers })))
    await expect(altered.downloadPreparedAssets(bundle)).rejects.toMatchObject({ code: 'offline_asset_integrity_failed' })
  })
})
