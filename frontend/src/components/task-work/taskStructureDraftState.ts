import type { TaskFolder, TaskWorkflow, TaskWorkflowStatus } from '@/types/task'

export function taskStatusDraftChanged(original?: TaskWorkflowStatus, draft?: TaskWorkflowStatus) {
  if (!original || !draft) return false
  return original.name !== draft.name || original.color.toUpperCase() !== draft.color.toUpperCase() || original.category !== draft.category
}

export function mergeCanonicalTaskStatusDrafts(
  workflows: TaskWorkflow[],
  current: Record<string, TaskWorkflowStatus>,
  dirtyStatusIDs: ReadonlySet<string>,
) {
  return Object.fromEntries(workflows.flatMap(workflow => workflow.statuses.map(status => [
    status.id,
    dirtyStatusIDs.has(status.id) && current[status.id] ? current[status.id] : { ...status },
  ])))
}

export function mergeCanonicalTaskFolderWorkflowDrafts(
  folders: TaskFolder[],
  current: Record<string, string>,
  dirtyFolderIDs: ReadonlySet<string>,
  defaultWorkflowID = '',
) {
  const drafts: Record<string, string> = {}
  const nextDirtyFolderIDs: string[] = []

  for (const folder of folders) {
    const canonical = folder.workflow_id || defaultWorkflowID
    const draft = current[folder.id]
    const keepDraft = dirtyFolderIDs.has(folder.id) && draft !== undefined && draft !== canonical
    drafts[folder.id] = keepDraft ? draft : canonical
    if (keepDraft) nextDirtyFolderIDs.push(folder.id)
  }

  return { drafts, dirtyFolderIDs: nextDirtyFolderIDs }
}

export function taskStructureHasPendingChanges(input: {
  dirtyStatusIDs: readonly string[]
  folderName: string
  listName: string
  workflowName: string
  newStatusName: string
  folders: TaskFolder[]
  folderWorkflows: Record<string, string>
}) {
  if (input.dirtyStatusIDs.length > 0) return true
  if ([input.folderName, input.listName, input.workflowName, input.newStatusName].some(value => value.trim().length > 0)) return true
  return input.folders.some(folder => (input.folderWorkflows[folder.id] || '') !== (folder.workflow_id || ''))
}
