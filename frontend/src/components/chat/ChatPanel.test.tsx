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
  const { forwardRef } = await import('react')
  return {
    default: forwardRef<HTMLDivElement, { placeholder?: string }>(function MockWhatsAppTextInput({ placeholder }, ref) {
      return <div ref={ref} data-testid="chat-composer">{placeholder}</div>
    }),
  }
})
vi.mock('./MessageBubble', () => ({
  default: ({ message, onReact, onSelect }: { message: { reactions?: Array<{ emoji: string; is_from_me: boolean }> }; onReact?: (message: unknown, emoji: string) => void; onSelect?: (message: unknown) => void }) => (
    <div data-testid="message-bubble">
      <span data-testid="own-reaction">{message.reactions?.find(reaction => reaction.is_from_me)?.emoji || ''}</span>
      <span data-testid="contact-reaction">{message.reactions?.find(reaction => !reaction.is_from_me)?.emoji || ''}</span>
      <button type="button" onClick={() => onReact?.(message, '👍')} disabled={!onReact}>Reaccionar con 👍</button>
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

describe('ChatPanel canonical device truth', () => {
  beforeEach(() => {
    localStorage.setItem('token', 'test-token')
    websocket.listeners.clear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('fails closed while validating, then trusts GET details and reconciles device_status', async () => {
    let resolveDetails!: (response: Response) => void
    const details = new Promise<Response>(resolve => { resolveDetails = resolve })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return details
      if (url.startsWith('/api/chats/chat-1/messages')) return Promise.resolve(jsonResponse({ success: true, messages: [] }))
      if (url === '/api/stickers/saved') return Promise.resolve(jsonResponse({ success: true, stickers: [] }))
      if (url === '/api/quick-replies') return Promise.resolve(jsonResponse({ success: true, quick_replies: [] }))
      return Promise.resolve(jsonResponse({ success: true }))
    }))

    render(<ChatPanel chatId="chat-1" deviceId="device-1" device={device('disconnected')} initialChat={chat} />)

    expect(screen.getByRole('status')).toHaveTextContent('Validando canal de WhatsApp')
    expect(screen.queryByTestId('chat-composer')).not.toBeInTheDocument()

    resolveDetails(jsonResponse({ success: true, chat, device: device('connected') }))
    await waitFor(() => expect(screen.getByTestId('chat-composer')).toHaveTextContent('Escribe un mensaje'))

    act(() => {
      websocket.listeners.forEach(listener => listener({
        event: 'device_status',
        data: { device_id: 'device-1', status: 'disconnected' },
      }))
    })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('El dispositivo de WhatsApp no está conectado'))
    expect(screen.queryByTestId('chat-composer')).not.toBeInTheDocument()
  })

  it('marks only the displayed incoming watermark as locally read and reconciles its canonical count', async () => {
    const onRead = vi.fn()
    const incoming = {
      id: 'row-incoming-1',
      message_id: 'provider-incoming-1',
      device_id: 'device-1',
      body: 'Mensaje visible',
      message_type: 'text',
      is_from_me: false,
      is_read: false,
      status: 'delivered',
      timestamp: '2026-08-13T10:00:00Z',
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return jsonResponse({ success: true, chat: { ...chat, unread_count: 1 }, device: device('connected') })
      if (url.startsWith('/api/chats/chat-1/messages')) return jsonResponse({ success: true, messages: [incoming] })
      if (url === '/api/chats/chat-1/read') return jsonResponse({ success: true, chat_id: 'chat-1', unread_count: 0, read_through: incoming.message_id })
      if (url === '/api/stickers/saved') return jsonResponse({ success: true, stickers: [] })
      if (url === '/api/quick-replies') return jsonResponse({ success: true, quick_replies: [] })
      return jsonResponse({ success: true })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ChatPanel chatId="chat-1" deviceId="device-1" device={device('connected')} initialChat={{ ...chat, unread_count: 1 }} onRead={onRead} />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chats/chat-1/read', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ through_message_id: 'row-incoming-1' }),
    })))
    await waitFor(() => expect(onRead).toHaveBeenCalledWith('chat-1', 0))
  })

  it('lets the conversation header menu own Escape inside a CRM workspace', async () => {
    const onBackToDetail = vi.fn()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return Promise.resolve(jsonResponse({ success: true, chat, device: device('connected') }))
      if (url.startsWith('/api/chats/chat-1/messages')) return Promise.resolve(jsonResponse({ success: true, messages: [] }))
      if (url === '/api/stickers/saved') return Promise.resolve(jsonResponse({ success: true, stickers: [] }))
      if (url === '/api/quick-replies') return Promise.resolve(jsonResponse({ success: true, quick_replies: [] }))
      return Promise.resolve(jsonResponse({ success: true }))
    }))

    render(
      <CrmDetailWorkspace
        chatOpen
        onBackToDetail={onBackToDetail}
        detail={<div>Detalle</div>}
        chat={<ChatPanel chatId="chat-1" deviceId="device-1" device={device('connected')} initialChat={chat} />}
      />,
    )
    await screen.findByTestId('chat-composer')
    const trigger = screen.getByRole('button', { name: 'Acciones de la conversación' })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(onBackToDetail).not.toHaveBeenCalled()
    expect(screen.getByTestId('chat-composer')).toBeInTheDocument()
  })

  it('sends an operation_id and reconciles the canonical reaction response', async () => {
    const message = {
      id: 'row-1',
      message_id: 'message-1',
      device_id: 'device-1',
      body: 'Hola',
      message_type: 'text',
      is_from_me: false,
      is_read: true,
      status: 'delivered',
      timestamp: '2026-08-13T10:00:00Z',
      reactions: [],
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return jsonResponse({ success: true, chat, device: device('connected') })
      if (url.startsWith('/api/chats/chat-1/messages')) return jsonResponse({ success: true, messages: [message] })
      if (url === '/api/stickers/saved') return jsonResponse({ success: true, stickers: [] })
      if (url === '/api/quick-replies') return jsonResponse({ success: true, quick_replies: [] })
      if (url === '/api/messages/react') {
        const request = JSON.parse(String(init?.body || '{}')) as { operation_id: string }
        return jsonResponse({
          success: true,
          state: 'applied',
          removed: false,
          reaction: { id: 'reaction-1', sender_jid: 'device-1', sender_name: 'Tú', emoji: '👍', is_from_me: true },
          timestamp: '2026-08-13T10:00:02Z',
          provider: 'whatsapp_web',
          operation_id: request.operation_id,
        })
      }
      return jsonResponse({ success: true })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ChatPanel chatId="chat-1" deviceId="device-1" device={device('connected')} initialChat={chat} />)
    const reactionButton = await screen.findByRole('button', { name: 'Reaccionar con 👍' })
    await waitFor(() => expect(reactionButton).toBeEnabled())
    fireEvent.click(reactionButton)

    await waitFor(() => expect(screen.getByTestId('own-reaction')).toHaveTextContent('👍'))
    const reactionCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/messages/react')
    expect(reactionCall).toBeDefined()
    const request = JSON.parse(String(reactionCall?.[1]?.body || '{}')) as Record<string, unknown>
    expect(request).toMatchObject({ chat_id: 'chat-1', target_message_id: 'message-1', emoji: '👍' })
    expect(request.operation_id).toEqual(expect.any(String))
    expect(String(request.operation_id)).not.toHaveLength(0)
  })

  it('keeps provider-applied state and explains a 202 local reconciliation delay', async () => {
    const message = {
      id: 'row-pending-1',
      message_id: 'message-pending-1',
      device_id: 'device-1',
      body: 'Hola pendiente',
      message_type: 'text',
      is_from_me: false,
      is_read: true,
      status: 'delivered',
      timestamp: '2026-08-13T10:00:00Z',
      reactions: [],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return jsonResponse({ success: true, chat, device: device('connected') })
      if (url.startsWith('/api/chats/chat-1/messages')) return jsonResponse({ success: true, messages: [message] })
      if (url === '/api/stickers/saved') return jsonResponse({ success: true, stickers: [] })
      if (url === '/api/quick-replies') return jsonResponse({ success: true, quick_replies: [] })
      if (url === '/api/messages/react') {
        const request = JSON.parse(String(init?.body || '{}')) as { operation_id: string }
        return jsonResponse({
          success: true,
          state: 'provider_applied_local_pending',
          removed: false,
          reaction: { id: '', sender_jid: 'device-1', sender_name: 'Tú', emoji: '👍', is_from_me: true },
          timestamp: '2026-08-13T10:00:02Z',
          provider: 'whatsapp_web',
          operation_id: request.operation_id,
        }, true, 202)
      }
      return jsonResponse({ success: true })
    }))

    render(<ChatPanel chatId="chat-1" deviceId="device-1" device={device('connected')} initialChat={chat} />)
    const reactionButton = await screen.findByRole('button', { name: 'Reaccionar con 👍' })
    fireEvent.click(reactionButton)

    await waitFor(() => expect(screen.getByTestId('own-reaction')).toHaveTextContent('👍'))
    expect(await screen.findByText('WhatsApp aplicó la reacción; Clarin aún está conciliando el historial.')).toBeInTheDocument()
  })

  it('keeps reactions synchronized in a search/context projection outside the loaded history', async () => {
    const searchMessage = {
      id: 'search-row-1',
      message_id: 'search-message-1',
      device_id: 'device-1',
      body: 'Mensaje fuera de la página actual',
      message_type: 'text',
      is_from_me: false,
      is_read: true,
      status: 'delivered',
      timestamp: '2026-08-12T10:00:00Z',
      reactions: [],
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return jsonResponse({ success: true, chat, device: device('connected') })
      if (url.includes('/messages/search?')) {
        return jsonResponse({ success: true, messages: [searchMessage], total: 1, history_offset: 100 })
      }
      if (url === '/api/chats/chat-1/messages?limit=50&offset=75') {
        return jsonResponse({ success: true, messages: [searchMessage] })
      }
      if (url === '/api/chats/chat-1/messages?limit=50') return jsonResponse({ success: true, messages: [] })
      if (url === '/api/stickers/saved') return jsonResponse({ success: true, stickers: [] })
      if (url === '/api/quick-replies') return jsonResponse({ success: true, quick_replies: [] })
      if (url === '/api/messages/react') {
        const request = JSON.parse(String(init?.body || '{}')) as { operation_id: string }
        return jsonResponse({
          success: true,
          removed: false,
          reaction: { id: 'search-reaction-1', sender_jid: 'device-1', sender_name: 'Tú', emoji: '👍', is_from_me: true },
          timestamp: '2026-08-13T10:00:02Z',
          provider: 'whatsapp_web',
          operation_id: request.operation_id,
        })
      }
      return jsonResponse({ success: true })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ChatPanel chatId="chat-1" deviceId="device-1" device={device('connected')} initialChat={chat} />)
    await screen.findByTestId('chat-composer')
    fireEvent.click(screen.getByRole('button', { name: 'Buscar en la conversación' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Texto a buscar' }), { target: { value: 'fuera' } })

    const reactionButton = await screen.findByRole('button', { name: 'Reaccionar con 👍' }, { timeout: 2500 })
    fireEvent.click(reactionButton)

    await waitFor(() => expect(screen.getByTestId('own-reaction')).toHaveTextContent('👍'))
    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/messages/react')).toBe(true)
  })

  it('keeps a newer canonical contact reaction when a pending historical reaction rolls back', async () => {
    const historicalMessage = {
      id: 'search-row-race', message_id: 'search-message-race', device_id: 'device-1',
      body: 'Mensaje histórico concurrente', message_type: 'text', is_from_me: false,
      is_read: true, status: 'delivered', timestamp: '2026-08-12T10:00:00Z',
      reactions: [{ id: 'contact-old', target_message_id: 'search-message-race', sender_jid: 'contact', emoji: '❤️', is_from_me: false }],
    }
    const newerHistoricalMessage = {
      ...historicalMessage,
      reactions: [{ id: 'contact-new', target_message_id: 'search-message-race', sender_jid: 'contact', emoji: '🙏', is_from_me: false }],
    }
    let rejectReaction!: () => void
    const pendingReaction = new Promise<Response>(resolve => {
      rejectReaction = () => resolve(jsonResponse({ success: false, error: 'Fallo de reacción simulado' }, false, 500))
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return jsonResponse({ success: true, chat, device: device('connected') })
      if (url.includes('/messages/search?')) {
        return jsonResponse({ success: true, messages: [newerHistoricalMessage], total: 1, history_offset: 0 })
      }
      if (url === '/api/chats/chat-1/messages?limit=50') return jsonResponse({ success: true, messages: [historicalMessage] })
      if (url === '/api/messages/react') return pendingReaction
      if (url === '/api/stickers/saved') return jsonResponse({ success: true, stickers: [] })
      if (url === '/api/quick-replies') return jsonResponse({ success: true, quick_replies: [] })
      return jsonResponse({ success: true })
    }))

    render(<ChatPanel chatId="chat-1" deviceId="device-1" device={device('connected')} initialChat={chat} />)
    await screen.findByTestId('chat-composer')
    expect(await screen.findByTestId('contact-reaction')).toHaveTextContent('❤️')
    fireEvent.click(screen.getByRole('button', { name: 'Reaccionar con 👍' }))
    await waitFor(() => expect(screen.getByTestId('own-reaction')).toHaveTextContent('👍'))

    fireEvent.click(screen.getByRole('button', { name: 'Buscar en la conversación' }))
    const searchbox = screen.getByRole('searchbox', { name: 'Texto a buscar' })
    fireEvent.change(searchbox, { target: { value: 'histórico nuevo' } })
    await waitFor(() => expect(screen.getByTestId('contact-reaction')).toHaveTextContent('🙏'), { timeout: 2500 })
    rejectReaction()

    await waitFor(() => expect(screen.getByTestId('own-reaction')).toHaveTextContent(''))
    expect(screen.getByTestId('contact-reaction')).toHaveTextContent('🙏')
    expect(await screen.findByText('Fallo de reacción simulado')).toBeInTheDocument()
  })

  it('disables and explains reactions in the touch selection sheet for another-device history', async () => {
    const historicalMessage = {
      id: 'historical-row-1',
      message_id: 'historical-message-1',
      device_id: 'device-previous',
      body: 'Historial de otro dispositivo',
      message_type: 'text',
      is_from_me: false,
      is_read: true,
      status: 'delivered',
      timestamp: '2026-08-12T10:00:00Z',
      reactions: [],
    }
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 375, height: 700, top: 0, left: 0, right: 375, bottom: 700, x: 0, y: 0, toJSON: () => ({}),
    })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/chats/chat-1') return Promise.resolve(jsonResponse({ success: true, chat, device: device('connected') }))
      if (url.startsWith('/api/chats/chat-1/messages')) return Promise.resolve(jsonResponse({ success: true, messages: [historicalMessage] }))
      if (url === '/api/stickers/saved') return Promise.resolve(jsonResponse({ success: true, stickers: [] }))
      if (url === '/api/quick-replies') return Promise.resolve(jsonResponse({ success: true, quick_replies: [] }))
      return Promise.resolve(jsonResponse({ success: true }))
    }))

    const onBackToDetail = vi.fn()
    render(
      <CrmDetailWorkspace
        chatOpen
        onBackToDetail={onBackToDetail}
        detail={<div>Detalle</div>}
        chat={<ChatPanel chatId="chat-1" deviceId="device-1" device={device('connected')} initialChat={chat} />}
      />,
    )
    const selectButton = await screen.findByRole('button', { name: 'Seleccionar mensaje' })
    await waitFor(() => expect(screen.getByTestId('chat-composer')).toBeInTheDocument())
    fireEvent.click(selectButton)
    const moreActions = await screen.findByRole('button', { name: 'Más acciones del mensaje' })
    fireEvent.click(moreActions)

    const unavailableReaction = await screen.findByRole('button', { name: /No se puede reaccionar con 👍/ })
    expect(unavailableReaction).toBeDisabled()
    expect(screen.getByText(/otro dispositivo de WhatsApp/)).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Acciones del mensaje seleccionado' })).not.toBeInTheDocument()
    await waitFor(() => expect(moreActions).toHaveFocus())
    expect(onBackToDetail).not.toHaveBeenCalled()
    expect(screen.getByTestId('message-selection-header')).toBeInTheDocument()
    rectSpy.mockRestore()
  })
})
