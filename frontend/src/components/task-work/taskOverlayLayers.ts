export const TASK_OVERLAY_LAYERS = {
  workspacePopover: 100,
  window: 120,
  dialog: 145,
  confirmation: 170,
  pickerBackdrop: 179,
  picker: 180,
  dragGhost: 190,
  dragOverlay: 200,
  toast: 220,
} as const

export function taskOverlayIsAbove(layer: keyof typeof TASK_OVERLAY_LAYERS, owner: keyof typeof TASK_OVERLAY_LAYERS) {
  return TASK_OVERLAY_LAYERS[layer] > TASK_OVERLAY_LAYERS[owner]
}
