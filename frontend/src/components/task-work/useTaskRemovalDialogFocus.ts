'use client'

import { useEffect, useRef, type RefObject } from 'react'

const focusableSelector = 'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** Keeps the removal confirmation modal, while its portaled destination picker owns focus when open. */
export function useTaskRemovalDialogFocus(ref: RefObject<HTMLElement | null>, onClose: () => void, picker = false) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focus = () => (ref.current?.querySelector<HTMLElement>('[data-removal-initial-focus]') || ref.current)?.focus({ preventScroll: true })
    const frame = requestAnimationFrame(focus)
    const childOwnsFocus = () => !picker && Boolean(document.querySelector('[data-task-removal-picker]'))
    const keydown = (event: KeyboardEvent) => {
      if (childOwnsFocus() || !ref.current) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        closeRef.current()
      }
      if (event.key !== 'Tab') return
      const targets = Array.from(ref.current.querySelectorAll<HTMLElement>(focusableSelector))
      const first = targets[0]
      const last = targets[targets.length - 1]
      if (!first) { event.preventDefault(); focus(); return }
      const outside = !ref.current.contains(document.activeElement)
      if (event.shiftKey && (outside || document.activeElement === first || document.activeElement === ref.current)) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (outside || document.activeElement === last || document.activeElement === ref.current)) {
        event.preventDefault(); first.focus()
      }
    }
    const focusin = (event: FocusEvent) => {
      if (!childOwnsFocus() && event.target instanceof Node && !ref.current?.contains(event.target)) focus()
    }
    window.addEventListener('keydown', keydown, true)
    document.addEventListener('focusin', focusin)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', keydown, true)
      document.removeEventListener('focusin', focusin)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [picker, ref])
}
