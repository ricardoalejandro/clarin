import { describe, expect, it } from 'vitest'
import { OPERATIONAL_OVERLAY_LAYERS } from './OperationalOverlayContext'

describe('operational overlay layers', () => {
  it('keeps pickers and dialogs above menus in a deterministic order', () => {
    expect([
      OPERATIONAL_OVERLAY_LAYERS.popover,
      OPERATIONAL_OVERLAY_LAYERS.menu,
      OPERATIONAL_OVERLAY_LAYERS.picker,
      OPERATIONAL_OVERLAY_LAYERS.sheet,
      OPERATIONAL_OVERLAY_LAYERS.dialog,
      OPERATIONAL_OVERLAY_LAYERS.confirmation,
    ]).toEqual([10, 20, 30, 40, 50, 60])
  })
})
