/**
 * Custom Fabric.js Objects — DynamicText (dynamic field placeholder)
 * Extends fabric.Textbox with isDynamic, fieldName, and visual badge
 */

import { Textbox, classRegistry } from 'fabric'
import type { FieldFormat } from '../dynamicFieldFormat'

// ─── DynamicText ──────────────────────────────────────────────────────────────

interface DynamicTextCustomProps {
  isDynamic?: boolean
  fieldName?: string
  elementType?: string
  elementName?: string
  verticalAlign?: string
  lineHeightRatio?: number
  letterSpacingValue?: number
  fieldFormat?: FieldFormat
}

export class DynamicText extends Textbox {
  static type = 'DynamicText'

  declare isDynamic: boolean
  declare fieldName: string
  declare elementType: string
  declare elementName: string
  declare verticalAlign: string
  declare lineHeightRatio: number
  declare letterSpacingValue: number
  declare fieldFormat?: FieldFormat

  constructor(text: string, options?: Record<string, any>) {
    super(text, options as any)
    const opts = (options ?? {}) as DynamicTextCustomProps
    this.isDynamic = opts.isDynamic ?? false
    this.fieldName = opts.fieldName ?? ''
    this.elementType = opts.elementType ?? 'text'
    this.elementName = opts.elementName ?? ''
    this.verticalAlign = opts.verticalAlign ?? 'top'
    this.lineHeightRatio = opts.lineHeightRatio ?? 1.2
    this.letterSpacingValue = opts.letterSpacingValue ?? 0
    this.fieldFormat = opts.fieldFormat
  }

  // In the editor, render dynamic fields with an emerald fill so they stand
  // out as placeholders without adding any extra decorations. Original fill is
  // preserved (restored after render), so export/preview uses the real color.
  render(ctx: CanvasRenderingContext2D): void {
    const isEditor = !!(this.canvas as any)?.wrapperEl
    const hide = !!(this.canvas as any)?.__hideDynamicMarkers
    if (this.isDynamic && this.fieldName && isEditor && !hide) {
      const origFill = this.fill
      this.fill = '#059669' // emerald-600
      super.render(ctx)
      this.fill = origFill
      return
    }
    super.render(ctx)
  }
}

// Register the class with Fabric's class registry
classRegistry.setClass(DynamicText)
classRegistry.setSVGClass(DynamicText)
