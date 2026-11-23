import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiBlob } from '@/lib/api'
import { readDocumentSlot, UtilityRequestError } from './libraryApi'

vi.mock('@/lib/api', () => ({ api: vi.fn(), apiBlob: vi.fn() }))
beforeEach(() => vi.clearAllMocks())

describe('versioned utility content reads', () => {
  it('pairs content bytes with the exact response version', async () => {
    const blob = new Blob(['saved'])
    vi.mocked(apiBlob).mockResolvedValue({ success: true, blob, contentVersion: '23' })
    const controller = new AbortController()
    expect(await readDocumentSlot('one', 'panel-a', controller.signal)).toEqual({ blob, version: 23 })
    expect(apiBlob).toHaveBeenCalledWith('/api/utilities/documents/one/content/panel-a', { signal: controller.signal, authMode: 'background' })
  })
  it.each([undefined, '', '0', '-1', '1.5', '1x', '9007199254740992'])('rejects unverifiable content version %s', async contentVersion => {
    vi.mocked(apiBlob).mockResolvedValue({ success: true, blob: new Blob(['saved']), contentVersion })
    await expect(readDocumentSlot('one', 'panel-a')).rejects.toMatchObject({ status: 502 })
  })
  it.each([401, 403, 404, 409, 503])('preserves status %d for actionable error feedback', async status => {
    vi.mocked(apiBlob).mockResolvedValue({ success: false, status, error: 'specific error' })
    await expect(readDocumentSlot('one', 'panel-a')).rejects.toEqual(new UtilityRequestError('specific error', status))
  })
})
