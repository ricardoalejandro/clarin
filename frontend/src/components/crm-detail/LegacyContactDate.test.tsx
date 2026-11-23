import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LeadDetailPanel from '@/components/LeadDetailPanel'
import type { Lead } from '@/types/contact'

vi.mock('@/components/tags/CanonicalContactTags', () => ({ default: () => null }))
vi.mock('@/components/ObservationHistoryModal', () => ({ default: () => null }))
vi.mock('@/components/TaskList', () => ({ default: () => null }))
vi.mock('@/components/TaskFormModal', () => ({ default: () => null }))
vi.mock('@/components/GenerateDocumentModal', () => ({ default: () => null }))
vi.mock('@/components/ContactAvatarControl', () => ({ default: () => null }))

const lead = { id: 'legacy-contact', contact_id: 'contact', name: 'Contacto de prueba', phone: '', jid: '', tags: [], structured_tags: [], status: 'open', birth_date: null, created_at: '', updated_at: '' } as unknown as Lead
const definition = { id: 'date-field', name: 'Renovación', field_type: 'date', config: {}, is_required: false }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('legacy Contact date API boundary', () => {
  it('retains and retries an inline custom date when the real parent API adapter rejects the write', async () => {
    let writes = 0
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/custom-fields') return { ok: true, json: async () => ({ success: true, fields: [definition] }) }
      if (url === '/api/contacts/contact/custom-fields' && !init?.method) return { ok: true, json: async () => ({ success: true, values: [] }) }
      if (url === '/api/contacts/contact/custom-fields/date-field' && init?.method === 'PUT') {
        writes += 1
        return { ok: writes > 1, json: async () => writes === 1 ? ({ success: false, error: 'Sin conexión de prueba' }) : ({ success: true, value: { field_id: 'date-field', value_date: '2026-06-20' } }) }
      }
      return { ok: true, json: async () => ({ success: true }) }
    })
    vi.stubGlobal('fetch', fetch)
    render(<LeadDetailPanel lead={lead} contactMode contactId="contact" onLeadChange={vi.fn()} onClose={vi.fn()} hideHeader hideIdentity hideCommercialSummary hideTasks hideNotes hideObservations hideAuxiliaryActions />)
    fireEvent.click(screen.getByRole('button', { name: 'Campos' }))
    fireEvent.click(await screen.findByText('Renovación'))
    const date = screen.getByRole('textbox', { name: 'Renovación' })
    fireEvent.change(date, { target: { value: '20/06/2026' } })
    fireEvent.keyDown(date, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo guardar la fecha')
    expect(date).toHaveValue('20/06/2026')
    fireEvent.keyDown(date, { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Renovación' })).not.toBeInTheDocument())
    expect(writes).toBe(2)
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ value: '2026-06-20' }, { value: '2026-06-20' }])
  })
})
