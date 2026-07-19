'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Measures the space a workspace actually owns after dashboard chrome (sidebar,
 * Eros, padding) has taken its share. Use this for dense layouts instead of
 * window.innerWidth-based breakpoints.
 */
export function useContainerWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const element = ref.current
    if (!element) return

    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        setWidth(Math.round(element.getBoundingClientRect().width))
      })
    }

    update()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    observer?.observe(element)
    window.addEventListener('resize', update, { passive: true })

    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  return { ref, width }
}
