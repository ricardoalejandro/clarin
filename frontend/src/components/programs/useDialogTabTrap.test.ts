import { afterEach, describe, expect, it } from 'vitest'
import { isDialogFocusableVisible, restoreDialogFocus, trapDialogTabKey } from './useDialogTabTrap'

afterEach(() => { document.body.innerHTML = '' })

function dialog() {
  const container = document.createElement('div')
  container.tabIndex = -1
  const first = document.createElement('button')
  first.textContent = 'Primero'
  const last = document.createElement('button')
  last.textContent = 'Último'
  container.append(first, last)
  document.body.append(container)
  return { container, first, last }
}

describe('trapDialogTabKey', () => {
  it('cycles forward from the last focusable control', () => {
    const { container, first, last } = dialog()
    last.focus()
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    expect(trapDialogTabKey(event, container)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(first).toHaveFocus()
  })

  it('cycles backward from the first control and recovers focus that escaped the dialog', () => {
    const { container, first, last } = dialog()
    first.focus()
    const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true })
    trapDialogTabKey(backward, container)
    expect(last).toHaveFocus()

    document.body.focus()
    const forward = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    trapDialogTabKey(forward, container)
    expect(first).toHaveFocus()
  })

  it('skips controls hidden by themselves or an ancestor without relying on layout rectangles', () => {
    const { container, first, last } = dialog()
    const hidden = document.createElement('button')
    hidden.style.display = 'none'
    container.append(hidden)
    const hiddenGroup = document.createElement('div')
    hiddenGroup.setAttribute('aria-hidden', 'true')
    const hiddenByParent = document.createElement('button')
    hiddenGroup.append(hiddenByParent)
    container.append(hiddenGroup)

    expect(isDialogFocusableVisible(hidden)).toBe(false)
    expect(isDialogFocusableVisible(hiddenByParent)).toBe(false)
    last.focus()
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    trapDialogTabKey(event, container)
    expect(first).toHaveFocus()
  })

  it('restores focus to the first connected enabled candidate', () => {
    const detached = document.createElement('button')
    const disabled = document.createElement('button')
    disabled.disabled = true
    const fallback = document.createElement('button')
    document.body.append(disabled, fallback)

    expect(restoreDialogFocus([detached, disabled, fallback])).toBe(fallback)
    expect(fallback).toHaveFocus()
  })
})
