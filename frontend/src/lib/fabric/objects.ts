/**
 * Custom Fabric.js Objects — DynamicText (dynamic field placeholder)
 * Extends fabric.Textbox with isDynamic, fieldName, and visual badge
 */

import { Textbox, classRegistry } from 'fabric'

// ─── DynamicText ──────────────────────────────────────────────────────────────

interface DynamicTextCustomProps {
  isDynamic?: boolean
  fieldName?: string
  elementType?: string
  elementName?: string
  verticalAlign?: string
  lineHeightRatio?: number
  letterSpacingValue?: number
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
  }

  // Render the dynamic badge above the object when it's dynamic
  render(ctx: CanvasRenderingContext2D): void {
    super.render(ctx)
    if (!this.isDynamic || !this.fieldName || !this.canvas) return

    // Only show badge on interactive canvas (skip StaticCanvas used for generation)
    if (!(this.canvas as any).wrapperEl) return
    const zoom = this.canvas.getZoom?.() ?? 1
    if (zoom <= 0) return

    ctx.save()
    const center = this.getCenterPoint()
    const badgeText = `{{${this.fieldName}}}`
    const fontSize = Math.max(9, 11 / zoom)
    ctx.font = `600 ${fontSize}px Inter, Arial, sans-serif`
    const textWidth = ctx.measureText(badgeText).width
    const padding = 4 / zoom
    const badgeW = textWidth + padding * 2
    const badgeH = fontSize + padding * 1.5
    const badgeX = center.x - badgeW / 2
    const badgeY = center.y - (this.getScaledHeight() / 2) - badgeH - 3 / zoom

    // Badge background
    ctx.fillStyle = '#059669'
    ctx.beginPath()
    const r = 3 / zoom
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, r)
    ctx.fill()

    // Badge text
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(badgeText, center.x, badgeY + badgeH / 2)
    ctx.restore()
  }
}

// Register the class with Fabric's class registry
classRegistry.setClass(DynamicText)
classRegistry.setSVGClass(DynamicText)
