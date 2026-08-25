export const TASK_PICKER_BLOCKING_LAYER_SELECTOR = [
  '[data-task-property-picker-portal]',
  '[data-task-select-picker-portal]',
  '[data-task-user-combobox-portal]',
  '[data-task-picker-backdrop]',
  '[data-task-date-range-picker]',
  '[data-task-date-range-backdrop]',
].join(',')

export const TASK_DETAIL_ESCAPE_LAYER_SELECTOR = [
  '[data-task-editor-modal]',
  '[data-task-structure-modal]',
  TASK_PICKER_BLOCKING_LAYER_SELECTOR,
  '[data-task-destructive-dialog]',
  '[data-task-move-environment-dialog]',
  '[data-task-participant-grant-dialog]',
  '[data-task-attachment-viewer]',
].join(',')

export type TaskDetailEscapeResolution = 'defer' | 'parent' | 'close'

export function resolveTaskDetailEscape(hasBlockingLayer: boolean, parentTaskID?: string | null): TaskDetailEscapeResolution {
  if (hasBlockingLayer) return 'defer'
  return parentTaskID ? 'parent' : 'close'
}
