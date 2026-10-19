'use client'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { subscribeWebSocket } from '@/lib/api'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import type { Chat, ChatPinState } from '@/types/chat'
import { applyChatPin, pinSnapshot } from '@/utils/chatPins'

export function usePersonalChatPins(onChange: (state: ChatPinState, rollback?: boolean) => void) {
  const scope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  const callback = useRef(onChange); callback.current = onChange
  const canonical = useRef(new Map<string, ChatPinState>())
  const optimistic = useRef(new Map<string, ChatPinState>())
  const requests = useRef(new Map<string, AbortController>())
  const active = useRef(true)
  const storedScope = useRef(scope)
  if (storedScope.current !== scope) {
    storedScope.current = scope
    for (const request of requests.current.values()) request.abort()
    requests.current.clear(); canonical.current.clear(); optimistic.current.clear()
  }
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const current = useCallback(() => active.current && scope === getAuthScope() && !isAuthIdentityChanging(scope), [scope])
  const accept = useCallback((state: ChatPinState) => {
    if (!current() || !state?.chat_id || typeof state.pin_version !== 'number') return
    if ((canonical.current.get(state.chat_id)?.pin_version ?? -1) > state.pin_version) return
    canonical.current.set(state.chat_id, state)
    const pendingState = optimistic.current.get(state.chat_id)
    if (pendingState && state.pin_version <= pendingState.pin_version) return
    callback.current(state)
  }, [current])
  useEffect(() => {
    active.current = true; setPending(new Set()); setError('')
    const unsubscribe = subscribeWebSocket((event: unknown) => {
      const data = event as { event?: string; data?: ChatPinState }
      if (data.event === 'chat_pin_updated' && data.data) accept(data.data)
    })
    return () => { active.current = false; unsubscribe(); for (const request of requests.current.values()) request.abort() }
  }, [accept])
  const project = useCallback((chat: Chat) => {
    if (!current()) return chat
    const state = canonical.current.get(chat.id)
    const base = applyChatPin(chat, state)
    const pendingState = optimistic.current.get(chat.id)
    return pendingState && (!state || state.pin_version <= pendingState.pin_version) ? { ...base, is_pinned: pendingState.is_pinned, pinned_at: pendingState.pinned_at, pin_version: pendingState.pin_version } : base
  }, [current])
  const toggle = useCallback(async (chat: Chat) => {
    if (!current() || optimistic.current.has(chat.id)) return
    const controller = new AbortController(); requests.current.set(chat.id, controller)
    const before = pinSnapshot(project(chat))
    const next: ChatPinState = { ...before, is_pinned: !before.is_pinned, pinned_at: before.is_pinned ? null : new Date().toISOString() }
    optimistic.current.set(chat.id, next)
    setPending(new Set(optimistic.current.keys())); setError('')
    callback.current(next, true)
    try {
      const response = await fetch(`/api/chats/${encodeURIComponent(chat.id)}/pin`, { method: 'PUT', credentials: 'include', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: next.is_pinned }) })
      const data = await response.json()
      if (!current() || controller.signal.aborted) return
      if (!response.ok || !data.success || data.chat_id !== chat.id || typeof data.pin_version !== 'number') throw new Error(data.error || 'No se pudo guardar el chat fijado.')
      accept(data)
    } catch (cause) {
      if (current() && !controller.signal.aborted) {
        const latest = canonical.current.get(chat.id)
        callback.current(latest && latest.pin_version > before.pin_version ? latest : before, true)
        setError(cause instanceof Error ? cause.message : 'No se pudo guardar el chat fijado. Reintenta.')
      }
    } finally {
      if (requests.current.get(chat.id) === controller) {
        requests.current.delete(chat.id); optimistic.current.delete(chat.id)
        if (current()) setPending(new Set(optimistic.current.keys()))
      }
    }
  }, [accept, project, current])
  return { project, toggle, pending, error, scope }
}
