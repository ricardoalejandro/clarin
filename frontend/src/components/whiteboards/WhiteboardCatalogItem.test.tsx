import { DndContext } from '@dnd-kit/core'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WhiteboardSummary } from '@/lib/whiteboards'
import WhiteboardCatalogItem from './WhiteboardCatalogItem'

afterEach(cleanup)

const access = {
  level: 'manage' as const,
  can_view: true,
  can_edit: true,
  can_comment: true,
  can_delete: true,
  can_manage_access: true,
}

function board(overrides: Partial<WhiteboardSummary> = {}): WhiteboardSummary {
  return {
    id: 'board-1',
    name: 'Mapa operativo',
    folder_name: 'Planeación',
    thumbnail_url: '/api/whiteboards/board-1/thumbnail',
    owner_name: 'Ana QA',
    created_at: '2026-09-04T08:00:00.000Z',
    updated_at: new Date().toISOString(),
    version: 1,
    scene_sequence: 2,
    effective_access: access,
    ...overrides,
  }
}

function renderItem(whiteboard: WhiteboardSummary, overrides: Partial<React.ComponentProps<typeof WhiteboardCatalogItem>> = {}) {
  const props: React.ComponentProps<typeof WhiteboardCatalogItem> = {
    whiteboard,
    view: 'list',
    layout: 'wide',
    busy: false,
    onOpen: vi.fn(),
    onMove: vi.fn(),
    purgeEligibleAt: null,
    canPurge: false,
    canDuplicate: true,
    canMove: true,
    canDrag: true,
    onMenuAction: vi.fn(),
    ...overrides,
  }
  const result = render(<DndContext><WhiteboardCatalogItem {...props} /></DndContext>)
  return { ...result, props }
}

describe('WhiteboardCatalogItem', () => {
  it('keeps every list slot stable and opens from the visual preview', () => {
    const { container, props } = renderItem(board())
    const item = container.querySelector('[data-whiteboard-view="list"]') as HTMLElement

    expect(item).toHaveClass('grid-cols-[44px_64px_minmax(0,1fr)_116px_minmax(148px,200px)_44px]')
    for (const slot of ['drag', 'thumbnail', 'identity', 'updated', 'location', 'actions']) {
      expect(item.querySelector(`[data-whiteboard-slot="${slot}"]`)).toBeInTheDocument()
    }
    const thumbnail = screen.getByRole('button', { name: /^Abrir Mapa operativo$/ })
    expect(thumbnail.querySelector('img')).toHaveClass('object-contain')
    fireEvent.click(thumbnail)
    expect(props.onOpen).toHaveBeenCalledTimes(1)
  })

  it('renders Work once, preserves alignment without a drag action and opens its location', () => {
    const workBoard = board({
      thumbnail_url: null,
      origin: 'work',
      work_location: {
        task_view_id: 'view-1',
        environment_id: 'environment-1',
        scope_type: 'list',
        scope_id: 'list-1',
        scope_name: 'Angola',
        breadcrumb: [
          { type: 'environment', id: 'environment-1', name: 'NTTDATA' },
          { type: 'folder', id: 'folder-1', name: 'Países' },
          { type: 'list', id: 'list-1', name: 'Angola' },
        ],
        lifecycle: 'active',
      },
    })
    const { container } = renderItem(workBoard, { canMove: false, canDrag: false })
    const item = container.querySelector('[data-whiteboard-view="list"]') as HTMLElement

    expect(screen.getAllByText('Clarin Work')).toHaveLength(1)
    expect(screen.getByText('NTTDATA / Países / Angola')).toBeVisible()
    expect(screen.queryByText(/Clarin Work ·/)).not.toBeInTheDocument()
    expect(item.querySelector('[data-whiteboard-slot="drag"]')).toHaveClass('w-11')
    expect(item.querySelector('[data-whiteboard-slot="thumbnail"] img')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Abrir ubicación en Work · Mapa operativo/ })).toHaveAttribute('href', '/dashboard/tasks?work_view=view-1')
    expect(screen.getByText('Abrir ubicación')).toBeVisible()
  })

  it('keeps move and menu actions functional without making the complete card clickable', () => {
    const { props } = renderItem(board())

    fireEvent.click(screen.getByRole('button', { name: /Cambiar carpeta de Mapa operativo/ }))
    expect(props.onMove).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Más acciones de Mapa operativo' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicar' }))
    expect(props.onMenuAction).toHaveBeenCalledWith('duplicate')
  })

  it('shows archived retention and honestly removes unavailable actions', () => {
    const restrictedAccess = { ...access, level: 'view' as const, can_edit: false, can_delete: false, can_manage_access: false }
    renderItem(board({
      archived_at: '2026-09-01T00:00:00.000Z',
      effective_access: restrictedAccess,
      thumbnail_url: null,
      owner_name: null,
    }), {
      canMove: false,
      canDrag: false,
      canDuplicate: false,
      purgeEligibleAt: '2026-10-01T00:00:00.000Z',
    })

    expect(screen.getByText(/Eliminación definitiva desde/)).toBeVisible()
    expect(screen.getByText('Cuenta')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Arrastrar/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Más acciones/ })).not.toBeInTheDocument()
  })

  it('uses the same information hierarchy in compact and grid modes', () => {
    const compact = renderItem(board(), { view: 'compact' })
    expect(compact.container.querySelector('[data-whiteboard-view="compact"]')).toBeInTheDocument()
    expect(compact.container.querySelector('[aria-label^="Cambiar carpeta"]')).toBeVisible()
    expect(screen.getByText('Ana QA')).toBeVisible()
    compact.unmount()

    const grid = renderItem(board(), { view: 'grid' })
    expect(grid.container.querySelector('[data-whiteboard-view="grid"]')).toBeInTheDocument()
    expect(grid.container.querySelector('[aria-label^="Cambiar carpeta"]')).toBeVisible()
    expect(screen.getByText('Ana QA')).toBeVisible()
  })
})
