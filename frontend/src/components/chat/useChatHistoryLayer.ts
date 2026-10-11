import { useEffect, useRef, useCallback } from 'react'

/** A transient layer adds one Back step without replacing the conversation entry. */
export function useChatHistoryLayer(open: boolean, marker: string, onClose: () => void) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const ownsRef = useRef(false)
  useEffect(() => {
    if (!open) return
    // The deferred claim avoids adding/consuming entries in React's StrictMode probe.
    const claim = window.setTimeout(() => {
      window.history.pushState({ ...(window.history.state || {}), [marker]: true }, '')
      ownsRef.current = true
    }, 0)
    const pop = (event: PopStateEvent) => {
      if (event.state?.[marker] || !ownsRef.current) return
      ownsRef.current = false
      closeRef.current()
    }
    window.addEventListener('popstate', pop)
    return () => {
      window.clearTimeout(claim)
      window.removeEventListener('popstate', pop)
      if (ownsRef.current && window.history.state?.[marker]) {
        ownsRef.current = false
        window.history.back()
      }
    }
  }, [open, marker])
  return useCallback(() => closeRef.current(), [])
}
