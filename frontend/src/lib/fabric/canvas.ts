/**
 * Fabric.js Canvas initialization, zoom, pan, and grid rendering.
 * Uses a pasteboard model: canvas fills viewport, white Rect = "page".
 */

import { Canvas, Rect, Shadow, Point, type FabricObject } from 'fabric'
import { MM_TO_PX, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, GRID_COLOR } from './constants'
import { calculateSnap, calculateDistances, type SnapGuide, type DistanceLabel, type UserGuide } from './snap'

// Store page dimensions on the canvas instance
declare module 'fabric' {
  interface Canvas {
    __pageWidth?: number
    __pageHeight?: number
    __pageRect?: Rect
    __panActive?: boolean
  }
}

export const DEFAULT_PASTEBOARD_COLOR = '#61636b'

// ─── Wheel helpers (reusable by external overlays like user guides) ──────────

/**
 * Apply Ctrl+Wheel zoom-to-cursor on a Fabric canvas.
 * @param x horizontal cursor coord (either canvas-relative offsetX or clientX; see isOffset)
 * @param y vertical cursor coord
 * @param deltaY wheel deltaY
 * @param isOffset when true, x/y are already relative to the canvas element; when false they are clientX/Y and will be translated via wrapperEl.getBoundingClientRect()
 */
export function applyWheelZoom(
  canvas: Canvas,
  x: number,
  y: number,
  deltaY: number,
  onZoomChange?: (zoom: number) => void,
  isOffset: boolean = false,
): number {
  let offX = x
  let offY = y
  if (!isOffset) {
    const wrapper = (canvas as any).wrapperEl as HTMLElement | undefined
    if (wrapper) {
      const rect = wrapper.getBoundingClientRect()
      offX = x - rect.left
      offY = y - rect.top
    }
  }
  let zoom = canvas.getZoom()
  zoom *= 0.999 ** deltaY
  zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom))
  canvas.zoomToPoint(new Point(offX, offY), zoom)
  onZoomChange?.(zoom)
  return zoom
}

/**
 * Apply plain-wheel pan on a Fabric canvas. shiftKey forces horizontal pan from deltaY.
 */
export function applyWheelPan(
  canvas: Canvas,
  deltaX: number,
  deltaY: number,
  shiftKey: boolean = false,
): void {
  const vpt = canvas.viewportTransform!
  if (shiftKey) {
    vpt[4] -= deltaY
  } else {
    vpt[4] -= deltaX
    vpt[5] -= deltaY
  }
  canvas.requestRenderAll()
}

// ─── Canvas Setup ─────────────────────────────────────────────────────────────

export interface CanvasSetupOptions {
  canvasEl: HTMLCanvasElement
  containerEl: HTMLElement
  pageWidth: number   // mm
  pageHeight: number  // mm
  pasteboardColor?: string
  onZoomChange?: (zoom: number) => void
  onSelectionChange?: (objects: FabricObject[]) => void
  onObjectModified?: () => void
  onSnapGuides?: (guides: SnapGuide[]) => void
  onDistanceLabels?: (labels: DistanceLabel[]) => void
  getUserGuides?: () => UserGuide[]
  onPan?: () => void
}

export function createEditorCanvas(opts: CanvasSetupOptions): Canvas {
  const pageW = opts.pageWidth * MM_TO_PX
  const pageH = opts.pageHeight * MM_TO_PX
  const containerW = opts.containerEl.clientWidth
  const containerH = opts.containerEl.clientHeight

  const canvas = new Canvas(opts.canvasEl, {
    width: containerW,
    height: containerH,
    backgroundColor: opts.pasteboardColor || DEFAULT_PASTEBOARD_COLOR,
    selection: true,
    preserveObjectStacking: true,
    stopContextMenu: true,
    fireRightClick: true,
    controlsAboveOverlay: true,
  })

  // Store page dimensions
  canvas.__pageWidth = pageW
  canvas.__pageHeight = pageH

  // Create page rect (white document area)
  const pageRect = new Rect({
    left: 0,
    top: 0,
    width: pageW,
    height: pageH,
    fill: '#ffffff',
    selectable: false,
    evented: false,
    hasControls: false,
    lockMovementX: true,
    lockMovementY: true,
    hoverCursor: 'default',
    excludeFromExport: false,
    shadow: new Shadow({
      color: 'rgba(0,0,0,0.10)',
      blur: 6,
      offsetX: 0,
      offsetY: 4,
    }),
  });
  (pageRect as any).__isPage = true
  canvas.add(pageRect)
  canvas.__pageRect = pageRect

  // ─── Selection events ────────────────────────────────────────────────
  const emitSelection = () => {
    const active = canvas.getActiveObject()
    if (!active) {
      opts.onSelectionChange?.([])
    } else if ('_objects' in active && Array.isArray((active as any)._objects)) {
      opts.onSelectionChange?.((active as any)._objects)
    } else {
      opts.onSelectionChange?.([active])
    }
  }
  canvas.on('selection:created', emitSelection)
  canvas.on('selection:updated', emitSelection)
  canvas.on('selection:cleared', () => {
    opts.onSelectionChange?.([])
    opts.onSnapGuides?.([])
    opts.onDistanceLabels?.([])
  })

  // ─── Object modified ────────────────────────────────────────────────
  canvas.on('object:modified', () => opts.onObjectModified?.())

  // ─── Snap guides during move ────────────────────────────────────────
  canvas.on('object:moving', (e) => {
    const obj = e.target
    if (!obj) return
    const result = calculateSnap(canvas, obj, undefined, opts.getUserGuides?.() || [])
    if (result.x !== undefined) obj.set('left', result.x)
    if (result.y !== undefined) obj.set('top', result.y)
    opts.onSnapGuides?.(result.guides)
    opts.onDistanceLabels?.(calculateDistances(canvas, obj))
  })

  canvas.on('object:modified', () => {
    opts.onSnapGuides?.([])
    opts.onDistanceLabels?.([])
  })

  // Always clear snap guides when the mouse is released (covers drags that
  // don't trigger object:modified, e.g. click-without-moving or ESC cancel).
  canvas.on('mouse:up', () => {
    opts.onSnapGuides?.([])
    opts.onDistanceLabels?.([])
  })

  // ─── Wheel: Ctrl+Wheel → zoom to cursor, plain wheel → pan ────────
  canvas.on('mouse:wheel', (opt) => {
    const e = opt.e as WheelEvent
    e.preventDefault()
    e.stopPropagation()

    if (e.ctrlKey || e.metaKey) {
      applyWheelZoom(canvas, e.offsetX, e.offsetY, e.deltaY, opts.onZoomChange, /*isOffset*/ true)
    } else {
      applyWheelPan(canvas, e.deltaX, e.deltaY, e.shiftKey)
      opts.onPan?.()
    }
  })

  // ─── Pan via Space+drag / Ctrl+drag ────────────────────────────────
  let isPanning = false
  let isMiddlePanning = false
  let panStart = { x: 0, y: 0 }

  canvas.on('mouse:down', (opt) => {
    const e = opt.e as MouseEvent
    if ((e as any).__spacePan) {
      isPanning = true
      panStart = { x: e.clientX, y: e.clientY }
      canvas.selection = false
      canvas.setCursor('grabbing')
      e.preventDefault()
    }
  })

  canvas.on('mouse:move', (opt) => {
    if (!isPanning) return
    const e = opt.e as MouseEvent
    const vpt = canvas.viewportTransform!
    vpt[4] += e.clientX - panStart.x
    vpt[5] += e.clientY - panStart.y
    panStart = { x: e.clientX, y: e.clientY }
    canvas.setViewportTransform(vpt)
    opts.onPan?.()
  })

  canvas.on('mouse:up', () => {
    // Only handle Space+drag pan here, NOT middle mouse
    if (isPanning && !isMiddlePanning) {
      isPanning = false
      if (canvas.__panActive) {
        canvas.setCursor('grab')
      } else {
        canvas.selection = true
        canvas.setCursor('default')
      }
      opts.onPan?.()
    }
  })

  // ─── Middle mouse pan (native events to bypass browser autoscroll) ──
  const upperCanvas = (canvas as any).upperCanvasEl || canvas.getElement()

  const onMiddleDown = (e: MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault()
      isPanning = true
      isMiddlePanning = true
      panStart = { x: e.clientX, y: e.clientY }
      canvas.selection = false
      canvas.setCursor('grabbing')
    }
  }
  const onMiddleUp = (e: MouseEvent) => {
    if (e.button === 1 && isMiddlePanning) {
      isPanning = false
      isMiddlePanning = false
      if (canvas.__panActive) {
        canvas.setCursor('grab')
      } else {
        canvas.selection = true
        canvas.setCursor('default')
      }
      opts.onPan?.()
    }
  }
  upperCanvas.addEventListener('mousedown', onMiddleDown)
  document.addEventListener('mouseup', onMiddleUp)
  // Prevent default autoscroll on middle click
  upperCanvas.addEventListener('auxclick', (e: MouseEvent) => { if (e.button === 1) e.preventDefault() })
  // Prevent native browser context menu on canvas
  upperCanvas.addEventListener('contextmenu', (e: Event) => e.preventDefault())

  // Store cleanup function on canvas for disposal
  ;(canvas as any).__cleanupMiddleMouse = () => {
    upperCanvas.removeEventListener('mousedown', onMiddleDown)
    document.removeEventListener('mouseup', onMiddleUp)
  }

  return canvas
}

// ─── Resize page rect (change document dimensions) ──────────────────────────

export function resizePageRect(canvas: Canvas, widthMm: number, heightMm: number): void {
  const pageW = widthMm * MM_TO_PX
  const pageH = heightMm * MM_TO_PX
  canvas.__pageWidth = pageW
  canvas.__pageHeight = pageH
  const pageRect = canvas.__pageRect
  if (pageRect) {
    pageRect.set({ width: pageW, height: pageH })
    pageRect.setCoords()
  }
  canvas.requestRenderAll()
}

// ─── Resize canvas to fit container ──────────────────────────────────────────

export function resizeCanvas(canvas: Canvas, containerEl: HTMLElement): void {
  canvas.setDimensions({
    width: containerEl.clientWidth,
    height: containerEl.clientHeight,
  })
  // Recalculate canvas offset for correct pointer mapping
  if (typeof (canvas as any).calcOffset === 'function') {
    (canvas as any).calcOffset()
  }
}

// ─── Get page objects (filter out __isPage rect) ─────────────────────────────

export function getPageObjects(canvas: Canvas): FabricObject[] {
  return canvas.getObjects().filter(o => !(o as any).__isPage)
}

// ─── Ensure page rect stays at bottom ────────────────────────────────────────

export function ensurePageAtBottom(canvas: Canvas): void {
  const pageRect = canvas.__pageRect
  if (pageRect) {
    canvas.sendObjectToBack(pageRect)
  }
}

// ─── Grid Rendering ───────────────────────────────────────────────────────────

export function renderGrid(
  canvas: Canvas,
  gridSize: number,
  show: boolean
): void {
  if (!show) {
    canvas.renderAll()
    return
  }
  canvas.renderAll()
}

/**
 * Draw grid dots on a canvas context (called from afterRender).
 * Only draws within the page area.
 */
export function drawGridDots(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  gridSize: number,
  zoom: number,
  vptX: number,
  vptY: number,
  pageW?: number,
  pageH?: number,
): void {
  const docW = pageW || canvasWidth
  const docH = pageH || canvasHeight

  ctx.save()
  ctx.fillStyle = GRID_COLOR
  ctx.globalAlpha = 0.4

  const startX = Math.max(0, Math.floor(-vptX / zoom / gridSize) * gridSize)
  const startY = Math.max(0, Math.floor(-vptY / zoom / gridSize) * gridSize)
  const endX = Math.min(docW, startX + canvasWidth / zoom + gridSize)
  const endY = Math.min(docH, startY + canvasHeight / zoom + gridSize)

  const dotSize = Math.max(0.5, 1 / zoom)

  for (let x = startX; x <= endX; x += gridSize) {
    for (let y = startY; y <= endY; y += gridSize) {
      const sx = x * zoom + vptX
      const sy = y * zoom + vptY
      ctx.beginPath()
      ctx.arc(sx, sy, dotSize, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.restore()
}

// ─── Zoom Helpers ─────────────────────────────────────────────────────────────

export function zoomIn(canvas: Canvas, step = ZOOM_STEP): number {
  const oldZoom = canvas.getZoom()
  const newZoom = Math.min(ZOOM_MAX, oldZoom + step)
  _zoomToViewportCenter(canvas, oldZoom, newZoom)
  return newZoom
}

export function zoomOut(canvas: Canvas, step = ZOOM_STEP): number {
  const oldZoom = canvas.getZoom()
  const newZoom = Math.max(ZOOM_MIN, oldZoom - step)
  _zoomToViewportCenter(canvas, oldZoom, newZoom)
  return newZoom
}

function _zoomToViewportCenter(canvas: Canvas, oldZoom: number, newZoom: number): void {
  const vpt = canvas.viewportTransform!
  // Calculate the scene point at the center of the viewport
  const viewCenterX = (canvas.getWidth() / 2 - vpt[4]) / oldZoom
  const viewCenterY = (canvas.getHeight() / 2 - vpt[5]) / oldZoom
  canvas.zoomToPoint(new Point(viewCenterX, viewCenterY), newZoom)
}

export function zoomToFit(canvas: Canvas, padding = 40): number {
  const canvasW = canvas.getWidth()
  const canvasH = canvas.getHeight()
  const pageW = canvas.__pageWidth || canvasW
  const pageH = canvas.__pageHeight || canvasH

  const availW = canvasW - padding * 2
  const availH = canvasH - padding * 2
  const zoom = Math.min(availW / pageW, availH / pageH, 2)

  // Reset transform and zoom
  canvas.setViewportTransform([1, 0, 0, 1, 0, 0])
  const pageCenterX = pageW / 2
  const pageCenterY = pageH / 2
  canvas.zoomToPoint(new Point(pageCenterX, pageCenterY), zoom)

  // Center the page in the viewport
  const vpt = canvas.viewportTransform!
  vpt[4] = (canvasW - pageW * zoom) / 2
  vpt[5] = (canvasH - pageH * zoom) / 2
  canvas.requestRenderAll()

  return zoom
}

export function setPasteboardColor(canvas: Canvas, color: string): void {
  canvas.backgroundColor = color
  canvas.requestRenderAll()
}
