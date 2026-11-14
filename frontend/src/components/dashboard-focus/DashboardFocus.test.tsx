import { StrictMode, useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DashboardFocusEnterButton,
  DashboardFocusProvider,
  DashboardFocusRestoreBar,
  DashboardFocusSidebar,
  useDashboardFocus,
  useDashboardSpecializedFocusOwner,
} from './DashboardFocus'

let desktop = true
let mediaListeners: Set<() => void>

function mediaChange(matches: boolean) {
  desktop = matches
  act(() => mediaListeners.forEach(listener => listener()))
}

function SpecializedOwner() {
  useDashboardSpecializedFocusOwner()
  return <div>Specialized editor</div>
}

function fixture(initial = { scopeKey: 'account:user:/dashboard/chats', enabled: true, specialized: false, strict: false }) {
  let latest: ReturnType<typeof useDashboardFocus>
  const mounted = vi.fn()
  const unmounted = vi.fn()
  function Content() {
    useEffect(() => { mounted(); return unmounted }, [])
    return <textarea aria-label="Message draft" defaultValue="Unsent message" />
  }
  function Probe() { latest = useDashboardFocus(); return null }
  function Surface({ scopeKey, enabled, specialized, strict }: typeof initial) {
    const surface = <DashboardFocusProvider scopeKey={scopeKey} enabled={enabled}>
      <Probe />
      <DashboardFocusSidebar className="sidebar-test"><button>Collapse navigation</button><DashboardFocusEnterButton /><button>Navigation</button></DashboardFocusSidebar>
      <DashboardFocusRestoreBar />
      <main><button>Workspace action</button><Content />{specialized && <SpecializedOwner />}</main>
    </DashboardFocusProvider>
    return strict ? <StrictMode>{surface}</StrictMode> : surface
  }
  const rendered = render(<Surface {...initial} />)
  return {
    ...rendered,
    focus: () => latest!,
    mounted, unmounted,
    update: (props: Partial<typeof initial>) => rendered.rerender(<Surface {...initial} {...props} />),
  }
}

function shortcut(target: Element | Document = document, options: Record<string, unknown> = {}) {
  return fireEvent.keyDown(target, { key: 'f', ctrlKey: true, shiftKey: true, ...options })
}

describe('DashboardFocus', () => {
  beforeEach(() => {
    desktop = true
    mediaListeners = new Set()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      get matches() { return desktop },
      media: '(min-width: 1024px)',
      addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener),
    })))
  })
  afterEach(() => {
    cleanup()
    document.body.replaceChildren()
    document.documentElement.classList.remove('kanban-panning')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('hides the existing sidebar entirely and keeps mounted drafts, selection and scroll intact', () => {
    const rendered = fixture()
    const sidebar = document.querySelector('[data-dashboard-sidebar]')!
    const draft = screen.getByRole('textbox', { name: 'Message draft' }) as HTMLTextAreaElement
    fireEvent.change(draft, { target: { value: 'Draft edited without sending' } })
    draft.setSelectionRange(6, 12)
    draft.scrollTop = 29
    const history = vi.spyOn(window.history, 'pushState')
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const action = screen.getByRole('button', { name: 'Workspace action' })
    action.focus()

    expect(shortcut(action)).toBe(false)
    expect(sidebar).toHaveStyle({ display: 'none' })
    expect(sidebar).toHaveAttribute('inert')
    expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('button', { name: 'Navigation' })).not.toBeInTheDocument()
    expect(document.querySelector('[data-dashboard-focus-restore-bar]')).toHaveClass('h-11', 'shrink-0')
    expect(action).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Message draft' })).toBe(draft)
    expect(draft).toHaveValue('Draft edited without sending')
    expect(draft.selectionStart).toBe(6)
    expect(draft.selectionEnd).toBe(12)
    expect(draft.scrollTop).toBe(29)
    expect(rendered.mounted).toHaveBeenCalledTimes(1)
    expect(rendered.unmounted).not.toHaveBeenCalled()

    shortcut(action, { ctrlKey: false, metaKey: true })
    expect(document.querySelector('[data-dashboard-sidebar]')).toBe(sidebar)
    expect(sidebar).not.toHaveAttribute('inert')
    expect(sidebar).not.toHaveAttribute('aria-hidden')
    expect(sidebar).not.toHaveStyle({ display: 'none' })
    expect(action).toHaveFocus()
    expect(history).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
  })

  it('moves sidebar focus to the visible restore button and returns to its invoker', () => {
    fixture()
    const enter = screen.getByRole('button', { name: 'Ocultar menú' })
    expect(enter).toHaveAttribute('aria-controls', 'dashboard-primary-navigation')
    expect(enter).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(enter)
    const restore = screen.getByRole('button', { name: /^Mostrar menú/ })
    expect(restore).toHaveFocus()
    expect(restore).toHaveAttribute('aria-controls', 'dashboard-primary-navigation')
    expect(restore).toHaveAttribute('aria-expanded', 'false')
    expect(restore).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+F Meta+Shift+F')
    fireEvent.click(restore)
    expect(screen.getByRole('button', { name: 'Ocultar menú' })).toBe(enter)
    expect(screen.getByRole('button', { name: 'Ocultar menú' })).toHaveFocus()
  })

  it('restores without stealing an existing content focus', () => {
    const rendered = fixture()
    shortcut()
    const draft = screen.getByRole('textbox', { name: 'Message draft' })
    draft.focus()
    act(() => rendered.focus().restore())
    expect(draft).toHaveFocus()
  })

  it('falls back to a visible sidebar action when the original invoker no longer exists', () => {
    fixture()
    const nav = screen.getByRole('button', { name: 'Navigation' })
    nav.focus()
    shortcut(nav)
    nav.remove()
    fireEvent.click(screen.getByRole('button', { name: /^Mostrar menú/ }))
    expect(screen.getByRole('button', { name: 'Ocultar menú' })).toHaveFocus()
  })

  it.each([{ scopeKey: 'account:user:/dashboard/contacts' }, { scopeKey: 'other-account:user:/dashboard/chats' }, { scopeKey: 'account:other-user:/dashboard/chats' }, { enabled: false }])('restores immediately when its route, identity or desktop availability changes: %j', update => {
    const rendered = fixture()
    shortcut()
    expect(rendered.focus().hidden).toBe(true)
    rendered.update(update)
    expect(rendered.focus().hidden).toBe(false)
    expect(document.querySelector('[data-dashboard-sidebar]')).not.toHaveAttribute('inert')
    rendered.update({})
    expect(rendered.focus().hidden).toBe(false)
  })

  it('resets below the desktop breakpoint and never restores a stale hidden preference on widening', () => {
    const rendered = fixture()
    fireEvent.click(screen.getByRole('button', { name: 'Ocultar menú' }))
    mediaChange(false)
    expect(rendered.focus().available).toBe(false)
    expect(rendered.focus().hidden).toBe(false)
    expect(screen.queryByRole('button', { name: 'Ocultar menú' })).not.toBeInTheDocument()
    expect(document.querySelector('[data-dashboard-sidebar]')?.contains(document.activeElement)).toBe(false)
    shortcut()
    expect(rendered.focus().hidden).toBe(false)
    mediaChange(true)
    expect(rendered.focus().hidden).toBe(false)
  })

  it.each(['pagehide', 'pageshow'])('discards temporary hidden state on %s', event => {
    const rendered = fixture()
    shortcut()
    act(() => window.dispatchEvent(new Event(event)))
    expect(rendered.focus().hidden).toBe(false)
  })

  it('gives a specialized owner priority during loading, blocked interactions and StrictMode remounts', () => {
    const rendered = fixture({ scopeKey: 'account:user:/dashboard/tasks', enabled: true, specialized: true, strict: true })
    expect(rendered.focus().specializedOwnerActive).toBe(true)
    expect(screen.queryByRole('button', { name: 'Ocultar menú' })).not.toBeInTheDocument()
    expect(shortcut()).toBe(true)
    expect(rendered.focus().hidden).toBe(false)
    rendered.update({ specialized: false })
    expect(rendered.focus().specializedOwnerActive).toBe(false)
    shortcut()
    expect(rendered.focus().hidden).toBe(true)
    rendered.update({ specialized: true })
    expect(rendered.focus().hidden).toBe(false)
    expect(rendered.focus().specializedOwnerActive).toBe(true)
  })

  it('does not let repeated or older owner cleanup release another mounted editor', () => {
    const rendered = fixture()
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    act(() => {
      releaseFirst = rendered.focus().registerSpecializedOwner(Symbol('first'))
      releaseSecond = rendered.focus().registerSpecializedOwner(Symbol('second'))
    })
    act(() => { releaseFirst(); releaseFirst() })
    expect(rendered.focus().specializedOwnerActive).toBe(true)
    expect(shortcut()).toBe(true)
    act(() => releaseSecond())
    shortcut()
    expect(rendered.focus().hidden).toBe(true)
  })

  it('lets the existing whiteboard capture handler consume one shortcut without generic alternation', () => {
    const rendered = fixture({ scopeKey: 'account:user:/dashboard/tasks', enabled: true, specialized: true, strict: false })
    const boardHandler = vi.fn((event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation() })
    document.addEventListener('keydown', boardHandler, true)
    shortcut()
    document.removeEventListener('keydown', boardHandler, true)
    expect(boardHandler).toHaveBeenCalledTimes(1)
    expect(rendered.focus().hidden).toBe(false)
  })

  it('preserves browser search, Eros and Escape, editor fields, repeats and composition', () => {
    const rendered = fixture()
    for (const options of [{ shiftKey: false }, { key: 'i', shiftKey: false }, { key: 'Escape' }, { repeat: true }, { isComposing: true }, { altKey: true }, { metaKey: true }]) {
      expect(shortcut(document, options)).toBe(true)
      expect(rendered.focus().hidden).toBe(false)
    }
    const draft = screen.getByRole('textbox', { name: 'Message draft' })
    draft.focus()
    expect(shortcut(draft)).toBe(true)
    expect(draft).toHaveFocus()
    expect(rendered.focus().hidden).toBe(false)
  })

  it('respects events already handled before the document bubble listener', () => {
    const rendered = fixture()
    const action = screen.getByRole('button', { name: 'Workspace action' })
    action.addEventListener('keydown', event => event.preventDefault())
    shortcut(action)
    expect(rendered.focus().hidden).toBe(false)
  })

  it.each(['<div role="dialog" aria-modal="true"></div>', '<div role="alertdialog" aria-modal="true"></div>', '<div role="menu"></div>', '<div role="listbox"></div>', '<div data-task-date-range-picker></div>', '<div data-operational-drag-overlay></div>', '<div data-task-hierarchy-overlay></div>', '<div data-calendar-drag-preview></div>', '<button aria-pressed="true" aria-describedby="DndDescribedBy-1"></button>'])('leaves visible temporary surfaces in control: %s', html => {
    const rendered = fixture()
    const temporary = document.createElement('div')
    temporary.innerHTML = html
    document.body.append(temporary)
    expect(shortcut()).toBe(true)
    expect(rendered.focus().hidden).toBe(false)
    temporary.hidden = true
    shortcut()
    expect(rendered.focus().hidden).toBe(true)
  })

  it('does not resize a pointer, native drag or kanban pan gesture and recovers on release or blur', () => {
    const rendered = fixture()
    fireEvent.pointerDown(document, { pointerId: 1 })
    expect(shortcut()).toBe(true)
    fireEvent.pointerCancel(document, { pointerId: 1 })
    fireEvent.dragStart(document)
    expect(shortcut()).toBe(true)
    fireEvent.dragEnd(document)
    document.documentElement.classList.add('kanban-panning')
    expect(shortcut()).toBe(true)
    document.documentElement.classList.remove('kanban-panning')
    fireEvent.pointerDown(document, { pointerId: 2 })
    act(() => window.dispatchEvent(new Event('blur')))
    shortcut()
    expect(rendered.focus().hidden).toBe(true)
  })

  it('supports safe standalone specialized editors outside a dashboard provider', () => {
    render(<><SpecializedOwner /><DashboardFocusEnterButton /><DashboardFocusRestoreBar /><DashboardFocusSidebar>Standalone</DashboardFocusSidebar></>)
    expect(screen.getByText('Standalone')).not.toHaveAttribute('inert')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('does not retain a drag gesture that its source cancelled', () => {
    const rendered = fixture()
    const action = screen.getByRole('button', { name: 'Workspace action' })
    action.addEventListener('dragstart', event => event.preventDefault())
    fireEvent.dragStart(action)
    shortcut()
    expect(rendered.focus().hidden).toBe(true)
  })

  it('removes all global listeners after unmount', () => {
    const rendered = fixture()
    rendered.unmount()
    expect(mediaListeners.size).toBe(0)
    expect(shortcut()).toBe(true)
  })
})
