'use client'

import { createContext, useContext } from 'react'

export const CHAT_CONVERSATION_ACTIVE_EVENT = 'clarin:chat-conversation-active'

export function announceChatConversationActive(active: boolean) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(CHAT_CONVERSATION_ACTIVE_EVENT, { detail: { active } }))
}

type ChatMobileChromeContextValue = {
  setComposerAccessoryOpen: (open: boolean) => void
  setConversationActive: (active: boolean) => void
}

const ChatMobileChromeContext = createContext<ChatMobileChromeContextValue>({
  setComposerAccessoryOpen: () => undefined,
  setConversationActive: () => undefined,
})

export const ChatMobileChromeProvider = ChatMobileChromeContext.Provider

export function useChatMobileChrome() {
  return useContext(ChatMobileChromeContext)
}
