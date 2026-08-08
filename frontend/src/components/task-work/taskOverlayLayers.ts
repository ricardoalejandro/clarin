import { OPERATIONAL_OVERLAY_LAYERS, operationalOverlayIsAbove } from '../operational-overlay/operationalOverlayLayers'

export const TASK_OVERLAY_LAYERS = OPERATIONAL_OVERLAY_LAYERS

export function taskOverlayIsAbove(layer: keyof typeof TASK_OVERLAY_LAYERS, owner: keyof typeof TASK_OVERLAY_LAYERS) {
  return operationalOverlayIsAbove(layer, owner)
}
