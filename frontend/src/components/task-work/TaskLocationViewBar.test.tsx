import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskLocationView } from '@/types/task'
import TaskLocationViewBar from './TaskLocationViewBar'

function locationView(overrides: Partial<TaskLocationView> = {}): TaskLocationView {
  return {
    id: 'view-1',
    type: 'whiteboard',
    environment_id: 'environment-1',
    scope: { scope_type: 'list', scope_id: 'list-1', scope_name: 'Lista', breadcrumb: [] },
    sort_order: 1,
    version: 1,
    access_revision: 1,
    lifecycle: 'active',
    created_by: 'user-1',
    resource: { whiteboard: { id: 'board-1', name: 'Mapa protegido', version: 1, scene_sequence: 0, updated_at: '' } },
    capabilities: { can_view: true, can_comment: true, can_edit: true, can_manage: true, can_manage_access: false },
    ...overrides,
  }
}

function props(view = locationView()) {
  return {
    builtinView: 'list' as const,
    activeLocationView: view,
    locationViews: [view],
    availableWidth: 1_200,
    locationLabel: 'Lista',
    locationContextKey: 'environment-1:list:list-1',
    featureEnabled: true,
    canCreate: true,
    onSelectBuiltin: vi.fn(),
    onSelectLocation: vi.fn(),
    onCreate: vi.fn(async () => null),
    onRename: vi.fn(async () => null),
    onDuplicate: vi.fn(async () => null),
    onTrash: vi.fn(async () => null),
  }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TaskLocationViewBar authority-safe overlays', () => {
  it('redacts an open privileged dialog when the feature or contextual authority is revoked', async () => {
    const initial = props()
    const rendered = render(<TaskLocationViewBar {...initial} />)
    fireEvent.click(screen.getByRole('button', { name: 'Acciones de Mapa protegido' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Cambiar nombre' }))
    expect(screen.getByRole('dialog', { name: 'Cambiar nombre' })).toBeVisible()

    rendered.rerender(<TaskLocationViewBar {...initial} featureEnabled={false} locationViews={[]} activeLocationView={null} />)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cambiar nombre' })).not.toBeInTheDocument())
    expect(screen.queryByDisplayValue('Mapa protegido')).not.toBeInTheDocument()

    const restored = locationView()
    rendered.rerender(<TaskLocationViewBar {...props(restored)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Acciones de Mapa protegido' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mover a Papelera' }))
    expect(screen.getByRole('dialog', { name: 'Mover pizarra a Papelera' })).toBeVisible()
    const downgraded = locationView({
      access_revision: 2,
      capabilities: { can_view: true, can_comment: true, can_edit: true, can_manage: false, can_manage_access: false },
    })
    rendered.rerender(<TaskLocationViewBar {...props(downgraded)} activeLocationView={downgraded} locationViews={[downgraded]} />)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Mover pizarra a Papelera' })).not.toBeInTheDocument())
  })

  it('keeps keyboard focus inside a portaled menu and closes it on viewport change', async () => {
    render(<TaskLocationViewBar {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Acciones de Mapa protegido' }))
    const menu = await screen.findByRole('menu', { name: 'Acciones de Mapa protegido' })
    const rename = screen.getByRole('menuitem', { name: 'Cambiar nombre' })
    const duplicate = screen.getByRole('menuitem', { name: 'Duplicar' })
    await waitFor(() => expect(rename).toHaveFocus())
    fireEvent.keyDown(menu, { key: 'Tab' })
    expect(duplicate).toHaveFocus()
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Acciones de Mapa protegido' })).not.toBeInTheDocument())
  })
})
