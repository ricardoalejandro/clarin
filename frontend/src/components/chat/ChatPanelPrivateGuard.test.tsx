import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat, Device } from '@/types/chat'
import { completeAuthIdentityChange } from '@/lib/authScope'

vi.mock('@/lib/api', () => ({ subscribeWebSocket: () => () => {} }))
vi.mock('../WhatsAppTextInput', async () => {
  const { forwardRef, useImperativeHandle, useRef } = await import('react')
  return { default: forwardRef(function Input(_props, ref) { const input = useRef<HTMLTextAreaElement>(null); useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), clear: () => {} })); return <textarea ref={input} aria-label="Compositor" /> }) }
})
vi.mock('./ContactPanel', async () => {
  const { forwardRef, useEffect, useImperativeHandle, useState } = await import('react')
  return { default: forwardRef(function Contact({ onClose }: { onClose: () => void }, ref) {
    const [draft, setDraft] = useState('')
    const canClose = () => !draft || window.confirm('Descartar nota privada')
    useImperativeHandle(ref, () => ({ canClose }))
    useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && canClose()) onClose() }; document.addEventListener('keydown', escape); return () => document.removeEventListener('keydown', escape) })
    return <section aria-label="Detalle privado"><textarea aria-label="Nota privada" value={draft} onChange={event => setDraft(event.target.value)} /></section>
  }) }
})
vi.mock('./MessageBubble', () => ({ default: () => null }))
vi.mock('./EmojiPicker', () => ({ default: () => null }))
vi.mock('./StickerPicker', () => ({ default: () => null }))
vi.mock('./MobileComposerAccessory', () => ({ default: () => null }))
vi.mock('./ForwardMessageModal', () => ({ default: () => null }))
vi.mock('./MessageInfoDialog', () => ({ default: () => null }))
vi.mock('./QuickReplyPicker', () => ({ default: () => null }))
vi.mock('./ImageViewer', () => ({ default: () => null }))
vi.mock('./ChatDocumentViewer', () => ({ default: () => null }))
vi.mock('../ContactSelector', () => ({ default: () => null }))
import ChatPanel from './ChatPanel'

const privateChat: Chat = { id: 'private-guard', jid: '51999999999@s.whatsapp.net', name: 'Contacto privado', device_id: 'device', unread_count: 0, last_message: '', last_message_at: '' }
const group: Chat = { ...privateChat, id: 'group-guard', kind: 'group', jid: 'group-guard@g.us', name: 'Grupo de origen', group: { subject: 'Grupo de origen', participant_count: 1, membership_status: 'member', announce: false, can_send: true } }
const device: Device = { id: 'device', name: 'WhatsApp', status: 'connected', provider: 'whatsapp_web', runtime_capabilities: { can_start_chat: true, can_check_whatsapp: true, can_send_sticker: false, can_send_animated_sticker: false, can_send_reaction: false, can_publish_status: false, can_sync_own_status: false, can_send_group_messages: true, can_list_groups: true } }
function response(data: unknown): Response { return { ok: true, status: 200, json: async () => data } as Response }
function Host({ onClosed, onGuard }: { onClosed: () => void; onGuard?: (guard: (() => boolean) | null) => void }) {
  const [target, setTarget] = useState<Chat | null>(privateChat)
  return <ChatPanel chatId={group.id} initialChat={group} participantChat={target} onParticipantChatChange={next => { setTarget(next); if (!next) onClosed() }} onParticipantCloseGuardChange={onGuard} />
}
beforeEach(() => {
  completeAuthIdentityChange(); localStorage.setItem('token', 'unit-token')
  window.history.replaceState({ clarinChatId: group.id, clarinChatSurface: 'details' }, '', '/dashboard/chats')
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === `/api/chats/${privateChat.id}` ? response({ success: true, chat: privateChat, device }) : String(input) === `/api/chats/${group.id}` ? response({ success: true, chat: group, device }) : response({ success: true, messages: [], stickers: [], quick_replies: [] })))
})
afterEach(async () => { cleanup(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) }); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('private conversation Contact draft guard', () => {
  it.each(['Volver', 'Escape', 'Back'] as const)('preserves a note when %s discard is rejected and closes only after approval', async action => {
    const closed = vi.fn(), confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<Host onClosed={closed} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ver detalles de la conversación' }))
    const note = await screen.findByRole('textbox', { name: 'Nota privada' })
    fireEvent.change(note, { target: { value: 'Nota sin guardar' } })
    await waitFor(() => expect(window.history.state.__clarinGroupMemberChat).toBe(true))
    const attempt = async () => {
      if (action === 'Volver') fireEvent.click(screen.getByRole('button', { name: 'Volver al integrante' }))
      else if (action === 'Escape') fireEvent.keyDown(document, { key: 'Escape' })
      else await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)) })
    }
    await attempt()
    expect(screen.getByRole('textbox', { name: 'Nota privada' })).toBe(note)
    expect(note).toHaveValue('Nota sin guardar')
    expect(closed).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledTimes(1)
    confirm.mockReturnValue(true)
    await attempt()
    if (action === 'Escape') { expect(closed).not.toHaveBeenCalled(); fireEvent.keyDown(document, { key: 'Escape' }); await act(async () => {}) }
    await waitFor(() => expect(closed).toHaveBeenCalledOnce())
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('exposes the same private draft guard to parent navigation and clears it on close', async () => {
    const guards: Array<(() => boolean) | null> = [], onGuard = (guard: (() => boolean) | null) => guards.push(guard)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const view = render(<Host onClosed={vi.fn()} onGuard={onGuard} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Ver detalles de la conversación' }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Nota privada' }), { target: { value: 'Nota protegida' } })
    expect(guards.at(-1)?.()).toBe(false)
    expect(confirm).toHaveBeenCalledOnce()
    view.unmount()
    expect(guards.at(-1)).toBeNull()
  })
})
