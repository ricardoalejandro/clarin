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
  it('links the group description without changing its plain text or making external requests', async () => {
    const description = 'Reunión: HTTPS://example.com/sala_(dos).\n_Nota_ www.example.org/a_b'
    const described = { ...group, group: { ...group.group!, description } }
    const fetcher = vi.fn((input: RequestInfo | URL) => Promise.resolve(response(String(input).includes('/participants?') ? { success: true, identity_revision: 1, group_revision: 1, order: 'admins_first', participants: [] } : { success: true, group: described.group })))
    vi.stubGlobal('fetch', fetcher)
    render(<GroupDetailsPanel chat={described} onClose={() => {}} />)
    const link = await screen.findByRole('link', { name: 'HTTPS://example.com/sala_(dos)' })
    expect(link).toHaveAttribute('href', 'https://example.com/sala_(dos)')
    expect(link.parentElement).toHaveTextContent('_Nota_')
    expect(link.parentElement?.textContent).toBe(description)
    expect(screen.getAllByRole('link')).toHaveLength(2)
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('/api/chats/group/group'))).toBe(true)
  })
  it('labels unavailable group text while retaining its author, timestamp and quoted context', () => {
    const message = Object.freeze({ id: 'empty-text', message_id: 'provider-empty', from_jid: '51@s.whatsapp.net', from_name: 'María', is_from_me: false, is_read: true, status: 'read', body: ' \n ', message_type: 'text', timestamp: '2026-10-18T12:00:00Z', quoted_message_id: 'quote', quoted_sender: '52@s.whatsapp.net', quoted_sender_name: 'José', quoted_body: 'Mensaje anterior' } as Message)
    const { rerender } = render(<MessageBubble message={message} isGroup />)
    expect(screen.getByText('Mensaje no disponible')).toBeInTheDocument()
    expect(screen.getByText('María')).toBeInTheDocument()
    expect(screen.getByText('José')).toBeInTheDocument()
    expect(screen.getByText('Mensaje anterior')).toBeInTheDocument()
    const timestamp = new Date(message.timestamp).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false })
    expect(screen.getByText(timestamp)).toBeInTheDocument()
    expect(message.body).toBe(' \n ')
    rerender(<MessageBubble message={{ ...message, body: 'Texto recuperado' }} isGroup />)
    expect(screen.queryByText('Mensaje no disponible')).not.toBeInTheDocument()
    expect(screen.getByText('Texto recuperado')).toBeInTheDocument()
  })
  it('renders participant authors and quoted authors instead of the group name, including emoji', () => {
    const message = { id: 'message', message_id: 'provider', from_jid: '51@s.whatsapp.net', from_name: 'María', is_from_me: false, body: 'Hola', message_type: 'text', timestamp: '2026-10-18T12:00:00Z', quoted_message_id: 'quote', quoted_sender: '52@s.whatsapp.net', quoted_sender_name: 'José', quoted_body: 'Mensaje anterior' } as Message
    render(<MessageBubble message={message} isGroup contactName="No mostrar grupo" />)
    expect(screen.getByText('María')).toBeInTheDocument(); expect(screen.getByText('José')).toBeInTheDocument(); expect(screen.queryByText('No mostrar grupo')).toBeNull()
  })
  it('loads bounded member pages and exposes no CRM identity or opportunity actions', async () => {
    const fetcher = vi.fn((input: RequestInfo | URL) => Promise.resolve(response(String(input).includes('/participants?') ? { success: true, identity_revision: 1, group_revision: 1, order: 'admins_first', participants: [{ jid: '51@s.whatsapp.net', name: 'María', role: 'admin' }], next_cursor: '' } : { success: true, group: group.group })))
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


it('keeps a username separate from the name, phone and technical LID', async () => {
  const unnamed = { jid: '123456789@lid', lid: '123456789@lid', name: 'Integrante', username: 'ale.test', role: 'member', is_self: false }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => response(String(input).includes('/participants?') ? { success: true, identity_revision: 1, group_revision: 1, order: 'admins_first', participants: [unnamed] } : { success: true, group: group.group })))
  render(<GroupDetailsPanel chat={group} onClose={() => {}} />)
  expect(await screen.findByText('Nombre no disponible')).toBeInTheDocument()
  expect(screen.getByText('Usuario: @ale.test')).toBeInTheDocument()
  expect(screen.getByText('Teléfono no disponible')).toBeInTheDocument()
  expect(screen.queryByText(/123456789/)).not.toBeInTheDocument()
})


it('waits exactly 500ms after typing and clearing participant search without changing the input feedback', async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => response(String(url).includes('/participants?') ? { success: true, identity_revision: 1, group_revision: 1, order: 'admins_first', participants: [{ jid: '7001@lid', name: 'Nombre disponible', role: 'member', is_self: false }], next_cursor: '' } : { success: true, group: group.group }))
  vi.stubGlobal('fetch', fetcher)
  render(<GroupDetailsPanel chat={group} onClose={() => {}} />)
  await screen.findByText('Nombre disponible')
  vi.useFakeTimers()
  const initial = fetcher.mock.calls.length
  const input = screen.getByRole('textbox', { name: 'Buscar participante' })
  fireEvent.change(input, { target: { value: 'Nombre' } })
  expect(input).toHaveValue('Nombre')
  await act(async () => { await vi.advanceTimersByTimeAsync(499) })
  expect(fetcher).toHaveBeenCalledTimes(initial)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(fetcher).toHaveBeenCalledTimes(initial + 2)
  fireEvent.click(screen.getByRole('button', { name: 'Limpiar búsqueda de participantes' }))
  expect(input).toHaveValue('')
  await act(async () => { await vi.advanceTimersByTimeAsync(499) })
  expect(fetcher).toHaveBeenCalledTimes(initial + 2)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(fetcher).toHaveBeenCalledTimes(initial + 4)
})
