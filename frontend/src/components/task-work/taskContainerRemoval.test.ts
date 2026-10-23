import { describe, expect, it } from 'vitest'
import { canConfirmTaskContainerRemoval, taskContainerRemovalInventory, taskContainerRemovalPayload, taskContainerRemovalPreparation, taskContainerRemovalPreviewMatches, taskRemovalInvalidatesMountedScope, taskRemovalRefreshResult, type TaskContainerRemovalDraft, type TaskContainerRemovalPreview } from './taskContainerRemoval'

export const emptyRemovalCounts = { lists: 0, tasks: 0, subtasks: 0, open_tasks: 0, completed_tasks: 0, cancelled_tasks: 0, events: 0, whiteboards: 0 }
export const removalPreview = (overrides: Partial<TaskContainerRemovalPreview> = {}): TaskContainerRemovalPreview => ({ type: 'list', id: 'list-1', name: 'Proyecto', environment_id: 'env-1', lifecycle: 'active', mode: 'trash_all', preview_token: 'preview-1', counts: emptyRemovalCounts, requires_name: false, requires_destination: false, requires_event_cancellation: false, requires_access_confirmation: false, can_execute: true, blockers: [], ...overrides })
const draft: TaskContainerRemovalDraft = { mode: 'trash_all', destinationListID: '', confirmationName: '', cancelFutureEvents: false, confirmAccessChanges: false }

describe('container removal preparation and confirmation', () => {
  it('omits a previously selected destination when removing everything', () => {
    expect(taskContainerRemovalPreparation({ mode: 'trash_all', destinationListID: 'old' })).toEqual({ mode: 'trash_all' })
  })
  it('accepts a simple empty confirmation but gates each server requirement independently', () => {
    expect(canConfirmTaskContainerRemoval(removalPreview(), draft)).toBe(true)
    expect(canConfirmTaskContainerRemoval(removalPreview({ requires_name: true }), draft)).toBe(false)
    expect(canConfirmTaskContainerRemoval(removalPreview({ requires_name: true }), { ...draft, confirmationName: 'Proyecto' })).toBe(true)
    expect(canConfirmTaskContainerRemoval(removalPreview({ requires_name: true }), { ...draft, confirmationName: ' Proyecto ' })).toBe(false)
    for (const requirement of ['requires_destination', 'requires_event_cancellation', 'requires_access_confirmation'] as const) {
      expect(canConfirmTaskContainerRemoval(removalPreview({ [requirement]: true }), draft)).toBe(false)
    }
    expect(canConfirmTaskContainerRemoval(removalPreview({ can_execute: false }), draft)).toBe(false)
    expect(canConfirmTaskContainerRemoval(removalPreview({ blockers: ['Sin autorización'] }), draft)).toBe(false)
  })
  it('rejects stale previews across target, option and destination changes before effects run', () => {
    const preview = removalPreview()
    expect(taskContainerRemovalPreviewMatches(preview, 'list', 'list-1', draft)).toBe(true)
    expect(taskContainerRemovalPreviewMatches(preview, 'folder', 'list-1', draft)).toBe(false)
    expect(taskContainerRemovalPreviewMatches(preview, 'list', 'list-2', draft)).toBe(false)
    expect(taskContainerRemovalPreviewMatches(preview, 'list', 'list-1', { ...draft, mode: 'preserve_contents' })).toBe(false)
    expect(taskContainerRemovalPreviewMatches(removalPreview({ mode: 'preserve_contents', destination_list_id: 'a' }), 'list', 'list-1', { ...draft, mode: 'preserve_contents', destinationListID: 'b' })).toBe(false)
  })
  it('constructs exactly one confirmed write without carrying obsolete checkbox grants', () => {
    expect(taskContainerRemovalPayload(removalPreview(), { ...draft, cancelFutureEvents: true, confirmAccessChanges: true }, 'operation-1')).toEqual({ mode: 'trash_all', preview_token: 'preview-1', confirmation_name: '', cancel_future_events: false, confirm_access_changes: false, operation_id: 'operation-1' })
  })
  it('keeps root tasks and subtasks separate in the inventory', () => {
    expect(taskContainerRemovalInventory({ ...emptyRemovalCounts, tasks: 7, subtasks: 11 })).toContainEqual({ label: 'Tareas', count: 7 })
    expect(taskContainerRemovalInventory({ ...emptyRemovalCounts, tasks: 7, subtasks: 11 })).toContainEqual({ label: 'Subtareas', count: 11 })
  })
  it('invalidates a remotely removed mounted scope only after its canonical 404, never for missing pagination or access-governance 403', () => {
    const source = { type: 'list', id: 'list-1' }
    expect(taskRemovalInvalidatesMountedScope('container_removed', 404, source, source)).toBe(true)
    expect(taskRemovalInvalidatesMountedScope('container_removed', undefined, source, source)).toBe(false)
    expect(taskRemovalInvalidatesMountedScope('container_removed', 403, source, source)).toBe(false)
    expect(taskRemovalInvalidatesMountedScope('container_removed', 200, source, source)).toBe(false)
    expect(taskRemovalInvalidatesMountedScope('container_removed', 404, { type: 'list', id: 'other' }, source)).toBe(false)
  })
  it('keeps saved-operation recovery open after any real refresh failure without treating superseded reads as failures', () => {
    expect(taskRemovalRefreshResult(true, false)).toBe(false)
    expect(taskRemovalRefreshResult(false, undefined)).toBe(false)
    expect(taskRemovalRefreshResult(true, undefined)).toBeUndefined()
    expect(taskRemovalRefreshResult(true, true)).toBe(true)
  })
})
