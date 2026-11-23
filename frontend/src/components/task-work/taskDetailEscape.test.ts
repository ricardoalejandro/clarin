import { describe, expect, it } from 'vitest'
import { resolveTaskDetailEscape, TASK_DETAIL_ESCAPE_LAYER_SELECTOR, TASK_PICKER_BLOCKING_LAYER_SELECTOR } from './taskDetailEscape'

describe('resolveTaskDetailEscape', () => {
  it('lets the topmost picker, editor, confirmation or viewer handle Escape first', () => {
    expect(resolveTaskDetailEscape(true, 'parent-1')).toBe('defer')
    expect(resolveTaskDetailEscape(true, null)).toBe('defer')
    expect(TASK_PICKER_BLOCKING_LAYER_SELECTOR).toContain('[data-task-date-range-picker]')
    expect(TASK_DETAIL_ESCAPE_LAYER_SELECTOR).toContain('[data-task-date-range-backdrop]')
    expect(TASK_PICKER_BLOCKING_LAYER_SELECTOR).toContain('[data-operational-date-picker]')
    expect(TASK_PICKER_BLOCKING_LAYER_SELECTOR).toContain('[data-operational-picker-backdrop]')
    expect(TASK_PICKER_BLOCKING_LAYER_SELECTOR).not.toContain('[data-task-date-range-field]')
  })

  it('returns from a subtask to its parent before closing the task window', () => {
    expect(resolveTaskDetailEscape(false, 'parent-1')).toBe('parent')
    expect(resolveTaskDetailEscape(false, null)).toBe('close')
  })
})
