export const DASHBOARD_FOCUS_MEDIA_QUERY = '(min-width: 1024px)'
export const DASHBOARD_FOCUS_SHORTCUT_LABEL = 'Ctrl/Cmd + Shift + F'
export const DASHBOARD_FOCUS_ARIA_SHORTCUTS = 'Control+Shift+F Meta+Shift+F'
export const DASHBOARD_FOCUS_SIDEBAR_ID = 'dashboard-primary-navigation'

type FocusKeyboardEvent = Pick<KeyboardEvent,
  'altKey' | 'ctrlKey' | 'defaultPrevented' | 'isComposing' | 'key' | 'metaKey' | 'repeat' | 'shiftKey' | 'target'
>

export function dashboardFocusTargetIsWritable(target: EventTarget | null) {
  const element = target instanceof Element
    ? target
    : target instanceof Node ? target.parentElement : null
  if (!element) return false
  if (element.closest('input, textarea, select, [role="textbox"]')) return true
  const editable = element.closest('[contenteditable]')
  return Boolean(editable && editable.getAttribute('contenteditable')?.toLowerCase() !== 'false')
}

export function dashboardFocusShortcutMatches(event: FocusKeyboardEvent) {
  return !event.defaultPrevented
    && !event.repeat
    && !event.isComposing
    && !event.altKey
    && event.shiftKey
    && event.ctrlKey !== event.metaKey
    && event.key.toLowerCase() === 'f'
    && !dashboardFocusTargetIsWritable(event.target)
}

export function dashboardFocusShortcutAllowed({
  available,
  specializedOwnerActive,
  pointerActive,
  temporarySurfaceOpen,
}: {
  available: boolean
  specializedOwnerActive: boolean
  pointerActive: boolean
  temporarySurfaceOpen: boolean
}) {
  return available && !specializedOwnerActive && !pointerActive && !temporarySurfaceOpen
}

function elementIsVisible(element: Element) {
  let current: Element | null = element
  while (current) {
    if (current.hasAttribute('hidden') || current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true') return false
    const style = getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
    current = current.parentElement
  }
  return true
}

const TEMPORARY_SURFACE_SELECTOR = [
  '[role="dialog"][aria-modal="true"]',
  '[role="alertdialog"][aria-modal="true"]',
  'dialog[open]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-operational-picker-backdrop]',
  '[data-operational-confirmation]',
  '[data-task-date-range-picker]',
  '[data-operational-drag-overlay]',
  '[data-task-hierarchy-overlay]',
  '[data-calendar-drag-preview]',
  '[aria-pressed="true"][aria-describedby*="DndDescribedBy"]',
].join(', ')

export function dashboardFocusHasTemporarySurface(root: ParentNode = document) {
  return Array.from(root.querySelectorAll(TEMPORARY_SURFACE_SELECTOR)).some(elementIsVisible)
}
