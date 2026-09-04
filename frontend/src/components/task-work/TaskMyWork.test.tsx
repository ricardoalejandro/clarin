import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiDelete, apiGet, apiPost, apiPut } from '@/lib/api'
import type { Task, TaskMyWorkResponse } from '@/types/task'
import { TaskMyWorkView } from './TaskMyWork'

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  subscribeWebSocket: vi.fn(() => () => undefined),
}))

const task = {
  id: '00000000-0000-0000-0000-000000000001',
  account_id: 'account-1',
  created_by: 'user-1',
  assigned_to: 'user-1',
  title: 'Preparar propuesta prioritaria',
  description: '',
  type: 'reminder',
  priority: 'urgent',
  status: 'pending',
  list_id: 'list-1',
  list_name: 'Propuestas',
  environment_id: 'environment-1',
  recurrence_rule: '',
  notes: '',
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-01T10:00:00Z',
} as Task

const summary = {
  business_date: '2026-09-01',
  timezone: 'America/Lima' as const,
  reset_at: '2026-09-02T00:00:00-05:00',
  revision: 0,
  focus_count: 0,
  completed_count: 0,
  suggestion_count: 1,
  overdue_suggestion_count: 1,
  due_today_suggestion_count: 0,
  previous_suggestion_count: 0,
  maximum_daily_task_count: 200,
}

const suggested: TaskMyWorkResponse = {
  summary,
  focus_items: [],
  completed_items: [],
  suggestions: [{ task, reasons: ['overdue'] }],
  focus_next_cursor: '',
  suggestions_next_cursor: '',
}

describe('TaskMyWorkView', () => {
  beforeAll(() => {
    class ResizeObserverMock { observe() {} unobserve() {} disconnect() {} }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  })

  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiPost).mockReset()
    vi.mocked(apiPut).mockReset()
    vi.mocked(apiDelete).mockReset()
  })

  it('keeps suggestions separate until the person explicitly adds one to today', async () => {
    const canonical: TaskMyWorkResponse = {
      ...suggested,
      summary: { ...summary, revision: 1, focus_count: 1, suggestion_count: 0, overdue_suggestion_count: 0 },
      focus_items: [{ task, position: 1024, added_at: '2026-09-01T10:05:00Z' }],
      suggestions: [],
    }
    vi.mocked(apiGet).mockResolvedValueOnce({ success: true, data: suggested }).mockResolvedValue({ success: true, data: canonical })
    vi.mocked(apiPost).mockResolvedValue({ success: true, data: { mutation: { business_date: '2026-09-01', revision: 1, ordered_task_ids: [task.id], focus_count: 1, completed_count: 0, operation_id: 'operation-1', idempotent: false } } })

    const view = render(<TaskMyWorkView onOpen={vi.fn()} onExit={vi.fn()} />)

    expect(await screen.findByText('Preparar propuesta prioritaria')).toBeInTheDocument()
    expect(screen.getByText('Tu foco está vacío')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Enfocar' }))

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/tasks/my-work/items', expect.objectContaining({ task_id: task.id, expected_revision: 0, business_date: '2026-09-01' })))
    await waitFor(() => expect(screen.queryByText('Tu foco está vacío')).not.toBeInTheDocument())
    expect(view.container.querySelector(`[data-task-my-work-row="${task.id}"]`)).toBeInTheDocument()
  })

  it('restores the exact focus row when a personal mutation fails', async () => {
    const focused: TaskMyWorkResponse = {
      ...suggested,
      summary: { ...summary, revision: 3, focus_count: 1, suggestion_count: 0, overdue_suggestion_count: 0 },
      focus_items: [{ task, position: 1024, added_at: '2026-09-01T10:05:00Z' }],
      suggestions: [],
    }
    vi.mocked(apiGet).mockResolvedValue({ success: true, data: focused })
    vi.mocked(apiDelete).mockResolvedValue({ success: false, status: 500, error: 'Fallo controlado' })

    const view = render(<TaskMyWorkView onOpen={vi.fn()} onExit={vi.fn()} />)
    const remove = await screen.findByRole('button', { name: `Quitar ${task.title} de Mi trabajo` })
    fireEvent.click(remove)

    await waitFor(() => expect(apiDelete).toHaveBeenCalledTimes(1))
    await screen.findByText('Fallo controlado')
    expect(view.container.querySelector(`[data-task-my-work-row="${task.id}"]`)).toBeInTheDocument()
  })
})
