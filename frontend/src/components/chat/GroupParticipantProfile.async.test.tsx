import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat, GroupParticipant } from '@/types/chat'
import { completeAuthIdentityChange, getAuthScope } from '@/lib/authScope'
import GroupParticipantProfile from './GroupParticipantProfile'
import GroupDetailsPanel, { type GroupDetailsPanelHandle } from './GroupDetailsPanel'

const websocket = vi.hoisted(() => ({ listeners: new Set<(event: unknown) => void>() }))
vi.mock('@/lib/api', () => ({ subscribeWebSocket: (listener: (event: unknown) => void) => { websocket.listeners.add(listener); return () => websocket.listeners.delete(listener) } }))
vi.mock('@/components/contact-details/ContactDetailSurface', async () => {
  const { forwardRef, useImperativeHandle, useState } = await import('react')
  return { default: forwardRef(function Contact({ onClose, readOnly }: { onClose: () => void; readOnly?: boolean }, ref) {
    const [draft, setDraft] = useState('')
    const canClose = () => !draft || window.confirm('Descartar nota pendiente')
    useImperativeHandle(ref, () => ({ canClose, requestClose: () => { if (!canClose()) return false; onClose(); return true } }))
    return <section aria-label="Ficha canónica"><textarea aria-label="Nota pendiente" value={draft} disabled={readOnly} onChange={event => setDraft(event.target.value)} /><button onClick={() => { if (canClose()) onClose() }}>Cerrar ficha canónica</button></section>
  }) }
})
const member: GroupParticipant = { jid: '51999999999@s.whatsapp.net', phone: '51999999999', name: 'Nombre WhatsApp', role: 'member', is_self: false }
const chat: Chat = { id: 'group-async', kind: 'group', jid: 'group-async@g.us', name: 'Grupo de prueba', device_id: 'device', device_name: 'Dispositivo del grupo', unread_count: 0, last_message: '', last_message_at: '', group: { subject: 'Grupo de prueba', participant_count: 1, membership_status: 'member', announce: false, can_send: true } }
const privateChat: Chat = { ...chat, id: 'private-async', kind: 'direct', jid: member.jid, group: undefined }
const capabilities = { can_message: true, can_query_avatar: false, can_query_about: false, can_list_common_groups: false }
const profile = (extra = {}) => ({ identity_revision: 1, group_revision: 1, participant: member, device_id: chat.device_id, identity_fingerprint: 'fingerprint-current', capabilities, ...extra })
function response(data: unknown, status = 200): Response { return { ok: status >= 200 && status < 300, status, json: async () => data } as Response }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { resolve, promise } }
function install(overrides: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined = () => undefined) {
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), override = overrides(url, init)
    if (override) return override
    if (url.includes('/participants?')) return response({ success: true, identity_revision: 1, group_revision: 1, participants: [member], next_cursor: '' })
    if (url.endsWith('/group')) return response({ success: true, group: chat.group })
    if (url.includes('/common-groups?')) return response({ success: true, groups: [], next_cursor: '' })
    if (url.endsWith('/about')) return response({ success: true, about: { text: '', state: 'available' } })
    if (url.endsWith('/chat')) return response({ success: true, chat: privateChat })
    return response({ success: true, profile: profile() })
  })
  vi.stubGlobal('fetch', request)
  return request
}
const props = () => ({ chat, member, scope: getAuthScope(), onBack: vi.fn(), onClose: vi.fn(), onOpenChat: vi.fn() })
beforeEach(() => { completeAuthIdentityChange(); window.history.replaceState({ clarinChatId: chat.id, clarinChatSurface: 'details' }, '', '/dashboard/chats') })
afterEach(async () => { cleanup(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) }); vi.restoreAllMocks(); vi.unstubAllGlobals(); websocket.listeners.clear() })

describe('participant profile async identity and navigation', () => {
  it('disables messaging for a deleted participant without creating any CRM records', async () => {
    const request = install(() => response({ success: false, code: 'participant_not_found', error: 'Este integrante ya no pertenece al grupo.' }, 404))
    render(<GroupParticipantProfile {...props()} />)
    await screen.findByText('Este integrante ya no pertenece al grupo.')
    expect(screen.getByRole('button', { name: 'Mensaje' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Mensaje' }))
    expect(request.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })

  it.each([{ device_id: 'other-device' }, { participant: { ...member, jid: 'other@lid', phone: undefined } }])('rejects a profile from another device or participant: %j', async extra => {
    install(() => response({ success: true, profile: profile(extra) }))
    render(<GroupParticipantProfile {...props()} />)
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: 'Mensaje' })).toBeDisabled()
  })

  it('hides the old CRM projection and disables capabilities immediately when its group snapshot changes', async () => {
    const pending = deferred<Response>()
    const canonical = { ...member, name: 'Nombre privado CRM', name_source: 'contact', whatsapp_name: 'Nombre WhatsApp', avatar_source: 'contact' as const, avatar_url: '/crm-photo' }
    let reads = 0
    install(url => url.endsWith('/participants/' + encodeURIComponent(member.jid)) ? ++reads === 1
      ? response({ success: true, profile: profile({ participant: canonical, contact_context: { contact_id: 'contact', context: 'contact' } }) }) : pending.promise : undefined)
    const base = props(), view = render(<GroupParticipantProfile {...base} snapshotRevision={0} />)
    await screen.findByText('Nombre privado CRM')
    view.rerender(<GroupParticipantProfile {...base} snapshotRevision={1} />)
    expect(screen.queryByText('Nombre privado CRM')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Abrir ficha Clarin' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Mensaje' })).toBeDisabled()
    await act(async () => pending.resolve(response({ success: true, profile: profile() })))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mensaje' })).toBeEnabled())
  })

  it('aborts a pending chat creation on suspension and never opens its late result', async () => {
    const pending = deferred<Response>()
    let signal: AbortSignal | null | undefined
    const request = install((url, init) => url.endsWith('/chat') ? (signal = init?.signal, pending.promise) : undefined)
    const base = props(), view = render(<GroupParticipantProfile {...base} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mensaje' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Mensaje' }))
    await waitFor(() => expect(signal).toBeDefined())
    view.rerender(<GroupParticipantProfile {...base} suspended />)
    expect(signal?.aborted).toBe(true)
    await act(async () => pending.resolve(response({ success: true, chat: privateChat })))
    expect(base.onOpenChat).not.toHaveBeenCalled()
    view.rerender(<GroupParticipantProfile {...base} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mensaje' })).toBeEnabled())
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('keeps Mensaje available after a private photo and never falls back to a WhatsApp URL', async () => {
    install(url => url.endsWith('/avatar') ? response({ success: false, code: 'photo_private' }, 404) : url.endsWith('/participants/' + encodeURIComponent(member.jid)) ? response({ success: true, profile: profile({ participant: { ...member, avatar_source: 'whatsapp', avatar_url: '/provider-photo' }, capabilities: { ...capabilities, can_query_avatar: true } }) }) : undefined)
    render(<GroupParticipantProfile {...props()} />)
    await screen.findByText('La foto no está disponible por privacidad.')
    expect(screen.queryByRole('img', { name: 'Foto del integrante' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Mensaje' })).toBeEnabled()
  })

  it('shows independent loading feedback while the WhatsApp photo is pending', async () => {
    const pending = deferred<Response>()
    install(url => url.endsWith('/avatar') ? pending.promise : url.endsWith('/participants/' + encodeURIComponent(member.jid)) ? response({ success: true, profile: profile({ participant: { ...member, avatar_source: 'whatsapp' }, capabilities: { ...capabilities, can_query_avatar: true } }) }) : undefined)
    render(<GroupParticipantProfile {...props()} />)
    expect(await screen.findByText('Consultando foto…')).toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: 'Mensaje' })).toBeEnabled()
  })

  it('renders a complete Unicode initial for a participant whose name starts with an emoji', async () => {
    const emoji = { ...member, name: '👩 Ana' }
    install(url => url.endsWith('/participants/' + encodeURIComponent(member.jid)) ? response({ success: true, profile: profile({ participant: emoji }) }) : undefined)
    render(<GroupParticipantProfile {...props()} member={emoji} />)
    await screen.findByRole('heading', { name: '👩 Ana' })
    expect(screen.getByText('👩')).toBeInTheDocument()
  })

  it('revokes its temporary avatar on unmount', async () => {
    const createURL = vi.fn(() => 'blob:participant-photo'), revokeURL = vi.fn()
    const OriginalURL = URL
    vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL = createURL; static revokeObjectURL = revokeURL })
    install(url => url.endsWith('/avatar') ? new Response(new Blob(['photo'], { type: 'image/jpeg' }), { headers: { 'content-type': 'image/jpeg' } }) : url.endsWith('/participants/' + encodeURIComponent(member.jid)) ? response({ success: true, profile: profile({ capabilities: { ...capabilities, can_query_avatar: true } }) }) : undefined)
    const view = render(<GroupParticipantProfile {...props()} />)
    expect(await screen.findByRole('img', { name: 'Foto del integrante' })).toHaveAttribute('src', 'blob:participant-photo')
    view.unmount()
    expect(revokeURL).toHaveBeenCalledWith('blob:participant-photo')
  })

  it('protects a canonical Contact draft from external navigation and preserves it during revalidation', async () => {
    const pending = deferred<Response>()
    let reads = 0
    install(url => url.endsWith('/participants/' + encodeURIComponent(member.jid)) ? ++reads === 1
      ? response({ success: true, profile: profile({ contact_context: { contact_id: 'contact', context: 'chat', chat_id: 'real-direct-chat' } }) }) : pending.promise : undefined)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false), ref = createRef<GroupDetailsPanelHandle>(), navigate = vi.fn()
    render(<GroupDetailsPanel ref={ref} chat={chat} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ver integrante: Nombre WhatsApp' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir ficha Clarin' }))
    const note = await screen.findByRole('textbox', { name: 'Nota pendiente' })
    fireEvent.change(note, { target: { value: 'Borrador conservado' } })
    expect(ref.current?.requestClose(navigate)).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledOnce()
    await act(async () => { websocket.listeners.forEach(listener => listener({ event: 'chat_group_updated', data: { chat_id: chat.id } })) })
    expect(screen.getByRole('textbox', { name: 'Nota pendiente', hidden: true })).toBe(note)
    await act(async () => pending.resolve(response({ success: true, profile: profile({ contact_context: { contact_id: 'contact', context: 'chat', chat_id: 'real-direct-chat' } }) })))
    expect(await screen.findByRole('textbox', { name: 'Nota pendiente' })).toHaveValue('Borrador conservado')
  })

  it.each(['device_status', 'device_deletion'] as const)('revalidates %s only for the source device and disables messaging after disconnection', async type => {
    let disconnected = false, reads = 0
    install(url => url.endsWith('/participants/' + encodeURIComponent(member.jid)) ? (reads++, response({ success: true, profile: profile({ capabilities: { ...capabilities, can_message: !disconnected, message_disabled_reason: disconnected ? 'El dispositivo está desconectado.' : undefined } }) })) : undefined)
    render(<GroupDetailsPanel chat={chat} onClose={vi.fn()} onOpenChat={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ver integrante: Nombre WhatsApp' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mensaje' })).toBeEnabled())
    const before = reads
    await act(async () => { websocket.listeners.forEach(listener => listener({ type, data: { device_id: 'other-device' } })) })
    expect(reads).toBe(before)
    disconnected = true
    await act(async () => { websocket.listeners.forEach(listener => listener({ type, data: { device_id: chat.device_id } })) })
    await screen.findByText('El dispositivo está desconectado.')
    expect(screen.getByRole('button', { name: 'Mensaje' })).toBeDisabled()
    expect(reads).toBe(before + 1)
  })

  it.each([['envelope', 'contact_update'], ['payload', 'contact_update'], ['envelope', 'whatsapp_crm_identity_updated'], ['payload', 'whatsapp_crm_identity_updated']] as const)('refreshes Contact identity for %s %s without replacing rows or accepting another account', async (location, event) => {
    const scopedChat = { ...chat, account_id: 'account-current' }
    let name = 'Nombre CRM anterior', reads = 0
    const canonical = () => ({ ...member, name, name_source: 'contact', whatsapp_name: member.name })
    install(url => url.includes('/participants?') ? response({ success: true, identity_revision: 1, group_revision: 1, participants: [canonical()], next_cursor: '' }) : url.endsWith('/participants/' + encodeURIComponent(member.jid)) ? (reads++, response({ success: true, profile: profile({ participant: canonical(), contact_context: { contact_id: 'contact-current', context: 'contact' } }) })) : undefined)
    render(<GroupDetailsPanel chat={scopedChat} onClose={vi.fn()} />)
    const row = await screen.findByRole('button', { name: 'Ver integrante: Nombre CRM anterior' })
    const scroll = screen.getByRole('region', { name: 'Detalles del grupo' }).querySelector('.overflow-y-auto') as HTMLDivElement
    scroll.scrollTop = 120
    fireEvent.click(row)
    await screen.findByRole('heading', { name: 'Nombre CRM anterior' })
    await waitFor(() => expect(window.history.state.__clarinGroupParticipant).toBeTruthy())
    const before = reads
    await act(async () => { websocket.listeners.forEach(listener => listener(location === 'envelope' ? { event, account_id: 'other-account', data: { id: 'contact-current', crm_identity_revision: 4 } } : { type: event, data: { id: 'contact-current', account_id: 'other-account', crm_identity_revision: 4 } })) })
    expect(reads).toBe(before)
    name = 'Nombre CRM actualizado'
    await act(async () => { websocket.listeners.forEach(listener => listener({ event, account_id: scopedChat.account_id, data: { id: 'contact-current', crm_identity_revision: 4 } })) })
    await screen.findByRole('heading', { name: 'Nombre CRM actualizado' })
    expect(reads).toBe(before + 1)
    if (event === 'whatsapp_crm_identity_updated') {
      await act(async () => { for (const revision of [4, 3]) websocket.listeners.forEach(listener => listener({ event, account_id: scopedChat.account_id, data: { crm_identity_revision: revision } })) })
      expect(reads).toBe(before + 1)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Volver a participantes' }))
    expect(await screen.findByRole('button', { name: 'Ver integrante: Nombre CRM actualizado' })).toBe(row)
    expect(scroll.scrollTop).toBe(120)
  })

  it('uses Back for the nested Contact, then the profile, without replacing the participant list DOM', async () => {
    install(url => url.endsWith('/participants/' + encodeURIComponent(member.jid)) ? response({ success: true, profile: profile({ contact_context: { contact_id: 'contact', context: 'contact' } }) }) : undefined)
    render(<GroupDetailsPanel chat={chat} onClose={vi.fn()} />)
    const listButton = await screen.findByRole('button', { name: 'Ver integrante: Nombre WhatsApp' })
    fireEvent.click(listButton)
    await waitFor(() => expect(window.history.state.__clarinGroupParticipant).toBeTruthy())
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir ficha Clarin' }))
    await screen.findByRole('region', { name: 'Ficha canónica' })
    await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)) })
    expect(screen.getByRole('region', { name: 'Perfil del integrante' })).toBeInTheDocument()
    expect(window.history.state.__clarinGroupParticipant).toBeTruthy()
    await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)) })
    expect(screen.getByRole('button', { name: 'Ver integrante: Nombre WhatsApp' })).toBe(listButton)
    expect(window.history.state.clarinChatId).toBe(chat.id)
  })

  it('keeps a dirty Contact on browser Back when discard is rejected', async () => {
    install(url => url.endsWith('/participants/' + encodeURIComponent(member.jid)) ? response({ success: true, profile: profile({ contact_context: { contact_id: 'contact', context: 'contact' } }) }) : undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<GroupDetailsPanel chat={chat} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ver integrante: Nombre WhatsApp' }))
    await waitFor(() => expect(window.history.state.__clarinGroupParticipant).toBeTruthy())
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir ficha Clarin' }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Nota pendiente' }), { target: { value: 'No descartar' } })
    await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)) })
    expect(screen.getByRole('textbox', { name: 'Nota pendiente' })).toHaveValue('No descartar')
    expect(window.history.state.__clarinGroupParticipant).toBeTruthy()
  })

  it('uses Escape for the profile before closing the entire group detail', async () => {
    install()
    const close = vi.fn()
    render(<GroupDetailsPanel chat={chat} onClose={close} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ver integrante: Nombre WhatsApp' }))
    await waitFor(() => expect(window.history.state.__clarinGroupParticipant).toBeTruthy())
    fireEvent.keyDown(document, { key: 'Escape' })
    await screen.findByRole('button', { name: 'Ver integrante: Nombre WhatsApp' })
    expect(close).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('drains the private chat and participant Back steps before navigating to another conversation', async () => {
    install()
    const ref = createRef<GroupDetailsPanelHandle>(), navigate = vi.fn(), view = render(<GroupDetailsPanel ref={ref} chat={chat} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ver integrante: Nombre WhatsApp' }))
    await waitFor(() => expect(window.history.state.__clarinGroupParticipant).toBeTruthy())
    window.history.pushState({ ...window.history.state, __clarinGroupMemberChat: true }, '')
    view.rerender(<GroupDetailsPanel ref={ref} chat={chat} suspended onClose={vi.fn()} />)
    expect(ref.current?.requestClose(navigate)).toBe(true)
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce())
    expect(window.history.state.__clarinGroupMemberChat).toBeUndefined()
    expect(window.history.state.__clarinGroupParticipant).toBeUndefined()
  })

  it('consumes the participant history step before applying a confirmed external navigation', async () => {
    install()
    const ref = createRef<GroupDetailsPanelHandle>(), navigate = vi.fn()
    render(<GroupDetailsPanel ref={ref} chat={chat} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ver integrante: Nombre WhatsApp' }))
    await waitFor(() => expect(window.history.state.__clarinGroupParticipant).toBeTruthy())
    expect(ref.current?.requestClose(navigate)).toBe(true)
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce())
    expect(window.history.state.__clarinGroupParticipant).toBeUndefined()
    expect(screen.getByRole('button', { name: 'Ver integrante: Nombre WhatsApp' })).toBeInTheDocument()
  })
})


it('shows an available username independently from the profile name and unavailable telephone', async () => {
  const unnamed = { ...member, jid: 'private@lid', lid: 'private@lid', phone: undefined, name: '', username: 'ale.test' }
  install(() => response({ success: true, profile: profile({ participant: unnamed, capabilities: { ...capabilities, can_message: false } }) }))
  render(<GroupParticipantProfile {...props()} member={unnamed} />)
  expect(await screen.findByText('Usuario: @ale.test')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Nombre no disponible' })).toBeInTheDocument()
  expect(screen.getByText('Teléfono no disponible')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Mensaje' })).toBeDisabled()
})


it('discards an old participant response after identity recovery updates the device', async () => {
  const old = deferred<Response>()
  let calls = 0
  let oldSignal: AbortSignal | null | undefined
  install((url, init) => {
    if (!url.includes('/participants?')) return
    calls++
    if (calls === 1) { oldSignal = init?.signal; return old.promise }
    return response({ success: true, identity_revision: 2, group_revision: 2, participants: [{ ...member, name: 'Nombre recuperado' }], next_cursor: '' })
  })
  render(<GroupDetailsPanel chat={chat} onClose={() => {}} />)
  await waitFor(() => expect(calls).toBe(1))
  act(() => { websocket.listeners.forEach(listener => listener({ event: 'whatsapp_identity_updated', data: { device_id: chat.device_id, identity_revision: 2 } })) })
  expect(oldSignal?.aborted).toBe(true)
  expect(await screen.findByText('Nombre recuperado')).toBeInTheDocument()
  await act(async () => old.resolve(response({ success: true, identity_revision: 1, group_revision: 1, participants: [{ ...member, name: 'Respuesta antigua' }], next_cursor: '' })))
  expect(screen.queryByText('Respuesta antigua')).not.toBeInTheDocument()
  expect(screen.getByText('Nombre recuperado')).toBeInTheDocument()
})

it('preserves the participant row and reading position while replacing revoked identity fields', async () => {
  let version = 1
  const oldMember = { ...member, lid: '7001@lid', username: 'usuario.anterior', avatar_url: '/old-avatar', avatar_source: 'whatsapp', role: 'admin' }
  const canonical = { jid: '7001@lid', lid: '7001@lid', name: 'Nombre actualizado', role: 'member', is_self: false }
  install(url => url.includes('/participants?') ? response({ success: true, identity_revision: version, group_revision: version, participants: [version === 1 ? oldMember : canonical], next_cursor: '' }) : undefined)
  const { container } = render(<GroupDetailsPanel chat={chat} onClose={() => {}} />)
  const row = await screen.findByRole('button', { name: 'Ver integrante: Nombre WhatsApp' })
  const scroll = container.querySelector('.overflow-y-auto') as HTMLDivElement
  scroll.scrollTop = 120
  version = 2
  act(() => { websocket.listeners.forEach(listener => listener({ event: 'whatsapp_identity_updated', data: { device_id: chat.device_id, identity_revision: 2 } })) })
  const next = await screen.findByRole('button', { name: 'Ver integrante: Nombre actualizado' })
  expect(next).toBe(row)
  expect(scroll.scrollTop).toBe(120)
  expect(screen.queryByText('Usuario: @usuario.anterior')).not.toBeInTheDocument()
  expect(screen.getByText('Teléfono no disponible')).toBeInTheDocument()
  expect(screen.queryByText('Admin')).not.toBeInTheDocument()
})

it('rejects a profile older than the participant snapshot before enabling Message', async () => {
  install()
  render(<GroupParticipantProfile chat={chat} member={member} scope={getAuthScope()} identityRevision={2} groupRevision={1} onBack={() => {}} onClose={() => {}} onOpenChat={() => {}} />)
  expect(await screen.findByText('La información del integrante cambió. Vuelve a consultar el perfil.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Mensaje' })).toBeDisabled()
})
