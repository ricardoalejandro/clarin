import { describe, expect, it, vi } from 'vitest'
import { finalizeAdminUserAccountMutation } from './adminUserAccountAssignments'

const assignment = {
  account_id: 'account-proyectos',
  account_name: 'Proyectos',
  role: 'super_admin',
  is_default: false,
}

describe('admin user-account mutation reconciliation', () => {
  it('refreshes the current operator before accepting canonical assignments', async () => {
    const refresh = vi.fn().mockResolvedValue(true)
    const result = await finalizeAdminUserAccountMutation({
      success: true,
      data: { success: true, accounts: [assignment], session_refresh_required: true },
    }, refresh)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: true, accounts: [assignment], persisted: true })
  })

  it('does not rotate the operator session when another user changed', async () => {
    const refresh = vi.fn().mockResolvedValue(true)
    const result = await finalizeAdminUserAccountMutation({
      success: true,
      data: { success: true, accounts: [assignment], session_refresh_required: false },
    }, refresh)

    expect(refresh).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('distinguishes a persisted change from a failed session renewal', async () => {
    const result = await finalizeAdminUserAccountMutation({
      success: true,
      data: { success: true, accounts: [assignment], session_refresh_required: true },
    }, async () => false)

    expect(result.success).toBe(false)
    expect(result.persisted).toBe(true)
    expect(result.code).toBe('session_refresh_failed')
    expect(result.accounts).toEqual([assignment])
  })

  it('keeps API conflicts actionable without attempting a refresh', async () => {
    const refresh = vi.fn().mockResolvedValue(true)
    const result = await finalizeAdminUserAccountMutation({
      success: false,
      status: 409,
      error: 'Cambia a otra cuenta antes de retirar tu cuenta activa',
      data: { success: false, code: 'active_account_assignment' },
    }, refresh)

    expect(refresh).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.persisted).toBe(false)
    expect(result.error).toContain('Cambia a otra cuenta')
  })
})
