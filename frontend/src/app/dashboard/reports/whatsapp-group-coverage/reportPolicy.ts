import type { LeadPolicy } from '@/lib/leadPolicy'
import type { WhatsAppGroupCoverageReport } from '@/types/report'

export function isCurrentCoverageReport(report: WhatsAppGroupCoverageReport | null, policy: LeadPolicy): boolean {
  return Boolean(report && report.account_id === policy.account_id
    && report.leads_policy_version === policy.leads_policy_version
    && report.leads_enabled === policy.leads_enabled)
}
