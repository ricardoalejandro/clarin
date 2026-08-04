import { describe, expect, it } from 'vitest'
import { accountOptionsURL, accountRoleLabel } from './accountSwitcher'

describe('account switcher contracts', () => {
  it('presents canonical and custom roles as readable labels', () => {
    expect(accountRoleLabel('super_admin')).toBe('Super administrador')
    expect(accountRoleLabel('agent')).toBe('Agente')
    expect(accountRoleLabel('content_manager')).toBe('Content manager')
    expect(accountRoleLabel('')).toBe('Sin rol asignado')
  })

  it('keeps recent and searched requests distinct', () => {
    expect(accountOptionsURL('')).toBe('/api/me/accounts')
    expect(accountOptionsURL('  Iquitos  ', 'next page')).toBe('/api/me/accounts?query=Iquitos&limit=50&cursor=next+page')
  })
})
