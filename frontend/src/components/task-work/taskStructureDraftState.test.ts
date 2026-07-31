import { describe, expect, it } from 'vitest'
import type { TaskFolder, TaskWorkflow, TaskWorkflowStatus } from '@/types/task'
import { mergeCanonicalTaskFolderWorkflowDrafts, mergeCanonicalTaskStatusDrafts, taskStatusDraftChanged, taskStructureHasPendingChanges } from './taskStructureDraftState'

const status = (id: string, name: string): TaskWorkflowStatus => ({
  id, account_id: 'account', workflow_id: 'workflow', name, color: '#10B981', category: 'active', sort_order: 1,
  is_default: false, created_at: '', updated_at: '',
})

describe('task structure draft state', () => {
  it('keeps dirty status drafts while refreshing canonical workflows', () => {
    const edited = { ...status('status', 'Anterior'), name: 'Borrador local' }
    const workflow = { id: 'workflow', account_id: 'account', name: 'Flujo', is_default: true, created_by: 'user', created_at: '', updated_at: '', statuses: [status('status', 'Servidor nuevo')] } as TaskWorkflow
    const merged = mergeCanonicalTaskStatusDrafts([workflow], { status: edited }, new Set(['status']))
    expect(merged.status.name).toBe('Borrador local')
    expect(mergeCanonicalTaskStatusDrafts([workflow], { status: edited }, new Set()).status.name).toBe('Servidor nuevo')
  })

  it('keeps dirty folder workflow drafts until the canonical refresh catches up', () => {
    const original = { id: 'folder', workflow_id: 'workflow-a' } as TaskFolder
    const refreshedElsewhere = { ...original, workflow_id: 'workflow-b' } as TaskFolder
    const pending = mergeCanonicalTaskFolderWorkflowDrafts(
      [refreshedElsewhere],
      { folder: 'workflow-local' },
      new Set(['folder']),
    )

    expect(pending).toEqual({
      drafts: { folder: 'workflow-local' },
      dirtyFolderIDs: ['folder'],
    })

    const reconciled = mergeCanonicalTaskFolderWorkflowDrafts(
      [{ ...original, workflow_id: 'workflow-local' } as TaskFolder],
      pending.drafts,
      new Set(pending.dirtyFolderIDs),
    )
    expect(reconciled).toEqual({
      drafts: { folder: 'workflow-local' },
      dirtyFolderIDs: [],
    })

    expect(mergeCanonicalTaskFolderWorkflowDrafts(
      [refreshedElsewhere],
      { folder: 'workflow-local' },
      new Set(),
    ).drafts).toEqual({ folder: 'workflow-b' })
  })

  it('detects meaningful status and form changes before closing', () => {
    const original = status('status', 'En curso')
    expect(taskStatusDraftChanged(original, { ...original })).toBe(false)
    expect(taskStatusDraftChanged(original, { ...original, color: '#EF4444' })).toBe(true)
    const folder = { id: 'folder', workflow_id: 'workflow-a' } as TaskFolder
    expect(taskStructureHasPendingChanges({ dirtyStatusIDs: [], folderName: '', listName: '', workflowName: '', newStatusName: '', folders: [folder], folderWorkflows: { folder: 'workflow-a' } })).toBe(false)
    expect(taskStructureHasPendingChanges({ dirtyStatusIDs: [], folderName: 'Operaciones', listName: '', workflowName: '', newStatusName: '', folders: [folder], folderWorkflows: { folder: 'workflow-a' } })).toBe(true)
    expect(taskStructureHasPendingChanges({ dirtyStatusIDs: [], folderName: '', listName: '', workflowName: '', newStatusName: '', folders: [folder], folderWorkflows: { folder: 'workflow-b' } })).toBe(true)
  })
})
