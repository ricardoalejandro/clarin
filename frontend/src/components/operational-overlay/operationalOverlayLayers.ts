export const OPERATIONAL_OVERLAY_LAYERS = {
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

export type OperationalOverlayLayer = keyof typeof OPERATIONAL_OVERLAY_LAYERS

export function operationalOverlayIsAbove(layer: OperationalOverlayLayer, owner: OperationalOverlayLayer) {
  return OPERATIONAL_OVERLAY_LAYERS[layer] > OPERATIONAL_OVERLAY_LAYERS[owner]
}
