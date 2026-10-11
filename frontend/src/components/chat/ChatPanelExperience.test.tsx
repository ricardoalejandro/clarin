import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat, Device } from '@/types/chat'

const websocket = vi.hoisted(() => ({ listeners: new Set<(data: unknown) => void>() }))
const compression = vi.hoisted(() => ({ compress: vi.fn(async (file: File) => file) }))
vi.mock('@/utils/imageCompression', () => ({ compressImageStandard: compression.compress }))

vi.mock('@/lib/api', () => ({
  subscribeWebSocket: vi.fn((listener: (data: unknown) => void) => {
    websocket.listeners.add(listener)
    return () => { websocket.listeners.delete(listener) }
  }),
}))

vi.mock('../WhatsAppTextInput', async () => {
  const { forwardRef, useEffect, useImperativeHandle, useRef } = await import('react')
  return {
    default: forwardRef<unknown, { placeholder?: string; value?: string; onChange?: (value: string) => void; onKeyDown?: (event: React.KeyboardEvent) => void; disabled?: boolean }>(function MockWhatsAppTextInput({ placeholder, value = '', onChange, onKeyDown, disabled }, ref) {
      const input = useRef<HTMLTextAreaElement>(null)
      useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), clear: () => { if (input.current) input.current.value = '' } }), [])
      useEffect(() => { if (input.current) input.current.value = value }, [value])
      return <div data-testid="chat-composer">{placeholder}<textarea ref={input} aria-label="Draft test editor" disabled={disabled} onKeyDown={onKeyDown} onChange={event => onChange?.(event.target.value)} /></div>
    }),
  }
})
vi.mock('./MessageBubble', () => ({
  default: ({ message, onDocumentClick, onReact, onSelect, onRetry }: { message: { status?: string; body?: string; quoted_body?: string; reactions?: Array<{ emoji: string; is_from_me: boolean }> }; onDocumentClick?: (document: { sessionId: string; src: string; filename: string; mimeType: string; size: number }) => void; onReact?: (message: unknown, emoji: string) => void; onSelect?: (message: unknown) => void; onRetry?: (message: unknown) => void }) => (
    <div data-testid="message-bubble">
      <span>{message.body}</span>{message.status === 'failed' && <button onClick={() => onRetry?.(message)}>Reintentar envío</button>}<span>{message.quoted_body}</span>
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


describe('ChatPanel experience invariants', () => {
  beforeEach(() => {
    localStorage.setItem('token', 'test-token'); websocket.listeners.clear()
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1200)
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
  const message = { id: 'canonical-z', message_id: 'wa-z', body: 'Último saliente', is_from_me: true, is_read: false, status: 'sent', timestamp: '2026-10-11T12:00:00Z' }
  it('waits for measurable layout before reading and follows late media without pulling a reader out of history', async () => {
    let height = 0
    let contentHeight = 1200
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight)
    const observers: Array<{ callback: () => void; targets: Element[] }> = []
    vi.stubGlobal('ResizeObserver', class {
      record: { callback: () => void; targets: Element[] }
      constructor(callback: () => void) { this.record = { callback, targets: [] }; observers.push(this.record) }
      observe(target: Element) { this.record.targets.push(target) }
      unobserve() {}
      disconnect() { this.record.targets = [] }
    })
    const incoming = { ...message, is_from_me: false, body: 'Mensaje visible al final' }
    const writes: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return Promise.resolve(jsonResponse({ success: true, chat: { ...chat, unread_count: 1 }, device: device('connected') }))
      if (url.includes('/messages?')) return Promise.resolve(jsonResponse({ success: true, messages: [incoming] }))
      if (url.endsWith('/read') || url.endsWith('/read-receipt')) writes.push(url)
      if (url.endsWith('/read')) return Promise.resolve(jsonResponse({ success: true, unread_count: 0 }))
      return Promise.resolve(jsonResponse({ success: true, stickers: [], quick_replies: [] }))
    }))
    const panel = render(<ChatPanel chatId={chat.id} initialChat={{ ...chat, unread_count: 1 }} />)
    await screen.findByText('Mensaje visible al final')
    expect(writes).toEqual([])
    const viewport = panel.container.querySelector<HTMLElement>('[data-chat-messages-viewport]')!
    const resize = () => { for (const observer of observers) if (observer.targets.some(target => target.hasAttribute('data-chat-messages-content'))) observer.callback() }
    height = 600
    act(resize)
    await waitFor(() => expect(viewport.scrollTop).toBe(1200))
    await waitFor(() => expect(writes).toEqual(['/api/messages/read-receipt', '/api/chats/chat-1/read']))
    contentHeight = 1800
    act(resize)
    await waitFor(() => expect(viewport.scrollTop).toBe(1800))
    viewport.scrollTop = 200
    fireEvent.scroll(viewport)
    contentHeight = 2100
    act(resize)
    await act(async () => { await new Promise(resolve => requestAnimationFrame(() => resolve(undefined))) })
    expect(viewport.scrollTop).toBe(200)
  })
  it('pauses inline audio and video on Back while preserving the mounted draft and media source', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return Promise.resolve(jsonResponse({ success: true, chat, device: device('connected') }))
      if (url.includes('/messages?')) return Promise.resolve(jsonResponse({ success: true, messages: [message] }))
      return Promise.resolve(jsonResponse({ success: true, stickers: [], quick_replies: [] }))
    }))
    const panel = render(<ChatPanel chatId={chat.id} initialChat={chat} />)
    const editor = await screen.findByRole('textbox', { name: 'Draft test editor' })
    fireEvent.change(editor, { target: { value: 'Borrador al volver' } })
    const viewport = panel.container.querySelector<HTMLElement>('[data-chat-messages-viewport]')!
    const audio = document.createElement('audio')
    audio.src = '/qa-audio.ogg'
    const video = document.createElement('video')
    video.src = '/qa-video.mp4'
    viewport.append(audio, video)
    panel.rerender(<ChatPanel chatId={chat.id} initialChat={chat} isActive={false} />)
    expect(pause).toHaveBeenCalledTimes(2)
    expect(audio.getAttribute('src')).toBe('/qa-audio.ogg')
    expect(video.getAttribute('src')).toBe('/qa-video.mp4')
    expect(editor).toHaveValue('Borrador al volver')
  })
  it('marks the outgoing canonical boundary and preserves pending attention beyond the latest history window', async () => {
    const onRead = vi.fn()
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return Promise.resolve(jsonResponse({ success: true, chat: { ...chat, unread_count: 3, needs_reply: true }, device: device('connected') }))
      if (url.includes('/messages?')) return Promise.resolve(jsonResponse({ success: true, messages: [message] }))
      if (url.endsWith('/read')) return Promise.resolve(jsonResponse({ success: true, unread_count: 0, chat_state: { chat_id: chat.id, unread_count: 0, needs_reply: true, state_version: 2 } }))
      return Promise.resolve(jsonResponse({ success: true, stickers: [], quick_replies: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ChatPanel chatId={chat.id} initialChat={{ ...chat, unread_count: 3 }} onRead={onRead} />)
    await waitFor(() => expect(onRead).toHaveBeenCalledWith(chat.id, 0, expect.objectContaining({ needs_reply: true })))
    const call = (fetchMock.mock.calls as unknown as [string, RequestInit][]).find(([url]) => url.endsWith('/read'))!
    expect(JSON.parse(String(call[1].body))).toEqual({ through_message_id: message.id })
  })
  it('keeps the newer incoming boundary when an older read response settles after realtime reconciliation', async () => {
    let finishRead!: (response: Response) => void
    const oldState = { chat_id: chat.id, unread_count: 3, needs_reply: true, waiting_since: '2026-10-11T11:00:00Z', state_version: 9,
      last_incoming_message_id: 'old-incoming', last_incoming_at: '2026-10-11T11:00:00Z' }
    const newer = { ...chat, ...oldState, state_version: 11, unread_count: 1, last_incoming_message_id: 'new-incoming', last_incoming_at: '2026-10-11T11:30:00Z' }
    const attentionBodies: Array<{ through_message_id: string }> = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return Promise.resolve(jsonResponse({ success: true, chat: { ...chat, ...oldState }, chat_state: oldState, device: device('connected') }))
      if (url.includes('/messages?')) return Promise.resolve(jsonResponse({ success: true, messages: [message] }))
      if (url.endsWith('/read')) return new Promise<Response>(resolve => { finishRead = resolve })
      if (url.endsWith('/attention')) { attentionBodies.push(JSON.parse(String(init?.body))); return Promise.resolve(jsonResponse({ success: true, chat_state: { ...oldState, ...newer, state_version: 12, unread_count: 0, needs_reply: false } })) }
      return Promise.resolve(jsonResponse({ success: true, stickers: [], quick_replies: [] }))
    }))
    const panel = render(<ChatPanel chatId={chat.id} initialChat={{ ...chat, ...oldState }} attentionMode />)
    await waitFor(() => expect(finishRead).toBeTypeOf('function'))
    panel.rerender(<ChatPanel chatId={chat.id} initialChat={newer} attentionMode />)
    await act(async () => finishRead(jsonResponse({ success: true, unread_count: 0, chat_state: { ...oldState, unread_count: 0, state_version: 10 } })))
    fireEvent.click(screen.getByRole('button', { name: 'No requiere respuesta' }))
    await waitFor(() => expect(attentionBodies).toEqual([{ through_message_id: 'new-incoming' }]))
  })
  it('freezes media attention before image compression even when a newer incoming message arrives', async () => {
    const OriginalURL = URL
    vi.stubGlobal('URL', class extends OriginalURL {
      static createObjectURL = vi.fn(() => 'blob:qa-image')
      static revokeObjectURL = vi.fn()
    })
    let finishCompression!: (file: File) => void
    compression.compress.mockImplementationOnce(() => new Promise<File>(resolve => { finishCompression = resolve }))
    const incoming = { ...message, id: 'incoming-a', message_id: 'wa-a', is_from_me: false, is_read: true, body: 'Antes de enviar', timestamp: '2026-10-11T11:00:00Z' }
    const bodies: Array<{ attention_through_message_id: string }> = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return Promise.resolve(jsonResponse({ success: true, chat: { ...chat, last_incoming_message_id: incoming.id, last_incoming_at: incoming.timestamp }, device: device('connected') }))
      if (url.includes('/messages?')) return Promise.resolve(jsonResponse({ success: true, messages: [incoming, message] }))
      if (url === '/api/media/upload') return Promise.resolve(jsonResponse({ success: true, proxy_url: '/api/media/file/account/image.jpg' }))
      if (url === '/api/messages/send') { bodies.push(JSON.parse(String(init?.body))); return Promise.resolve(jsonResponse({ success: true, message: { ...message, id: 'sent-image', message_id: 'wa-image', message_type: 'image', media_url: '/api/media/file/account/image.jpg' } })) }
      if (url.endsWith('/read')) return Promise.resolve(jsonResponse({ success: true, unread_count: 0 }))
      return Promise.resolve(jsonResponse({ success: true, stickers: [], quick_replies: [] }))
    }))
    const panel = render(<ChatPanel chatId={chat.id} initialChat={chat} />)
    await screen.findByText('Antes de enviar')
    const picker = panel.container.querySelector<HTMLInputElement>('input[type="file"][accept="image/*,video/*"]')!
    const file = new File(['image'], 'image.jpg', { type: 'image/jpeg' })
    fireEvent.change(picker, { target: { files: [file] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar adjunto' }))
    await waitFor(() => expect(finishCompression).toBeTypeOf('function'))
    await act(async () => {
      for (const listener of Array.from(websocket.listeners)) listener({ event: 'new_message', data: { chat_id: chat.id,
        message: { ...incoming, id: 'incoming-b', message_id: 'wa-b', body: 'Durante la compresión', timestamp: '2026-10-11T12:01:00Z' } } })
    })
    await screen.findByText('Durante la compresión')
    await act(async () => finishCompression(file))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].attention_through_message_id).toBe(incoming.id)
  })
  it('uploads media once and retries the exact frozen payload while preserving the next draft', async () => {
    const OriginalURL = URL
    vi.stubGlobal('URL', class extends OriginalURL {
      static createObjectURL = vi.fn(() => 'blob:qa-video')
      static revokeObjectURL = vi.fn()
    })
    let uploadCount = 0
    const bodies: string[] = []
    let failSend!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return Promise.resolve(jsonResponse({ success: true, chat, device: device('connected') }))
      if (url.includes('/messages?')) return Promise.resolve(jsonResponse({ success: true, messages: [] }))
      if (url === '/api/media/upload') { uploadCount++; return Promise.resolve(jsonResponse({ success: true, proxy_url: '/api/media/file/account/qa-video.mp4' })) }
      if (url === '/api/messages/send') {
        bodies.push(String(init?.body))
        if (bodies.length === 1) return new Promise<Response>(resolve => { failSend = resolve })
        return Promise.resolve(jsonResponse({ success: true, message: { ...message, body: 'Video QA', message_type: 'video', media_url: '/api/media/file/account/qa-video.mp4' } }))
      }
      return Promise.resolve(jsonResponse({ success: true, stickers: [], quick_replies: [] }))
    }))
    const panel = render(<ChatPanel chatId={chat.id} initialChat={chat} />)
    const editor = await screen.findByRole('textbox', { name: 'Draft test editor' })
    await waitFor(() => expect(editor).not.toBeDisabled())
    const picker = panel.container.querySelector<HTMLInputElement>('input[type="file"][accept="image/*,video/*"]')!
    fireEvent.change(picker, { target: { files: [new File(['video'], 'video.mp4', { type: 'video/mp4' })] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar adjunto' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(screen.queryByRole('button', { name: 'Enviar adjunto' })).not.toBeInTheDocument()
    expect(editor).not.toBeDisabled()
    fireEvent.change(editor, { target: { value: 'Borrador mientras se envía el video' } })
    await act(async () => failSend(jsonResponse({ success: false, error: 'Fallo simulado' }, false)))
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar envío' }))
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(uploadCount).toBe(1)
    expect(bodies[1]).toBe(bodies[0])
    expect(JSON.parse(bodies[0]).client_operation_id).toBeTruthy()
    expect(editor).toHaveValue('Borrador mientras se envía el video')
  })
  it('leaves the next draft editable and retries the frozen idempotent payload without clearing it', async () => {
    let finish!: (response: Response) => void
    const bodies: string[] = []
    let attempt = 0
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return Promise.resolve(jsonResponse({ success: true, chat, device: device('connected') }))
      if (url.includes('/messages?')) return Promise.resolve(jsonResponse({ success: true, messages: [] }))
      if (url === '/api/messages/send') { bodies.push(String(init?.body)); attempt++; if (attempt === 1) return new Promise<Response>(resolve => { finish = resolve }); return Promise.resolve(jsonResponse({ success: true, message: { ...message, body: 'Primero' } })) }
      return Promise.resolve(jsonResponse({ success: true, stickers: [], quick_replies: [] }))
    }))
    render(<ChatPanel chatId={chat.id} initialChat={chat} />)
    const editor = await screen.findByRole('textbox', { name: 'Draft test editor' })
    fireEvent.change(editor, { target: { value: 'Primero' } }); fireEvent.click(screen.getByRole('button', { name: 'Enviar mensaje' }))
    expect(editor).not.toBeDisabled()
    fireEvent.change(editor, { target: { value: 'Siguiente borrador' } })
    await act(async () => finish(jsonResponse({ success: false }, false)))
    fireEvent.click(await screen.findByText('Reintentar envío'))
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[0]).toBe(bodies[1]); expect(JSON.parse(bodies[0]).client_operation_id).toBeTruthy()
    expect(editor).toHaveValue('Siguiente borrador')
  })
})
