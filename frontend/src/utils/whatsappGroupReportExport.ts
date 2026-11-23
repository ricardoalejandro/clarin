import * as XLSX from 'xlsx'
import { saveAs } from 'file-saver'
import type { CoverageStatus, WhatsAppGroupCoverageMember, WhatsAppGroupCoverageReport } from '@/types/report'

const statusLabels: Record<CoverageStatus, string> = {
  active_management: 'Gestión activa',
  historical_only: 'Con historial, sin gestión activa',
  contact_only: 'Solo contacto',
  not_registered: 'No registrado',
  unidentifiable: 'No identificable',
  ambiguous: 'Coincidencia ambigua',
}

const roleLabels: Record<WhatsAppGroupCoverageMember['role'], string> = {
  owner: 'Propietario',
  super_admin: 'Administrador principal',
  admin: 'Administrador',
  member: 'Integrante',
}

function dateTime(value?: string | null): string {
  if (!value) return ''
  return new Date(value).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })
}

function existsLabel(member: WhatsAppGroupCoverageMember): string {
  if (member.coverage_status === 'ambiguous') return `Sí, ${member.matched_contact_count} coincidencias`
  if (member.exists_in_clarin === null) return 'No verificable'
  return member.exists_in_clarin ? 'Sí' : 'No'
}

export function whatsappCoverageMemberRows(report: WhatsAppGroupCoverageReport) {
  return report.members.map((member, index) => ({
    '#': index + 1,
    'Nombre WhatsApp': member.whatsapp_name,
    'Usuario WhatsApp': member.username ? `@${member.username.replace(/^@/, '')}` : '',
    'Teléfono': member.phone ? `+${member.phone}` : member.redacted_phone || '',
    'Rol en grupo': member.is_self ? 'Este dispositivo' : roleLabels[member.role],
    'Existe en Clarin': existsLabel(member),
    [report.leads_enabled ? 'Estado de gestión' : 'Estado de registro']: !report.leads_enabled && ['active_management', 'historical_only', 'contact_only'].includes(member.coverage_status) ? 'Registrado' : statusLabels[member.coverage_status],
    'Contacto Clarin': member.contact?.display_name || '',
    'Fuente': member.contact?.source || '',
    'Etiquetas': (member.contact?.tags || []).map(tag => tag.name).join(', '),
    ...(report.leads_enabled ? {
      'Oportunidades activas': member.contact?.active_leads.length || 0,
      'Pipeline / etapa': (member.contact?.active_leads || []).map(lead => [lead.pipeline_name, lead.stage_name].filter(Boolean).join(' / ')).filter(Boolean).join(' | '),
      'Responsables': (member.contact?.active_leads || []).map(lead => lead.assigned_to_name).filter(Boolean).join(', '),
      'Leads históricos': member.contact?.historical_lead_count || 0,
    } : {}),
    'Última actividad directa': dateTime(member.contact?.last_direct_activity_at),
    'No contactar': member.contact?.do_not_contact ? 'Sí' : 'No',
  }))
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ _-]/g, '').trim().replace(/\s+/g, '_') || 'grupo_whatsapp'
}

export function whatsappCoverageSummaryRows(report: WhatsAppGroupCoverageReport) {
  const summary = report.summary
  return [
    ['Reporte', 'Cobertura de integrantes de WhatsApp'],
    ['Grupo', report.group.name],
    ['Dispositivo', report.device.name],
    ['Generado', dateTime(report.generated_at)],
    ['Integrantes del grupo', summary.total_group_members],
    ['Integrantes evaluados', summary.evaluated_members],
    ['Registrados en Clarin', summary.registered_members],
    ...(report.leads_enabled ? [
      ['Gestión activa', summary.active_management_members],
      ['Con historial', summary.historical_only_members],
      ['Solo contacto', summary.contact_only_members],
    ] : []),
    ['No registrados', summary.not_registered_members],
    ['No identificables', summary.unidentifiable_members],
    ['Coincidencias ambiguas', summary.ambiguous_members],
    ['No contactar', summary.do_not_contact_members],
    ['Cobertura CRM', summary.registration_coverage_percent == null ? '' : `${summary.registration_coverage_percent}%`],
    ...(report.leads_enabled ? [['Cobertura de gestión', summary.management_coverage_percent == null ? '' : `${summary.management_coverage_percent}%`]] : []),
  ]
}

export function exportWhatsAppGroupReportExcel(report: WhatsAppGroupCoverageReport) {
  const workbook = XLSX.utils.book_new()
  const summarySheet = XLSX.utils.aoa_to_sheet(whatsappCoverageSummaryRows(report))
  summarySheet['!cols'] = [{ wch: 28 }, { wch: 42 }]
  const membersSheet = XLSX.utils.json_to_sheet(whatsappCoverageMemberRows(report))
  membersSheet['!cols'] = [
    { wch: 5 }, { wch: 28 }, { wch: 24 }, { wch: 18 }, { wch: 22 }, { wch: 20 }, { wch: 30 },
    { wch: 28 }, { wch: 16 }, { wch: 32 }, { wch: 22 }, { wch: 35 }, { wch: 25 },
    { wch: 18 }, { wch: 24 }, { wch: 14 },
  ]
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Resumen')
  XLSX.utils.book_append_sheet(workbook, membersSheet, 'Integrantes')
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })
  saveAs(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${safeFilename(report.group.name)}_cobertura.xlsx`)
}

export function exportWhatsAppGroupReportCSV(report: WhatsAppGroupCoverageReport) {
  const sheet = XLSX.utils.json_to_sheet(whatsappCoverageMemberRows(report))
  const csv = XLSX.utils.sheet_to_csv(sheet)
  saveAs(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }), `${safeFilename(report.group.name)}_cobertura.csv`)
}
