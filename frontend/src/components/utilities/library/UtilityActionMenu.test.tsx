import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Folder, Plus } from 'lucide-react'
import { expect, it, vi } from 'vitest'
import { UtilityActionMenu } from './UtilityActionMenu'

it('portals complete actions, supports keyboard movement and restores trigger focus', async () => {
  const create = vi.fn(), move = vi.fn()
  render(<div style={{ overflow: 'hidden', height: 44 }}><UtilityActionMenu label="Acciones de prueba" className="button" actions={[
    { id: 'create', label: 'Crear', icon: Plus, onSelect: create }, { id: 'move', label: 'Mover', icon: Folder, onSelect: move },
  ]} /></div>)
  const trigger = screen.getByRole('button', { name: 'Acciones de prueba' })
  trigger.focus(); fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const menu = await screen.findByRole('menu', { name: 'Acciones de prueba' })
  expect(menu.parentElement).toBe(document.body)
  await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Crear' })).toHaveFocus())
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Crear' }), { key: 'End' })
  expect(screen.getByRole('menuitem', { name: 'Mover' })).toHaveFocus()
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Mover' }), { key: 'Escape' })
  expect(trigger).toHaveFocus()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  fireEvent.click(trigger); fireEvent.click(screen.getByRole('menuitem', { name: 'Crear' }))
  expect(create).toHaveBeenCalledOnce(); expect(move).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})
