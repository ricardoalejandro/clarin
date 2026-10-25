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
  default: ({ message, onMediaClick, onDocumentClick, onReact, onSelect, onRetry, onRecoverMedia, onQuotedMessageClick, onEdit }: { message: { link_preview?: { title: string; thumbnail_url?: string | null } | null; link_preview_version?: number; media_url?: string; status?: string; body?: string; quoted_body?: string; quoted_message_id?: string; media_filename?: string; media_recoverable?: boolean; media_unavailable_reason?: string; reactions?: Array<{ emoji: string; is_from_me: boolean }> }; onMediaClick?: (url: string, type: string) => void; onDocumentClick?: (document: { sessionId: string; src: string; filename: string; mimeType: string; size: number }) => void; onReact?: (message: unknown, emoji: string) => void; onSelect?: (message: unknown) => void; onRetry?: (message: unknown) => void; onRecoverMedia?: (message: unknown) => Promise<void>; onQuotedMessageClick?: (id: string) => void; onEdit?: (message: unknown) => void }) => (
    <div data-testid="message-bubble">
      {message.media_url && onMediaClick && <button onClick={() => onMediaClick(message.media_url!, 'image')}>Abrir imagen simulada</button>}
      <span>{message.body}</span><span data-testid="link-preview-title" data-preview-version={message.link_preview_version} data-preview-thumbnail={message.link_preview?.thumbnail_url || ''}>{message.link_preview?.title}</span>{onEdit && <button onClick={() => onEdit(message)}>Editar mensaje simulado</button>}{message.status === 'failed' && <button onClick={() => onRetry?.(message)}>Reintentar envío</button>}<span>{message.quoted_body}</span>
      <span>{message.media_filename}</span><span data-testid="media-unavailable-reason">{message.media_unavailable_reason}</span>
      {message.quoted_message_id && onQuotedMessageClick && <button onClick={() => onQuotedMessageClick(message.quoted_message_id!)}>Abrir cita simulada</button>}
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


describe('Group member private conversation', () => {
  const group: Chat = { ...chat, id: 'source-group', jid: '120001@g.us', kind: 'group', name: 'Grupo de estudio', group: { subject: 'Grupo de estudio', participant_count: 2, membership_status: 'member', announce: false, can_send: true } }
  beforeEach(() => {
    localStorage.setItem('token', 'test-token'); completeAuthIdentityChange(); websocket.listeners.clear()
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1200)
  })
  afterEach(() => { cleanup(); completeAuthIdentityChange(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
  it('keeps the group draft mounted and restores it after visiting the private chat without sending', async () => {
    const onChange = vi.fn()
    const sourceDevice = { ...device('connected'), runtime_capabilities: { ...device('connected').runtime_capabilities, can_list_groups: true, can_send_group_messages: true } }
    const requests = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      return Promise.resolve(jsonResponse(url === `/api/chats/${group.id}`
        ? { success: true, chat: group, device: sourceDevice }
        : url === `/api/chats/${chat.id}` ? { success: true, chat, device: device('connected') }
        : { success: true, messages: [], stickers: [], quick_replies: [] }))
    })
    vi.stubGlobal('fetch', requests)
    const panel = (privateChat: Chat | null) => <ChatPanel chatId={group.id} initialChat={group} participantChat={privateChat} onParticipantChatChange={onChange} />
    const view = render(panel(null))
    const groupDraft = await screen.findByRole('textbox', { name: 'Draft test editor' })
    fireEvent.change(groupDraft, { target: { value: 'Borrador pendiente para el grupo' } })
    view.rerender(panel(chat))
    const privateDraft = await screen.findByRole('textbox', { name: 'Draft test editor' })
    expect(privateDraft).not.toBe(groupDraft)
    expect(screen.getByRole('heading', { name: group.name, hidden: true }).closest('[hidden]')).toBeInTheDocument()
    expect(privateDraft).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Volver al integrante' }))
    expect(onChange).toHaveBeenCalledWith(null)
    view.rerender(panel(null))
    expect(await screen.findByRole('textbox', { name: 'Draft test editor' })).toHaveValue('Borrador pendiente para el grupo')
    expect(requests.mock.calls.some(([input]) => String(input).includes('/messages/send'))).toBe(false)
  })
})

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
      if (url.includes('/group/participants?')) return Promise.resolve(jsonResponse({ success: true, order: 'admins_first', participants: [member] }))
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

describe('received link preview reconciliation', () => {
  const preview = { url: 'https://example.com/a_b', title: 'Vista previa recibida', description: 'Descripción', thumbnail_url: null }
  const linked = { id: 'preview-local', message_id: 'preview-provider', device_id: chat.device_id, body: 'Consulta https://example.com/a_b', is_from_me: true, is_read: true, status: 'read', timestamp: new Date().toISOString(), link_preview: preview, link_preview_version: 0 }
  const recent = { ...linked, id: 'recent-local', message_id: 'recent-provider', body: 'Mensaje reciente', link_preview: null, quoted_message_id: linked.message_id }
  beforeEach(() => {
    localStorage.setItem('token', 'test-token'); completeAuthIdentityChange(); websocket.listeners.clear()
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1200)
  })
  afterEach(() => { cleanup(); completeAuthIdentityChange(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
  function install(historical = false) {
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/chats/${chat.id}`) return Promise.resolve(jsonResponse({ success: true, chat, device: device('connected') }))
      if (url === '/api/chats/other-chat') return Promise.resolve(jsonResponse({ success: true, chat: { ...chat, id: 'other-chat' }, device: device('connected') }))
      if (url.includes('/other-chat/messages?')) return Promise.resolve(jsonResponse({ success: true, messages: [{ ...recent, body: 'Otra conversación' }] }))
      if (url.includes('/messages/search?')) return Promise.resolve(jsonResponse({ success: true, messages: [linked], total: 1, history_offset: 75 }))
      if (url.includes('/context?')) return Promise.resolve(jsonResponse({ success: true, messages: [linked], message: linked }))
      if (url.includes('/messages?')) return Promise.resolve(jsonResponse({ success: true, messages: historical && !url.includes('offset=50') ? [recent] : [linked] }))
      if (url === '/api/messages/edit') return Promise.resolve(jsonResponse({ success: true, link_preview_version: 5 }))
      return Promise.resolve(jsonResponse({ success: true, stickers: [], quick_replies: [], link_preview: null }))
    })
    vi.stubGlobal('fetch', fetcher)
    return fetcher
  }
  function emit(data: Record<string, unknown> = {}, event = 'message_link_preview_updated', listeners = Array.from(websocket.listeners)) {
    const payload = event === 'message_link_preview_updated'
      ? { chat_id: chat.id, device_id: chat.device_id, message_id: linked.id, body_snapshot: linked.body, is_edited_snapshot: false, link_preview: { ...preview, title: 'Metadatos enriquecidos' }, link_preview_version: 1, ...data }
      : { chat_jid: chat.jid, device_id: chat.device_id, message_id: linked.message_id, ...data }
    for (const listener of listeners) listener({ event, data: payload })
  }
  it('loads canonical metadata and ignores foreign/stale enrichment without changing the message', async () => {
    install()
    render(<ChatPanel chatId={chat.id} initialChat={chat} />)
    await screen.findByText(preview.title)
    await act(async () => {
      for (const invalid of [{ chat_id: 'other-chat' }, { device_id: 'other-device' }, { message_id: 'other-id' }, { body_snapshot: 'Anterior' }, { is_edited_snapshot: true }]) emit(invalid)
      emit({ chat_id: 'other-chat', new_body: 'No aplicar', link_preview: null }, 'message_edited')
      emit({ chat_id: 'other-chat' }, 'message_revoked')
    })
    expect(screen.getByTestId('link-preview-title')).toHaveTextContent(preview.title)
    await act(async () => { emit(); emit() })
    expect(screen.getByTestId('link-preview-title')).toHaveTextContent('Metadatos enriquecidos')
    expect(screen.getByText(linked.body)).toBeInTheDocument()
    expect(screen.getAllByTestId('message-bubble')).toHaveLength(1)
    await act(async () => emit({ link_preview: null, link_preview_version: 2 }))
    expect(screen.getByTestId('link-preview-title')).toBeEmptyDOMElement()
  })
  it.each(['search', 'quote'] as const)('updates a historical %s projection and clears an edited preview without leaking it into the main page', async mode => {
    install(true)
    render(<ChatPanel chatId={chat.id} initialChat={chat} />)
    await screen.findByText(recent.body)
    if (mode === 'search') {
      fireEvent.click(screen.getByRole('button', { name: 'Buscar en la conversación' }))
      fireEvent.change(screen.getByRole('searchbox', { name: 'Texto a buscar' }), { target: { value: 'Consulta' } })
    } else fireEvent.click(screen.getByRole('button', { name: 'Abrir cita simulada' }))
    await screen.findByText(preview.title)
    await act(async () => emit())
    expect(screen.getByTestId('link-preview-title')).toHaveTextContent('Metadatos enriquecidos')
    await act(async () => emit({ new_body: 'Texto editado', mentions: [], link_preview: null, link_preview_version: 2 }, 'message_edited'))
    expect(screen.getByText('Texto editado')).toBeInTheDocument()
    expect(screen.getByTestId('link-preview-title')).toBeEmptyDOMElement()
    if (mode === 'search') expect(screen.getByText('Coincidencia: Texto editado')).toBeInTheDocument()
    await act(async () => emit())
    expect(screen.getByTestId('link-preview-title')).toBeEmptyDOMElement()
    fireEvent.click(screen.getByRole('button', { name: mode === 'search' ? 'Cerrar búsqueda' : 'Volver a donde estaba' }))
    expect(screen.getByText(recent.body)).toBeInTheDocument()
    expect(screen.queryByText('Texto editado')).not.toBeInTheDocument()
  })
  it('clears a preview on HTTP edit in an older context without depending on a WebSocket echo', async () => {
    const fetcher = install(true)
    render(<ChatPanel chatId={chat.id} initialChat={chat} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir cita simulada' }))
    await screen.findByText(preview.title)
    fireEvent.click(screen.getByRole('button', { name: 'Editar mensaje simulado' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft test editor' }), { target: { value: 'Texto editado desde Clarin' } })
    fireEvent.click(screen.getByRole('button', { name: /Guardar cambios|Enviar mensaje/ }))
    await screen.findByText('Texto editado desde Clarin')
    expect(screen.getByTestId('link-preview-title')).toBeEmptyDOMElement()
    expect(screen.getByTestId('link-preview-title')).toHaveAttribute('data-preview-version', '5')
    await act(async () => emit({ body_snapshot: 'Texto editado desde Clarin', is_edited_snapshot: true, link_preview_version: 4 }))
    expect(screen.getByTestId('link-preview-title')).toBeEmptyDOMElement()
    expect(fetcher.mock.calls.filter(([url]) => String(url) === '/api/messages/edit')).toHaveLength(1)
  })
  it.each(['main', 'search', 'quote'] as const)('does not resurrect a detached thumbnail in the %s projection and accepts a newer restore', async mode => {
    install(mode !== 'main')
    render(<ChatPanel chatId={chat.id} initialChat={chat} />)
    if (mode === 'search') {
      await screen.findByText(recent.body)
      fireEvent.click(screen.getByRole('button', { name: 'Buscar en la conversación' }))
      fireEvent.change(screen.getByRole('searchbox', { name: 'Texto a buscar' }), { target: { value: 'Consulta' } })
    } else if (mode === 'quote') fireEvent.click(await screen.findByRole('button', { name: 'Abrir cita simulada' }))
    await screen.findByText(preview.title)
    const withImage = { ...preview, thumbnail_url: '/api/media/file/test-thumbnail.jpg' }
    await act(async () => emit({ link_preview: withImage }))
    expect(screen.getByTestId('link-preview-title')).toHaveAttribute('data-preview-thumbnail', withImage.thumbnail_url)
    await act(async () => emit({ chat_id: chat.id, message: { ...linked, link_preview_version: 2 } }, 'message_media_updated'))
    expect(screen.getByTestId('link-preview-title')).toHaveAttribute('data-preview-thumbnail', '')
    await act(async () => { emit({ link_preview: withImage }); emit({ link_preview: withImage, link_preview_version: 2 }) })
    expect(screen.getByTestId('link-preview-title')).toHaveAttribute('data-preview-version', '2')
    expect(screen.getByTestId('link-preview-title')).toHaveAttribute('data-preview-thumbnail', '')
    await act(async () => emit({ link_preview: withImage, link_preview_version: 3 }))
    expect(screen.getByTestId('link-preview-title')).toHaveAttribute('data-preview-thumbnail', withImage.thumbnail_url)
    await act(async () => emit({ chat_id: chat.id, message: { ...linked, link_preview: null, link_preview_version: 2 } }, 'message_media_updated'))
    expect(screen.getByTestId('link-preview-title')).toHaveAttribute('data-preview-version', '3')
    expect(screen.getByTestId('link-preview-title')).toHaveAttribute('data-preview-thumbnail', withImage.thumbnail_url)
  })
  it.each(['search', 'quote'] as const)('retains a newer preview removal when a pending %s HTTP snapshot finishes late', async mode => {
    const fetcher = install(mode === 'quote')
    const original = fetcher.getMockImplementation()!
    const quoted = { ...linked, quoted_message_id: linked.message_id }
    if (mode === 'quote') fetcher.mockImplementation(input => String(input).includes('/context?')
      ? Promise.resolve(jsonResponse({ success: true, messages: [quoted], message: quoted })) : original(input))
    render(<ChatPanel chatId={chat.id} initialChat={chat} />)
    if (mode === 'quote') fireEvent.click(await screen.findByRole('button', { name: 'Abrir cita simulada' }))
    await screen.findByText(preview.title)
    let complete: ((response: Response) => void) | undefined
    fetcher.mockImplementation(input => String(input).includes(mode === 'search' ? '/messages/search?' : '/context?')
      ? new Promise<Response>(resolve => { complete = resolve }) : original(input))
    if (mode === 'search') {
      fireEvent.click(screen.getByRole('button', { name: 'Buscar en la conversación' }))
      fireEvent.change(screen.getByRole('searchbox', { name: 'Texto a buscar' }), { target: { value: 'Consulta' } })
    } else fireEvent.click(screen.getByRole('button', { name: 'Abrir cita simulada' }))
    await waitFor(() => expect(complete).toBeTypeOf('function'))
    await act(async () => emit({ chat_id: chat.id, message: { ...linked, link_preview: null, link_preview_version: 2 } }, 'message_media_updated'))
    expect(screen.getByTestId('link-preview-title')).toBeEmptyDOMElement()
    await act(async () => complete!(jsonResponse({ success: true, messages: [{ ...linked, link_preview_version: 1 }], message: linked, total: 1, history_offset: 0 })))
    expect(screen.getByTestId('link-preview-title')).toBeEmptyDOMElement()
    expect(screen.getByTestId('link-preview-title')).toHaveAttribute('data-preview-version', '2')
    expect(screen.getByText(linked.body)).toBeInTheDocument()
  })
  it('does not apply an old listener to another chat or a different authentication scope', async () => {
    install()
    const view = render(<ChatPanel chatId={chat.id} initialChat={chat} />)
    await screen.findByText(preview.title)
    const previous = Array.from(websocket.listeners)
    await act(async () => beginAuthIdentityChange())
    await act(async () => emit({}, 'message_link_preview_updated', previous))
    expect(screen.queryByText('Metadatos enriquecidos')).not.toBeInTheDocument()
    await act(async () => completeAuthIdentityChange())
    view.rerender(<ChatPanel chatId="other-chat" initialChat={{ ...chat, id: 'other-chat' }} />)
    await screen.findByText('Otra conversación')
    await act(async () => emit({}, 'message_link_preview_updated', previous))
    expect(screen.getByText('Otra conversación')).toBeInTheDocument()
    expect(screen.queryByText('Metadatos enriquecidos')).not.toBeInTheDocument()
  })
  it('keeps the enriched canonical row in the chat cache while a return refresh is pending', async () => {
    const fetcher = install()
    const view = render(<ChatPanel chatId={chat.id} initialChat={chat} />)
    await screen.findByText(preview.title)
    await act(async () => emit())
    expect(screen.getByTestId('link-preview-title')).toHaveTextContent('Metadatos enriquecidos')
    view.rerender(<ChatPanel chatId="other-chat" initialChat={{ ...chat, id: 'other-chat' }} />)
    await screen.findByText('Otra conversación')
    const original = fetcher.getMockImplementation()!
    fetcher.mockImplementation(input => String(input) === `/api/chats/${chat.id}` ? new Promise<Response>(() => {}) : original(input))
    view.rerender(<ChatPanel chatId={chat.id} initialChat={chat} />)
    await screen.findByText('Metadatos enriquecidos')
    expect(screen.getByText(linked.body)).toBeInTheDocument()
  })
})

describe('group media recovery canonical responses', () => {
  const groupChat: Chat = { ...chat, id: 'group-recovery', jid: '120009@g.us', kind: 'group', group: { subject: 'Archivos', participant_count: 2, membership_status: 'member', announce: false, can_send: true } }
  const message = { id: 'media-recovery', chat_id: groupChat.id, device_id: groupChat.device_id, message_id: 'wa-media-recovery', body: 'Material de la reunión', message_type: 'document', media_filename: 'Grabación.zip', media_recoverable: true, is_from_me: false, is_read: true, status: 'delivered', timestamp: '2026-10-18T12:00:00Z' }
  const canonical = { ...message, media_recoverable: false, media_unavailable_reason: 'group_media_too_large' }
  beforeEach(() => {
    localStorage.setItem('token', 'test-token'); completeAuthIdentityChange(); websocket.listeners.clear()
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1200)
  })
  afterEach(() => { cleanup(); completeAuthIdentityChange(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
  function install(recover: (init?: RequestInit) => Promise<Response>, historical = false, react?: () => Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/media/recover')) return recover(init)
      if (url === '/api/messages/react' && react) return react()
      if (url === `/api/chats/${chat.id}`) return Promise.resolve(jsonResponse({ success: true, chat, device: device('connected') }))
      if (url.includes(`/api/chats/${chat.id}/messages?`)) return Promise.resolve(jsonResponse({ success: true, messages: [{ ...message, id: 'other-row', message_id: 'wa-other', body: 'Otra conversación', media_recoverable: false }] }))
      if (url === `/api/chats/${groupChat.id}`) return Promise.resolve(jsonResponse({ success: true, chat: groupChat, device: device('connected') }))
      if (url.includes('/messages/search?')) return Promise.resolve(jsonResponse({ success: true, messages: [message], total: 1, history_offset: 75 }))
      if (url.includes('/context?')) return Promise.resolve(jsonResponse({ success: true, messages: [message], message }))
      if (url.includes('/messages?')) return Promise.resolve(jsonResponse({ success: true, messages: historical && !url.includes('offset=50') ? [{ ...message, id: 'recent', message_id: 'wa-recent', body: 'Último mensaje visible', media_filename: undefined, media_recoverable: false, message_type: 'text', quoted_message_id: message.message_id }] : [message] }))
      return Promise.resolve(jsonResponse({ success: true, stickers: [], quick_replies: [] }))
    }))
  }
  async function openHistoricalSearch() {
    await screen.findByText('Último mensaje visible')
    fireEvent.click(screen.getByRole('button', { name: 'Buscar en la conversación' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Texto a buscar' }), { target: { value: 'Material' } })
    return screen.findByRole('button', { name: 'Recuperar archivo simulado' })
  }
  function emit(snapshot: unknown, targetChat = groupChat.id) {
    for (const listener of Array.from(websocket.listeners)) listener({ event: 'message_media_updated', data: { chat_id: targetChat, message: snapshot } })
  }
  it.each([200, 422])('reconciles recovery HTTP %i in a historical search window and its result', async status => {
    const { media_recoverable: _recoverable, ...base } = message
    const snapshot = { ...base, body: 'Archivo canónico', ...(status === 200 ? { media_url: '/api/media/file/account/recovered.zip' } : { media_unavailable_reason: 'group_media_too_large' }) }
    install(() => Promise.resolve(jsonResponse({ success: status === 200, message: snapshot, code: status === 422 ? 'group_media_too_large' : undefined }, status === 200, status)), true)
    render(<ChatPanel chatId={groupChat.id} initialChat={groupChat} />)
    fireEvent.click(await openHistoricalSearch())
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Recuperar archivo simulado' })).not.toBeInTheDocument())
    expect(screen.getByText('Archivo canónico')).toBeInTheDocument()
    expect(screen.getByText('Coincidencia: Archivo canónico')).toBeInTheDocument()
    if (status === 422) expect(screen.getByTestId('media-unavailable-reason')).toHaveTextContent('group_media_too_large')
    else expect(screen.getByRole('button', { name: 'Abrir imagen simulada' })).toBeInTheDocument()
  })
  it('reconciles a historical search result and window through scoped WebSocket updates', async () => {
    install(() => Promise.resolve(jsonResponse({})), true)
    render(<ChatPanel chatId={groupChat.id} initialChat={groupChat} />)
    await openHistoricalSearch()
    await act(async () => {
      emit({ ...canonical, body: 'Otro chat' }, 'other-chat')
      emit({ ...canonical, id: 'unloaded', body: 'Otro mensaje' })
    })
    expect(screen.queryByText('Otro chat')).not.toBeInTheDocument()
    expect(screen.queryByText('Otro mensaje')).not.toBeInTheDocument()
    await act(async () => emit({ ...canonical, body: 'Contenido reparado' }))
    expect(screen.getByText('Contenido reparado')).toBeInTheDocument()
    expect(screen.getByText('Coincidencia: Contenido reparado')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Recuperar archivo simulado' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar búsqueda' }))
    expect(screen.getByText('Último mensaje visible')).toBeInTheDocument()
    expect(screen.queryByText('Contenido reparado')).not.toBeInTheDocument()
  })
  it.each(['http', 'websocket'] as const)('reconciles an older quoted context through %s without extending the main page', async source => {
    const snapshot = { ...message, media_url: '/api/media/file/account/recovered.zip', body: 'Contexto recuperado' }
    install(() => Promise.resolve(jsonResponse({ success: true, message: snapshot })), true)
    render(<ChatPanel chatId={groupChat.id} initialChat={groupChat} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir cita simulada' }))
    const recovery = await screen.findByRole('button', { name: 'Recuperar archivo simulado' })
    if (source === 'http') fireEvent.click(recovery)
    else await act(async () => emit(snapshot))
    await screen.findByText('Contexto recuperado')
    expect(screen.queryByRole('button', { name: 'Recuperar archivo simulado' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Volver a donde estaba' }))
    expect(screen.getByText('Último mensaje visible')).toBeInTheDocument()
    expect(screen.queryByText('Contexto recuperado')).not.toBeInTheDocument()
  })
  it.each(['http', 'websocket'] as const)('preserves a pending own reaction during %s historical recovery and uses its canonical rollback baseline', async source => {
    let finishReaction!: (response: Response) => void
    const reaction = { id: 'other-reaction', target_message_id: message.message_id, sender_jid: 'member', emoji: '❤️', is_from_me: false }
    const snapshot = { ...canonical, reactions: [reaction] }
    install(() => Promise.resolve(jsonResponse({ success: false, message: snapshot }, false, 422)), true, () => new Promise(resolve => { finishReaction = resolve }))
    render(<ChatPanel chatId={groupChat.id} initialChat={groupChat} />)
    const recover = await openHistoricalSearch()
    fireEvent.click(screen.getByRole('button', { name: 'Reaccionar con 👍' }))
    await waitFor(() => expect(finishReaction).toBeTypeOf('function'))
    expect(screen.getByTestId('own-reaction')).toHaveTextContent('👍')
    if (source === 'http') fireEvent.click(recover)
    else await act(async () => emit(snapshot))
    await waitFor(() => expect(screen.getByTestId('contact-reaction')).toHaveTextContent('❤️'))
    expect(screen.getByTestId('own-reaction')).toHaveTextContent('👍')
    await act(async () => finishReaction(jsonResponse({ success: false, error: 'Reacción rechazada' }, false)))
    expect(screen.getByTestId('own-reaction')).toBeEmptyDOMElement()
    expect(screen.getByTestId('contact-reaction')).toHaveTextContent('❤️')
  })
  it('aborts historical recovery on chat switch and ignores the late HTTP and old WebSocket callback', async () => {
    let finish!: (response: Response) => void
    let signal: AbortSignal | null | undefined
    install(init => { signal = init?.signal; return new Promise(resolve => { finish = resolve }) }, true)
    const view = render(<ChatPanel chatId={groupChat.id} initialChat={groupChat} />)
    fireEvent.click(await openHistoricalSearch())
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    const oldListeners = Array.from(websocket.listeners)
    view.rerender(<ChatPanel chatId={chat.id} initialChat={chat} />)
    await screen.findByText('Otra conversación')
    await act(async () => {
      finish(jsonResponse({ success: true, message: { ...canonical, body: 'Respuesta obsoleta' } }))
      for (const listener of oldListeners) listener({ event: 'message_media_updated', data: { chat_id: groupChat.id, message: { ...canonical, body: 'Evento obsoleto' } } })
    })
    expect(signal?.aborted).toBe(true)
    expect(screen.getByText('Otra conversación')).toBeInTheDocument()
    expect(screen.queryByText('Respuesta obsoleta')).not.toBeInTheDocument()
    expect(screen.queryByText('Evento obsoleto')).not.toBeInTheDocument()
  })
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
    install(init => { signal = init?.signal; return new Promise(resolve => { finish = resolve }) }, true)
    render(<ChatPanel chatId={groupChat.id} initialChat={groupChat} />)
    fireEvent.click(await openHistoricalSearch())
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    await act(async () => {
      beginAuthIdentityChange()
      finish(jsonResponse({ code: 'group_media_too_large', message: canonical }, false, 422))
      emit({ ...canonical, body: 'Otra sesión' })
    })
    expect(signal?.aborted).toBe(true)
    expect(screen.getByTestId('media-unavailable-reason')).toBeEmptyDOMElement()
    expect(screen.queryByText('Otra sesión')).not.toBeInTheDocument()
    expect(screen.getByText('Coincidencia: Material de la reunión')).toBeInTheDocument()
  })
})
