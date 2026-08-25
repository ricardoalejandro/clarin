import { describe, expect, it } from 'vitest'
import type { TaskWorkflowStatus } from '@/types/task'
import { createTaskQuickSubtaskDraft } from './TaskQuickSubtaskComposer'

const statuses: TaskWorkflowStatus[] = [
  { id: 'later', account_id: 'a', workflow_id: 'w', name: 'Después', color: '#64748B', category: 'not_started', sort_order: 1, is_default: false, created_at: '', updated_at: '' },
  { id: 'default', account_id: 'a', workflow_id: 'w', name: 'Pendiente', color: '#64748B', category: 'not_started', sort_order: 9, is_default: true, created_at: '', updated_at: '' },
]

describe('createTaskQuickSubtaskDraft', () => {
  it('inherits the responsible owner and canonical initial status without inventing dates', () => {
    expect(createTaskQuickSubtaskDraft({ assigned_to: 'owner' }, statuses)).toEqual({
      title: '',
      statusId: 'default',
      assignedTo: 'owner',
      priority: 'medium',
      startAt: '',
      dueAt: '',
      isAllDay: false,
    })
  })
})
