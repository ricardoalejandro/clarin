import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskWorkspaceManagementActions, TaskWorkspaceScopeSwitch } from './TaskWorkspaceNavigationActions'

describe('TaskWorkspace navigation actions', () => {
  afterEach(cleanup)

  it('renders Todo and Compartidas in one expanded segmented row with full accessible names', () => {
    const onAll = vi.fn()
    const onShared = vi.fn()
    render(<TaskWorkspaceScopeSwitch collapsed={false} environmentName="Propaganda" scopeType="environment" onAll={onAll} onShared={onShared} />)

    const group = screen.getByRole('group', { name: 'Alcance en Propaganda' })
    expect(group).toHaveAttribute('data-task-scope-switch')
    expect(screen.getByRole('button', { name: 'Todo el Entorno' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Compartidas conmigo' }))
    expect(onShared).toHaveBeenCalledTimes(1)
  })

  it('keeps management actions in one row while expanded and preserves permission states', () => {
    const onTrash = vi.fn()
    const onManage = vi.fn()
    const { rerender } = render(<TaskWorkspaceManagementActions collapsed={false} canManage trashSelected={false} onTrash={onTrash} onManage={onManage} />)

    const actions = screen.getByRole('button', { name: 'Papelera' }).parentElement
    expect(actions).toHaveClass('grid-cols-2')
    fireEvent.click(screen.getByRole('button', { name: 'Papelera' }))
    fireEvent.click(screen.getByRole('button', { name: 'Administrar' }))
    expect(onTrash).toHaveBeenCalledTimes(1)
    expect(onManage).toHaveBeenCalledTimes(1)

    rerender(<TaskWorkspaceManagementActions collapsed={false} canManage={false} trashSelected={false} onTrash={onTrash} onManage={onManage} />)
    expect(screen.getByRole('button', { name: 'Papelera' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Administrar' })).toBeDisabled()
  })

  it('uses one collapsed management trigger, portals its menu and restores focus on Escape', async () => {
    render(<TaskWorkspaceManagementActions collapsed canManage trashSelected={false} onTrash={() => {}} onManage={() => {}} />)
    const trigger = screen.getByRole('button', { name: 'Gestión del Entorno' })
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Gestión del Entorno' })
    expect(menu).toBeInTheDocument()
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Gestión del Entorno' })).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })
})
