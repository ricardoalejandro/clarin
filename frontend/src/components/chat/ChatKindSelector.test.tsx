import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatKindSelector from './ChatKindSelector'

afterEach(cleanup)
describe('compact chat kind menu', () => {
  it('opens a portaled keyboard menu and returns focus after selecting groups', () => {
    const change = vi.fn()
    const { container } = render(<ChatKindSelector value="all" onChange={change} />)
    const trigger = screen.getByRole('button', { name: 'Tipo de conversación: Todos los chats' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const menu = screen.getByRole('menu', { name: 'Tipo de conversación' })
    expect(container).not.toContainElement(menu)
    expect(screen.getByRole('menuitemradio', { name: 'Todos los chats' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(menu, { key: 'End' })
    expect(screen.getByRole('menuitemradio', { name: 'Grupos' })).toHaveFocus()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Grupos' }))
    expect(change).toHaveBeenCalledExactlyOnceWith('group')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
  it('closes on Escape or an outside press without changing the selected kind', () => {
    const change = vi.fn()
    render(<ChatKindSelector value="group" onChange={change} />)
    const trigger = screen.getByRole('button', { name: 'Tipo de conversación: Grupos' })
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(change).not.toHaveBeenCalled()
  })
})
