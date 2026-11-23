import { afterEach, describe, expect, it } from 'vitest'
import {
  dashboardFocusHasTemporarySurface,
  dashboardFocusShortcutAllowed,
  dashboardFocusShortcutMatches,
  dashboardFocusTargetIsWritable,
} from './dashboardFocusState'

describe('dashboard focus keyboard policy', () => {
  afterEach(() => document.body.replaceChildren())

  const shortcut = { altKey: false, ctrlKey: true, defaultPrevented: false, isComposing: false, key: 'F', metaKey: false, repeat: false, shiftKey: true, target: null }

  it('accepts only the exact Control or Command Shift F chord', () => {
    expect(dashboardFocusShortcutMatches(shortcut)).toBe(true)
    expect(dashboardFocusShortcutMatches({ ...shortcut, key: 'f', ctrlKey: false, metaKey: true })).toBe(true)
    for (const change of [
      { defaultPrevented: true }, { repeat: true }, { isComposing: true }, { altKey: true },
      { shiftKey: false }, { ctrlKey: false }, { metaKey: true }, { key: 'i' }, { key: 'Escape' },
    ]) expect(dashboardFocusShortcutMatches({ ...shortcut, ...change })).toBe(false)
  })

  it('leaves inputs, selects, text nodes and editable descendants to their editor', () => {
    for (const html of ['<input />', '<textarea></textarea>', '<select></select>', '<div role="textbox"><span>text</span></div>', '<div contenteditable="true"><span>text</span></div>', '<div contenteditable=""><span>text</span></div>']) {
      const host = document.createElement('div')
      host.innerHTML = html
      const target = host.querySelector('span')?.firstChild || host.firstElementChild
      expect(dashboardFocusTargetIsWritable(target)).toBe(true)
      expect(dashboardFocusShortcutMatches({ ...shortcut, target })).toBe(false)
    }
    const nonEditable = document.createElement('div')
    nonEditable.contentEditable = 'false'
    nonEditable.setAttribute('contenteditable', 'false')
    expect(dashboardFocusTargetIsWritable(nonEditable)).toBe(false)
  })

  it('requires an available desktop and no specialized, pointer or temporary owner', () => {
    const allowed = { available: true, specializedOwnerActive: false, pointerActive: false, temporarySurfaceOpen: false }
    expect(dashboardFocusShortcutAllowed(allowed)).toBe(true)
    for (const change of [{ available: false }, { specializedOwnerActive: true }, { pointerActive: true }, { temporarySurfaceOpen: true }]) {
      expect(dashboardFocusShortcutAllowed({ ...allowed, ...change })).toBe(false)
    }
  })

  it.each([
    '<div role="dialog" aria-modal="true"></div>', '<div role="alertdialog" aria-modal="true"></div>', '<dialog open></dialog>', '<div role="menu"></div>',
    '<div role="listbox"></div>', '<div data-operational-picker-backdrop></div>', '<div data-operational-confirmation></div>',
    '<div data-task-date-range-picker></div>',
    '<div data-operational-drag-overlay></div>', '<div data-task-hierarchy-overlay></div>',
    '<div data-calendar-drag-preview></div>', '<button aria-pressed="true" aria-describedby="DndDescribedBy-1"></button>',
  ])('recognizes a visible temporary surface: %s', html => {
    document.body.innerHTML = html
    expect(dashboardFocusHasTemporarySurface()).toBe(true)
  })

  it.each(['hidden', 'inert', 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"'])('ignores hidden temporary surfaces, including hidden ancestors: %s', attribute => {
    document.body.innerHTML = `<div ${attribute}><div role="menu"></div></div>`
    expect(dashboardFocusHasTemporarySurface()).toBe(false)
  })

  it('does not treat nonmodal work windows or notifications as blocking dialogs', () => {
    document.body.innerHTML = '<section role="dialog" aria-modal="false"></section><div role="status"></div>'
    expect(dashboardFocusHasTemporarySurface()).toBe(false)
  })
})
