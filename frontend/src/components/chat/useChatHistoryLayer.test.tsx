import { StrictMode, type ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatHistoryLayer } from './useChatHistoryLayer'

beforeEach(() => window.history.replaceState({ clarinChatId: 'chat-a', clarinChatSurface: 'conversation' }, '', '/dashboard/chats'))
afterEach(async () => { cleanup(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }) })

describe('transient Android history layer', () => {
  it('adds one entry under StrictMode and Back closes only the transient view', async () => {
    const close = vi.fn()
    const push = vi.spyOn(window.history, 'pushState')
    const view = renderHook(({ open }) => useChatHistoryLayer(open, '__qaLayer', close), {
      initialProps: { open: true }, wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
    })
    await waitFor(() => expect(window.history.state.__qaLayer).toBe(true))
    expect(push).toHaveBeenCalledTimes(1)
    await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(close).toHaveBeenCalledTimes(1)
    expect(window.history.state.clarinChatId).toBe('chat-a')
    view.rerender({ open: false })
    expect(window.history.state.__qaLayer).toBeUndefined()
  })

  it('consumes its own history entry after explicit close without changing the selected chat', async () => {
    const view = renderHook(({ open }) => useChatHistoryLayer(open, '__qaLayer', vi.fn()), { initialProps: { open: true } })
    await waitFor(() => expect(window.history.state.__qaLayer).toBe(true))
    view.rerender({ open: false })
    await waitFor(() => expect(window.history.state.__qaLayer).toBeUndefined())
    expect(window.history.state.clarinChatId).toBe('chat-a')
  })
})
