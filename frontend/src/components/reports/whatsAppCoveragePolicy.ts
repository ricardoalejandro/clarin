import type { LeadPolicy } from '@/lib/leadPolicy'
import type { WhatsAppGroupCoverageReport } from '@/types/report'

export function isCurrentCoverageReport(report: WhatsAppGroupCoverageReport | null, policy: LeadPolicy): boolean {
  return Boolean(report && report.account_id === policy.account_id
    && report.leads_policy_version === policy.leads_policy_version
    && report.leads_enabled === policy.leads_enabled)
}

export function hasCoverageSnapshotRevisions(report: WhatsAppGroupCoverageReport): boolean {
  return [report.identity_revision, report.group_revision, report.crm_identity_revision].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

export function coverageValidationPayload(report: WhatsAppGroupCoverageReport) {
  if (!hasCoverageSnapshotRevisions(report)) throw new Error('No pudimos verificar la versión de los datos. Genera nuevamente el reporte.')
  return { device_id: report.device.id, group_id: report.group.id, identity_revision: report.identity_revision, group_revision: report.group_revision, crm_identity_revision: report.crm_identity_revision, leads_policy_version: report.leads_policy_version, leads_enabled: report.leads_enabled }
}

export function coverageEventInvalidates(raw: unknown, context: { accountId: string; deviceId: string; identityRevision?: number; crmIdentityRevision?: number }): boolean {
  if (!raw || typeof raw !== 'object') return false
  const event = raw as { event?: string; type?: string; account_id?: string; data?: { account_id?: string; device_id?: string; identity_revision?: unknown; crm_identity_revision?: unknown } }
  if ([event.account_id, event.data?.account_id].some(account => account && account !== context.accountId)) return false
  const type = event.event || event.type
  if (type === 'whatsapp_crm_identity_updated') {
    if (![event.account_id, event.data?.account_id].includes(context.accountId)) return false
    const revision = event.data?.crm_identity_revision
    if (revision === undefined) return context.crmIdentityRevision === undefined
    return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
      && (context.crmIdentityRevision === undefined || revision > context.crmIdentityRevision)
  }
  if (type === 'contact_update') return true
  if (!['whatsapp_identity_updated', 'chat_group_updated', 'groups_synced', 'device_deletion'].includes(type || '')) return false
  if (event.data?.device_id && event.data.device_id !== context.deviceId) return false
  if (type === 'whatsapp_identity_updated') {
    if (event.data?.device_id !== context.deviceId) return false
    const revision = event.data.identity_revision
    if (typeof revision === 'number' && Number.isSafeInteger(revision) && context.identityRevision !== undefined && revision <= context.identityRevision) return false
  }
  return true
}
