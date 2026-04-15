/**
 * Fabric.js Serialization Helpers
 * Convert between our domain model and Fabric.js canvas JSON.
 */

import {
  Canvas, StaticCanvas, Rect, Ellipse, Line, FabricImage,
  Shadow, type FabricObject,
} from 'fabric'
import { DynamicText } from './objects'
import { CUSTOM_PROPS, MM_TO_PX, DYNAMIC_COLOR, GOOGLE_FONTS_URL } from './constants'

// ─── Types ────────────────────────────────────────────────────────────────────

interface CanvasBackground {
  color: string
  imageUrl?: string
}

interface TemplateData {
  version: number
  fabricJson?: Record<string, unknown>
  objects: Record<string, unknown>[]
  background: CanvasBackground
}

// ─── Font Loading ─────────────────────────────────────────────────────────────

let fontsLoaded = false

export async function ensureFontsLoaded(): Promise<void> {
  if (typeof document === 'undefined') return
  if (fontsLoaded) {
    await document.fonts.ready
    return
  }
  const existing = document.querySelector(`link[href*="fonts.googleapis.com"]`)
  if (!existing) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = GOOGLE_FONTS_URL
    document.head.appendChild(link)
  }
  await document.fonts.ready
  fontsLoaded = true
}

// ─── Save: Canvas → JSON for backend ─────────────────────────────────────────

export function canvasToTemplateJson(
  canvas: Canvas,
  background: CanvasBackground
): Record<string, unknown> {
  const fabricJson = canvas.toObject(CUSTOM_PROPS)
  // Filter out the __isPage rect (pasteboard page background)
  if (fabricJson.objects && Array.isArray(fabricJson.objects)) {
    fabricJson.objects = fabricJson.objects.filter((o: any) => !o.__isPage)
  }
  return {
    version: 3,
    fabricJson,
    background,
  }
}

// ─── Load: Backend JSON → Canvas ──────────────────────────────────────────────

export async function loadTemplateToCanvas(
  canvas: Canvas | StaticCanvas,
  canvasJson: Record<string, unknown>,
  pageWidth: number,
  pageHeight: number
): Promise<CanvasBackground> {
  const data = canvasJson as unknown as TemplateData

  // Version 3 = Fabric.js format
  if (data.version === 3 && data.fabricJson) {
    await canvas.loadFromJSON(data.fabricJson)
    canvas.renderAll()
    return data.background || { color: '#ffffff' }
  }

  // Version 2 or legacy = old DOM-based format, convert
  return await migrateV2ToFabric(canvas, canvasJson, pageWidth, pageHeight)
}

// ─── Migration: V2 (old DOM editor) → Fabric objects ─────────────────────────

interface LegacyElement {
  id: string
  type: string
  x: number; y: number; width: number; height: number
  rotation?: number
  content?: string
  fontSize?: number; fontFamily?: string; fontWeight?: string; fontStyle?: string
  textAlign?: string; textDecoration?: string; lineHeight?: number
  letterSpacing?: number; verticalAlign?: string; color?: string
  fill?: string; stroke?: string; strokeWidth?: number
  opacity?: number; borderRadius?: number; src?: string
  isDynamic?: boolean; fieldName?: string
  visible?: boolean; locked?: boolean; name?: string
  shadow?: { offsetX: number; offsetY: number; blur: number; spread: number; color: string }
  groupId?: string
}

async function migrateV2ToFabric(
  canvas: Canvas | StaticCanvas,
  canvasJson: Record<string, unknown>,
  _pageWidth: number,
  _pageHeight: number
): Promise<CanvasBackground> {
  const cj = canvasJson as any
  const elements: LegacyElement[] = cj?.elements || []
  const bg: CanvasBackground = cj?.background || { color: '#ffffff' }

  canvas.clear()

  for (const el of elements) {
    if (el.visible === false) continue
    const obj = await legacyElementToFabric(el)
    if (obj) {
      canvas.add(obj)
    }
  }

  canvas.renderAll()
  return bg
}

async function legacyElementToFabric(el: LegacyElement): Promise<FabricObject | null> {
  const commonOpts = {
    left: el.x,
    top: el.y,
    width: el.width,
    height: el.height,
    angle: el.rotation || 0,
    opacity: el.opacity ?? 1,
    visible: el.visible !== false,
    lockMovementX: el.locked || false,
    lockMovementY: el.locked || false,
    selectable: !el.locked,
    hasControls: !el.locked,
    shadow: el.shadow ? new Shadow({
      offsetX: el.shadow.offsetX,
      offsetY: el.shadow.offsetY,
      blur: el.shadow.blur,
      color: el.shadow.color,
    }) : undefined,
  }

  switch (el.type) {
    case 'text': {
      const text = new DynamicText(el.content || '', {
        ...commonOpts,
        fontSize: el.fontSize || 16,
        fontFamily: el.fontFamily || 'Arial',
        fontWeight: (el.fontWeight || 'normal') as any,
        fontStyle: (el.fontStyle || 'normal') as any,
        textAlign: el.textAlign || 'left',
        underline: el.textDecoration === 'underline',
        lineHeight: el.lineHeight || 1.2,
        fill: el.color || '#000000',
        isDynamic: el.isDynamic || false,
        fieldName: el.fieldName || '',
        elementType: 'text',
        elementName: el.name || '',
        verticalAlign: el.verticalAlign || 'top',
        lineHeightRatio: el.lineHeight || 1.2,
        letterSpacingValue: el.letterSpacing || 0,
        splitByGrapheme: true,
      })
      if (el.letterSpacing) {
        text.charSpacing = el.letterSpacing * 1000 / (el.fontSize || 16)
      }
      return text
    }

    case 'rect': {
      return new Rect({
        ...commonOpts,
        fill: el.fill || 'transparent',
        stroke: el.stroke || '',
        strokeWidth: el.strokeWidth || 0,
        rx: el.borderRadius || 0,
        ry: el.borderRadius || 0,
      })
    }

    case 'circle': {
      return new Ellipse({
        ...commonOpts,
        rx: el.width / 2,
        ry: el.height / 2,
        fill: el.fill || 'transparent',
        stroke: el.stroke || '',
        strokeWidth: el.strokeWidth || 0,
      })
    }

    case 'line': {
      const strokeW = el.strokeWidth || 2
      return new Line([0, 0, el.width, 0], {
        ...commonOpts,
        stroke: el.stroke || '#000000',
        strokeWidth: strokeW,
      })
    }

    case 'image': {
      if (!el.src) return null
      try {
        const img = await FabricImage.fromURL(el.src, { crossOrigin: 'anonymous' })
        img.set({
          ...commonOpts,
          scaleX: el.width / (img.width || el.width),
          scaleY: el.height / (img.height || el.height),
        })
        return img
      } catch {
        return null
      }
    }

    default:
      return null
  }
}

// ─── Extract fields used from canvas ──────────────────────────────────────────

export function extractFieldsUsed(canvas: Canvas): string[] {
  const fields = new Set<string>()
  for (const obj of canvas.getObjects()) {
    const o = obj as any
    if (o.__isPage) continue
    if ((obj instanceof DynamicText || o.isDynamic) && o.fieldName) {
      fields.add(o.fieldName)
    }
    // Recurse into groups
    if (o._objects && Array.isArray(o._objects)) {
      for (const child of o._objects) {
        if ((child.isDynamic || child instanceof DynamicText) && child.fieldName) {
          fields.add(child.fieldName)
        }
      }
    }
  }
  return Array.from(fields)
}
