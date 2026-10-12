import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ContactSelector from '@/components/ContactSelector'

const fixture = vi.hoisted(() => ({ leadsEnabled: true, fetch: vi.fn() }))
vi.mock('@/components/LeadPolicyProvider', () => ({ useLeadPolicy: () => ({ leadsEnabled: fixture.leadsEnabled }) }))
vi.mock('@/components/FormulaEditor', () => ({ default: () => null }))
const contact = { id: 'contact-1', name: 'Contacto canónico', phone: '100', email: '', source_type: 'contact' }
const lead = { id: 'lead-1', name: 'Oportunidad histórica', phone: '100', email: '', source_type: 'lead' }
const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response
beforeEach(() => {
  fixture.leadsEnabled = true
  fixture.fetch.mockReset()
  fixture.fetch.mockImplementation(async (url: string) => json(url.startsWith('/api/people/search')
    ? { success: true, people: new URL(url, 'https://test.invalid').searchParams.get('type') === 'contact' ? [contact] : [contact, lead], total: 2 }
    : { success: true, tags: [] }))
  vi.stubGlobal('fetch', fixture.fetch)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ContactSelector lead policy', () => {
  it('keeps advanced Contact searches independent of historical Leads while disabled', async () => {
    fixture.leadsEnabled = false
    render(<ContactSelector open sourceFilter="contact" advancedFilters withoutActiveLead onClose={() => {}} onConfirm={() => {}} />)
    await waitFor(() => expect(fixture.fetch.mock.calls.some(([url]) => url.startsWith('/api/contacts?'))).toBe(true))
    fixture.fetch.mock.calls.filter(([url]) => url.startsWith('/api/contacts?')).forEach(([url]) => {
      expect(url).not.toContain('without_active_lead')
    })
  })

  it('never searches or confirms a forced Lead selector while disabled', async () => {
    fixture.leadsEnabled = false
    const confirm = vi.fn()
    render(<ContactSelector open sourceFilter="lead" onClose={() => {}} onConfirm={confirm} />)
    expect(screen.getByRole('status')).toHaveTextContent('cuando se habilite Leads')
    expect(screen.getByRole('button', { name: 'Agregar' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }))
    await act(async () => {})
    expect(fixture.fetch.mock.calls.some(([url]) => url.startsWith('/api/people/search'))).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('narrows the general selector to Contacts and clears selected Leads on revocation', async () => {
    const confirm = vi.fn()
    const props = { open: true, onClose: () => {}, onConfirm: confirm }
    const rendered = render(<ContactSelector {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Oportunidad histórica/ }))
    expect(screen.getByRole('button', { name: 'Agregar (1)' })).toBeEnabled()
    fixture.leadsEnabled = false
    rendered.rerender(<ContactSelector {...props} />)
    await waitFor(() => expect(fixture.fetch.mock.calls.filter(([url]) => url.startsWith('/api/people/search')).at(-1)?.[0]).toContain('type=contact'))
    expect(screen.queryByText('Oportunidad histórica')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Agregar' })).toBeDisabled()
    fireEvent.click(await screen.findByRole('button', { name: /Contacto canónico/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Agregar (1)' }))
    expect(confirm).toHaveBeenCalledWith([expect.objectContaining({ id: contact.id, source_type: 'contact' })])
  })

  it('aborts a previous mixed search and rejects its late completion after revocation', async () => {
    let resolveOld!: (response: Response) => void
    let oldSignal: AbortSignal | undefined
    fixture.fetch.mockImplementation((url: string, options: RequestInit) => {
      if (!url.startsWith('/api/people/search')) return Promise.resolve(json({ success: true, tags: [] }))
      if (url.includes('type=contact')) return Promise.resolve(json({ success: true, people: [contact], total: 1 }))
      oldSignal = options.signal as AbortSignal
      return new Promise<Response>(resolve => { resolveOld = resolve })
    })
    const props = { open: true, onClose: () => {}, onConfirm: vi.fn() }
    const rendered = render(<ContactSelector {...props} />)
    await waitFor(() => expect(oldSignal).toBeDefined())
    fixture.leadsEnabled = false
    rendered.rerender(<ContactSelector {...props} />)
    expect(await screen.findByRole('button', { name: /Contacto canónico/ })).toBeInTheDocument()
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => { resolveOld(json({ success: true, people: [lead], total: 1 })) })
    expect(screen.queryByText('Oportunidad histórica')).not.toBeInTheDocument()
  })
})
