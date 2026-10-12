import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RelatedTasksPanel from './RelatedTasksPanel'

const fixture = vi.hoisted(() => ({ apiGet: vi.fn() }))
vi.mock('@/lib/api', () => ({ apiGet: fixture.apiGet, subscribeWebSocket: () => () => {} }))
vi.mock('@/components/LeadPolicyProvider', () => ({ useLeadPolicy: () => ({ leadsEnabled: false }) }))
vi.mock('./TaskEditorModal', () => ({ default: () => null }))
vi.mock('./TaskDetailDrawer', () => ({ default: () => null }))
afterEach(() => { cleanup(); fixture.apiGet.mockReset() })

describe('related task history with Leads disabled', () => {
  it('retains the exact historical scope and existing tasks while blocking new Lead links', async () => {
    fixture.apiGet.mockResolvedValue({ success: true, data: { tasks: [{ id: 'task-1', title: 'Tarea histórica', status: 'pending' }] } })
    render(<RelatedTasksPanel scope={{ contactId: 'contact-1', leadId: 'lead-1' }} />)
    expect(await screen.findByText('Tarea histórica')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Nueva tarea' })).not.toBeInTheDocument()
    expect(fixture.apiGet).toHaveBeenCalledWith(expect.stringContaining('lead_id=lead-1'))
    expect(fixture.apiGet.mock.calls.every(([url]) => url.startsWith('/api/tasks?'))).toBe(true)
  })

  it('continues to allow new tasks from a Contact context', async () => {
    fixture.apiGet.mockResolvedValue({ success: true, data: { tasks: [] } })
    render(<RelatedTasksPanel scope={{ contactId: 'contact-1' }} />)
    await waitFor(() => expect(fixture.apiGet).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Nueva tarea' })).toBeEnabled()
  })
})
