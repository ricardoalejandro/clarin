import { describe, expect, it } from 'vitest'
import { TASK_OVERLAY_LAYERS, taskOverlayIsAbove } from './taskOverlayLayers'

describe('Clarin Work overlay contract', () => {
  it('keeps workspace menus above cards and below task windows', () => {
    expect(TASK_OVERLAY_LAYERS.workspacePopover).toBeLessThan(TASK_OVERLAY_LAYERS.window)
    expect(TASK_OVERLAY_LAYERS.workspacePopover).toBeGreaterThan(50)
  })

  it('keeps pickers above every task window and composer', () => {
    expect(taskOverlayIsAbove('pickerBackdrop', 'dialog')).toBe(true)
    expect(taskOverlayIsAbove('picker', 'pickerBackdrop')).toBe(true)
    expect(taskOverlayIsAbove('picker', 'window')).toBe(true)
  })

  it('keeps drag feedback and notifications above transient controls', () => {
    expect(TASK_OVERLAY_LAYERS.dragOverlay).toBeGreaterThan(TASK_OVERLAY_LAYERS.picker)
    expect(TASK_OVERLAY_LAYERS.toast).toBeGreaterThan(TASK_OVERLAY_LAYERS.dragOverlay)
  })
})
