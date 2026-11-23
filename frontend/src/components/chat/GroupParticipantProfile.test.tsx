import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Chat, GroupParticipant } from '@/types/chat'
import { getAuthScope } from '@/lib/authScope'
import GroupParticipantProfile from './GroupParticipantProfile'
import GroupDetailsPanel from './GroupDetailsPanel'

vi.mock('@/lib/api', () => ({ subscribeWebSocket: () => () => {} }))
vi.mock('@/components/contact-details/ContactDetailSurface', () => ({ default: ({ onClose }: { onClose: () => void }) => <button onClick={onClose}>Cerrar ficha canónica</button> }))
const member: GroupParticipant = { jid: '51999999999@s.whatsapp.net', phone: '51999999999', name: 'Integrante de prueba', role: 'admin', is_self: false }
const chat: Chat = { id: 'group', kind: 'group', jid: 'group@g.us', name: 'Grupo de prueba', device_id: 'device', device_name: 'Dispositivo del grupo', unread_count: 0, last_message: '', last_message_at: '', group: { subject: 'Grupo de prueba', participant_count: 1, membership_status: 'member', announce: true, can_send: false } }
const privateChat: Chat = { ...chat, id: 'private', kind: 'direct', jid: member.jid, group: undefined }
const profile = (extra = {}) => ({ identity_revision: 1, group_revision: 1, participant: member, device_id: 'device', identity_fingerprint: 'verified-fingerprint', capabilities: { can_message: true, can_query_avatar: false, can_query_about: true, can_list_common_groups: true }, ...extra })
function response(data: unknown, status = 200): Response { return { ok: status >= 200 && status < 300, status, json: async () => data } as Response }
function fetcher(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const override = Object.entries(overrides).find(([suffix]) => url.endsWith(suffix))?.[1]
    if (override) return override()
    if (url.includes('/common-groups?')) return response({ success: true, groups: [], next_cursor: '', source: 'known_device_groups' })
    if (url.endsWith('/about')) return response({ success: true, about: { text: 'Información visible', state: 'available' } })
    if (url.endsWith('/chat') && init?.method === 'POST') return response({ success: true, chat: privateChat })
    if (url.includes('/participants?')) return response({ success: true, identity_revision: 1, group_revision: 1, order: 'admins_first', participants: [member], next_cursor: '' })
    if (url.endsWith('/group')) return response({ success: true, group: chat.group })
    return response({ success: true, profile: profile() })
  })
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('WhatsApp participant profile', () => {
  it('consults a participant without creating CRM records and opens a private chat without an initial message', async () => {
    const request = fetcher(); vi.stubGlobal('fetch', request)
    const onOpen = vi.fn()
    render(<StrictMode><GroupParticipantProfile chat={chat} member={member} scope={getAuthScope()} onBack={vi.fn()} onClose={vi.fn()} onOpenChat={onOpen} /></StrictMode>)
    const button = await screen.findByRole('button', { name: 'Mensaje' })
    await waitFor(() => expect(button).toBeEnabled())
    expect(request.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Abrir ficha Clarin' })).toBeNull()
    fireEvent.click(button)
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(privateChat))
    const post = request.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(post?.[0]).toContain('/participants/51999999999%40s.whatsapp.net/chat')
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ identity_fingerprint: 'verified-fingerprint' })
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
  it('keeps Mensaje available when optional profile information fails, including announcement groups', async () => {
    const request = fetcher({ '/about': () => response({ success: false }, 503) }); vi.stubGlobal('fetch', request)
    render(<GroupParticipantProfile chat={chat} member={member} scope={getAuthScope()} onBack={vi.fn()} onClose={vi.fn()} onOpenChat={vi.fn()} />)
    await screen.findByRole('button', { name: 'Reintentar información' })
    expect(screen.getByRole('button', { name: 'Mensaje' })).toBeEnabled()
    expect(screen.getByText(/No tenemos grupos sincronizados en común/)).toBeInTheDocument()
  })
  it('does not enable a private message for a LID-only identity', async () => {
    const hidden = { ...member, jid: '123456789012345@lid', phone: undefined, name: '' }
    vi.stubGlobal('fetch', fetcher({ '/participants/123456789012345%40lid': () => response({ success: true, profile: profile({ participant: hidden, capabilities: { can_message: false, message_disabled_reason: 'WhatsApp no ha entregado un teléfono verificable.', can_query_avatar: false, can_query_about: false, can_list_common_groups: true } }) }) }))
    render(<GroupParticipantProfile chat={chat} member={hidden} scope={getAuthScope()} onBack={vi.fn()} onClose={vi.fn()} onOpenChat={vi.fn()} />)
    await screen.findByText('WhatsApp no ha entregado un teléfono verificable.')
    expect(screen.getByRole('button', { name: 'Mensaje' })).toBeDisabled()
    expect(screen.queryByText('+123456789012345')).toBeNull()
  })
  it('keeps participant search and list mounted when opening and returning from a profile', async () => {
    const request = fetcher(); vi.stubGlobal('fetch', request)
    render(<GroupDetailsPanel chat={chat} onClose={vi.fn()} onOpenChat={vi.fn()} />)
    const open = await screen.findByRole('button', { name: 'Ver integrante: Integrante de prueba' })
    fireEvent.click(open)
    expect(screen.getByRole('region', { name: 'Perfil del integrante' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Buscar participante', hidden: true })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Volver a participantes' }))
    await screen.findByRole('button', { name: 'Ver integrante: Integrante de prueba' })
  })
  it('requires explicit confirmation before retrying a changed sender', async () => {
    const sender = { device_id: 'device', device_phone: '51911111111', history_revision: 4 }
    let count = 0
    const request = fetcher({ '/chat': () => ++count === 1 ? response({ success: false, code: 'sender_confirmation_required', sender_confirmation: sender }, 409) : response({ success: true, chat: privateChat }) })
    vi.stubGlobal('fetch', request)
    const onOpen = vi.fn()
    render(<GroupParticipantProfile chat={chat} member={member} scope={getAuthScope()} onBack={vi.fn()} onClose={vi.fn()} onOpenChat={onOpen} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mensaje' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Mensaje' }))
    expect(await screen.findByText('Número del dispositivo: +51911111111')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar este número' }))
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(request.mock.calls.filter(([, init]) => init?.method === 'POST')[1][1]?.body)).sender_confirmation).toEqual(sender)
  })
})
