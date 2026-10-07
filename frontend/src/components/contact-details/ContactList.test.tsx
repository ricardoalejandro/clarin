import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ reset: vi.fn(), width: 1200, listeners: new Set<(value: unknown) => void>() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: () => ({ getVirtualItems: () => [], getTotalSize: () => 0, measureElement: () => {} }) }))
vi.mock('@/components/offline-v5/ClarinRuntimeProvider', () => ({ useClarinRuntime: () => ({ requireOnline: () => true }) }))
vi.mock('@/components/responsive/useContainerWidth', () => ({ useContainerWidth: () => ({ ref: { current: null }, width: mocks.width }) }))
vi.mock('@/components/crm-detail/useCrmWindowStorageScope', () => ({ default: () => 'synthetic-scope' }))
vi.mock('@/hooks/useWhatsAppChatLauncher', () => ({ default: () => ({ reset: mocks.reset, close: mocks.reset, chatOpen: false, showDeviceSelector: false, chat: null, device: null }) }))
vi.mock('@/lib/api', () => ({ subscribeWebSocket: (listener: (value: unknown) => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener) } }))
vi.mock('@/components/ImportCSVModal', () => ({ default: () => null }))
vi.mock('@/components/TagInput', () => ({ default: () => null }))
vi.mock('@/components/CreateCampaignModal', () => ({ default: () => null }))
vi.mock('@/components/CreateContactModal', () => ({ default: () => null }))
vi.mock('@/components/PasteFromExcelModal', () => ({ default: () => null }))
vi.mock('@/components/contact-details/ContactDetailSurface', () => ({ default: ({ contactId }: { contactId: string }) => <div data-testid="canonical-contact-detail">{contactId}</div> }))
vi.mock('@/components/chat/ChatPanel', () => ({ default: () => null }))
vi.mock('@/components/WhatsAppDevicePicker', () => ({ default: () => null }))
vi.mock('@/components/operational-window/OperationalWindowShell', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('@/components/crm-detail/CrmDetailWorkspace', () => ({ default: ({ detail }: { detail: ReactNode }) => <div>{detail}</div> }))
vi.mock('@/components/FormulaEditor', () => ({ default: () => null }))
vi.mock('@/components/BulkGenerateDocumentModal', () => ({ default: () => null }))

import ContactsPage from '@/app/dashboard/contacts/page'
import { beginAuthIdentityChange, completeAuthIdentityChange } from '@/lib/authScope'

const definition = { id: 'synthetic-field-1', name: 'Calidad QA', slug: 'calidad_qa', field_type: 'text', config: {}, sort_order: 0 }
let requestUrls: string[] = []
beforeEach(() => {
  mocks.width = 1200
  window.history.replaceState({}, '', '/dashboard/contacts')
  localStorage.clear()
  localStorage.setItem('token', 'synthetic-audit-token')
  requestUrls = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    requestUrls.push(url)
    let body: unknown = { success: true }
    if (url.startsWith('/api/contacts?')) body = { success: true, contacts: [], total: 0 }
    if (url === '/api/devices') body = { success: true, devices: [] }
    if (url === '/api/tags') body = { success: true, tags: [] }
    if (url === '/api/custom-fields') body = { success: true, definitions: [definition] }
    if (url === '/api/google/status') body = { success: true, connected: false }
    return { ok: true, status: 200, json: async () => body } as Response
  }))
})

describe('Contact deep links and identity initialization', () => {
  it('keeps the initial contact intent until the current request opens the canonical detail', async () => {
    window.history.replaceState({}, '', '/dashboard/contacts?contact_id=synthetic-contact&keep=1')
    const base = vi.mocked(fetch).getMockImplementation()!
    const requests: Array<{ resolve: (response: Response) => void; signal: AbortSignal | null | undefined }> = []
    vi.mocked(fetch).mockImplementation((input, init) => String(input) === '/api/contacts/synthetic-contact'
      ? new Promise<Response>(resolve => { requests.push({ resolve, signal: init?.signal }) })
      : base(input, init))
    render(<StrictMode><ContactsPage /></StrictMode>)
    await waitFor(() => expect(requests.length).toBeGreaterThan(0))
    expect(new URLSearchParams(window.location.search).get('contact_id')).toBe('synthetic-contact')
    await act(async () => {
      requests.forEach(request => request.resolve({ ok: true, json: async () => ({ success: true, contact: { id: 'synthetic-contact', name: 'Synthetic contact', tags: [], structured_tags: [] } }) } as Response))
    })
    expect(await screen.findByTestId('canonical-contact-detail')).toHaveTextContent('synthetic-contact')
    expect(new URLSearchParams(window.location.search).has('contact_id')).toBe(false)
    expect(new URLSearchParams(window.location.search).get('keep')).toBe('1')
  })

  it('aborts the old account request and rejects its completion while preserving a new account request', async () => {
    window.history.replaceState({}, '', '/dashboard/contacts?contact_id=synthetic-contact')
    const base = vi.mocked(fetch).getMockImplementation()!
    const requests: Array<{ resolve: (response: Response) => void; signal: AbortSignal | null | undefined }> = []
    vi.mocked(fetch).mockImplementation((input, init) => String(input) === '/api/contacts/synthetic-contact'
      ? new Promise<Response>(resolve => { requests.push({ resolve, signal: init?.signal }) })
      : base(input, init))
    render(<ContactsPage />)
    await waitFor(() => expect(requests).toHaveLength(1))
    await act(async () => { beginAuthIdentityChange() })
    expect(requests[0].signal?.aborted).toBe(true)
    await act(async () => { completeAuthIdentityChange() })
    await waitFor(() => expect(requests).toHaveLength(2))
    await act(async () => {
      requests[0].resolve({ ok: true, json: async () => ({ success: true, contact: { id: 'synthetic-contact', name: 'Old account' } }) } as Response)
    })
    expect(screen.queryByTestId('canonical-contact-detail')).not.toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('contact_id')).toBe('synthetic-contact')
    await act(async () => {
      requests[1].resolve({ ok: true, json: async () => ({ success: true, contact: { id: 'synthetic-contact', name: 'Current account', tags: [], structured_tags: [] } }) } as Response)
    })
    expect(await screen.findByTestId('canonical-contact-detail')).toHaveTextContent('synthetic-contact')
    expect(window.location.search).toBe('')
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); mocks.listeners.clear() })

describe('mobile Contact actions portal', () => {
  it('keeps a portaled action mounted through mousedown and opens the export dialog on click', async () => {
    mocks.width = 375
    render(<ContactsPage />)
    await screen.findByText('Contactos')
    fireEvent.click(screen.getByTitle('Más acciones'))
    const menu = screen.getByRole('dialog', { name: 'Más acciones de contactos' })
    const exportAction = within(menu).getByRole('button', { name: 'Exportar contactos' })

    fireEvent.mouseDown(exportAction)
    expect(menu).toBeInTheDocument()
    fireEvent.mouseUp(exportAction)
    fireEvent.click(exportAction)

    expect(await screen.findByRole('heading', { name: 'Exportar Contactos' })).toBeVisible()
    expect(screen.queryByRole('dialog', { name: 'Más acciones de contactos' })).not.toBeInTheDocument()
  })

  it('dismisses the portaled actions on an outside mousedown and keeps the trigger usable', async () => {
    mocks.width = 375
    render(<ContactsPage />)
    await screen.findByText('Contactos')
    const trigger = screen.getByTitle('Más acciones')
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Más acciones de contactos' })).toBeVisible()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'Más acciones de contactos' })).not.toBeInTheDocument()
    fireEvent.mouseDown(trigger)
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Más acciones de contactos' })).toBeVisible()
    fireEvent.mouseDown(within(screen.getByRole('dialog', { name: 'Más acciones de contactos' })).getByRole('button', { name: 'Cerrar acciones' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar acciones' }))
    expect(screen.queryByRole('dialog', { name: 'Más acciones de contactos' })).not.toBeInTheDocument()
  })
})

describe('applied Contact list filters and columns', () => {
  it('debounces exactly 500 ms, aborts a predecessor, and accepts a fresh A after A → B → A', async () => {
    const base = vi.mocked(fetch).getMockImplementation()!
    let resolveStale!: (response: Response) => void
    let firstSignal: AbortSignal | undefined
    let aRequests = 0
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/contacts?') && new URL(url, 'http://test.invalid').searchParams.get('search') === 'A') {
        aRequests += 1
        if (aRequests === 1) { firstSignal = options?.signal || undefined; return new Promise<Response>(resolve => { resolveStale = resolve }) }
        return Promise.resolve({ ok: true, json: async () => ({ success: true, contacts: [], total: 7 }) } as Response)
      }
      return base(input, options)
    })
    render(<ContactsPage />)
    await screen.findByText('Contactos')
    vi.useFakeTimers()
    const input = screen.getByPlaceholderText('Buscar por nombre, teléfono, email...')
    fireEvent.change(input, { target: { value: 'A' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(499) })
    expect(aRequests).toBe(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(aRequests).toBe(1)
    fireEvent.change(input, { target: { value: 'B' } })
    expect(firstSignal?.aborted).toBe(true)
    fireEvent.change(input, { target: { value: 'A' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(aRequests).toBe(2)
    expect(screen.getByText('Mostrando 0 de 7 contactos')).toBeVisible()
    await act(async () => { resolveStale({ ok: true, json: async () => ({ success: true, contacts: [], total: 999 }) } as Response) })
    expect(screen.getByText('Mostrando 0 de 7 contactos')).toBeVisible()
  })
  it('applying only a custom field filter must query the server with cf_filter', async () => {
    render(<ContactsPage />)
    await screen.findByText('Contactos')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)) })
    fireEvent.focus(screen.getByPlaceholderText('Buscar por nombre, teléfono, email...'))
    const fieldsLabel = await screen.findByText('Campos')
    const addFilter = fieldsLabel.parentElement?.parentElement?.querySelector('button')
    expect(addFilter).toBeTruthy()
    fireEvent.click(addFilter!)
    fireEvent.change(screen.getByPlaceholderText('Valor...'), { target: { value: 'AuditValue' } })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)) })
    expect(requestUrls.some(url => url.includes('cf_filter='))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }))
    await waitFor(() => expect(requestUrls.some(url => url.startsWith('/api/contacts?') && url.includes('cf_filter='))).toBe(true))
  })

  it('showing a custom field column must query canonical custom_field_values', async () => {
    render(<ContactsPage />)
    await screen.findByText('Contactos')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)) })
    fireEvent.click(await screen.findByTitle('Columnas personalizadas'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Calidad QA' }))
    await waitFor(() => expect(requestUrls.some(url => url.startsWith('/api/contacts?') && url.includes('include_custom_fields=true'))).toBe(true))
  })
})
