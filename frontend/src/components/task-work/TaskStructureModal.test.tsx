import React from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api, apiPost } from '@/lib/api'
import type { TaskList } from '@/types/task'
import TaskStructureModal from './TaskStructureModal'
import type { TaskContainerLifecycleMutation } from './taskHierarchyLazy'

vi.mock('@/lib/api', () => ({ api: vi.fn(), apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear() })

const list: TaskList = {
  id: 'list-1', account_id: 'account-1', environment_id: 'environment-1', name: 'Proyecto',
  icon: 'list', color: '#10B981', sort_order: 1, created_by: 'user-1', created_at: '', updated_at: '',
  task_count: 0, open_task_count: 0, completed_task_count: 0, cancelled_task_count: 0,
  permissions: { level: 'full', can_view: true, can_comment: true, can_edit: true, can_delete: true, can_manage_access: false },
}

describe('configuration hierarchy lifecycle reconciliation', () => {
  it('propagates the real tree removal mutation and operation ID through Configuration', async () => {
    vi.mocked(api).mockResolvedValue({ success: true, data: { preview: {
      type: 'list', id: list.id, name: list.name, environment_id: list.environment_id,
      lifecycle: 'active', mode: 'trash_all', preview_token: 'preview-configuration',
      counts: { lists: 0, tasks: 0, subtasks: 0, open_tasks: 0, completed_tasks: 0, cancelled_tasks: 0, events: 0, whiteboards: 0 },
      requires_name: false, can_execute: true, blockers: [],
    } } })
    vi.mocked(apiPost).mockResolvedValue({ success: true })
    const changed = vi.fn<(mutation?: TaskContainerLifecycleMutation) => Promise<void>>().mockResolvedValue(undefined)
    render(<TaskStructureModal open environmentId="environment-1" folders={[]} lists={[list]} workflows={[]} onClose={vi.fn()} onChanged={changed} />)
    fireEvent.click(screen.getByRole('button', { name: 'Opciones de la lista Proyecto' }))
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar…' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mover todo a Papelera' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Mover todo a Papelera' }))
    await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ type: 'list', id: 'list-1', action: 'trashed', operationID: expect.any(String) })))
    expect(apiPost).toHaveBeenCalledTimes(1)
  })

  it('connects Configuration to the same lifecycle-aware workspace handler as the navigation tree', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/task-work/TaskWorkspace.tsx'), 'utf8')
    const configuration = source.match(/<TaskStructureModal\b[^\n]+/u)?.[0]
    expect(configuration).toContain('onChanged={handleHierarchyChanged}')
  })
})
