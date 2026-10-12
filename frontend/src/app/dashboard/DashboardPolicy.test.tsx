import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LeadPolicyProvider, type LeadPolicyState } from '@/components/LeadPolicyProvider'
import DashboardPage from './page'

const mocks = vi.hoisted(() => ({ api: vi.fn(), listeners: new Set<(event: unknown) => void>() }))
vi.mock('@/lib/api', () => ({ api: mocks.api, subscribeWebSocket: (listener: (event: unknown) => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener) } }))
const dashboard = {
  generated_at: '2026-10-12T00:00:00Z', timezone: 'America/Lima', period: { preset: '30d' },
  sections: { leads: true, chats: true, tasks: true, events: false, devices: false },
  leads: { open: 2, new: { current: 1, previous: 0, change_percent: null }, won: { current: 0, previous: 0, change_percent: null }, conversion: { current_percent: null, previous_percent: null, change_points: null }, trend: [] },
  chats: { total: 1, unread_total: 1, awaiting_reply: 1, items: [{ id: 'chat-1', display_name: 'Conversación vigente', last_message: 'Mensaje pendiente', last_message_at: null, last_inbound_at: null, unread_count: 1 }] },
  tasks: { overdue: 1, due_today: 0, items: [{ id: 'task-1', environment_id: 'env-1', title: 'Tarea vigente', due_at: null, status: 'todo', type: 'task' }] },
}
const state = (enabled: boolean): LeadPolicyState => ({ ready: true, policy: null, leadsEnabled: enabled, automationEnabled: enabled, error: '', refresh: vi.fn() })
const view = (enabled: boolean) => <LeadPolicyProvider value={state(enabled)}><DashboardPage /></LeadPolicyProvider>
beforeEach(() => mocks.api.mockReset().mockResolvedValue({ success: true, data: { success: true, dashboard } }))
afterEach(() => { cleanup(); mocks.listeners.clear() })

describe('Dashboard account Lead policy', () => {
  it('removes all commercial sections on toggle while keeping chats and tasks mounted and linked', async () => {
    const { rerender } = render(view(true))
    expect(await screen.findByText('Rendimiento comercial')).toBeVisible()
    const chat = screen.getByRole('link', { name: /Conversación vigente/ })
    const task = screen.getByRole('link', { name: /Tarea vigente/ })
    rerender(view(false))
    expect(screen.queryByText('Rendimiento comercial')).not.toBeInTheDocument()
    expect(screen.queryByText('Actividad comercial')).not.toBeInTheDocument()
    expect(screen.queryByText('Salud del pipeline')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Abrir leads' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Periodo del dashboard')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Conversación vigente/ })).toBe(chat)
    expect(screen.getByRole('link', { name: /Tarea vigente/ })).toBe(task)
    expect(chat).toHaveAttribute('href', '/dashboard/chats?open=chat-1')
    expect(task).toHaveAttribute('href', '/dashboard/tasks?environment=env-1&task=task-1')
    rerender(view(true))
    expect(screen.getByText('Rendimiento comercial')).toBeVisible()
    expect(mocks.api).toHaveBeenCalledTimes(1)
  })

  it('never revives Lead sections from a late summary while policy is disabled', async () => {
    let resolve!: (result: unknown) => void
    mocks.api.mockReturnValueOnce(new Promise(next => { resolve = next }))
    const { rerender } = render(view(true))
    rerender(view(false))
    await act(async () => resolve({ success: true, data: { success: true, dashboard } }))
    await waitFor(() => expect(screen.getByText('Conversación vigente')).toBeVisible())
    expect(screen.getByText('Tarea vigente')).toBeVisible()
    expect(screen.queryByText('Rendimiento comercial')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Abrir leads' })).not.toBeInTheDocument()
  })
})
