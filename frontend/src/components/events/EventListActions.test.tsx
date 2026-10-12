import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { EventListActions } from './EventListActions'

vi.mock('@/components/operational-overlay/WorkspaceActionsMenu', () => ({
  default: ({ anchor, children }: { anchor: unknown; children: ReactNode }) => anchor ? <div>{children}</div> : null,
}))
afterEach(cleanup)
it('blocks replacing an open configuration and local navigation while a configuration is open', () => {
  const configure = vi.fn(), stages = vi.fn()
  render(<EventListActions name="Jornada" readOnly={false} busy={false} configurationOpen folders={[]} onConfigure={configure} onStages={stages} onLogbooks={vi.fn()} onDuplicate={vi.fn()} onCancel={vi.fn()} onMove={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Acciones de Jornada' }))
  expect(screen.getByRole('menuitem', { name: 'Configurar evento' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: 'Organizar etapas' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: 'Bitácoras' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: 'Duplicar' })).toBeDisabled()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Configurar evento' }))
  expect(configure).not.toHaveBeenCalled()
  expect(stages).not.toHaveBeenCalled()
})

it('disables cancellation of terminal events', () => {
  const cancel = vi.fn()
  render(<EventListActions name="Histórico" readOnly busy={false} folders={[]} onConfigure={vi.fn()} onStages={vi.fn()} onLogbooks={vi.fn()} onDuplicate={vi.fn()} onCancel={cancel} onMove={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Acciones de Histórico' }))
  const action = screen.getByRole('menuitem', { name: 'Cancelar evento' })
  expect(action).toBeDisabled()
  expect(action).toHaveAttribute('title', 'Este evento ya está cerrado y conserva su historial')
  fireEvent.click(action)
  expect(cancel).not.toHaveBeenCalled()
})
