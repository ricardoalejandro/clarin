import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WorkspaceActionsMenu from './WorkspaceActionsMenu'
import { OPERATIONAL_OVERLAY_LAYERS } from './operationalOverlayLayers'

afterEach(cleanup)
function Harness({ compact = false, action = vi.fn(), row = vi.fn() }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return <div onClick={row} style={{ overflow: 'hidden', transform: 'translateY(10px)' }} data-row>
    <button ref={anchor} aria-expanded={open} onClick={event => { event.stopPropagation(); setOpen(value => !value) }}>Acciones</button>
    {open && <WorkspaceActionsMenu anchor={anchor.current} id="actions" label="Acciones del contacto" compact={compact} onClose={() => setOpen(false)}>
      <button role="menuitem" onClick={() => { action(); setOpen(false) }}>Ver detalle</button>
      <button role="menuitem" disabled>Deshabilitado</button>
      <button role="menuitem">Editar</button>
    </WorkspaceActionsMenu>}
  </div>
}
function rect(top = 40, right = 300) { return { left: right - 40, right, top, bottom: top + 40, width: 40, height: 40, x: right - 40, y: top, toJSON: () => ({}) } }

describe('Workspace row actions portal', () => {
  it('escapes transformed and clipped rows, owns pointer events and executes exactly once on click', async () => {
    const action = vi.fn(), row = vi.fn()
    render(<Harness action={action} row={row} />)
    const trigger = screen.getByRole('button', { name: 'Acciones' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect())
    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu')
    expect(menu.parentElement).toBe(document.body)
    expect(menu.closest('[data-row]')).toBeNull()
    expect(menu).toHaveStyle({ zIndex: String(OPERATIONAL_OVERLAY_LAYERS.workspacePopover), visibility: 'visible' })
    fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'Ver detalle' }))
    expect(action).not.toHaveBeenCalled()
    expect(menu).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ver detalle' }))
    expect(action).toHaveBeenCalledOnce()
    expect(row).not.toHaveBeenCalled()
  })

  it('navigates enabled actions, closes with Escape and restores the trigger', async () => {
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Acciones' })
    fireEvent.click(trigger)
    const first = await screen.findByRole('menuitem', { name: 'Ver detalle' })
    await waitFor(() => expect(first).toHaveFocus())
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'Editar' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('tracks scroll and resize, flips at the bottom, and closes when its anchor leaves the viewport', async () => {
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Acciones' })
    const bounds = vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect())
    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu')
    expect(menu).toHaveStyle({ top: '88px' })
    bounds.mockReturnValue(rect(100))
    fireEvent.scroll(window)
    expect(menu).toHaveStyle({ top: '148px' })
    bounds.mockReturnValue(rect(window.innerHeight - 50, window.innerWidth - 1))
    fireEvent.resize(window)
    expect(parseInt(menu.style.top)).toBeLessThan(window.innerHeight - 50)
    expect(parseInt(menu.style.left) + parseInt(menu.style.width)).toBeLessThanOrEqual(window.innerWidth - 8)
    bounds.mockReturnValue(rect(-200))
    fireEvent.scroll(window)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('uses the same layer on narrow surfaces and dismisses outside without swallowing the next action', async () => {
    render(<Harness compact />)
    fireEvent.click(screen.getByRole('button', { name: 'Acciones' }))
    const menu = await screen.findByRole('menu')
    expect(menu).toHaveAttribute('data-presentation', 'sheet')
    expect(menu).toHaveStyle({ zIndex: String(OPERATIONAL_OVERLAY_LAYERS.workspacePopover) })
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Acciones' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })
})
