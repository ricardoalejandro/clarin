import { createCanvas, loadImage, type Canvas as NativeCanvas } from '@napi-rs/canvas'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Canvas, Gradient, Rect, StaticCanvas, Textbox } from './runtime'
import { DynamicText } from './objects'
import { loadTemplateToCanvas, canvasToTemplateJson } from './serialization'
import { exportCanvasToBlob } from './export'
import { CanvasHistory } from './history'

// Keep Fabric's real browser classes, serializers and rendering code. JSDOM
// supplies the DOM; the installed native canvas supplies actual raster pixels.
const canvases: StaticCanvas[] = []

beforeEach(() => {
  const surfaces = new WeakMap<HTMLCanvasElement, NativeCanvas>()
  for (const dimension of ['width', 'height'] as const) {
    const original = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dimension)!
    vi.spyOn(HTMLCanvasElement.prototype, dimension, 'set').mockImplementation(function (this: HTMLCanvasElement, value: number) {
      original.set!.call(this, value)
      const surface = surfaces.get(this)
      if (surface) surface[dimension] = this[dimension]
    })
  }
  const surfaceFor = (element: HTMLCanvasElement) => {
    let surface = surfaces.get(element)
    if (!surface) {
      surface = createCanvas(element.width, element.height)
      surfaces.set(element, surface)
    }
    if (surface.width !== element.width) surface.width = element.width
    if (surface.height !== element.height) surface.height = element.height
    return surface
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null
    const context = surfaceFor(this).getContext('2d')
    return new Proxy(context, {
      get(target, property) {
        if (property === 'drawImage') {
          return (image: unknown, ...args: number[]) => {
            const source = image instanceof HTMLCanvasElement ? surfaceFor(image) : image
            return Reflect.apply(target.drawImage, target, [source, ...args])
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
      set(target, property, value) {
        return Reflect.set(target, property, value, target)
      },
    }) as unknown as CanvasRenderingContext2D
  } as typeof HTMLCanvasElement.prototype.getContext)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (this: HTMLCanvasElement, type?: string, quality?: number) {
    const surface = surfaceFor(this)
    return type === 'image/jpeg' ? surface.toDataURL('image/jpeg', quality) : surface.toDataURL('image/png')
  })
})

afterEach(async () => {
  for (const canvas of canvases.splice(0)) await canvas.dispose()
})

function makeCanvas() {
  const canvas = new StaticCanvas(document.createElement('canvas'), {
    width: 100,
    height: 80,
    enableRetinaScaling: false,
    renderOnAddRemove: false,
  })
  canvases.push(canvas)
  return canvas
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

describe('Fabric 6 compatibility on the patched Fabric runtime', () => {
  it('preserves the linear and radial restore overloads', async () => {
    const linear: Gradient<'linear'> = await Gradient.fromObject({ type: 'linear', coords: { x1: 0, y1: 0, x2: 20, y2: 0 } })
    const radial: Gradient<'radial'> = await Gradient.fromObject({ type: 'radial', coords: { x1: 0, y1: 0, r1: 0, x2: 10, y2: 10, r2: 20 } })
    expect(linear.type).toBe('linear')
    expect(radial.type).toBe('radial')
    expect(radial.coords.r2).toBe(20)
  })

  it('does not wrap gradient deserialization again when the facade is reloaded', async () => {
    const restore = Gradient.fromObject
    vi.resetModules()
    const reloaded = await import('./runtime')
    expect(reloaded.Gradient.fromObject).toBe(restore)
  })

  it('matches the exact upstream gradient compatibility adapter for every alpha mode', async () => {
    const sourcePath = resolve(process.cwd(), 'node_modules/fabric/dist-extensions/data_updaters/gradient/index.mjs')
    const { gradientUpdaterWrapper } = await import(/* @vite-ignore */ sourcePath)
    const source = {
      type: 'linear' as const,
      colorStops: [
        { offset: 0, color: 'red' },
        { offset: 0.2, color: 'red', opacity: 0 },
        { offset: 0.4, color: 'red', opacity: 0.25 },
        { offset: 0.6, color: 'red', opacity: 1 },
        { offset: 0.8, color: 'rgba(0,0,255,0.5)' },
        { offset: 1, color: 'rgba(0,255,0,0.5)', opacity: 1 },
      ],
    }
    const expected = await gradientUpdaterWrapper(async (options: unknown) => options)(source)
    expect((await Gradient.fromObject(source)).colorStops).toEqual(expected.colorStops)
  })

  it('preserves the origin for newly created document and status objects', () => {
    for (const object of [
      new Rect({ left: 20, top: 30, width: 40, height: 20, strokeWidth: 0 }),
      new Textbox('Estado', { left: 20, top: 30, width: 60 }),
      new DynamicText('Nombre', { left: 20, top: 30, width: 60, fieldName: 'name', isDynamic: true }),
    ]) {
      expect(object.originX).toBe('left')
      expect(object.originY).toBe('top')
      expect(object.getBoundingRect().left).toBeCloseTo(20)
      expect(object.getBoundingRect().top).toBeCloseTo(30)
    }
  })

  it('keeps default gestures and preserves explicit editor options', () => {
    const defaults = new Canvas(document.createElement('canvas'))
    const editor = new Canvas(document.createElement('canvas'), {
      fireRightClick: true,
      stopContextMenu: true,
      preserveObjectStacking: true,
    })
    canvases.push(defaults, editor)
    expect(defaults.fireMiddleClick).toBe(false)
    expect(defaults.fireRightClick).toBe(false)
    expect(defaults.stopContextMenu).toBe(false)
    expect(defaults.preserveObjectStacking).toBe(false)
    expect(editor.fireMiddleClick).toBe(false)
    expect(editor.fireRightClick).toBe(true)
    expect(editor.stopContextMenu).toBe(true)
    expect(editor.preserveObjectStacking).toBe(true)
  })

  it('restores legacy JSON with omitted defaults without moving objects or changing the source', async () => {
    const canvas = makeCanvas()
    const template = {
      version: 3,
      background: { color: '#ffffff' },
      fabricJson: {
        version: '6.9.1',
        objects: [{ type: 'Rect', left: 20, top: 10, width: 30, height: 40, strokeWidth: 0 }],
      },
    }
    const original = JSON.stringify(template)
    await loadTemplateToCanvas(canvas, template, 50, 40)
    expect(canvas.getObjects()[0].getBoundingRect()).toMatchObject({ left: 20, top: 10, width: 30, height: 40 })
    expect(JSON.stringify(template)).toBe(original)
    const saved = canvas.toObject()
    await canvas.loadFromJSON(saved)
    expect(canvas.getObjects()[0].getBoundingRect()).toMatchObject({ left: 20, top: 10, width: 30, height: 40 })
  })

  it('preserves an explicitly centered origin through load and save', async () => {
    const canvas = makeCanvas()
    await canvas.loadFromJSON({
      version: '6.9.1',
      objects: [{ type: 'Rect', originX: 'center', originY: 'center', left: 50, top: 40, width: 20, height: 10, strokeWidth: 0 }],
    })
    const object = canvas.getObjects()[0]
    expect(object.getBoundingRect()).toMatchObject({ left: 40, top: 35, width: 20, height: 10 })
    expect(object.toObject()).toMatchObject({ originX: 'center', originY: 'center', left: 50, top: 40 })
  })

  it('retains legacy gradient opacity without modifying the stored JSON', async () => {
    const canvas = makeCanvas()
    const source = {
      version: '6.9.1',
      objects: [{
        type: 'Rect', left: 0, top: 0, width: 100, height: 80, strokeWidth: 0,
        fill: {
          type: 'linear', coords: { x1: 0, y1: 0, x2: 100, y2: 0 },
          colorStops: [{ offset: 0, color: '#ff0000', opacity: 0.25 }, { offset: 1, color: '#ff0000', opacity: 0.25 }],
        },
      }],
    }
    const before = JSON.stringify(source)
    await canvas.loadFromJSON(source)
    const gradient = canvas.getObjects()[0].fill as Gradient<'linear'>
    expect(gradient.colorStops.map(stop => stop.color)).toEqual(['rgba(255,0,0,0.25)', 'rgba(255,0,0,0.25)'])
    expect(JSON.stringify(source)).toBe(before)
    canvas.renderAll()
    expect(canvas.getContext().getImageData(30, 30, 1, 1).data[3]).toBeGreaterThanOrEqual(63)
    expect(canvas.getContext().getImageData(30, 30, 1, 1).data[3]).toBeLessThanOrEqual(64)
    await canvas.loadFromJSON(canvas.toObject())
    expect((canvas.getObjects()[0].fill as Gradient<'linear'>).colorStops[0].color).toBe('rgba(255,0,0,0.25)')
  })

  it('migrates V2 rectangles and dynamic text with their original coordinates and fields', async () => {
    const canvas = makeCanvas()
    const background = await loadTemplateToCanvas(canvas, {
      version: 2,
      background: { color: '#fefefe' },
      elements: [
        { id: 'rect', type: 'rect', x: 10, y: 15, width: 30, height: 20, fill: '#ff0000' },
        { id: 'text', type: 'text', x: 12, y: 40, width: 60, height: 15, content: '{{name}}', isDynamic: true, fieldName: 'name' },
      ],
    }, 50, 40)
    expect(background.color).toBe('#fefefe')
    expect(canvas.getObjects()[0].getBoundingRect()).toMatchObject({ left: 10, top: 15, width: 30, height: 20 })
    const text = canvas.getObjects()[1] as DynamicText
    expect(text).toBeInstanceOf(DynamicText)
    expect(text).toMatchObject({ left: 12, top: 40, originX: 'left', originY: 'top', fieldName: 'name', isDynamic: true })
    await canvas.loadFromJSON(canvas.toObject(['fieldName', 'isDynamic']))
    expect(canvas.getObjects()[1]).toMatchObject({ left: 12, top: 40, fieldName: 'name', isDynamic: true })
  })

  it('preserves canvas history and excludes the editor page from saved templates', async () => {
    const canvas = new Canvas(document.createElement('canvas'), { renderOnAddRemove: false })
    canvases.push(canvas)
    const page = new Rect({ left: 0, top: 0, width: 100, height: 80, __isPage: true } as never)
    const object = new Rect({ left: 10, top: 15, width: 30, height: 20, strokeWidth: 0 })
    canvas.add(page, object)
    const history = new CanvasHistory(canvas)
    history.init()
    object.set({ left: 45 })
    history.save()
    await history.undo()
    expect(canvas.getObjects()[1].left).toBe(10)
    expect(canvas.getObjects()[0]).toMatchObject({ selectable: false, evented: false })
    await history.redo()
    expect(canvas.getObjects()[1].left).toBe(45)
    const template = canvasToTemplateJson(canvas, { color: '#ffffff' })
    expect((template.fabricJson as { objects: unknown[] }).objects).toHaveLength(1)
  })

  it('exports real PNG pixels and a PDF while preserving the editing viewport', async () => {
    const canvas = makeCanvas()
    canvas.add(new Rect({ left: 0, top: 0, width: 100, height: 80, fill: '#ff0000', strokeWidth: 0 }))
    const viewport = [2, 0, 0, 2, 18, 24] as [number, number, number, number, number, number]
    canvas.setViewportTransform(viewport)
    const png = await exportCanvasToBlob(canvas, { format: 'png', multiplier: 1 })
    expect(png.type).toBe('image/png')
    const image = await loadImage(Buffer.from(await blobBytes(png)))
    expect([image.width, image.height]).toEqual([100, 80])
    const pixels = createCanvas(100, 80).getContext('2d')
    pixels.drawImage(image, 0, 0)
    expect(Array.from(pixels.getImageData(2, 2, 1, 1).data)).toEqual([255, 0, 0, 255])
    expect(Array.from(pixels.getImageData(97, 77, 1, 1).data)).toEqual([255, 0, 0, 255])
    expect(canvas.viewportTransform).toEqual(viewport)
    const pdf = await exportCanvasToBlob(canvas, { format: 'pdf', multiplier: 1 })
    expect(new TextDecoder().decode((await blobBytes(pdf)).slice(0, 5))).toBe('%PDF-')
    expect(canvas.viewportTransform).toEqual(viewport)
  })

  it('escapes untrusted object IDs and gradient colors during SVG serialization', () => {
    const rect = new Rect({
      id: 'object"><script>alert(1)</script><g id="tail',
      width: 20,
      height: 20,
      fill: new Gradient({
        type: 'linear',
        coords: { x1: 0, y1: 0, x2: 20, y2: 0 },
        colorStops: [{ offset: 0, color: 'red"><script>alert(2)</script><stop stop-color="blue' }],
      }),
    } as never)
    const svg = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${rect.toSVG()}</svg>`, 'image/svg+xml')
    expect(svg.querySelector('parsererror')).toBeNull()
    expect(svg.querySelector('script')).toBeNull()
    expect(svg.querySelectorAll('rect')).toHaveLength(1)
  })
})
