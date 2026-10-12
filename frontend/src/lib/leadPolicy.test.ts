import { describe, expect, it } from 'vitest'
import { isLeadModulePath, leadAutomationEnabled, parseLeadPolicy, reconcileLeadPolicy } from './leadPolicy'

describe('account Lead policy', () => {
  it.each([[true, true, true], [true, false, false], [false, true, false], [false, false, false]])('combines module %s and automation %s', (leads_enabled, lead_automation_enabled, effective) => {
    expect(leadAutomationEnabled({ leads_enabled, lead_automation_enabled, leads_policy_version: 1 })).toBe(effective)
  })
  it('rejects malformed policy rather than enabling an unknown account', () => {
    expect(parseLeadPolicy(null)).toBeNull()
    expect(parseLeadPolicy({ leads_enabled: 'false', lead_automation_enabled: true, leads_policy_version: 1 })).toBeNull()
  })
  it('rejects another account and stale snapshots', () => {
    const current = { account_id: 'a', leads_enabled: false, lead_automation_enabled: true, leads_policy_version: 3 }
    expect(reconcileLeadPolicy(current, { ...current, account_id: 'b', leads_policy_version: 4 }, 'a')).toBe(current)
    expect(reconcileLeadPolicy(current, { ...current, leads_enabled: true, leads_policy_version: 2 }, 'a')).toBe(current)
    expect(reconcileLeadPolicy(current, { ...current, leads_enabled: true, leads_policy_version: 4 }, 'a')?.leads_enabled).toBe(true)
  })
  it('gates commercial routes without gating Events, Bots, or account administration', () => {
    expect(isLeadModulePath('/dashboard/leads/example')).toBe(true)
    expect(isLeadModulePath('/dashboard/automations')).toBe(true)
    expect(isLeadModulePath('/dashboard/reports/lead-intelligence')).toBe(true)
    expect(isLeadModulePath('/dashboard/reports/lead-intelligence/result')).toBe(true)
    for (const path of ['/dashboard/events', '/dashboard/programs', '/dashboard/bots', '/dashboard/admin', '/dashboard/reports', '/dashboard/reports/whatsapp-group-coverage', '/dashboard/reports/lead-intelligence-other']) expect(isLeadModulePath(path)).toBe(false)
  })
})
