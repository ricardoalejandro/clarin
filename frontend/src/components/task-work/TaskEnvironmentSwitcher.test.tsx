import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiGet } from '@/lib/api'
import TaskEnvironmentSwitcher, { taskEnvironmentActorAccessLabel } from './TaskEnvironmentSwitcher'
import type { TaskEnvironment } from '@/types/task'

vi.mock('@/lib/api', () => ({ apiGet: vi.fn() }))

const environment: TaskEnvironment = {
  id: 'environment-general',
  account_id: 'account-1',
  name: 'General',
  description: '',
  color: '#6366F1',
  icon: 'layers',
  sort_order: 0,
  visibility: 'account',
  default_access_level: 'full',
  is_default: true,
  version: 1,
  access_revision: 1,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
  folder_count: 0,
  list_count: 1,
  task_count: 0,
  open_task_count: 0,
  completed_task_count: 0,
  cancelled_task_count: 0,
  permissions: {
    level: 'full',
    can_view: true,
    can_comment: true,
    can_edit: true,
    can_delete: true,
    can_manage_access: true,
    inherited_from: 'account_admin',
  },
}

describe('TaskEnvironmentSwitcher', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('keeps typing immediate and starts the remote search exactly after 500 ms', async () => {
    vi.useFakeTimers()
    vi.mocked(apiGet).mockResolvedValue({
      success: true,
      status: 200,
      data: { environments: [environment], can_create: true },
    })
    render(<TaskEnvironmentSwitcher
      active={environment}
      environments={[environment]}
      canCreate
      onSelect={() => {}}
      onCreate={() => {}}
      onConfigure={() => {}}
    />)

    fireEvent.click(screen.getByRole('button', { name: /Entorno General/i }))
    await act(async () => { await Promise.resolve() })
    vi.mocked(apiGet).mockClear()

    const input = screen.getByPlaceholderText('Buscar Entornos…')
    fireEvent.change(input, { target: { value: 'Privado' } })
    expect(input).toHaveValue('Privado')
    expect(apiGet).not.toHaveBeenCalled()

    await act(async () => { vi.advanceTimersByTime(499) })
    expect(apiGet).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve() })
    expect(apiGet).toHaveBeenCalledTimes(1)
    expect(vi.mocked(apiGet).mock.calls[0][0]).toContain('search=Privado')
  })

  it('keeps focus inside the portaled selector and restores it on Escape', async () => {
    vi.mocked(apiGet).mockResolvedValue({ success: true, status: 200, data: { environments: [environment] } })
    render(<TaskEnvironmentSwitcher
      active={environment}
      environments={[environment]}
      canCreate
      onSelect={() => {}}
      onCreate={() => {}}
      onConfigure={() => {}}
    />)
    const trigger = screen.getByRole('button', { name: /Entorno General/i })
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Seleccionar Entorno' })
    const input = screen.getByPlaceholderText('Buscar Entornos…')
    await waitFor(() => expect(input).toHaveFocus())
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Seleccionar Entorno' })).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('does not present the environment default policy as the actor capability', async () => {
    const withoutCapability = { ...environment, permissions: undefined, default_access_level: 'full' } as unknown as TaskEnvironment
    expect(taskEnvironmentActorAccessLabel(withoutCapability)).toBe('Sin acceso')
  })
})

it('offers removal of a populated managed environment without writing or trusting cached counts', async () => {
  const populated = { ...environment, id: 'private', name: 'Privado', is_default: false, task_count: 90, open_task_count: 70 }
  const remove = vi.fn()
  vi.mocked(apiGet).mockResolvedValue({ success: true, data: { environments: [populated] } })
  render(<TaskEnvironmentSwitcher active={populated} environments={[populated]} canCreate={false} onSelect={vi.fn()} onCreate={vi.fn()} onConfigure={vi.fn()} onRemove={remove} />)
  fireEvent.click(screen.getByRole('button', { name: 'Entorno Privado' }))
  const action = await screen.findByRole('button', { name: 'Eliminar Entorno Privado' })
  expect(action).toBeEnabled()
  expect(remove).not.toHaveBeenCalled()
  fireEvent.click(action)
  expect(remove).toHaveBeenCalledExactlyOnceWith(populated)
})
it('does not offer environment removal for General', async () => {
  vi.mocked(apiGet).mockResolvedValue({ success: true, data: { environments: [environment] } })
  render(<TaskEnvironmentSwitcher active={environment} environments={[environment]} canCreate={false} onSelect={vi.fn()} onCreate={vi.fn()} onConfigure={vi.fn()} onRemove={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Entorno General' }))
  expect(screen.queryByRole('button', { name: 'Eliminar Entorno General' })).not.toBeInTheDocument()
})
