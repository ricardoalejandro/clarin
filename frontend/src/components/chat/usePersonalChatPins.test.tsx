import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginAuthIdentityChange, completeAuthIdentityChange } from '@/lib/authScope'
import type { Chat, ChatPinState } from '@/types/chat'
const socket = vi.hoisted(() => ({ emit: undefined as ((event: unknown) => void) | undefined }))
vi.mock('@/lib/api', () => ({ subscribeWebSocket: (listener: (event: unknown) => void) => { socket.emit = listener; return () => {} } }))
import { usePersonalChatPins } from './usePersonalChatPins'
const chat: Chat = { id: 'chat', jid: '51@s.whatsapp.net', name: 'Nombre', last_message: 'Original', last_message_at: '', unread_count: 4, pin_version: 1 }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('personal pin mutations', () => {
  it('sends one idempotent desired-state write and projects a pending pin over stale HTTP', async () => {
    let finish: (response: Response) => void = () => {}
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(resolve => { finish = resolve })); vi.stubGlobal('fetch', fetcher)
    const change = vi.fn(); const { result } = renderHook(() => usePersonalChatPins(change))
    let promise: Promise<void>
    act(() => { promise = result.current.toggle(chat); void result.current.toggle(chat) })
    expect(fetcher).toHaveBeenCalledTimes(1); expect(result.current.project(chat).is_pinned).toBe(true)
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual({ pinned: true })
    await act(async () => { finish({ ok: true, json: async () => ({ success: true, chat_id: chat.id, is_pinned: true, pinned_at: '2026-10-18T12:00:00Z', pin_version: 2 }) } as Response); await promise })
    expect(result.current.pending.size).toBe(0); expect(result.current.project(chat).pin_version).toBe(2)
  })
  it('rolls back only pin fields while retaining a newer canonical event', async () => {
    let fail: (error: Error) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((_, reject) => { fail = reject })))
    const change = vi.fn(); const { result } = renderHook(() => usePersonalChatPins(change))
    act(() => { void result.current.toggle(chat) })
    const canonical: ChatPinState = { chat_id: chat.id, is_pinned: true, pinned_at: '2026-10-18T12:00:00Z', pin_version: 3 }
    await act(async () => { socket.emit?.({ event: 'chat_pin_updated', data: canonical }); fail(new Error('Sin conexión')) })
    await waitFor(() => expect(result.current.pending.size).toBe(0))
    expect(change).toHaveBeenLastCalledWith(canonical, true)
    expect(result.current.project({ ...chat, last_message: 'Nuevo', unread_count: 5 })).toMatchObject({ last_message: 'Nuevo', unread_count: 5, is_pinned: true })
    expect(result.current.error).toBe('Sin conexión')
  })
})


it('aborts and discards pending responses and old listeners when the actor changes', async () => {
  let finish: (response: Response) => void = () => {}
  const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(resolve => { finish = resolve })); vi.stubGlobal('fetch', fetcher)
  const change = vi.fn(); const { result } = renderHook(() => usePersonalChatPins(change))
  act(() => { void result.current.toggle(chat) })
  const oldListener = socket.emit, oldSignal = fetcher.mock.calls[0][1]?.signal
  act(() => { beginAuthIdentityChange(); completeAuthIdentityChange() })
  expect(oldSignal?.aborted).toBe(true)
  change.mockClear()
  await act(async () => { oldListener?.({ event: 'chat_pin_updated', data: { chat_id: chat.id, is_pinned: true, pin_version: 99 } }); finish({ ok: true, json: async () => ({ success: true, chat_id: chat.id, is_pinned: true, pinned_at: '2026-10-18T00:00:00Z', pin_version: 99 }) } as Response) })
  expect(change).not.toHaveBeenCalled()
  expect(result.current.project(chat)).toEqual(chat)
  expect(result.current.pending.size).toBe(0)
})


it('keeps a pending intent visible when an older equal-version echo arrives', async () => {
  let finish: (response: Response) => void = () => {}
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
  const change = vi.fn(); const { result } = renderHook(() => usePersonalChatPins(change))
  act(() => { void result.current.toggle(chat) })
  const optimistic = change.mock.calls[0][0]; change.mockClear()
  act(() => { socket.emit?.({ event: 'chat_pin_updated', data: { chat_id: chat.id, is_pinned: false, pinned_at: null, pin_version: 1 } }) })
  expect(change).not.toHaveBeenCalled(); expect(result.current.project(chat).is_pinned).toBe(true)
  await act(async () => { finish({ ok: true, json: async () => ({ success: true, ...optimistic, pin_version: 2 }) } as Response) })
  expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ is_pinned: true, pin_version: 2 }))
})
