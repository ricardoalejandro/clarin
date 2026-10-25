import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ForwardMessageModal from './ForwardMessageModal'
import { beginAuthIdentityChange, completeAuthIdentityChange } from '@/lib/authScope'
import type { Chat, Message } from '@/types/chat'

const destinations = [{ id: 'target-1', device_id: 'device-1', jid: '1001@s.whatsapp.net', name: 'Destino uno' }, { id: 'target-2', device_id: 'device-1', jid: '1002@s.whatsapp.net', name: 'Destino dos' }, { id: 'group', kind: 'group', device_id: 'device-1', jid: '1@g.us', name: 'Grupo disponible', group: { can_send: true } }] as Chat[]
const message = { id: 'message-1', device_id: 'device-1', message_id: 'wa-1', body: 'Mensaje original', message_type: 'text', status: 'sent', forwarding: { state: 'not_forwarded', score: 0 } } as Message
const props = { nativeForwardEnabled: true, message, deviceId: 'device-1', chatId: 'source-1', onClose: vi.fn(), onSuccess: vi.fn() }
const fetchMock = vi.fn()
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const writes = () => fetchMock.mock.calls.filter(([url, init]) => url === '/api/messages/forward/batch' && init?.method === 'POST')
const receipt = (request: any, state = 'sent') => ({ success: true, mode: request.mode ?? 'native', content_variant: request.content_variant ?? 'original', operation_id: request.client_operation_id, complete: state === 'sent', results: request.destination_chat_ids.map((chat_id: string) => ({ chat_id, state })) })

beforeEach(() => {
  sessionStorage.clear(); completeAuthIdentityChange()
  props.onClose.mockReset(); props.onSuccess.mockReset()
  fetchMock.mockReset().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith('/api/chats?') ? response({ success: true, chats: destinations, total: destinations.length }) : response(receipt(JSON.parse(String(init?.body)))))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('canonical forwarding batch', () => {
  it('queries both groups and private chats for the source device, then sends one canonical batch', async () => {
    render(<ForwardMessageModal {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
    fireEvent.click(screen.getByRole('button', { name: /Grupo disponible/ }))
    expect(String(fetchMock.mock.calls[0][0])).toContain('device_ids=device-1')
    expect(String(fetchMock.mock.calls[0][0])).toContain('kind=all')
    const button = screen.getByRole('button', { name: 'Reenviar a 2 chats' })
    fireEvent.click(button); fireEvent.click(button)
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledOnce())
    expect(writes()).toHaveLength(1)
    expect(JSON.parse(writes()[0][1].body)).toEqual({ mode: 'native', content_variant: 'original', source_chat_id: 'source-1', source_message_id: 'message-1', device_id: 'device-1', destination_chat_ids: ['target-1', 'group'], client_operation_id: expect.any(String) })
  })
  it('does not send an old confirmation while suspended and retains selection on return', async () => {
    const view = render(<ForwardMessageModal {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
    const button = screen.getByRole('button', { name: 'Reenviar a 1 chat' })
    const confirm = (button as any)[Object.keys(button).find(key => key.startsWith('__reactProps$'))!].onClick
    view.rerender(<ForwardMessageModal {...props} suspended />)
    await act(async () => { await confirm() })
    expect(writes()).toHaveLength(0)
    view.rerender(<ForwardMessageModal {...props} />)
    expect(screen.getByRole('button', { name: 'Quitar Destino uno' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reenviar a 1 chat' }))
    await waitFor(() => expect(writes()).toHaveLength(1))
  })
  it('keeps an uncertain operation across close/reopen and checks state without sending another copy', async () => {
    let original: any
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).startsWith('/api/chats?')) return response({ success: true, chats: destinations, total: 3 })
      if (init?.method === 'POST') { original = JSON.parse(init.body); throw new Error('Respuesta perdida') }
      return response(receipt(original))
    })
    const view = render(<ForwardMessageModal {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Reenviar a 1 chat' }))
    expect(await screen.findByRole('button', { name: 'Comprobar estado' })).toBeInTheDocument()
    await screen.findByText('Respuesta perdida')
    view.unmount()
    render(<ForwardMessageModal {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Comprobar estado' }))
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledOnce())
    expect(writes()).toHaveLength(1)
    expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/messages/forward/batch/' + original.client_operation_id && !init?.method)).toBe(true)
  })
  it('confirms a lost unregistered operation with exactly the same identifier and destinations', async () => {
    let first = true
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).startsWith('/api/chats?')) return response({ success: true, chats: destinations, total: 3 })
      if (!init?.method) return response({ success: false, code: 'forward_operation_not_found' }, 404)
      const request = JSON.parse(init.body)
      if (first) { first = false; throw new Error('Conexión perdida') }
      return response(receipt(request))
    })
    render(<ForwardMessageModal {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Reenviar a 1 chat' }))
    await screen.findByText('Conexión perdida')
    fireEvent.click(screen.getByRole('button', { name: 'Comprobar estado' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar la misma operación' }))
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledOnce())
    expect(writes()).toHaveLength(2)
    expect(JSON.parse(writes()[0][1].body)).toEqual(JSON.parse(writes()[1][1].body))
  })
  it('waits exactly 500ms after typing or clearing while updating the input immediately', async () => {
    render(<ForwardMessageModal {...props} />)
    await screen.findByRole('button', { name: /Destino uno/ })
    vi.useFakeTimers()
    const before = fetchMock.mock.calls.length
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Uno' } })
    await act(async () => vi.advanceTimersByTime(499))
    expect(fetchMock).toHaveBeenCalledTimes(before)
    await act(async () => vi.advanceTimersByTime(1))
    expect(fetchMock).toHaveBeenCalledTimes(before + 1)
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('search=Uno')
    fireEvent.click(screen.getByRole('button', { name: 'Limpiar búsqueda de chats' }))
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-busy', 'true')
    await act(async () => vi.advanceTimersByTime(499))
    expect(fetchMock).toHaveBeenCalledTimes(before + 1)
    await act(async () => vi.advanceTimersByTime(1))
    expect(fetchMock).toHaveBeenCalledTimes(before + 2)
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).not.toContain('search=')
  })
  it('applies one-group and one-chat limits and disables another sender or blocked destinations', async () => {
    const extra = { ...destinations[2], id: 'group-2', name: 'Otro grupo', jid: '2@g.us' }
    fetchMock.mockImplementation(async () => response({ success: true, chats: [...destinations, extra, { ...destinations[0], id: 'foreign', name: 'Otro dispositivo', device_id: 'device-2' }], total: 5 }))
    const forwarded = { ...message, forwarding: { state: 'forwarded' as const, score: 1 } }
    const view = render(<ForwardMessageModal {...props} message={forwarded} />)
    fireEvent.click(await screen.findByRole('button', { name: /Grupo disponible/ }))
    expect(screen.getByRole('button', { name: /Otro grupo/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Otro dispositivo/ })).toBeDisabled()
    view.unmount()
    render(<ForwardMessageModal {...props} message={{ ...message, forwarding: { state: 'frequently_forwarded', score: 5 } }} />)
    fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
    expect(screen.getByRole('button', { name: /Destino dos/ })).toBeDisabled()
  })
  it('invalidates in-flight queries and old actions during an account or source switch', async () => {
    const view = render(<ForwardMessageModal {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
    view.rerender(<ForwardMessageModal {...props} chatId="other-source" />)
    expect(screen.queryByRole('button', { name: 'Quitar Destino uno' })).not.toBeInTheDocument()
    await act(async () => { beginAuthIdentityChange() })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(writes()).toHaveLength(0)
  })
  it('offers an explicit copy for historical unknown content while still rejecting view-once content', async () => {
    const view = render(<ForwardMessageModal {...props} message={{ ...message, forwarding: { state: 'unknown', score: null } }} />)
    expect(screen.getByRole('button', { name: 'Reenvío de WhatsApp' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Enviar una copia' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/sin la etiqueta de reenvío de WhatsApp/)).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Enviar copia a 1 chat' }))
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledOnce())
    expect(JSON.parse(writes()[0][1].body)).toMatchObject({ mode: 'copy', content_variant: 'original' })
    view.unmount()
    fetchMock.mockClear()
    render(<ForwardMessageModal {...props} message={{ ...message, is_view_once: true }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('única')
    expect(screen.getByRole('button', { name: 'Enviar copia a 0 chats' })).toBeDisabled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})


it('retries only proven unsent destinations after a deliberate action, using a new operation', async () => {
  let batches = 0
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input).startsWith('/api/chats?')) return response({ success: true, chats: destinations, total: 3 })
    const request = JSON.parse(init.body)
    batches++
    if (batches === 1) return response({ success: true, operation_id: request.client_operation_id, complete: true, results: [{ chat_id: 'target-1', state: 'sent' }, { chat_id: 'target-2', state: 'failed', can_retry: true, error: 'El dispositivo no estaba conectado antes del envío.' }] })
    return response(receipt(request))
  })
  render(<ForwardMessageModal {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
  fireEvent.click(screen.getByRole('button', { name: /Destino dos/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Reenviar a 2 chats' }))
  const retry = await screen.findByRole('button', { name: 'Reintentar solo los destinos no enviados' })
  expect(writes()).toHaveLength(1)
  expect(screen.getByText('Enviado')).toBeInTheDocument()
  fireEvent.click(retry)
  await waitFor(() => expect(props.onSuccess).toHaveBeenCalledOnce())
  const submitted = writes().map(([, init]) => JSON.parse(init.body))
  expect(submitted[1].destination_chat_ids).toEqual(['target-2'])
  expect(submitted[1].client_operation_id).not.toBe(submitted[0].client_operation_id)
})

it('retains an operation conflict for checking rather than preparing a fresh copy', async () => {
  fetchMock.mockImplementation(async (input) => String(input).startsWith('/api/chats?') ? response({ success: true, chats: destinations, total: 3 }) : response({ success: false, code: 'forward_operation_conflict', error: 'La operación ya existe.' }, 409))
  render(<ForwardMessageModal {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Reenviar a 1 chat' }))
  expect(await screen.findByText('La operación ya existe.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Comprobar estado' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Reenviar a 1 chat' })).not.toBeInTheDocument()
})

it('aborts on clear and discards the late response while loading bounded pages explicitly', async () => {
  let stale!: (value: Response) => void
  let staleSignal: AbortSignal | undefined
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.includes('search=Anterior')) { staleSignal = init.signal; return new Promise<Response>(resolve => { stale = resolve }) }
    if (url.includes('offset=3')) return response({ success: true, chats: [{ ...destinations[0], id: 'page-2', name: 'Página siguiente' }], total: 4 })
    return response({ success: true, chats: destinations, total: 4 })
  })
  render(<ForwardMessageModal {...props} />)
  await screen.findByRole('button', { name: /Destino uno/ })
  fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }))
  expect(await screen.findByRole('button', { name: /Página siguiente/ })).toBeInTheDocument()
  vi.useFakeTimers()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Anterior' } })
  await act(async () => vi.advanceTimersByTime(500))
  const beforeClear = fetchMock.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: 'Limpiar búsqueda de chats' }))
  expect(screen.getByRole('textbox')).toHaveValue('')
  expect(staleSignal?.aborted).toBe(true)
  await act(async () => vi.advanceTimersByTime(499))
  expect(fetchMock).toHaveBeenCalledTimes(beforeClear)
  await act(async () => vi.advanceTimersByTime(1))
  expect(fetchMock).toHaveBeenCalledTimes(beforeClear + 1)
  await act(async () => stale(response({ success: true, chats: [{ ...destinations[0], id: 'stale', name: 'Obsoleto' }], total: 1 })))
  expect(screen.queryByRole('button', { name: /Obsoleto/ })).not.toBeInTheDocument()
})


it('bounds a stalled submission and preserves its uncertain identity without auto-resending', async () => {
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input).startsWith('/api/chats?')) return response({ success: true, chats: destinations, total: 3 })
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
  })
  render(<ForwardMessageModal {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole('button', { name: 'Reenviar a 1 chat' }))
  expect(screen.getByRole('button', { name: 'Cerrar reenvío' })).toBeDisabled()
  await act(async () => vi.advanceTimersByTime(45000))
  expect(screen.getByRole('button', { name: 'Comprobar estado' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Cerrar reenvío' })).toBeEnabled()
  expect(screen.getByRole('alert')).toHaveTextContent('El resultado está pendiente')
  expect(writes()).toHaveLength(1)
})


it('clears only a terminal failed operation through an explicit close-and-refresh action', async () => {
  fetchMock.mockImplementation(async (input, init) => String(input).startsWith('/api/chats?') ? response({ success: true, chats: destinations, total: 3 }) : response({ success: true, operation_id: JSON.parse(init.body).client_operation_id, complete: true, results: [{ chat_id: 'target-1', state: 'failed', code: 'forward_source_changed', error: 'El mensaje cambió; vuelve a prepararlo.', can_retry: false }] }))
  const view = render(<ForwardMessageModal {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Reenviar a 1 chat' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Cerrar y actualizar' }))
  expect(writes()).toHaveLength(1)
  expect(props.onSuccess).toHaveBeenCalledOnce()
  expect(props.onClose).toHaveBeenCalledOnce()
  view.unmount()
  render(<ForwardMessageModal {...props} />)
  expect(await screen.findByRole('button', { name: /Destino uno/ })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Comprobar estado' })).not.toBeInTheDocument()
})


it('offers copying when native is unavailable and preserves read-only native operation checks after revocation', async () => {
  const view = render(<ForwardMessageModal {...props} nativeForwardEnabled={undefined} />)
  expect(screen.getByRole('button', { name: 'Reenvío de WhatsApp' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Enviar una copia' })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
  expect(screen.getByRole('button', { name: 'Enviar copia a 1 chat' })).toBeEnabled()
  expect(writes()).toHaveLength(0)
  view.unmount()
  let request: any
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input).startsWith('/api/chats?')) return response({ success: true, chats: destinations, total: 3 })
    if (init?.method === 'POST') { request = JSON.parse(init.body); return response(receipt(request, 'uncertain')) }
    return response(receipt(request))
  })
  const allowed = render(<ForwardMessageModal {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Reenviar a 1 chat' }))
  await screen.findByText('Resultado por comprobar')
  allowed.rerender(<ForwardMessageModal {...props} nativeForwardEnabled={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'Comprobar estado' }))
  await waitFor(() => expect(props.onSuccess).toHaveBeenCalledOnce())
  expect(writes()).toHaveLength(1)
})


it('rejects a stale confirmation after the native capability is revoked', async () => {
  const view = render(<ForwardMessageModal {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
  const button = screen.getByRole('button', { name: 'Reenviar a 1 chat' })
  const confirm = (button as any)[Object.keys(button).find(key => key.startsWith('__reactProps$'))!].onClick
  view.rerender(<ForwardMessageModal {...props} nativeForwardEnabled={false} />)
  await act(async () => { await confirm() })
  expect(writes()).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'Reenviar a 1 chat' })).toBeDisabled()
})

it('locks native send after a canonical unverified-capability rejection without creating a pending copy', async () => {
  fetchMock.mockImplementation(async (input) => String(input).startsWith('/api/chats?') ? response({ success: true, chats: destinations, total: 3 }) : response({ success: false, code: 'forward_capability_unverified', error: 'El reenvío nativo aún no está verificado para este dispositivo.' }, 503))
  render(<ForwardMessageModal {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Reenviar a 1 chat' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Reenviar a 1 chat' })).toBeDisabled())
  expect(screen.queryByRole('button', { name: 'Comprobar estado' })).not.toBeInTheDocument()
  expect(writes()).toHaveLength(1)
})


describe('explicit content copies', () => {
  it('sends a historical image copy with native off using only the canonical source identifiers', async () => {
    render(<ForwardMessageModal {...props} nativeForwardEnabled={false} message={{ ...message, forwarding: undefined, message_type: 'image', media_url: '/api/media/file/account/image', body: 'Leyenda conservada' }} />)
    fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
    expect(screen.getByText('Leyenda conservada')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Enviar copia a 1 chat' }))
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledOnce())
    const request = JSON.parse(writes()[0][1].body)
    expect(request).toMatchObject({ mode: 'copy', content_variant: 'original', source_chat_id: 'source-1', source_message_id: 'message-1', device_id: 'device-1' })
    expect(request).not.toHaveProperty('body')
    expect(request).not.toHaveProperty('media_url')
    expect(writes()).toHaveLength(1)
  })
  it('requires an explicit attachment choice for audio whose PTT is unknown and restores the immutable variant', async () => {
    let request: any
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).startsWith('/api/chats?')) return response({ success: true, chats: destinations, total: 3 })
      request = JSON.parse(init.body)
      return response(receipt(request, 'uncertain'))
    })
    const audioProps = { ...props, nativeForwardEnabled: false, message: { ...message, forwarding: undefined, message_type: 'audio', media_url: '/api/media/file/account/audio', audio_ptt: undefined } }
    const view = render(<ForwardMessageModal {...audioProps} />)
    const attachment = screen.getByRole('checkbox', { name: /Enviar como archivo adjunto/ })
    expect(attachment).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Enviar copia a 0 chats' })).toBeDisabled()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(attachment)
    fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Enviar copia a 1 chat' }))
    await screen.findByText('Resultado por comprobar')
    expect(request).toMatchObject({ mode: 'copy', content_variant: 'audio_document' })
    view.unmount()
    render(<ForwardMessageModal {...audioProps} />)
    expect(screen.getByRole('checkbox', { name: /Enviar como archivo adjunto/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Enviar como archivo adjunto/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Enviar una copia' })).toBeDisabled()
    expect(writes()).toHaveLength(1)
  })
  it('permits a deliberate copy choice for a known original without performing an implicit fallback', async () => {
    render(<ForwardMessageModal {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Enviar una copia' }))
    expect(screen.getByRole('button', { name: 'Enviar una copia' })).toHaveAttribute('aria-pressed', 'true')
    expect(writes()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Enviar copia a 1 chat' }))
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledOnce())
    expect(JSON.parse(writes()[0][1].body)).toMatchObject({ mode: 'copy', content_variant: 'original' })
  })
  it('does not change a pending native operation into a copy after capability revocation or reopen', async () => {
    fetchMock.mockImplementation(async (input, init) => String(input).startsWith('/api/chats?') ? response({ success: true, chats: destinations, total: 3 }) : response(receipt(JSON.parse(init.body), 'uncertain')))
    const view = render(<ForwardMessageModal {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Reenviar a 1 chat' }))
    await screen.findByText('Resultado por comprobar')
    view.unmount()
    render(<ForwardMessageModal {...props} nativeForwardEnabled={false} />)
    expect(screen.getByRole('button', { name: 'Reenvío de WhatsApp' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Enviar una copia' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Enviar una copia' }))
    expect(screen.getByRole('button', { name: 'Comprobar estado' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Enviar copia a 1 chat' })).not.toBeInTheDocument()
    expect(writes()).toHaveLength(1)
  })
  it('applies inherited one-chat restrictions to an unmarked copy and rejects stale copy confirmation when the device becomes unavailable', async () => {
    const copyMessage = { ...message, is_from_me: true, sharing_limits: { max_chats: 1 as const, max_groups: 1 as const } }
    const view = render(<ForwardMessageModal {...props} nativeForwardEnabled={false} message={copyMessage} />)
    fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
    expect(screen.getByRole('button', { name: /Destino dos/ })).toBeDisabled()
    const button = screen.getByRole('button', { name: 'Enviar copia a 1 chat' })
    const confirm = (button as any)[Object.keys(button).find(key => key.startsWith('__reactProps$'))!].onClick
    view.rerender(<ForwardMessageModal {...props} nativeForwardEnabled={false} copyEnabled={false} message={copyMessage} />)
    await act(async () => { await confirm() })
    expect(writes()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Enviar copia a 1 chat' })).toBeDisabled()
  })
})
