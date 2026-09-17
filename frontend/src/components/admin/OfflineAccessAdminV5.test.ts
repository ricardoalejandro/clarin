// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { revokeOfflineV5GrantAndLocalCopy } from './OfflineAccessAdminV5'

describe('OfflineAccessAdminV5 revocation', () => {
  it('revokes on the server before purging that exact local browser grant', async () => {
    const order: string[] = []
    const revoke = vi.fn(async (id: string) => { order.push(`server:${id}`) })
    const purge = vi.fn(async (id: string) => { order.push(`local:${id}`) })

    await revokeOfflineV5GrantAndLocalCopy('grant-a', revoke, purge)

    expect(order).toEqual(['server:grant-a', 'local:grant-a'])
    expect(revoke).toHaveBeenCalledWith('grant-a')
    expect(purge).toHaveBeenCalledWith('grant-a')
  })

  it('does not remove a local copy when server revocation failed', async () => {
    const purge = vi.fn()
    await expect(revokeOfflineV5GrantAndLocalCopy('grant-a', async () => { throw new Error('server failed') }, purge)).rejects.toThrow('server failed')
    expect(purge).not.toHaveBeenCalled()
  })
})
