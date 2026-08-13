import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPERATIONAL_OVERLAY_LAYERS } from '@/components/operational-overlay/operationalOverlayLayers'
import LeadCardActionsMenu, { leadCardMenuPosition } from './LeadCardActionsMenu'

const originalMatchMedia = window.matchMedia

function setCompactMenu(compact: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn(() => ({
      matches: compact,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

function renderMenu(status = 'open') {
  const onLifecycleAction = vi.fn()
  const onDelete = vi.fn()
  const result = render(
    <div data-crm-pipeline-card="lead-1" style={{ transform: 'translateY(120px)' }}>
      <LeadCardActionsMenu
        leadName="Claudia Finipe"
        status={status}
        onLifecycleAction={onLifecycleAction}
        onDelete={onDelete}
      />
    </div>,
  )
  return { ...result, onLifecycleAction, onDelete }
}

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  })
})

describe('leadCardMenuPosition', () => {
  it('aligns to the trigger and flips above near the viewport bottom', () => {
    expect(leadCardMenuPosition(
      { left: 260, right: 292, top: 40, bottom: 72 },
      { width: 192, height: 96 },
      { left: 0, top: 0, width: 320, height: 220 },
    )).toEqual({ left: 100, top: 80, width: 192, maxHeight: 132, placement: 'bottom' })

    expect(leadCardMenuPosition(
      { left: 6, right: 38, top: 178, bottom: 210 },
      { width: 192, height: 96 },
      { left: 0, top: 0, width: 320, height: 220 },
    )).toEqual({ left: 8, top: 74, width: 192, maxHeight: 162, placement: 'top' })
  })

  it('honors visualViewport offsets, clamps horizontally and rejects an invisible trigger', () => {
    expect(leadCardMenuPosition(
      { left: 390, right: 418, top: 420, bottom: 448 },
      { width: 256, height: 300 },
      { left: 100, top: 50, width: 320, height: 400 },
    )).toEqual({ left: 156, top: 112, width: 256, maxHeight: 354, placement: 'top' })

    expect(leadCardMenuPosition(
      { left: 0, right: 20, top: 0, bottom: 20 },
      { width: 192, height: 120 },
      { left: 100, top: 50, width: 320, height: 400 },
    )).toBeNull()
  })
})

describe('LeadCardActionsMenu', () => {
  it('portals the desktop popover outside the transformed card at the semantic workspace layer', async () => {
    setCompactMenu(false)
    renderMenu()
    const trigger = screen.getByRole('button', { name: 'Acciones de Claudia Finipe' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      left: 260, right: 300, top: 40, bottom: 80, width: 40, height: 40, x: 260, y: 40, toJSON: () => ({}),
    })

    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu', { name: 'Acciones de Claudia Finipe' })
    await waitFor(() => expect(menu).toHaveStyle({ visibility: 'visible' }))

    expect(menu.parentElement).toBe(document.body)
    expect(menu.closest('[data-crm-pipeline-card]')).toBeNull()
    expect(menu).toHaveAttribute('data-presentation', 'popover')
    expect(menu).toHaveStyle({ zIndex: String(OPERATIONAL_OVERLAY_LAYERS.workspacePopover) })
  })

  it('supports arrow navigation, Escape and trigger focus restoration', async () => {
    setCompactMenu(false)
    renderMenu()
    const trigger = screen.getByRole('button', { name: 'Acciones de Claudia Finipe' })
    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu')
    const items = screen.getAllByRole('menuitem')

    await waitFor(() => expect(items[0]).toHaveFocus())
    fireEvent.keyDown(items[0], { key: 'ArrowDown' })
    expect(items[1]).toHaveFocus()
    fireEvent.keyDown(items[1], { key: 'End' })
    expect(items[2]).toHaveFocus()
    fireEvent.keyDown(items[2], { key: 'Home' })
    expect(items[0]).toHaveFocus()

    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('repositions with scrolling and closes when virtualization moves the trigger outside the viewport', async () => {
    setCompactMenu(false)
    renderMenu()
    const trigger = screen.getByRole('button', { name: 'Acciones de Claudia Finipe' })
    const rect = vi.spyOn(trigger, 'getBoundingClientRect')
      .mockReturnValue({ left: 260, right: 300, top: 40, bottom: 80, width: 40, height: 40, x: 260, y: 40, toJSON: () => ({}) })

    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu')
    await waitFor(() => expect(menu).toHaveStyle({ top: '88px' }))

    rect.mockReturnValue({ left: 260, right: 300, top: 140, bottom: 180, width: 40, height: 40, x: 260, y: 140, toJSON: () => ({}) })
    fireEvent.scroll(window)
    await waitFor(() => expect(menu).toHaveStyle({ top: '188px' }))

    rect.mockReturnValue({ left: 260, right: 300, top: -200, bottom: -160, width: 40, height: 40, x: 260, y: -200, toJSON: () => ({}) })
    fireEvent.scroll(window)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it('closes on outside click and preserves lifecycle and delete callbacks', async () => {
    setCompactMenu(false)
    const { onLifecycleAction, onDelete, rerender } = renderMenu()
    const trigger = screen.getByRole('button', { name: 'Acciones de Claudia Finipe' })

    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Marcar como ganado' }))
    expect(onLifecycleAction).toHaveBeenCalledWith('won')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.click(trigger)
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    rerender(
      <div data-crm-pipeline-card="lead-1" style={{ transform: 'translateY(120px)' }}>
        <LeadCardActionsMenu leadName="Claudia Finipe" status="won" onLifecycleAction={onLifecycleAction} onDelete={onDelete} />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Acciones de Claudia Finipe' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reabrir lead' }))
    expect(onLifecycleAction).toHaveBeenLastCalledWith('reopen')

    fireEvent.click(screen.getByRole('button', { name: 'Acciones de Claudia Finipe' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mover a papelera' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('renders one portaled bottom sheet for compact and touch workspaces', async () => {
    setCompactMenu(true)
    renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Acciones de Claudia Finipe' }))
    const menu = await screen.findByRole('menu', { name: 'Acciones de Claudia Finipe' })

    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(menu.parentElement).toBe(document.body)
    expect(menu).toHaveAttribute('data-presentation', 'sheet')
    expect(menu).toHaveClass('inset-x-3')
    expect(menu).toHaveStyle({ zIndex: String(OPERATIONAL_OVERLAY_LAYERS.workspacePopover) })
  })
})
