import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGet } from '@/lib/api'
import TaskSharedHub from './TaskSharedHub'

vi.mock('@/lib/api', () => ({ apiGet: vi.fn() }))

const mockedGet = vi.mocked(apiGet)

describe('TaskSharedHub', () => {
  beforeEach(() => mockedGet.mockReset())

  it('loads only the active Entorno and reconciles a realtime refresh token', async () => {
    mockedGet
      .mockResolvedValueOnce({ success: true, data: { items: [{ id: 'task-1', type: 'task', name: 'Tarea compartida', effective_access_level: 'view' }], next_cursor: null } })
      .mockResolvedValueOnce({ success: true, data: { items: [], next_cursor: null } })
    const onOpenTask = vi.fn()
    const props = { environmentId: 'env-active', onOpenFolder: vi.fn(), onOpenList: vi.fn(), onOpenTask }
    const view = render(<TaskSharedHub {...props} refreshToken={0} />)

    fireEvent.click(await screen.findByRole('button', { name: /Tarea compartida/ }))
    expect(onOpenTask).toHaveBeenCalledWith('task-1')
    expect(mockedGet).toHaveBeenNthCalledWith(1, '/api/tasks/environments/env-active/shared-resources?limit=50', expect.anything())

    view.rerender(<TaskSharedHub {...props} refreshToken={1} />)
    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('Tarea compartida')).not.toBeInTheDocument())
    expect(screen.getByText(/No tienes recursos compartidos directamente/)).toBeInTheDocument()
  })
})
