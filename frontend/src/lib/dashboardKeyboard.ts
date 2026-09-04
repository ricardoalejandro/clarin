type DashboardKeyboardEvent = Pick<KeyboardEvent,
  'ctrlKey' | 'defaultPrevented' | 'key' | 'metaKey' | 'target'
>

function targetElement(target: EventTarget | null) {
  if (target instanceof Element) return target
  return target instanceof Node ? target.parentElement : null
}

export function dashboardKeyboardTargetIsWritable(target: EventTarget | null) {
  const element = targetElement(target)
  if (!element) return false
  if (element.closest('input, textarea, select')) return true

  const contentEditable = element.closest('[contenteditable]')
  return Boolean(
    contentEditable
    && contentEditable.getAttribute('contenteditable')?.toLocaleLowerCase('en') !== 'false',
  )
}

export function shouldToggleErosFromKeyboard(event: DashboardKeyboardEvent) {
  return !event.defaultPrevented
    && (event.ctrlKey || event.metaKey)
    && event.key === 'i'
    && !dashboardKeyboardTargetIsWritable(event.target)
}
