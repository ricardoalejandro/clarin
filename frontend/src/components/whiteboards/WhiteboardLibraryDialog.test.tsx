import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WhiteboardLibraryDialog, { type WhiteboardLibraryCatalogSummary } from './WhiteboardLibraryDialog'

afterEach(cleanup)

const catalogs: WhiteboardLibraryCatalogSummary[] = [
  {
    id: 'owned',
    name: 'Flujos del equipo',
    description: 'Formas internas',
    itemCount: 4,
    visibility: 'account',
    version: 7,
    canManage: true,
  },
  {
    id: 'foreign',
    name: 'Catálogo de Operaciones',
    itemCount: 9,
    visibility: 'account',
    version: 3,
    canManage: false,
  },
]

function renderDialog(overrides: Partial<React.ComponentProps<typeof WhiteboardLibraryDialog>> = {}) {
  return render(<WhiteboardLibraryDialog
    personalItemCount={2}
    catalogs={catalogs}
    saveState="saved"
    error={null}
    onImport={vi.fn()}
    onExport={vi.fn()}
    onSave={vi.fn()}
    onReload={vi.fn()}
    onClose={vi.fn()}
    {...overrides}
  />)
}

describe('WhiteboardLibraryDialog catalog management', () => {
  it('shows mutation controls only for catalogs with server-derived manage capability', () => {
    renderDialog({
      canManageCatalogs: true,
      onCreateCatalog: vi.fn(),
      onUpdateCatalog: vi.fn(),
      onArchiveCatalog: vi.fn(),
      onExportCatalog: vi.fn(),
    })

    expect(screen.getByRole('button', { name: 'Nuevo catálogo' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Editar Flujos del equipo' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Archivar Flujos del equipo' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Editar Catálogo de Operaciones' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Archivar Catálogo de Operaciones' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Exportar Catálogo de Operaciones' })).toBeVisible()
  })

  it('creates an account catalog through the controlled callback', async () => {
    const onCreateCatalog = vi.fn().mockResolvedValue(true)
    renderDialog({ canManageCatalogs: true, onCreateCatalog })

    fireEvent.click(screen.getByRole('button', { name: 'Nuevo catálogo' }))
    const form = screen.getByRole('form', { name: 'Crear catálogo' })
    fireEvent.change(within(form).getByLabelText('Nombre'), { target: { value: '  Atención comercial  ' } })
    fireEvent.change(within(form).getByLabelText('Descripción'), { target: { value: '  Recursos aprobados  ' } })
    fireEvent.change(within(form).getByLabelText('Visibilidad'), { target: { value: 'account' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Crear catálogo' }))

    await waitFor(() => expect(onCreateCatalog).toHaveBeenCalledWith({
      name: 'Atención comercial',
      description: 'Recursos aprobados',
      visibility: 'account',
      sourceFile: null,
    }))
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Crear catálogo' })).not.toBeInTheDocument())
  })

  it('validates and forwards an imported .excalidrawlib without reading it in the view', async () => {
    const onCreateCatalog = vi.fn().mockResolvedValue(true)
    renderDialog({ canManageCatalogs: true, onCreateCatalog })
    const file = new File(['{"libraryItems":[]}'], 'Formas aprobadas.excalidrawlib', { type: 'application/json' })

    fireEvent.change(screen.getByLabelText('Seleccionar archivo de catálogo'), { target: { files: [file] } })
    const form = screen.getByRole('form', { name: 'Importar catálogo' })
    expect(within(form).getByLabelText('Nombre')).toHaveValue('Formas aprobadas')
    fireEvent.click(within(form).getByRole('button', { name: 'Crear catálogo' }))

    await waitFor(() => expect(onCreateCatalog).toHaveBeenCalledWith({
      name: 'Formas aprobadas',
      description: '',
      visibility: 'private',
      sourceFile: file,
    }))
  })

  it('passes the canonical version when editing and archiving a managed catalog', async () => {
    const onUpdateCatalog = vi.fn().mockResolvedValue(true)
    const onArchiveCatalog = vi.fn().mockResolvedValue(true)
    renderDialog({ onUpdateCatalog, onArchiveCatalog })

    fireEvent.click(screen.getByRole('button', { name: 'Editar Flujos del equipo' }))
    const editForm = screen.getByRole('form', { name: 'Editar catálogo' })
    fireEvent.change(within(editForm).getByLabelText('Nombre'), { target: { value: 'Flujos comerciales' } })
    fireEvent.click(within(editForm).getByRole('button', { name: 'Guardar cambios' }))
    await waitFor(() => expect(onUpdateCatalog).toHaveBeenCalledWith('owned', {
      name: 'Flujos comerciales',
      description: 'Formas internas',
      visibility: 'account',
    }, 7))

    fireEvent.click(screen.getByRole('button', { name: 'Archivar Flujos del equipo' }))
    const confirmation = screen.getByRole('alertdialog', { name: 'Confirmar archivo de catálogo' })
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Archivar catálogo' }))
    await waitFor(() => expect(onArchiveCatalog).toHaveBeenCalledWith('owned', 7))
  })
})
