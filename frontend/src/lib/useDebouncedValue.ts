import { useEffect, useState } from 'react'

export const SEARCH_DEBOUNCE_MS = 500

export function useDebouncedValue<T>(value: T, delay = SEARCH_DEBOUNCE_MS) {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [delay, value])

  return [debounced, setDebounced] as const
}
