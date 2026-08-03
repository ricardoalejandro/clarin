import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { apiPut } from '@/lib/api'
import type { TaskFolder, TaskList } from '@/types/task'
import { TaskAppearanceDialog } from './TaskContainerAppearance'

vi.mock('@/lib/api', () => ({
  apiDelete: vi.fn(),
  apiPut: vi.fn(),
}))

const base = {
  account_id: 'account-1',
  environment_id: 'environment-1',
  description: '',
  color: '#10B981',
  sort_order: 1024,
  created_by: 'user-1',
  created_at: '2026-08-02T00:00:00Z',
  updated_at: '2026-08-02T00:00:00Z',
  task_count: 0,
  open_task_count: 0,
  completed_task_count: 0,
  cancelled_task_count: 0,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('task container icon rules', () => {
  it('shows the fixed folder icon and never sends an icon update', async () => {
    vi.mocked(apiPut).mockResolvedValue({ success: true })
    const folder = { ...base, id: 'folder-1', name: 'Mauritius', icon: 'rocket', lists: [] } as TaskFolder
    render(<TaskAppearanceDialog item={folder} type="folder" onClose={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} />)

    expect(screen.getByLabelText('Icono fijo de carpeta')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Icono de carpeta/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1))
    const [, payload] = vi.mocked(apiPut).mock.calls[0]
    expect(payload).not.toHaveProperty('icon')
  })

  it('keeps the configurable icon picker and payload for lists', async () => {
    vi.mocked(apiPut).mockResolvedValue({ success: true })
    const list = { ...base, id: 'list-1', name: 'Zambia', icon: 'rocket', is_default: false } as TaskList
    render(<TaskAppearanceDialog item={list} type="list" onClose={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} />)

    expect(screen.getByRole('button', { name: /Icono de lista/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1))
    const [, payload] = vi.mocked(apiPut).mock.calls[0]
    expect(payload).toMatchObject({ icon: 'rocket' })
  })
})
