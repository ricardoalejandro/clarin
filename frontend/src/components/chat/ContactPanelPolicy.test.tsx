import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LeadPolicyProvider, type LeadPolicyState } from '@/components/LeadPolicyProvider'
import ContactPanel from './ContactPanel'

vi.mock('@/components/LeadDetailPanel', () => ({ default: ({ lead, onArchive }: any) => <div><span>Detalle {lead.title}</span><button onClick={() => onArchive(lead.id, true)}>Archivar oportunidad de prueba</button></div> }))
vi.mock('@/components/contact-details/ContactDetailSurface', async () => {
  const { forwardRef, useImperativeHandle, useState } = await import('react')
  return { default: forwardRef(function Detail({ contextContent, onSendMessage }: any, ref) {
    const [draft, setDraft] = useState('')
    useImperativeHandle(ref, () => ({ canClose: () => true, requestClose: () => true }))
    return <><input aria-label="Borrador de contacto" value={draft} onChange={event => setDraft(event.target.value)} /><button onClick={onSendMessage}>Mensaje</button>{contextContent}</>
  }) }
})
const contact = { id: 'contact-1', name: 'Contacto conservado', phone: '51999999999', is_group: false }
const lead = { id: 'lead-1', title: 'Oportunidad vigente', status: 'open', contact_id: contact.id }
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
function deferred() { let resolve!: (value: Response) => void; const promise = new Promise<Response>(next => { resolve = next }); return { promise, resolve } }
const state = (enabled: boolean): LeadPolicyState => ({ ready: true, policy: null, leadsEnabled: enabled, automationEnabled: enabled, error: '', refresh: vi.fn() })
const view = (enabled: boolean) => <LeadPolicyProvider value={state(enabled)}><ContactPanel chatId="chat-1" isOpen onClose={vi.fn()} onFocusConversation={vi.fn()} /></LeadPolicyProvider>
beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => response({ success: true, contact, opportunities: [lead], lead }))))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Chat Contact Lead policy transitions', () => {
  it('keeps Contact and messaging usable without reading fallback commercial data while disabled', async () => {
    vi.mocked(fetch).mockImplementation(async () => response({ success: true, contact, lead }))
    render(view(false))
    expect(await screen.findByRole('textbox', { name: 'Borrador de contacto' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Mensaje' })).toBeEnabled()
    expect(screen.queryByText('Contexto comercial')).not.toBeInTheDocument()
    expect(screen.queryByText('Detalle Oportunidad vigente')).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('hides commercial data immediately and preserves the exact Contact draft through disable and re-enable', async () => {
    const pending = deferred()
    let reads = 0
    vi.mocked(fetch).mockImplementation(async () => ++reads === 2 ? pending.promise : response({ success: true, contact, opportunities: [lead], lead }))
    const { rerender } = render(view(true))
    expect(await screen.findByText('Detalle Oportunidad vigente')).toBeVisible()
    const draft = screen.getByRole('textbox', { name: 'Borrador de contacto' })
    fireEvent.change(draft, { target: { value: 'Mi nota permanece' } })
    rerender(view(false))
    expect(screen.queryByText('Contexto comercial')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Borrador de contacto' })).toBe(draft)
    rerender(view(true))
    expect(await screen.findByText('Detalle Oportunidad vigente')).toBeVisible()
    await act(async () => { pending.resolve(response({ success: true, contact: null, opportunities: [] })); await pending.promise })
    expect(screen.getByRole('textbox', { name: 'Borrador de contacto' })).toBe(draft)
    expect(draft).toHaveValue('Mi nota permanece')
    expect(screen.getByText('Detalle Oportunidad vigente')).toBeVisible()
  })

  it('aborts an opportunity query on toggle and rejects its late completion after re-enable', async () => {
    const pending = deferred()
    let pendingSignal: AbortSignal | undefined
    let reads = 0
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      if (String(input).includes('/opportunities/')) { pendingSignal = options?.signal as AbortSignal; return pending.promise }
      reads++
      return response({ success: true, contact, opportunities: reads === 3 ? [lead] : [], ...(reads === 1 ? { lead, opportunities: [lead] } : {}) })
    })
    const { rerender } = render(view(true))
    await screen.findByText('Detalle Oportunidad vigente')
    const draft = screen.getByRole('textbox', { name: 'Borrador de contacto' })
    fireEvent.change(draft, { target: { value: 'Sin perder contacto' } })
    rerender(view(false)); await waitFor(() => expect(reads).toBe(2))
    rerender(view(true)); await waitFor(() => expect(pendingSignal).toBeDefined())
    rerender(view(false)); expect(pendingSignal?.aborted).toBe(true)
    rerender(view(true)); await waitFor(() => expect(reads).toBe(5))
    await act(async () => { pending.resolve(response({ success: true, lead })); await pending.promise })
    expect(screen.queryByText('Detalle Oportunidad vigente')).not.toBeInTheDocument()
    expect(screen.getByText('Sin oportunidades')).toBeVisible()
    expect(draft).toHaveValue('Sin perder contacto')
  })

  it('aborts creation when disabled and does not refresh or select its late result', async () => {
    const pending = deferred()
    let mutationSignal: AbortSignal | undefined
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (_input, options) => {
      if (options?.method === 'POST') { mutationSignal = options.signal as AbortSignal; return pending.promise }
      return response({ success: true, contact, opportunities: [] })
    })
    const { rerender } = render(view(true))
    fireEvent.click(await screen.findByRole('button', { name: 'Crear' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Concepto de la oportunidad' }), { key: 'Enter' })
    await waitFor(() => expect(mutationSignal).toBeDefined())
    rerender(view(false)); expect(mutationSignal?.aborted).toBe(true)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    await act(async () => { pending.resolve(response({ success: true, lead })); await pending.promise })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(screen.queryByText('Contexto comercial')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Borrador de contacto' })).toBeVisible()
  })

  it('aborts an open archive confirmation and ignores a late success after the module is disabled', async () => {
    const pending = deferred()
    let mutationSignal: AbortSignal | undefined
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (_input, options) => {
      if (options?.method === 'PATCH') { mutationSignal = options.signal as AbortSignal; return pending.promise }
      return response({ success: true, contact, opportunities: [lead], lead })
    })
    const { rerender } = render(view(true))
    fireEvent.click(await screen.findByRole('button', { name: 'Archivar oportunidad de prueba' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Otro motivo' }), { target: { value: 'Archivo solicitado' } })
    fireEvent.click(screen.getByRole('button', { name: 'Archivar oportunidad' }))
    await waitFor(() => expect(mutationSignal).toBeDefined())
    rerender(view(false))
    expect(mutationSignal?.aborted).toBe(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    await act(async () => { pending.resolve(response({ success: true, lead })); await pending.promise })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(screen.queryByText('Contexto comercial')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Borrador de contacto' })).toBeVisible()
  })
})
