import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ContactSelector from '@/components/ContactSelector'

const fixture = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/components/LeadPolicyProvider', () => ({ useLeadPolicy: () => ({ leadsEnabled: true }) }))
vi.mock('@/components/FormulaEditor', () => ({ default: () => null }))
const person = { id: 'contact-1', name: 'Ana de prueba', phone: '', email: '', source_type: 'contact' }
const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response

beforeEach(() => {
  fixture.fetch.mockReset().mockImplementation(async (url: string) => json(url.startsWith('/api/people/search')
    ? { success: true, people: [person], total: 1 }
    : { success: true, tags: [] }))
  vi.stubGlobal('fetch', fixture.fetch)
  document.body.style.overflow = ''
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ContactSelector responsive suspension', () => {
  it('preserves selection and search, releases the dialog, and confirms only after resuming', async () => {
    const props = { open: true, sourceFilter: 'contact' as const, onClose: vi.fn(), onConfirm: vi.fn() }
    const view = render(<ContactSelector {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Ana de prueba/ }))
    fireEvent.change(screen.getByPlaceholderText('Buscar por nombre, teléfono, email...'), { target: { value: 'Ana' } })
    await waitFor(() => expect(fixture.fetch.mock.calls.some(([url]) => url.includes('search=Ana'))).toBe(true))
    const reads = fixture.fetch.mock.calls.length

    view.rerender(<ContactSelector {...props} suspended />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.body.style.overflow).toBe('')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.onClose).not.toHaveBeenCalled()
    expect(props.onConfirm).not.toHaveBeenCalled()
    expect(fixture.fetch).toHaveBeenCalledTimes(reads)

    view.rerender(<ContactSelector {...props} />)
    expect(screen.getByPlaceholderText('Buscar por nombre, teléfono, email...')).toHaveValue('Ana')
    fireEvent.click(screen.getByRole('button', { name: 'Agregar (1)' }))
    expect(props.onConfirm).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ id: person.id })])
    view.rerender(<ContactSelector {...props} open={false} />)
    view.rerender(<ContactSelector {...props} />)
    expect(screen.getByPlaceholderText('Buscar por nombre, teléfono, email...')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Agregar' })).toBeDisabled()
  })

  it('aborts people and metadata reads and rejects completions from the suspended generation', async () => {
    let resolvePeople!: (response: Response) => void
    let resolveTags!: (response: Response) => void
    let peopleSignal!: AbortSignal
    let metadataSignal!: AbortSignal
    let peopleRequests = 0
    let tagRequests = 0
    fixture.fetch.mockImplementation((url: string, options: RequestInit) => {
      if (url.startsWith('/api/people/search') && peopleRequests++ === 0) {
        peopleSignal = options.signal as AbortSignal
        return new Promise<Response>(resolve => { resolvePeople = resolve })
      }
      if (url === '/api/tags' && tagRequests++ === 0) {
        metadataSignal = options.signal as AbortSignal
        return new Promise<Response>(resolve => { resolveTags = resolve })
      }
      return Promise.resolve(json(url.startsWith('/api/people/search')
        ? { success: true, people: [person], total: 1 }
        : { success: true, tags: [{ id: 'current', name: 'Etiqueta vigente', color: '#008800' }] }))
    })
    const props = { open: true, sourceFilter: 'contact' as const, onClose: vi.fn(), onConfirm: vi.fn() }
    const view = render(<ContactSelector {...props} />)
    view.rerender(<ContactSelector {...props} suspended />)
    expect(peopleSignal.aborted).toBe(true)
    expect(metadataSignal.aborted).toBe(true)
    view.rerender(<ContactSelector {...props} />)
    await screen.findByRole('button', { name: /Ana de prueba/ })
    await act(async () => {
      resolvePeople(json({ success: true, people: [{ ...person, id: 'stale', name: 'Resultado obsoleto' }], total: 1 }))
      resolveTags(json({ success: true, tags: [{ id: 'stale', name: 'Etiqueta obsoleta', color: '#880000' }] }))
    })
    expect(screen.queryByText('Resultado obsoleto')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Abrir filtros de contactos' }))
    expect(await screen.findByText('Etiqueta vigente')).toBeInTheDocument()
    expect(screen.queryByText('Etiqueta obsoleta')).not.toBeInTheDocument()
  })
})
