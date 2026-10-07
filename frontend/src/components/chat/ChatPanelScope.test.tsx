import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat, Device } from '@/types/chat'

const websocket = vi.hoisted(() => ({ listeners: new Set<(data: unknown) => void>() }))

vi.mock('@/lib/api', () => ({
  subscribeWebSocket: vi.fn((listener: (data: unknown) => void) => {
    websocket.listeners.add(listener)
    return () => { websocket.listeners.delete(listener) }
  }),
}))

vi.mock('../WhatsAppTextInput', async () => {
  const { forwardRef, useEffect, useImperativeHandle, useRef } = await import('react')
  return {
    default: forwardRef<unknown, { placeholder?: string; value?: string; onChange?: (value: string) => void }>(function MockWhatsAppTextInput({ placeholder, value = '', onChange }, ref) {
      const input = useRef<HTMLTextAreaElement>(null)
      useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), clear: () => { if (input.current) input.current.value = '' } }), [])
      useEffect(() => { if (input.current) input.current.value = value }, [value])
      return <div data-testid="chat-composer">{placeholder}<textarea ref={input} aria-label="Draft test editor" onChange={event => onChange?.(event.target.value)} /></div>
    }),
  }
})
vi.mock('./MessageBubble', () => ({
  default: ({ message, onDocumentClick, onReact, onSelect }: { message: { body?: string; quoted_body?: string; reactions?: Array<{ emoji: string; is_from_me: boolean }> }; onDocumentClick?: (document: { sessionId: string; src: string; filename: string; mimeType: string; size: number }) => void; onReact?: (message: unknown, emoji: string) => void; onSelect?: (message: unknown) => void }) => (
    <div data-testid="message-bubble">
      <span>{message.body}</span><span>{message.quoted_body}</span>
      <span data-testid="own-reaction">{message.reactions?.find(reaction => reaction.is_from_me)?.emoji || ''}</span>
      <span data-testid="contact-reaction">{message.reactions?.find(reaction => !reaction.is_from_me)?.emoji || ''}</span>
      <button type="button" onClick={() => onReact?.(message, '👍')} disabled={!onReact}>Reaccionar con 👍</button>
      {onDocumentClick && <button type="button" onClick={() => onDocumentClick({ sessionId: 'document-session-1', src: '/api/media/document.pdf', filename: 'Documento QA.pdf', mimeType: 'application/pdf', size: 2048 })}>Abrir documento simulado</button>}
      {onSelect && <button type="button" onClick={() => onSelect(message)}>Seleccionar mensaje</button>}
    </div>
  ),
}))
vi.mock('./EmojiPicker', () => ({ default: () => null }))
vi.mock('./StickerPicker', () => ({ default: () => null }))
vi.mock('./MobileComposerAccessory', () => ({ default: () => null }))
vi.mock('./ContactPanel', () => ({ default: () => null }))
vi.mock('./ForwardMessageModal', () => ({ default: () => null }))
vi.mock('./MessageInfoDialog', () => ({ default: () => null }))
vi.mock('./QuickReplyPicker', () => ({ default: () => null }))
vi.mock('./ImageViewer', () => ({ default: () => null }))
vi.mock('./ChatDocumentViewer', () => ({
  default: ({ document, onClose }: { document: { filename: string }; onClose: () => void }) => (
    <div role="dialog" aria-label={`Vista previa de ${document.filename}`}>
      <button type="button" onClick={onClose}>Cerrar documento simulado</button>
    </div>
  ),
}))
vi.mock('../ContactSelector', () => ({ default: () => null }))

import ChatPanel from './ChatPanel'
import CrmDetailWorkspace from '@/components/crm-detail/CrmDetailWorkspace'

const chat: Chat = {
  id: 'chat-1',
  jid: '51999999999@s.whatsapp.net',
  name: 'Contacto QA',
  device_id: 'device-1',
  last_message: 'Hola',
  last_message_at: '2026-08-13T10:00:00Z',
  unread_count: 0,
}

function device(status: string): Device {
  const connected = status === 'connected'
  return {
    id: 'device-1',
    name: 'WhatsApp principal',
    status,
    provider: 'whatsapp_web',
    runtime_capabilities: {
      can_start_chat: connected,
      can_check_whatsapp: connected,
      can_send_reaction: connected,
      can_send_sticker: connected,
      can_send_animated_sticker: false,
      can_publish_status: false,
      can_sync_own_status: false,
    },
  }
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return { ok, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response
}

describe('ChatPanel channel scope and quote hydration', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); websocket.listeners.clear() })
  it('ignores another channel message with the same contact JID when canonical chat_id differs', async () => {
    localStorage.setItem('token', 'synthetic-audit-token')
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return Promise.resolve(jsonResponse({ success: true, chat, device: device('connected') }))
      if (url.includes('/messages')) return Promise.resolve(jsonResponse({ success: true, messages: [] }))
      return Promise.resolve(jsonResponse({ success: true, stickers: [], quick_replies: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ChatPanel chatId="chat-1" deviceId="device-1" device={device('connected')} initialChat={chat} />)
    await screen.findByTestId('chat-composer')
    expect(screen.queryAllByTestId('message-bubble')).toHaveLength(0)
    await act(async () => {
      websocket.listeners.forEach(listener => listener({ event: 'new_message', data: { chat_id: 'cloud-chat-2', message: {
        id: 'row-cloud-2', chat_id: 'cloud-chat-2', device_id: 'cloud-device-2',
        provider: 'whatsapp_cloud_api', message_id: 'cloud-provider-msg-2', from_jid: chat.jid,
        from_name: 'Synthetic contact', body: 'Synthetic foreign channel message', is_from_me: false,
        is_read: true, status: 'received', message_type: 'text', timestamp: '2026-10-07T00:00:00Z',
      } } }))
    })
    expect(screen.queryAllByTestId('message-bubble')).toHaveLength(0)
  })

  it('patches a hydrated quote by exact chat/message ID without adding unread or duplicate rows', async () => {
    const message = { id: 'reply-1', message_id: 'provider-reply-1', body: 'Existing reply', quoted_message_id: 'quoted-1', is_from_me: true, is_read: true, status: 'sent', timestamp: '2026-10-07T00:00:00Z' }
    const fetchMock = vi.fn((input: RequestInfo | URL) => Promise.resolve(jsonResponse(String(input) === '/api/chats/chat-1' ? { success: true, chat, device: device('connected') } : { success: true, messages: [message], stickers: [], quick_replies: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const onRead = vi.fn()
    render(<ChatPanel chatId="chat-1" deviceId="device-1" device={device('connected')} initialChat={chat} onRead={onRead} />)
    await screen.findByText('Existing reply')
    const calls = fetchMock.mock.calls.length
    await act(async () => { websocket.listeners.forEach(listener => listener({ event: 'message_updated', data: { chat_id: 'chat-1', message: { ...message, quoted_body: 'Canonical hydrated quote' } } })) })
    expect(screen.getByText('Canonical hydrated quote')).toBeTruthy()
    expect(screen.getAllByTestId('message-bubble')).toHaveLength(1)
    expect(fetchMock.mock.calls).toHaveLength(calls)
    expect(onRead).not.toHaveBeenCalled()
    await act(async () => { websocket.listeners.forEach(listener => listener({ event: 'message_updated', data: { chat_id: 'other-chat', message: { ...message, quoted_body: 'Foreign quote' } } })) })
    expect(screen.queryByText('Foreign quote')).toBeNull()
  })

  it('refreshes quote hydration when sync saved zero new messages', async () => {
    let hydrated = false
    const message = { id: 'reply-1', message_id: 'provider-reply-1', body: 'Existing reply', quoted_message_id: 'quoted-1', is_from_me: true, is_read: true, status: 'sent', timestamp: '2026-10-07T00:00:00Z' }
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(jsonResponse(String(input) === '/api/chats/chat-1' ? { success: true, chat, device: device('connected') } : { success: true, messages: [{ ...message, quoted_body: hydrated ? 'Recovered quote' : undefined }], stickers: [], quick_replies: [] }))))
    render(<ChatPanel chatId="chat-1" deviceId="device-1" device={device('connected')} initialChat={chat} />)
    await screen.findByText('Existing reply')
    hydrated = true
    await act(async () => { websocket.listeners.forEach(listener => listener({ event: 'history_sync_complete', data: { chat_id: 'chat-1', messages_saved: 0, quotes_hydrated: 1, finished: true } })) })
    await screen.findByText('Recovered quote')
  })
})
