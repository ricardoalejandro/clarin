import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@/types/chat'
const session = vi.hoisted(() => ({ scope: 'scope-a', scopeListeners: new Set<() => void>(), listeners: new Set<(event: any) => void>() }))
vi.mock('@/lib/api', () => ({ subscribeWebSocket: (listener: (event: any) => void) => { session.listeners.add(listener); return () => session.listeners.delete(listener) } }))
vi.mock('@/lib/authScope', () => ({ getAuthScope: () => session.scope, isAuthIdentityChanging: () => false, subscribeAuthScope: (listener: () => void) => { session.scopeListeners.add(listener); return () => session.scopeListeners.delete(listener) } }))
import MessageInfoDialog from './MessageInfoDialog'

const message = { id: 'message-a', message_id: 'provider-a', device_id: 'device-a', is_from_me: true, timestamp: '2026-10-18T12:00:00Z', status: 'sent', body: 'Mensaje de prueba' } as Message
const receipt = (name: string, read = false) => ({ jid: name + '@lid', name, delivered_at: '2026-10-18T12:01:00Z', ...(read ? { read_at: '2026-10-18T12:02:00Z' } : {}) })
const response = (receipts: unknown[], cursor = '') => ({ ok: true, json: async () => ({ success: true, receipts, next_cursor: cursor }) }) as Response
const tick = () => new Promise(resolve => setTimeout(resolve, 240))
const emit = (data: Record<string, unknown> = {}) => session.listeners.forEach(listener => listener({ event: 'group_message_receipt', data: { chat_id: 'group-a', device_id: 'device-a', message_ids: ['provider-a'], ...data } }))
beforeEach(() => { session.scope = 'scope-a'; session.listeners.clear(); session.scopeListeners.clear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('group receipt live session', () => {
  it('coalesces matching receipts and silently revalidates every loaded page', async () => {
    let refreshing = false, resolveFirst!: (response: Response) => void
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const cursor = new URL(String(input), 'http://test.invalid').searchParams.get('cursor')
      if (refreshing && !cursor) return new Promise<Response>(resolve => { resolveFirst = resolve })
      return Promise.resolve(response([receipt(cursor ? 'Bruno' : 'Ana', refreshing)], cursor ? '' : 'after-a'))
    })
    vi.stubGlobal('fetch', fetcher)
    render(<MessageInfoDialog message={message} chatId="group-a" isGroup onClose={() => {}} />)
    const firstName = await screen.findByText('Ana')
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar más recibos' }))
    await screen.findByText('Bruno'); expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => { emit({ chat_id: 'other' }); emit({ message_ids: ['another-message'] }); emit({ device_id: 'another-device' }); await tick() })
    expect(fetcher).toHaveBeenCalledTimes(2)
    refreshing = true
    await act(async () => { emit(); emit(); emit(); await tick() })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(screen.getByText('Ana')).toBe(firstName); expect(screen.getByText('Bruno')).toBeInTheDocument()
    expect(screen.queryByText('Cargando recibos…')).not.toBeInTheDocument()
    await act(async () => { resolveFirst(response([receipt('Ana', true)], 'after-a')) })
    await waitFor(() => expect(screen.getAllByText(/^Leído:/)).toHaveLength(2))
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(screen.getByText('Ana')).toBe(firstName)
    expect(fetcher.mock.calls.every(([url]) => String(url).includes('limit=50'))).toBe(true)
  })

  it('aborts and rejects stale responses after changing the message and closing the dialog', async () => {
    let oldCalls = 0, newCalls = 0, finishOld!: (response: Response) => void, finishClosed!: (response: Response) => void
    let oldSignal: AbortSignal | undefined, closedSignal: AbortSignal | undefined
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('message-a')) {
        if (++oldCalls === 1) return Promise.resolve(response([receipt('Ana')]))
        oldSignal = init?.signal as AbortSignal; return new Promise<Response>(resolve => { finishOld = resolve })
      }
      if (++newCalls === 1) return Promise.resolve(response([receipt('Carla')]))
      closedSignal = init?.signal as AbortSignal; return new Promise<Response>(resolve => { finishClosed = resolve })
    })
    vi.stubGlobal('fetch', fetcher)
    const view = render(<MessageInfoDialog message={message} chatId="group-a" isGroup onClose={() => {}} />)
    await screen.findByText('Ana')
    await act(async () => { emit(); await tick() })
    view.rerender(<MessageInfoDialog message={{ ...message, id: 'message-b', message_id: 'provider-b' }} chatId="group-b" isGroup onClose={() => {}} />)
    await screen.findByText('Carla'); expect(oldSignal?.aborted).toBe(true)
    await act(async () => { finishOld(response([receipt('Respuesta antigua', true)])); emit(); await tick() })
    expect(screen.queryByText('Respuesta antigua')).not.toBeInTheDocument(); expect(fetcher).toHaveBeenCalledTimes(3)
    await act(async () => { emit({ chat_id: 'group-b', message_ids: ['provider-b'] }); await tick() })
    expect(fetcher).toHaveBeenCalledTimes(4)
    view.unmount(); expect(closedSignal?.aborted).toBe(true)
    await act(async () => { finishClosed(response([receipt('Respuesta cerrada', true)])); emit({ chat_id: 'group-b', message_ids: ['provider-b'] }); await tick() })
    expect(session.listeners.size).toBe(0); expect(fetcher).toHaveBeenCalledTimes(4)
    expect(screen.queryByText('Respuesta cerrada')).not.toBeInTheDocument()
  })

  it('starts a new scoped session and ignores old identity completions', async () => {
    let finishOld!: (response: Response) => void, oldSignal: AbortSignal | undefined
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => session.scope === 'scope-a'
      ? new Promise<Response>(resolve => { finishOld = resolve; oldSignal = init?.signal as AbortSignal })
      : Promise.resolve(response([receipt('Nueva sesión')])))
    vi.stubGlobal('fetch', fetcher)
    render(<MessageInfoDialog message={message} chatId="group-a" isGroup onClose={() => {}} />)
    await act(async () => { session.scope = 'scope-b'; session.scopeListeners.forEach(listener => listener()) })
    await screen.findByText('Nueva sesión'); expect(oldSignal?.aborted).toBe(true)
    await act(async () => { finishOld(response([receipt('Cuenta anterior')])) })
    expect(screen.queryByText('Cuenta anterior')).not.toBeInTheDocument()
  })
})
