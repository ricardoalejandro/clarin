import { describe, expect, it } from 'vitest'
import type { AdminOfflineGrant } from '@/offline-v3/onlineClient'
import { buildOfflineV3Control, defaultOfflineV3Approval, validateOfflineV3Approval } from './OfflineAccessAdminV3'

const grant = {
  installation_id: '11111111-1111-4111-8111-111111111111',
  windows_principal_id: '22222222-2222-4222-8222-222222222222',
  browser_profile_id: '33333333-3333-4333-8333-333333333333',
  authorization_id: '44444444-4444-4444-8444-444444444444',
  grant_id: '55555555-5555-4555-8555-555555555555',
  user_id: '66666666-6666-4666-8666-666666666666',
  account_id: '77777777-7777-4777-8777-777777777777',
} as AdminOfflineGrant

describe('offline v3 superadmin authorization', () => {
  it('derives pilot accounts from the requesting user membership', () => {
    const result = defaultOfflineV3Approval(
      { id: grant.user_id, username: 'ana', display_name: 'Ana', is_active: true, accounts: [{ account_id: grant.account_id }] },
      [{ id: 'other', name: 'Otra', is_active: true }, { id: grant.account_id, name: 'Autorizada', is_active: true }],
    )
    expect(result).toHaveLength(1)
    expect(result[0].accountId).toBe(grant.account_id)
    expect(result[0].actions).toEqual(['tasks.read', 'contacts.read', 'programs.read', 'whiteboards.read'])
    expect(result[0].actions).not.toContain('tasks.create')
  })

  it('does not allow task writes without the corresponding task read scope', () => {
    expect(validateOfflineV3Approval([{ accountId: grant.account_id, actions: ['tasks.create'] }])).toContain('leer tareas')
  })

  it('maps PC-account and PC-user controls without swapping account and user IDs', () => {
    expect(buildOfflineV3Control(grant, 'installation_account', 'wipe')).toEqual({
      scope: 'installation_account',
      scope_id: grant.account_id,
      installation_id: grant.installation_id,
      action: 'wipe',
    })
    expect(buildOfflineV3Control(grant, 'installation_user', 'wipe')).toEqual({
      scope: 'installation_user',
      scope_id: grant.user_id,
      installation_id: grant.installation_id,
      action: 'wipe',
    })
  })

  it('rejects a non-destructive lock on aggregate account/user controls', () => {
    expect(() => buildOfflineV3Control(grant, 'account', 'lock')).toThrow(/revocación/)
  })
})
