'use client'

import { createContext, useContext } from 'react'

type ChatMobileChromeContextValue = {
  setComposerAccessoryOpen: (open: boolean) => void
}

const ChatMobileChromeContext = createContext<ChatMobileChromeContextValue>({
  setComposerAccessoryOpen: () => undefined,
})

export const ChatMobileChromeProvider = ChatMobileChromeContext.Provider

export function useChatMobileChrome() {
  return useContext(ChatMobileChromeContext)
}
