import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat, Device } from '@/types/chat'
import { beginAuthIdentityChange, completeAuthIdentityChange } from '@/lib/authScope'

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
  default: ({ message, onMediaClick, onDocumentClick, onReact, onSelect, onRetry, onRecoverMedia }: { message: { media_url?: string; status?: string; body?: string; quoted_body?: string; media_filename?: string; media_recoverable?: boolean; media_unavailable_reason?: string; reactions?: Array<{ emoji: string; is_from_me: boolean }> }; onMediaClick?: (url: string, type: string) => void; onDocumentClick?: (document: { sessionId: string; src: string; filename: string; mimeType: string; size: number }) => void; onReact?: (message: unknown, emoji: string) => void; onSelect?: (message: unknown) => void; onRetry?: (message: unknown) => void; onRecoverMedia?: (message: unknown) => Promise<void> }) => (
    <div data-testid="message-bubble">
      {message.media_url && onMediaClick && <button onClick={() => onMediaClick(message.media_url!, 'image')}>Abrir imagen simulada</button>}
      <span>{message.body}</span>{message.status === 'failed' && <button onClick={() => onRetry?.(message)}>Reintentar envío</button>}<span>{message.quoted_body}</span>
      <span>{message.media_filename}</span><span data-testid="media-unavailable-reason">{message.media_unavailable_reason}</span>
      {message.media_recoverable && !message.media_unavailable_reason && onRecoverMedia && <button type="button" onClick={() => { void onRecoverMedia(message).catch(() => {}) }}>Recuperar archivo simulado</button>}
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
vi.mock('./ImageViewer', () => ({ default: ({ src, onClose }: { src: string; onClose: () => void }) => <div role="dialog" aria-label="Imagen simulada" data-src={src}><button onClick={onClose}>Cerrar imagen simulada</button></div> }))
vi.mock('./ChatDocumentViewer', () => ({
  default: ({ document, onClose }: { document: { filename: string }; onClose: () => void }) => (
    <div role="dialog" aria-label={`Vista previa de ${document.filename}`}>
      <button type="button" onClick={onClose}>Cerrar documento simulado</button>
    </div>
  ),
}))
vi.mock('../ContactSelector', async () => {
  const { useEffect, useState } = await import('react')
  return { default: ({ open, suspended }: { open: boolean; suspended?: boolean }) => {
    const [value, setValue] = useState('')
    useEffect(() => { if (!open) setValue('') }, [open])
    return open && !suspended ? <div role="dialog" aria-label="Selector de contacto simulado"><input aria-label="Selección de contacto pendiente" value={value} onChange={event => setValue(event.target.value)} /></div> : null
  } }
})

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
    compression.compress.mockReset().mockImplementation(async (file: File) => file)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1200)
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
  const message = { id: 'canonical-z', message_id: 'wa-z', body: 'Último saliente', is_from_me: true, is_read: false, status: 'sent', timestamp: '2026-10-11T12:00:00Z' }
  it('retains an opened contact selector instead of closing its selection on suspension', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(jsonResponse(String(input) === '/api/chats/chat-1'
      ? { success: true, chat, device: device('connected') }
      : { success: true, messages: [], stickers: [], quick_replies: [] }))))
    const panel = (suspended: boolean) => <ChatPanel chatId={chat.id} initialChat={chat} suspended={suspended} />
    const view = render(panel(false))
    await screen.findByRole('textbox', { name: 'Draft test editor' })
    fireEvent.click(screen.getByRole('button', { name: 'Adjuntar archivo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Contacto' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Selección de contacto pendiente' }), { target: { value: 'Contacto elegido' } })
    view.rerender(panel(true))
    expect(screen.queryByRole('dialog', { name: 'Selector de contacto simulado' })).not.toBeInTheDocument()
    view.rerender(panel(false))
    expect(screen.getByRole('textbox', { name: 'Selección de contacto pendiente' })).toHaveValue('Contacto elegido')
  })
  it('keeps a desktop message draft through mobile suspension and blocks a saved send callback', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return Promise.resolve(jsonResponse({ success: true, chat, device: device('connected') }))
      if (url.includes('/messages?')) return Promise.resolve(jsonResponse({ success: true, messages: [] }))
      if (url === '/api/messages/send') return Promise.resolve(jsonResponse({ success: true, message: { ...message, body: 'Borrador conservado' } }))
      return Promise.resolve(jsonResponse({ success: true, stickers: [], quick_replies: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const consult = vi.fn()
    const panel = (suspended: boolean) => <CrmDetailWorkspace chatOpen chatSuspended={suspended} detail={<button onClick={consult}>Consultar asistencia</button>} chat={<ChatPanel chatId={chat.id} initialChat={chat} suspended={suspended} />} />
    const view = render(panel(false))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Draft test editor' }), { target: { value: 'Borrador conservado' } })
    const button = screen.getByRole('button', { name: 'Enviar mensaje' })
    const send = (button as any)[Object.keys(button).find(key => key.startsWith('__reactProps$'))!].onClick
    const before = fetchMock.mock.calls.length
    view.rerender(panel(true))
    expect(screen.queryByRole('textbox', { name: 'Draft test editor' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Consultar asistencia' }))
    expect(consult).toHaveBeenCalledOnce()
    await act(async () => { await send() })
    expect(fetchMock.mock.calls.slice(before).filter(([url]) => String(url) === '/api/messages/send')).toHaveLength(0)
    view.rerender(panel(false))
    expect(await screen.findByRole('textbox', { name: 'Draft test editor' })).toHaveValue('Borrador conservado')
    fireEvent.click(screen.getByRole('button', { name: 'Enviar mensaje' }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/messages/send')).toHaveLength(1))
  })

  it('preserves an attachment and caption when image preparation finishes during suspension', async () => {
    const NativeURL = URL
    const revoke = vi.fn()
    vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = vi.fn(() => 'blob:suspended-image'); static revokeObjectURL = revoke })
    let finishCompression!: (file: File) => void
    compression.compress.mockImplementationOnce(() => new Promise<File>(resolve => { finishCompression = resolve }))
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return Promise.resolve(jsonResponse({ success: true, chat, device: device('connected') }))
      if (url.includes('/messages?')) return Promise.resolve(jsonResponse({ success: true, messages: [] }))
      return Promise.resolve(jsonResponse({ success: true, stickers: [], quick_replies: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const panel = (suspended: boolean) => <ChatPanel chatId={chat.id} initialChat={chat} suspended={suspended} />
    const view = render(panel(false))
    await screen.findByRole('textbox', { name: 'Draft test editor' })
    const file = new File(['image'], 'foto.png', { type: 'image/png' })
    fireEvent.change(view.container.querySelector<HTMLInputElement>('input[type="file"][accept="image/*,video/*"]')!, { target: { files: [file] } })
    fireEvent.change(screen.getAllByRole('textbox', { name: 'Draft test editor' })[0], { target: { value: 'Pie de foto pendiente' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar adjunto' }))
    await waitFor(() => expect(finishCompression).toBeTypeOf('function'))
    view.rerender(panel(true))
    await act(async () => finishCompression(file))
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/media/upload' || String(url) === '/api/messages/send')).toHaveLength(0)
    expect(revoke).not.toHaveBeenCalled()
    view.rerender(panel(false))
    expect((await screen.findAllByRole('textbox', { name: 'Draft test editor' }))[0]).toHaveValue('Pie de foto pendiente')
    expect(screen.getByAltText('Vista previa del adjunto')).toHaveAttribute('src', 'blob:suspended-image')
    expect(screen.getByRole('button', { name: 'Enviar adjunto' })).toBeEnabled()
  })

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
  it('pauses media on Back and resumes only silent GIF loops, preserving the draft and handling rejected play', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new DOMException('Autoplay blocked', 'NotAllowedError'))
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
    const gif = document.createElement('video')
    gif.src = '/qa-gif.mp4'; gif.autoplay = true; gif.loop = true; gif.muted = true
    const audibleLoop = document.createElement('video')
    audibleLoop.autoplay = true; audibleLoop.loop = true
    const controlledVideo = document.createElement('video')
    controlledVideo.autoplay = true; controlledVideo.loop = true; controlledVideo.muted = true; controlledVideo.controls = true
    viewport.append(audio, video, gif, audibleLoop, controlledVideo)
    panel.rerender(<ChatPanel chatId={chat.id} initialChat={chat} isActive={false} />)
    expect(pause).toHaveBeenCalledTimes(5)
    expect(audio.getAttribute('src')).toBe('/qa-audio.ogg')
    expect(video.getAttribute('src')).toBe('/qa-video.mp4')
    expect(editor).toHaveValue('Borrador al volver')
    expect(play).not.toHaveBeenCalled()
    await act(async () => panel.rerender(<ChatPanel chatId={chat.id} initialChat={chat} isActive />))
    expect(play).toHaveBeenCalledTimes(1)
    expect(play.mock.contexts[0]).toBe(gif)
    expect(gif.getAttribute('src')).toBe('/qa-gif.mp4')
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
  it('does not allocate or send media after the panel unmounts during image compression', async () => {
    const OriginalURL = URL
    const create = vi.fn(() => 'blob:qa-unmount-draft')
    const revoke = vi.fn()
    vi.stubGlobal('URL', class extends OriginalURL {
      static createObjectURL = create
      static revokeObjectURL = revoke
    })
    let finishCompression!: (file: File) => void
    compression.compress.mockImplementationOnce(() => new Promise<File>(resolve => { finishCompression = resolve }))
    const writes: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return Promise.resolve(jsonResponse({ success: true, chat, device: device('connected') }))
      if (url.includes('/messages?')) return Promise.resolve(jsonResponse({ success: true, messages: [] }))
      if (url === '/api/media/upload' || url === '/api/messages/send') writes.push(url)
      return Promise.resolve(jsonResponse({ success: true, stickers: [], quick_replies: [] }))
    }))
    const panel = render(<ChatPanel chatId={chat.id} initialChat={chat} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Draft test editor' })).not.toBeDisabled())
    const file = new File(['image'], 'image.jpg', { type: 'image/jpeg' })
    fireEvent.change(panel.container.querySelector<HTMLInputElement>('input[type="file"][accept="image/*,video/*"]')!, { target: { files: [file] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar adjunto' }))
    await waitFor(() => expect(finishCompression).toBeTypeOf('function'))
    expect(create).toHaveBeenCalledTimes(1)
    panel.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:qa-unmount-draft')
    await act(async () => finishCompression(file))
    expect(create).toHaveBeenCalledTimes(1)
    expect(writes).toEqual([])
  })
  it.each(['http', 'websocket'] as const)('keeps the open optimistic image viewer alive with its canonical source after %s confirmation', async source => {
    const OriginalURL = URL
    let nextBlob = 0
    const revoke = vi.fn()
    vi.stubGlobal('URL', class extends OriginalURL {
      static createObjectURL = vi.fn(() => `blob:qa-viewer-${++nextBlob}`)
      static revokeObjectURL = revoke
    })
    let finishSend!: (response: Response) => void
    const canonicalURL = '/api/media/file/account/viewer.jpg'
    const canonical = { ...message, id: 'sent-viewer', message_id: 'wa-viewer', body: '', message_type: 'image', media_filename: 'image.jpg', media_url: canonicalURL }
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return Promise.resolve(jsonResponse({ success: true, chat, device: device('connected') }))
      if (url.includes('/messages?')) return Promise.resolve(jsonResponse({ success: true, messages: [] }))
      if (url === '/api/media/upload') return Promise.resolve(jsonResponse({ success: true, proxy_url: canonicalURL }))
      if (url === '/api/messages/send') return new Promise<Response>(resolve => { finishSend = resolve })
      return Promise.resolve(jsonResponse({ success: true, stickers: [], quick_replies: [] }))
    }))
    const panel = render(<ChatPanel chatId={chat.id} initialChat={chat} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Draft test editor' })).not.toBeDisabled())
    const file = new File(['image'], 'image.jpg', { type: 'image/jpeg' })
    fireEvent.change(panel.container.querySelector<HTMLInputElement>('input[type="file"][accept="image/*,video/*"]')!, { target: { files: [file] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar adjunto' }))
    await waitFor(() => expect(finishSend).toBeTypeOf('function'))
    expect(revoke).toHaveBeenCalledWith('blob:qa-viewer-1')
    expect(revoke).not.toHaveBeenCalledWith('blob:qa-viewer-2')
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir imagen simulada' }))
    const viewer = screen.getByRole('dialog', { name: 'Imagen simulada' })
    expect(viewer).toHaveAttribute('data-src', 'blob:qa-viewer-2')
    if (source === 'http') {
      await act(async () => finishSend(jsonResponse({ success: true, message: canonical })))
    } else {
      await act(async () => { for (const listener of Array.from(websocket.listeners)) listener({ event: 'message_sent', data: { chat_id: chat.id, message: canonical } }) })
    }
    await waitFor(() => expect(viewer).toHaveAttribute('data-src', canonicalURL))
    expect(screen.getByRole('dialog', { name: 'Imagen simulada' })).toBe(viewer)
    expect(revoke.mock.calls.filter(([url]) => url === 'blob:qa-viewer-2')).toHaveLength(1)
    if (source === 'websocket') await act(async () => finishSend(jsonResponse({ success: true, message: canonical })))
    expect(revoke.mock.calls.filter(([url]) => url === 'blob:qa-viewer-2')).toHaveLength(1)
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


describe('group composer identities through drafts and retries', () => {
  const groupChat: Chat = { ...chat, id: 'group-1', jid: '120000@g.us', kind: 'group', name: 'Equipo', group: { subject: 'Equipo', participant_count: 2, membership_status: 'member', announce: false, can_send: true } }
  const member = { jid: '51900000002@s.whatsapp.net', name: 'María León', role: 'member', is_self: false }
  beforeEach(() => { localStorage.setItem('token', 'test-token'); websocket.listeners.clear(); vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600); vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1200) })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
  function install() {
    const bodies: string[] = []
    let uploadCount = 0
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/chats/group-1' || url === '/api/chats/chat-1') return Promise.resolve(jsonResponse({ success: true, chat: url.endsWith('group-1') ? groupChat : chat, device: { ...device('connected'), runtime_capabilities: { ...device('connected').runtime_capabilities, can_send_group_messages: true, can_list_groups: true } } }))
      if (url.includes('/group/participants?')) return Promise.resolve(jsonResponse({ success: true, participants: [member] }))
      if (url.includes('/messages?')) return Promise.resolve(jsonResponse({ success: true, messages: [] }))
      if (url === '/api/media/upload') { uploadCount++; return Promise.resolve(jsonResponse({ success: true, proxy_url: '/api/media/file/account/group-video.mp4' })) }
      if (url === '/api/messages/send') {
        bodies.push(String(init?.body)); const payload = JSON.parse(String(init?.body))
        return Promise.resolve(jsonResponse(bodies.length === 1 ? { success: false, error: 'Fallo temporal' } : { success: true, message: { ...payload, id: 'sent-group', message_id: 'wa-group', is_from_me: true, is_read: false, status: 'sent', timestamp: '2026-10-18T12:00:00Z' } }, bodies.length !== 1))
      }
      return Promise.resolve(jsonResponse({ success: true, stickers: [], quick_replies: [] }))
    }))
    return { bodies, uploads: () => uploadCount }
  }
  async function mention() {
    const editor = await screen.findByRole('textbox', { name: 'Draft test editor' })
    await waitFor(() => expect(editor).not.toBeDisabled())
    fireEvent.change(editor, { target: { value: 'Hola @Mar' } })
    fireEvent.click(await screen.findByRole('option', { name: 'María León' }))
    return editor
  }
  it('retains the exact mention identity across chat switches and frozen text retry', async () => {
    const state = install()
    const view = render(<ChatPanel chatId={groupChat.id} initialChat={groupChat} />)
    await mention()
    view.rerender(<ChatPanel chatId={chat.id} initialChat={chat} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Draft test editor' })).toHaveValue(''))
    view.rerender(<ChatPanel chatId={groupChat.id} initialChat={groupChat} />)
    const editor = await screen.findByRole('textbox', { name: 'Draft test editor' })
    await waitFor(() => expect(editor).toHaveValue('Hola @María León '))
    expect(screen.getByLabelText('Personas mencionadas')).toHaveTextContent('María León')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar mensaje' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: 'Enviar mensaje' }))
    await screen.findByRole('button', { name: 'Reintentar envío' })
    fireEvent.change(editor, { target: { value: 'Próximo borrador' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar envío' }))
    await waitFor(() => expect(state.bodies).toHaveLength(2))
    expect(state.bodies[1]).toBe(state.bodies[0]); expect(JSON.parse(state.bodies[0])).toMatchObject({ body: 'Hola @51900000002', mentions: [{ jid: member.jid, name: member.name }] })
    expect(editor).toHaveValue('Próximo borrador')
  })
  it('moves mention metadata into a media caption and preserves it without reupload on retry', async () => {
    const OriginalURL = URL
    vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL = vi.fn(() => 'blob:group-video'); static revokeObjectURL = vi.fn() })
    const state = install()
    const view = render(<ChatPanel chatId={groupChat.id} initialChat={groupChat} />)
    await mention()
    fireEvent.change(view.container.querySelector<HTMLInputElement>('input[type="file"][accept="image/*,video/*"]')!, { target: { files: [new File(['video'], 'video.mp4', { type: 'video/mp4' })] } })
    expect(await screen.findByLabelText('Personas mencionadas')).toHaveTextContent('María León')
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar adjunto' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar envío' }))
    await waitFor(() => expect(state.bodies).toHaveLength(2))
    expect(state.bodies[1]).toBe(state.bodies[0]); expect(state.uploads()).toBe(1)
    expect(JSON.parse(state.bodies[0])).toMatchObject({ body: 'Hola @51900000002 ', mentions: [{ jid: member.jid, name: member.name }], media_type: 'video' })
  })
})

describe('group media recovery canonical responses', () => {
  const groupChat: Chat = { ...chat, id: 'group-recovery', jid: '120009@g.us', kind: 'group', group: { subject: 'Archivos', participant_count: 2, membership_status: 'member', announce: false, can_send: true } }
  const message = { id: 'media-recovery', chat_id: groupChat.id, message_id: 'wa-media-recovery', body: 'Material de la reunión', message_type: 'document', media_filename: 'Grabación.zip', media_recoverable: true, is_from_me: false, is_read: true, status: 'delivered', timestamp: '2026-10-18T12:00:00Z' }
  const canonical = { ...message, media_recoverable: false, media_unavailable_reason: 'group_media_too_large' }
  beforeEach(() => {
    localStorage.setItem('token', 'test-token'); completeAuthIdentityChange(); websocket.listeners.clear()
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1200)
  })
  afterEach(() => { cleanup(); completeAuthIdentityChange(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
  function install(recover: (init?: RequestInit) => Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/media/recover')) return recover(init)
      if (url === `/api/chats/${groupChat.id}`) return Promise.resolve(jsonResponse({ success: true, chat: groupChat, device: device('connected') }))
      if (url.includes('/messages?')) return Promise.resolve(jsonResponse({ success: true, messages: [message] }))
      return Promise.resolve(jsonResponse({ success: true, stickers: [], quick_replies: [] }))
    }))
  }
  it('applies the terminal HTTP 422 message without a WebSocket event and retains its caption and filename', async () => {
    const recover = vi.fn(() => Promise.resolve(jsonResponse({ code: 'group_media_too_large', message: canonical, error: 'Archivo demasiado grande' }, false, 422)))
    install(recover)
    render(<ChatPanel chatId={groupChat.id} initialChat={groupChat} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Recuperar archivo simulado' }))
    await waitFor(() => expect(screen.getByTestId('media-unavailable-reason')).toHaveTextContent('group_media_too_large'))
    expect(screen.queryByRole('button', { name: 'Recuperar archivo simulado' })).not.toBeInTheDocument()
    expect(screen.getByText('Material de la reunión')).toBeInTheDocument()
    expect(screen.getByText('Grabación.zip')).toBeInTheDocument()
    expect(recover).toHaveBeenCalledOnce()
  })
  it.each([{ id: 'other-message' }, { chat_id: 'other-chat' }])('rejects a canonical error message outside the requested identity: %j', async (replacement) => {
    install(() => Promise.resolve(jsonResponse({ code: 'group_media_too_large', message: { ...canonical, ...replacement } }, false, 422)))
    render(<ChatPanel chatId={groupChat.id} initialChat={groupChat} />)
    const button = await screen.findByRole('button', { name: 'Recuperar archivo simulado' })
    await act(async () => fireEvent.click(button))
    expect(screen.getByTestId('media-unavailable-reason')).toBeEmptyDOMElement()
    expect(button).toBeInTheDocument()
  })
  it('discards a delayed canonical error after an auth scope change', async () => {
    let finish!: (response: Response) => void
    let signal: AbortSignal | null | undefined
    install(init => { signal = init?.signal; return new Promise(resolve => { finish = resolve }) })
    render(<ChatPanel chatId={groupChat.id} initialChat={groupChat} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Recuperar archivo simulado' }))
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    await act(async () => {
      beginAuthIdentityChange()
      finish(jsonResponse({ code: 'group_media_too_large', message: canonical }, false, 422))
    })
    expect(signal?.aborted).toBe(true)
    expect(screen.getByTestId('media-unavailable-reason')).toBeEmptyDOMElement()
  })
})
