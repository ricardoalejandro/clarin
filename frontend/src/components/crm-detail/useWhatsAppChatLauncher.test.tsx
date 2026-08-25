import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useWhatsAppChatLauncher, {
  whatsappLauncherCrmPhase,
  whatsappLauncherIsPending,
} from '@/hooks/useWhatsAppChatLauncher'

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }))
}

function deferredResponse() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(next => { resolve = next })
  return { promise, resolve }
}

const connectedDevice = {
  id: 'device-1',
  name: 'Canal principal',
  phone: '51999999999',
  status: 'connected',
  provider: 'whatsapp_web' as const,
  runtime_capabilities: {
    can_start_chat: true,
    can_check_whatsapp: true,
    can_send_sticker: true,
    can_send_animated_sticker: false,
    can_send_reaction: true,
    can_publish_status: false,
    can_sync_own_status: false,
  },
}

describe('useWhatsAppChatLauncher', () => {
  beforeEach(() => {
    localStorage.setItem('token', 'test-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('maps its detailed phases to the operational CRM contract', () => {
    expect(whatsappLauncherCrmPhase('idle')).toBe('idle')
    expect(whatsappLauncherCrmPhase('resolving')).toBe('resolving')
    expect(whatsappLauncherCrmPhase('choosing_device')).toBe('choosing_device')
    expect(whatsappLauncherCrmPhase('opening_chat')).toBe('opening_chat')
    expect(whatsappLauncherCrmPhase('read_only')).toBe('chat')
    expect(whatsappLauncherIsPending('resolving')).toBe(true)
    expect(whatsappLauncherIsPending('opening_chat')).toBe(true)
    expect(whatsappLauncherIsPending('choosing_device')).toBe(false)
  })

  it('resolves, selects a canonical device and creates a Contact-scoped chat', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => response({
        success: true,
        phone: '51911111111',
        jid: '51911111111@s.whatsapp.net',
        chat: null,
        devices: [connectedDevice],
        mode: 'choose_device',
      }))
      .mockImplementationOnce(() => response({
        success: true,
        chat: { id: 'chat-1', jid: '51911111111@s.whatsapp.net', name: 'Contacto', device_id: 'device-1' },
      }, 201))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useWhatsAppChatLauncher({
      sessionKey: 'lead-1',
      contactId: 'contact-1',
    }))

    await act(async () => { await result.current.open('+51 911 111 111') })
    expect(result.current.phase).toBe('choosing_device')
    expect(result.current.devices).toHaveLength(1)

    act(() => result.current.selectDevice(result.current.devices[0]))
    await waitFor(() => expect(result.current.phase).toBe('chat'))
    expect(result.current.device).toMatchObject({ id: 'device-1', provider: 'whatsapp_web' })
    expect(result.current.chat?.id).toBe('chat-1')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/chats/resolve-whatsapp/51911111111?contact_id=contact-1')
    const createRequest = fetchMock.mock.calls[1][1] as RequestInit
    expect(JSON.parse(String(createRequest.body))).toEqual({
      device_id: 'device-1',
      phone: '51911111111',
      contact_id: 'contact-1',
    })
  })

  it('opens historical chats read-only and explains the capability boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response({
      success: true,
      phone: '51922222222',
      jid: '51922222222@s.whatsapp.net',
      chat: { id: 'chat-old', jid: '51922222222@s.whatsapp.net', name: 'Historial', device_id: 'old-device' },
      devices: [],
      mode: 'read_only',
    })))
    const { result } = renderHook(() => useWhatsAppChatLauncher({ sessionKey: 'participant-1', contactId: 'contact-1' }))

    await act(async () => { await result.current.open('51922222222') })

    expect(result.current.phase).toBe('read_only')
    expect(result.current.chatOpen).toBe(true)
    expect(result.current.readOnly).toBe(true)
    expect(result.current.readOnlyReason).toContain('solo lectura')
  })

  it('discards a late resolver response after switching participants', async () => {
    const first = deferredResponse()
    const second = deferredResponse()
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    vi.stubGlobal('fetch', fetchMock)

    const { result, rerender } = renderHook(
      ({ sessionKey, contactId }) => useWhatsAppChatLauncher({ sessionKey, contactId }),
      { initialProps: { sessionKey: 'participant-1', contactId: 'contact-1' } },
    )

    act(() => { void result.current.open('51911111111') })
    rerender({ sessionKey: 'participant-2', contactId: 'contact-2' })
    act(() => { void result.current.open('51922222222') })

    second.resolve(new Response(JSON.stringify({
      success: true,
      phone: '51922222222',
      jid: '51922222222@s.whatsapp.net',
      chat: { id: 'chat-2', jid: '51922222222@s.whatsapp.net', name: 'Segundo', device_id: 'old-device' },
      devices: [],
      mode: 'read_only',
    }), { status: 200 }))
    await waitFor(() => expect(result.current.chat?.id).toBe('chat-2'))

    first.resolve(new Response(JSON.stringify({
      success: true,
      phone: '51911111111',
      jid: '51911111111@s.whatsapp.net',
      chat: { id: 'chat-1', jid: '51911111111@s.whatsapp.net', name: 'Anterior', device_id: 'old-device' },
      devices: [],
      mode: 'read_only',
    }), { status: 200 }))

    await act(async () => { await Promise.resolve() })
    expect(result.current.chat?.id).toBe('chat-2')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/chats/resolve-whatsapp/51922222222?contact_id=contact-2')
  })

  it('invalidates an in-flight resolver when a later launch has no valid phone', async () => {
    const first = deferredResponse()
    vi.stubGlobal('fetch', vi.fn(() => first.promise))
    const { result } = renderHook(() => useWhatsAppChatLauncher({ sessionKey: 'contact-1', contactId: 'contact-1' }))

    act(() => { void result.current.open('51911111111') })
    await act(async () => { await result.current.open('sin teléfono') })
    expect(result.current.phase).toBe('error')

    first.resolve(new Response(JSON.stringify({
      success: true,
      phone: '51911111111',
      jid: '51911111111@s.whatsapp.net',
      chat: { id: 'chat-stale', jid: '51911111111@s.whatsapp.net', name: 'Anterior', device_id: 'old-device' },
      devices: [],
      mode: 'read_only',
    }), { status: 200 }))
    await act(async () => { await Promise.resolve() })

    expect(result.current.phase).toBe('error')
    expect(result.current.chat).toBeNull()
  })
})
