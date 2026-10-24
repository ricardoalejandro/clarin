export interface LeadPolicy {
  account_id: string
  leads_enabled: boolean
  lead_automation_enabled: boolean
  leads_policy_version: number
  lead_automation_enabled_since?: string | null
}

export function parseLeadPolicy(value: unknown): LeadPolicy | null {
  if (!value || typeof value !== 'object') return null
  const policy = value as LeadPolicy
  if (typeof policy.account_id !== 'string' || !policy.account_id.trim()
    || typeof policy.leads_enabled !== 'boolean' || typeof policy.lead_automation_enabled !== 'boolean'
    || !Number.isSafeInteger(policy.leads_policy_version) || policy.leads_policy_version < 1) return null
  return policy
}

export function reconcileLeadPolicy(current: LeadPolicy | null, next: LeadPolicy, accountId: string): LeadPolicy | null {
  if (next.account_id !== accountId) return current
  if (current && current.leads_policy_version > next.leads_policy_version) return current
  return next
}

export function isLeadModulePath(path: string) {
  return ['/dashboard/leads', '/dashboard/automations'].some(prefix => path === prefix || path.startsWith(`${prefix}/`))
}

export function leadAutomationEnabled(policy: LeadPolicy) {
  return policy.leads_enabled && policy.lead_automation_enabled
}
