import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ForwardMessageModal from './ForwardMessageModal'
import type { Chat, Message } from '@/types/chat'

const destinations = [{ id: 'target-1', device_id: 'device-1', jid: '1001@s.whatsapp.net', name: 'Destino uno' }, { id: 'target-2', device_id: 'device-1', jid: '1002@s.whatsapp.net', name: 'Destino dos' }] as Chat[]
const message = { id: 'message-1', message_id: 'wa-1', body: 'Mensaje original', message_type: 'text' } as Message
const props = { message, deviceId: 'device-1', chatId: 'source-1', onClose: vi.fn(), onSuccess: vi.fn() }
const fetchMock = vi.fn()
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

beforeEach(() => {
  props.onClose.mockReset(); props.onSuccess.mockReset()
  fetchMock.mockReset().mockImplementation(async (input: RequestInfo | URL) => response(String(input).startsWith('/api/chats?') ? { success: true, chats: destinations, total: 2 } : { success: true }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('ForwardMessageModal retained suspension', () => {
  it('retains selected destinations and search, blocks an old confirmation, and resumes explicitly', async () => {
    const view = render(<ForwardMessageModal {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
    fireEvent.change(screen.getByPlaceholderText('Buscar por nombre, teléfono...'), { target: { value: 'Destino' } })
    const button = screen.getByRole('button', { name: 'Reenviar a 1 chat' })
    const confirm = (button as any)[Object.keys(button).find(key => key.startsWith('__reactProps$'))!].onClick
    view.rerender(<ForwardMessageModal {...props} suspended />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await act(async () => { await confirm() })
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/messages/forward')).toHaveLength(0)
    view.rerender(<ForwardMessageModal {...props} />)
    expect(screen.getByPlaceholderText('Buscar por nombre, teléfono...')).toHaveValue('Destino')
    fireEvent.click(screen.getByRole('button', { name: 'Reenviar a 1 chat' }))
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledOnce())
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/messages/forward')).toHaveLength(1)
  })

  it('reconciles an already sent destination once and retains the unsent destination while suspended', async () => {
    let finishFirst!: (value: Response) => void
    let forwarded = 0
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/chats?')) return response({ success: true, chats: destinations, total: 2 })
      forwarded += 1
      if (forwarded === 1) return new Promise<Response>(resolve => { finishFirst = resolve })
      return response({ success: true })
    })
    const view = render(<ForwardMessageModal {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /Destino uno/ }))
    fireEvent.click(screen.getByRole('button', { name: /Destino dos/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Reenviar a 2 chats' }))
    await waitFor(() => expect(finishFirst).toBeTypeOf('function'))
    view.rerender(<ForwardMessageModal {...props} suspended />)
    await act(async () => finishFirst(response({ success: true })))
    expect(forwarded).toBe(1)
    expect(props.onSuccess).not.toHaveBeenCalled()
    view.rerender(<ForwardMessageModal {...props} />)
    expect(screen.getByRole('button', { name: 'Quitar Destino dos' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Quitar Destino uno' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reenviar a 1 chat' }))
    await waitFor(() => expect(props.onSuccess).toHaveBeenCalledOnce())
    expect(forwarded).toBe(2)
    const writes = fetchMock.mock.calls.filter(([url]) => url === '/api/messages/forward')
    expect(writes.map(([, init]) => JSON.parse(init.body).to)).toEqual(destinations.map(chat => chat.jid))
  })
})


it('queries the source device and disables foreign or unwritable group destinations', async () => {
  const rows = [...destinations, { id: 'foreign', device_id: 'device-2', jid: '999@s.whatsapp.net', name: 'Otro número' }, { id: 'group', kind: 'group', device_id: 'device-1', jid: '1@g.us', name: 'Anuncios', group: { subject: 'Anuncios', participant_count: 2, membership_status: 'member', announce: true, can_send: false } }]
  fetchMock.mockResolvedValue(response({ success: true, chats: rows, total: 4 }))
  render(<ForwardMessageModal {...props} />)
  expect(await screen.findByRole('button', { name: /Otro número/ })).toBeDisabled()
  expect(screen.getByRole('button', { name: /Anuncios/ })).toBeDisabled()
  expect(String(fetchMock.mock.calls[0][0])).toContain('device_ids=device-1')
})
