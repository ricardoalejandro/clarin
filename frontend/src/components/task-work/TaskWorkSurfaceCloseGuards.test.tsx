import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGet } from '@/lib/api'
import type { TaskEnvironment, TaskWorkflow } from '@/types/task'
import TaskEnvironmentWindow, { type TaskEnvironmentWindowHandle } from './TaskEnvironmentWindow'
import TaskStructureModal, { type TaskStructureModalHandle } from './TaskStructureModal'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  apiDelete: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}))

vi.mock('./TaskHierarchyTree', () => ({ default: () => <div data-testid="task-hierarchy" /> }))

const permissions = {
  level: 'full',
  can_view: true,
  can_comment: true,
  can_edit: true,
  can_delete: true,
  can_archive: true,
  can_trash: true,
  can_restore: true,
  can_manage_access: true,
} as const

const environment = {
  id: 'environment-1',
  account_id: 'account-1',
  name: 'Operaciones',
  description: 'Trabajo operativo',
  color: '#6366F1',
  icon: 'layers',
  sort_order: 1,
  visibility: 'restricted',
  default_access_level: 'none',
  is_default: false,
  version: 1,
  access_revision: 1,
  created_at: '',
  updated_at: '',
  folder_count: 0,
  list_count: 0,
  task_count: 0,
  open_task_count: 0,
  completed_task_count: 0,
  cancelled_task_count: 0,
  permissions,
} satisfies TaskEnvironment

const workflow = {
  id: 'workflow-1',
  account_id: 'account-1',
  environment_id: environment.id,
  name: 'General',
  is_default: true,
  created_at: '',
  updated_at: '',
  statuses: [],
} satisfies TaskWorkflow

beforeEach(() => {
  vi.mocked(apiGet).mockReset()
  localStorage.clear()
})

afterEach(cleanup)

describe('guardas de cierre de superficies de Clarin Work', () => {
  it('mantiene Configuración abierta hasta que el cierre externo obtiene una decisión explícita', async () => {
    const ref = React.createRef<TaskStructureModalHandle>()
    const onClose = vi.fn()
    const rendered = render(<TaskStructureModal
      ref={ref}
      open
      environmentId={environment.id}
      folders={[]}
      lists={[]}
      workflows={[workflow]}
      onClose={onClose}
      onChanged={vi.fn()}
    />)

    fireEvent.change(screen.getByPlaceholderText('Ej. Operaciones'), { target: { value: 'Carpeta sin guardar' } })

    let cancelled!: Promise<boolean>
    await act(async () => { cancelled = ref.current!.requestClose() })
    const continueEditing = await screen.findByRole('button', { name: 'Seguir editando' })
    const discard = screen.getByRole('button', { name: 'Descartar cambios' })
    await waitFor(() => expect(continueEditing).toHaveFocus())
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(discard).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    await expect(cancelled).resolves.toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('Ej. Operaciones')).toHaveValue('Carpeta sin guardar')

    let forcedUnmount!: Promise<boolean>
    await act(async () => { forcedUnmount = ref.current!.requestClose() })
    rendered.rerender(<TaskStructureModal
      ref={ref}
      open={false}
      environmentId={environment.id}
      folders={[]}
      lists={[]}
      workflows={[workflow]}
      onClose={onClose}
      onChanged={vi.fn()}
    />)
    await expect(forcedUnmount).resolves.toBe(false)

    rendered.rerender(<TaskStructureModal
      ref={ref}
      open
      environmentId={environment.id}
      folders={[]}
      lists={[]}
      workflows={[workflow]}
      onClose={onClose}
      onChanged={vi.fn()}
    />)
    fireEvent.change(await screen.findByPlaceholderText('Ej. Operaciones'), { target: { value: 'Otra carpeta' } })
    let accepted!: Promise<boolean>
    await act(async () => { accepted = ref.current!.requestClose() })
    fireEvent.click(await screen.findByRole('button', { name: 'Descartar cambios' }))
    await expect(accepted).resolves.toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('protege los borradores del Entorno y sólo abre Configuración después de confirmar el descarte', async () => {
    const ref = React.createRef<TaskEnvironmentWindowHandle>()
    const onClose = vi.fn()
    const onOpenStructure = vi.fn()
    render(<TaskEnvironmentWindow
      ref={ref}
      open
      environment={environment}
      users={[]}
      folders={[]}
      lists={[]}
      workflows={[workflow]}
      storageScope="account-1:user-1"
      onClose={onClose}
      onSaved={vi.fn()}
      onOpenStructure={onOpenStructure}
    />)

    const name = await screen.findByDisplayValue(environment.name)
    fireEvent.change(name, { target: { value: 'Nombre local pendiente' } })
    name.focus()
    expect(name).toHaveFocus()

    let cancelled!: Promise<boolean>
    await act(async () => { cancelled = ref.current!.requestClose() })
    const continueEditing = await screen.findByRole('button', { name: 'Seguir editando' })
    const discard = screen.getByRole('button', { name: 'Descartar cambios' })
    await waitFor(() => expect(continueEditing).toHaveFocus())
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(discard).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    await expect(cancelled).resolves.toBe(false)
    await waitFor(() => expect(name).toHaveFocus())
    expect(onClose).not.toHaveBeenCalled()
    expect(name).toHaveValue('Nombre local pendiente')

    fireEvent.click(screen.getByRole('tab', { name: 'Estructura' }))
    fireEvent.click(screen.getByRole('button', { name: 'Administrar estructura' }))
    expect(await screen.findByRole('alertdialog', { name: '¿Descartar cambios del Entorno?' })).toBeVisible()
    expect(onOpenStructure).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Descartar cambios' }))
    await waitFor(() => expect(onOpenStructure).toHaveBeenCalledTimes(1))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('considera cambios de acceso cargados como borrador protegido', async () => {
    vi.mocked(apiGet).mockResolvedValue({
      success: true,
      data: {
        access_revision: 1,
        grants: [{ user_id: 'user-2', display_name: 'Ana', username: 'ana', access_level: 'view', can_manage_access: false }],
      },
    })
    const ref = React.createRef<TaskEnvironmentWindowHandle>()
    const onClose = vi.fn()
    render(<TaskEnvironmentWindow
      ref={ref}
      open
      environment={environment}
      users={[{ id: 'user-2', display_name: 'Ana', username: 'ana' }]}
      folders={[]}
      lists={[]}
      workflows={[workflow]}
      storageScope="account-1:user-1"
      onClose={onClose}
      onSaved={vi.fn()}
      onOpenStructure={vi.fn()}
    />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Acceso' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Quitar acceso de Ana' }))
    let pending!: Promise<boolean>
    await act(async () => { pending = ref.current!.requestClose() })
    expect(await screen.findByRole('alertdialog', { name: '¿Descartar cambios del Entorno?' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Seguir editando' }))
    await expect(pending).resolves.toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })
})
