import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LeadPolicyProvider, type LeadPolicyState } from '@/components/LeadPolicyProvider'
import ReportsPage from './page'

const fixture = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/lib/api', () => ({ subscribeWebSocket: () => () => {} }))
const state = (enabled: boolean): LeadPolicyState => ({ ready: true, policy: null, leadsEnabled: enabled, automationEnabled: enabled, error: '', refresh: vi.fn() })
const view = (enabled: boolean) => <LeadPolicyProvider value={state(enabled)}><ReportsPage /></LeadPolicyProvider>
const access = (user: Record<string, unknown>) => fixture.fetch.mockResolvedValue({ ok: true, json: async () => ({ user }) })

beforeEach(() => {
  fixture.fetch.mockReset()
  access({ permissions: ['reports'] })
  vi.stubGlobal('fetch', fixture.fetch)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Reports account Lead policy', () => {
  it('removes the commercial report immediately on revocation and retains the independent report', async () => {
    const { rerender } = render(view(true))
    expect(await screen.findByRole('link', { name: /Análisis inteligente de leads/ })).toHaveAttribute('href', '/dashboard/reports/lead-intelligence')
    const groupReport = screen.getByRole('link', { name: /Cobertura de integrantes de WhatsApp/ })
    rerender(view(false))
    expect(screen.queryByRole('link', { name: /Análisis inteligente de leads/ })).not.toBeInTheDocument()
    expect(screen.getByText('1 reporte disponible')).toBeVisible()
    expect(screen.getByRole('link', { name: /Cobertura de integrantes de WhatsApp/ })).toBe(groupReport)
    expect(groupReport).toHaveAttribute('href', '/dashboard/reports/whatsapp-group-coverage')
    expect(groupReport).toHaveTextContent('Compara los integrantes de un grupo con los contactos de Clarin.')
    rerender(view(true))
    expect(screen.getByRole('link', { name: /Análisis inteligente de leads/ })).toBeVisible()
    expect(screen.getByText('2 reportes disponibles')).toBeVisible()
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
  })

  it.each([{ is_admin: true }, { is_super_admin: true }, { permissions: ['*'] }, { permissions: ['reports'] }])('preserves permitted independent reports with Leads disabled: %j', async user => {
    access(user)
    render(view(false))
    expect(await screen.findByRole('link', { name: /Cobertura de integrantes de WhatsApp/ })).toBeVisible()
    expect(screen.queryByRole('link', { name: /Análisis inteligente de leads/ })).not.toBeInTheDocument()
  })

  it.each([true, false])('still denies the catalog without reporting permission when Leads is %s', async enabled => {
    access({ permissions: ['leads', 'chats'] })
    render(view(enabled))
    expect(await screen.findByText('Acceso restringido')).toBeVisible()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
