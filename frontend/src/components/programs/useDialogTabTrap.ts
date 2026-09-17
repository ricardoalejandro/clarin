'use client'

import { useEffect, type RefObject } from 'react'

export const DIALOG_TAB_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export type DialogFocusableVisibility = (element: HTMLElement) => boolean

export function isDialogFocusableVisible(
  element: HTMLElement,
  getStyle: (element: Element) => CSSStyleDeclaration = node => window.getComputedStyle(node),
) {
  let current: HTMLElement | null = element
  while (current) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false
    const style = getStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
    current = current.parentElement
  }
  return true
}

export function restoreDialogFocus(candidates: Array<HTMLElement | null | undefined>) {
  const target = candidates.find(candidate => (
    candidate?.isConnected
    && !(candidate instanceof HTMLButtonElement && candidate.disabled)
    && isDialogFocusableVisible(candidate)
  ))
  target?.focus({ preventScroll: true })
  return target || null
}

export function trapDialogTabKey(
  event: KeyboardEvent,
  container: HTMLElement,
  isVisible: DialogFocusableVisibility = isDialogFocusableVisible,
) {
  if (event.key !== 'Tab') return false
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(DIALOG_TAB_FOCUSABLE_SELECTOR))
    .filter(element => isVisible(element))
  if (focusable.length === 0) {
    event.preventDefault()
    container.focus({ preventScroll: true })
    return true
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement
  if (!container.contains(active)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus({ preventScroll: true })
    return true
  }
  if (event.shiftKey && (active === first || active === container)) {
    event.preventDefault()
    last.focus({ preventScroll: true })
    return true
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus({ preventScroll: true })
    return true
  }
  return false
}

export function useDialogTabTrap(active: boolean, containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return
    const handleKeyDown = (event: KeyboardEvent) => {
      const container = containerRef.current
      if (container) trapDialogTabKey(event, container)
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [active, containerRef])
}
