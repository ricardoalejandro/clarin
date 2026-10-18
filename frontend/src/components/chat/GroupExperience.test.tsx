import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Chat, Message } from '@/types/chat'
import GroupDetailsPanel from './GroupDetailsPanel'
import MessageInfoDialog from './MessageInfoDialog'
import MessageBubble from './MessageBubble'
vi.mock('@/lib/api', () => ({ subscribeWebSocket: () => () => {} }))
const group: Chat = { id: 'group', kind: 'group', jid: '120000@g.us', name: 'Comunidad', unread_count: 0, last_message: '', last_message_at: '', group: { subject: 'Comunidad', participant_count: 2, membership_status: 'member', announce: false, can_send: true } }
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })
describe('group surfaces', () => {
  it('renders participant authors and quoted authors instead of the group name, including emoji', () => {
    const message = { id: 'message', message_id: 'provider', from_jid: '51@s.whatsapp.net', from_name: 'María', is_from_me: false, body: 'Hola', message_type: 'text', timestamp: '2026-10-18T12:00:00Z', quoted_message_id: 'quote', quoted_sender: '52@s.whatsapp.net', quoted_sender_name: 'José', quoted_body: 'Mensaje anterior' } as Message
    render(<MessageBubble message={message} isGroup contactName="No mostrar grupo" />)
    expect(screen.getByText('María')).toBeInTheDocument(); expect(screen.getByText('José')).toBeInTheDocument(); expect(screen.queryByText('No mostrar grupo')).toBeNull()
  })
  it('loads bounded member pages and exposes no CRM identity or opportunity actions', async () => {
    const fetcher = vi.fn((input: RequestInfo | URL) => Promise.resolve(response(String(input).includes('/participants?') ? { success: true, participants: [{ jid: '51@s.whatsapp.net', name: 'María', role: 'admin' }], next_cursor: '' } : { success: true, group: group.group })))
    vi.stubGlobal('fetch', fetcher)
    render(<GroupDetailsPanel chat={group} onClose={() => {}} />)
    await screen.findByText('María'); expect(screen.getByText('Admin')).toBeInTheDocument()
    expect(screen.queryByText(/Crear oportunidad|Crear o vincular contacto|Número sin vincular/)).toBeNull()
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('limit=50'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar participantes' }))
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/group?refresh=true'))).toBe(true))
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar participante' }), { target: { value: 'José' } })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)) })
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes('search=Jos%C3%A9'))).toBe(true))
  })
  it('lists actual receipt senders without claiming all members read it', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response({ success: true, receipts: [{ jid: '51@s.whatsapp.net', name: 'María', read_at: '2026-10-18T12:00:00Z' }], total: 1 }))))
    render(<MessageInfoDialog message={{ id: 'msg', message_id: 'provider', is_from_me: true, timestamp: '2026-10-18T11:00:00Z', status: 'sent' } as Message} chatId={group.id} isGroup onClose={() => {}} />)
    await screen.findByText('María'); expect(screen.getByText('Recibos confirmados')).toBeInTheDocument(); expect(screen.getByText(/no prueban que todo el grupo/)).toBeInTheDocument()
    expect(screen.queryByText(/Si la otra persona/)).toBeNull()
  })
})


it('recovers historical group media on demand with an honest retry state', async () => {
  const recover = vi.fn().mockRejectedValueOnce(new Error('WhatsApp ya no dispone del archivo')).mockResolvedValueOnce(undefined)
  render(<MessageBubble message={{ id: 'media', message_id: 'provider', is_from_me: false, timestamp: '2026-10-18T12:00:00Z', message_type: 'document', media_recoverable: true, media_filename: 'Acuerdo.pdf', status: 'sent', is_read: false } as Message} isGroup onRecoverMedia={recover} />)
  expect(recover).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Recuperar archivo' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert')).toHaveTextContent('WhatsApp ya no dispone del archivo')
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar recuperación' }))
  await waitFor(() => expect(recover).toHaveBeenCalledTimes(2))
})

it('shows the group media limit and never offers recovery even if an older snapshot says recoverable', () => {
  const recover = vi.fn()
  const message = { id: 'large-media', message_id: 'provider-large', is_from_me: false, timestamp: '2026-10-18T12:00:00Z', message_type: 'document', media_recoverable: true, media_unavailable_reason: 'group_media_too_large', media_filename: 'Grabación.zip', body: 'Material de la reunión', media_size: 80 * 1024 * 1024, status: 'sent', is_read: false } as Message
  render(<MessageBubble message={message} isGroup onRecoverMedia={recover} />)
  expect(screen.getByText('Este archivo supera el límite de 64 MB de Clarin. Revísalo en WhatsApp.')).toBeInTheDocument()
  expect(screen.getByText('Grabación.zip')).toBeInTheDocument()
  expect(screen.getByText('Material de la reunión')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Recuperar archivo|Reintentar recuperación/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByText('Grabación.zip'))
  expect(recover).not.toHaveBeenCalled()
})
