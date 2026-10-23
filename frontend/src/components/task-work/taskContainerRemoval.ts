import type { TaskHierarchyCounts } from './taskHierarchyCounts'

export type TaskContainerRemovalMode = 'trash_all' | 'preserve_contents'
export type TaskContainerRemovalType = 'list' | 'folder'
export interface TaskContainerRemovalCounts {
  lists: number
  tasks: number
  subtasks: number
  open_tasks: number
  completed_tasks: number
  cancelled_tasks: number
  events: number
  whiteboards: number
}
export interface TaskContainerRemovalPreview {
  type: TaskContainerRemovalType
  id: string
  name: string
  environment_id: string
  lifecycle: string
  mode: TaskContainerRemovalMode
  destination_list_id?: string
  preview_token: string
  counts: TaskContainerRemovalCounts
  requires_name: boolean
  requires_destination?: boolean
  requires_event_cancellation: boolean
  requires_access_confirmation: boolean
  can_execute: boolean
  blockers: string[]
  access_change_summary?: string
}
export interface TaskContainerRemovalDestination {
  id: string
  name: string
  environment_id: string
  icon?: string
  color?: string
  lifecycle: string
  folder_name?: string
}
export interface TaskContainerRemovalResponse {
  preview?: TaskContainerRemovalPreview
  code?: string
  operation_id?: string
  result?: { type: TaskContainerRemovalType; id: string; environment_id: string; action: 'trashed'; mode: TaskContainerRemovalMode }
  hierarchy_counts?: TaskHierarchyCounts
}
export interface TaskContainerRemovalDraft {
  mode: TaskContainerRemovalMode
  destinationListID: string
  confirmationName: string
  cancelFutureEvents: boolean
  confirmAccessChanges: boolean
}

export function taskContainerRemovalEndpoint(type: TaskContainerRemovalType, id: string) {
  return `/api/tasks/${type === 'folder' ? 'folders' : 'lists'}/${encodeURIComponent(id)}`
}

export function taskContainerRemovalPreparation(draft: Pick<TaskContainerRemovalDraft, 'mode' | 'destinationListID'>) {
  return {
    mode: draft.mode,
    ...(draft.mode === 'preserve_contents' && draft.destinationListID ? { destination_list_id: draft.destinationListID } : {}),
  }
}

export function taskContainerRemovalPreviewMatches(preview: TaskContainerRemovalPreview | null, type: TaskContainerRemovalType, id: string, draft: TaskContainerRemovalDraft) {
  return Boolean(preview && preview.type === type && preview.id === id && preview.mode === draft.mode &&
    (preview.destination_list_id || '') === (draft.mode === 'preserve_contents' ? draft.destinationListID : ''))
}

export function canConfirmTaskContainerRemoval(preview: TaskContainerRemovalPreview | null, draft: TaskContainerRemovalDraft) {
  return Boolean(preview?.can_execute && preview.preview_token && !preview.blockers?.length &&
    (!preview.requires_name || draft.confirmationName === preview.name) &&
    (!preview.requires_destination || draft.destinationListID) &&
    (!preview.requires_event_cancellation || draft.cancelFutureEvents) &&
    (!preview.requires_access_confirmation || draft.confirmAccessChanges))
}

export function taskContainerRemovalPayload(preview: TaskContainerRemovalPreview, draft: TaskContainerRemovalDraft, operationID: string) {
  return {
    ...taskContainerRemovalPreparation(draft),
    preview_token: preview.preview_token,
    confirmation_name: draft.confirmationName,
    cancel_future_events: preview.requires_event_cancellation && draft.cancelFutureEvents,
    confirm_access_changes: preview.requires_access_confirmation && draft.confirmAccessChanges,
    operation_id: operationID,
  }
}

export function taskContainerRemovalInventory(counts: TaskContainerRemovalCounts) {
  return [
    { label: 'Listas', count: counts.lists },
    { label: 'Tareas', count: counts.tasks },
    { label: 'Subtareas', count: counts.subtasks },
    { label: 'Eventos de calendario', count: counts.events },
    { label: 'Pizarras', count: counts.whiteboards },
  ]
}

export function taskRemovalInvalidatesMountedScope(action: string, status: number | undefined, current: { type: string; id?: string }, requested: { type: string; id?: string }) {
  return (action === 'container_removed' || action === 'container_restored') && status === 404 &&
    (requested.type === 'folder' || requested.type === 'list') && current.type === requested.type && current.id === requested.id
}

/** A superseded read is neutral; an actual failed read must keep the saved-operation recovery surface open. */
export function taskRemovalRefreshResult(...results: Array<boolean | undefined>): boolean | undefined {
  if (results.some(result => result === false)) return false
  return results.every(result => result === true) ? true : undefined
}
