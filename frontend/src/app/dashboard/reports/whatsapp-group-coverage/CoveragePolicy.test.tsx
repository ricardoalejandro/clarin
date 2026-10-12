import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LeadPolicyProvider, type LeadPolicyState } from '@/components/LeadPolicyProvider'
import type { LeadPolicy } from '@/lib/leadPolicy'
import type { WhatsAppGroupCoverageReport } from '@/types/report'
import { exportWhatsAppGroupReportCSV, exportWhatsAppGroupReportExcel, whatsappCoverageMemberRows, whatsappCoverageSummaryRows } from '@/utils/whatsappGroupReportExport'
import WhatsAppGroupCoveragePage from './page'
import { isCurrentCoverageReport } from './reportPolicy'

vi.mock('@/lib/api', () => ({ subscribeWebSocket: () => () => {} }))
vi.mock('@/components/reports/WhatsAppGroupSelector', () => ({ default: ({ groups, onChange }: any) => <button disabled={!groups.length} onClick={() => onChange(groups[0])}>Elegir grupo</button> }))
vi.mock('@/utils/whatsappGroupReportExport', async importOriginal => ({ ...await importOriginal<typeof import('@/utils/whatsappGroupReportExport')>(), exportWhatsAppGroupReportCSV: vi.fn(), exportWhatsAppGroupReportExcel: vi.fn() }))

const policy = (enabled = true, version = 1): LeadPolicy => ({ account_id: 'account', leads_enabled: enabled, leads_policy_version: version, lead_automation_enabled: true })
const fixture = (enabled = true, version = 1): WhatsAppGroupCoverageReport => ({
  account_id: 'account', leads_enabled: enabled, leads_policy_version: version, generated_at: '2026-10-12T10:00:00Z',
  device: { id: 'device', name: 'Synthetic device', phone: '51999999999' },
  group: { id: 'group', name: 'Synthetic group', participant_count: 1, kind: 'group', suspended: false },
  summary: { total_group_members: 1, evaluated_members: 1, eligible_members: 1, registered_members: 1, active_management_members: enabled ? 1 : 0, historical_only_members: 0, contact_only_members: enabled ? 0 : 1, not_registered_members: 0, unidentifiable_members: 0, ambiguous_members: 0, do_not_contact_members: 0, registration_coverage_percent: 100, management_coverage_percent: enabled ? 100 : null },
  members: [{ whatsapp_name: 'Synthetic member', phone: '51999999999', redacted_phone: null, role: 'member', is_self: false, exists_in_clarin: true, coverage_status: enabled ? 'active_management' : 'contact_only', matched_contact_count: 1, contact: { id: 'contact', display_name: 'Synthetic contact', source: 'whatsapp', do_not_contact: false, last_direct_activity_at: null, tags: [], active_leads: enabled ? [{ id: 'lead', title: 'Opportunity', pipeline_name: 'Private pipeline', stage_name: 'Private stage', stage_color: '#64748b', assigned_to_name: 'Private owner', updated_at: '2026-10-12' }] : [], historical_lead_count: 0 } }],
})
const response = (value: object) => ({ ok: true, json: async () => ({ success: true, ...value }) })
let currentPolicy: LeadPolicy
let reportResponse: () => Promise<unknown>
let policyResponse: () => Promise<unknown>
let fetchMock: ReturnType<typeof vi.fn>
const refresh = vi.fn()
const view = (p: LeadPolicy) => {
  const state: LeadPolicyState = { policy: p, ready: true, leadsEnabled: p.leads_enabled, automationEnabled: p.leads_enabled, refresh, error: '' }
  return <LeadPolicyProvider value={state}><WhatsAppGroupCoveragePage /></LeadPolicyProvider>
}
async function generate() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Elegir grupo' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Elegir grupo' }))
  fireEvent.click(screen.getByRole('button', { name: 'Generar reporte' }))
}
beforeEach(() => {
  vi.clearAllMocks()
  currentPolicy = policy()
  reportResponse = async () => response({ report: fixture(currentPolicy.leads_enabled, currentPolicy.leads_policy_version) })
  policyResponse = async () => response({ policy: currentPolicy })
  fetchMock = vi.fn((url: string) => {
    if (url === '/api/devices') return Promise.resolve(response({ devices: [{ id: 'device', name: 'Synthetic device', status: 'connected' }] }))
    if (url.includes('/groups?')) return Promise.resolve(response({ groups: [{ id: 'group', name: 'Synthetic group' }] }))
    if (url.endsWith('/generate')) return reportResponse()
    if (url === '/api/settings/lead-policy') return policyResponse()
    throw new Error(`Unexpected URL ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('WhatsApp coverage policy', () => {
  it('offers retry when account policy cannot be loaded', () => {
    const state: LeadPolicyState = { policy: null, ready: false, leadsEnabled: false, automationEnabled: false, refresh, error: 'No pudimos verificar la configuración.' }
    render(<LeadPolicyProvider value={state}><WhatsAppGroupCoveragePage /></LeadPolicyProvider>)
    expect(screen.getByText(state.error)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(refresh).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('clears commercial results on live toggle, keeps Contact reporting and exports off without lead context', async () => {
    const { rerender } = render(view(currentPolicy))
    await generate()
    expect(await screen.findByText('Private pipeline · Private stage')).toBeVisible()
    currentPolicy = policy(false, 2)
    rerender(view(currentPolicy))
    expect(screen.queryByRole('button', { name: 'Excel' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Private pipeline/)).not.toBeInTheDocument()
    await generate()
    expect(await screen.findByRole('link', { name: 'Synthetic contact' })).toBeVisible()
    expect(screen.queryByRole('columnheader', { name: 'Oportunidades activas' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Gestión activa' })).not.toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Estado de registro' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }))
    await waitFor(() => expect(exportWhatsAppGroupReportCSV).toHaveBeenCalledWith(expect.objectContaining({ leads_enabled: false, leads_policy_version: 2 })))
  })

  it('rejects an old generation completion after a policy change even if fetch ignores abort', async () => {
    let finish!: (value: unknown) => void
    reportResponse = () => new Promise(resolve => { finish = resolve })
    const { rerender } = render(view(currentPolicy))
    await generate()
    const call = fetchMock.mock.calls.find(([url]) => url.endsWith('/generate'))!
    currentPolicy = policy(false, 2)
    rerender(view(currentPolicy))
    expect(call[1].signal.aborted).toBe(true)
    await act(async () => finish(response({ report: fixture() })))
    expect(screen.queryByRole('button', { name: 'CSV' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Private pipeline/)).not.toBeInTheDocument()
  })

  it('revalidates cached export against the server even before the live policy notification', async () => {
    render(view(currentPolicy))
    await generate()
    await screen.findByRole('button', { name: 'Excel' })
    currentPolicy = policy(false, 2)
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }))
    expect(await screen.findByText('La configuración de la cuenta cambió. Genera nuevamente el reporte.')).toBeVisible()
    expect(exportWhatsAppGroupReportExcel).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Excel' })).not.toBeInTheDocument()
    expect(refresh).toHaveBeenCalled()
  })

  it('cancels an export verification on live policy change', async () => {
    const { rerender } = render(view(currentPolicy))
    await generate()
    await screen.findByRole('button', { name: 'CSV' })
    let finish!: (value: unknown) => void
    policyResponse = () => new Promise(resolve => { finish = resolve })
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }))
    currentPolicy = policy(false, 2)
    rerender(view(currentPolicy))
    await act(async () => finish(response({ policy: policy() })))
    expect(exportWhatsAppGroupReportCSV).not.toHaveBeenCalled()
  })

  it('does not accept a generated response from another policy or account', async () => {
    reportResponse = async () => response({ report: { ...fixture(), account_id: 'other' } })
    render(view(currentPolicy))
    await generate()
    expect(await screen.findByText('La configuración de la cuenta cambió. Genera nuevamente el reporte.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'CSV' })).not.toBeInTheDocument()
  })

  it('keeps exports independent of commercial fields when the report is marked off', () => {
    const report = { ...fixture(), leads_enabled: false }
    const rows = whatsappCoverageMemberRows(report)
    expect(rows[0]).toMatchObject({ 'Contacto Clarin': 'Synthetic contact', 'Estado de registro': 'Registrado' })
    expect(rows[0]).not.toHaveProperty('Oportunidades activas')
    expect(rows[0]).not.toHaveProperty('Pipeline / etapa')
    expect(rows[0]).not.toHaveProperty('Responsables')
    expect(rows[0]).not.toHaveProperty('Leads históricos')
    expect(JSON.stringify(whatsappCoverageSummaryRows(report))).not.toMatch(/Gestión|historial|Solo contacto|gestión/)
    expect(whatsappCoverageMemberRows(fixture())[0]).toHaveProperty('Pipeline / etapa', 'Private pipeline / Private stage')
  })

  it('requires matching account, version and module state', () => {
    expect(isCurrentCoverageReport(fixture(), policy())).toBe(true)
    expect(isCurrentCoverageReport(fixture(false, 2), policy(false, 2))).toBe(true)
    expect(isCurrentCoverageReport(fixture(), policy(true, 3))).toBe(false)
    expect(isCurrentCoverageReport(fixture(), { ...policy(), account_id: 'other' })).toBe(false)
    expect(isCurrentCoverageReport(fixture(), policy(false))).toBe(false)
    expect(isCurrentCoverageReport(null, policy())).toBe(false)
  })
})
