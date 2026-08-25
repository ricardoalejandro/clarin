import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WhiteboardFolder, WhiteboardSummary } from '@/lib/whiteboards'
import WhiteboardSettingsPanel from './WhiteboardSettingsPanel'

const folders: WhiteboardFolder[] = [
  { id: 'root-a', name: 'Operaciones', parent_id: null, sort_order: 1024, version: 4 },
  { id: 'child-a', name: 'Procesos', description: 'Trabajo interno', parent_id: 'root-a', sort_order: 1024, version: 2 },
]

const board: WhiteboardSummary = {
  id: 'board-a',
  name: 'Mapa comercial',
  description: 'Flujo actual',
  folder_id: 'root-a',
  folder_name: 'Operaciones',
  created_at: '2026-08-18T00:00:00Z',
  updated_at: '2026-08-18T00:00:00Z',
  version: 5,
  scene_sequence: 1,
  effective_access: { level: 'manage', can_view: true, can_edit: true, can_manage_access: true },
}

function commonProps() {
  return {
    folders,
    layout: 'wide' as const,
    canCreateBoard: true,
    canManageFolders: true,
    onClose: vi.fn(),
    onSaveFolder: vi.fn(async () => ({ success: true })),
    onSaveBoard: vi.fn(async () => ({ success: true })),
    onOpenBoard: vi.fn(),
    onShareBoard: vi.fn(),
    onDuplicateBoard: vi.fn(),
    onArchiveBoard: vi.fn(),
    onCreateSubfolder: vi.fn(),
    onArchiveFolder: vi.fn(),
  }
}

describe('WhiteboardSettingsPanel', () => {
  afterEach(cleanup)

  it('stages folder metadata and a root placement into one versioned save', async () => {
    const props = commonProps()
    render(<WhiteboardSettingsPanel {...props} target={{ kind: 'folder', value: folders[1] }} />)

    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Procesos críticos' } })
    fireEvent.click(screen.getByRole('radio', { name: /Raíz de Pizarras/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() => expect(props.onSaveFolder).toHaveBeenCalledTimes(1))
    expect(props.onSaveFolder).toHaveBeenCalledWith(folders[1], {
      name: 'Procesos críticos',
      description: 'Trabajo interno',
      placement: { parent_id: null, before_folder_id: null },
      expected_version: 2,
    })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('protects a dirty board draft and exposes real access actions', () => {
    const props = commonProps()
    render(<WhiteboardSettingsPanel {...props} target={{ kind: 'board', value: board }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Administrar acceso y enlaces' }))
    expect(props.onShareBoard).toHaveBeenCalledWith(board)

    fireEvent.change(screen.getByLabelText('Descripción'), { target: { value: 'Cambio sin guardar' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar configuración' }))
    expect(screen.getByRole('alertdialog', { name: '¿Descartar cambios?' })).toBeInTheDocument()
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Seguir editando' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})
