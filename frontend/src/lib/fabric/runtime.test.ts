import { createCanvas, loadImage, type Canvas as NativeCanvas } from '@napi-rs/canvas'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveSelection, Group, Point, Canvas, Gradient, Pattern, Rect, StaticCanvas, Textbox, FabricImage, util } from './runtime'
import { DynamicText } from './objects'
import { loadTemplateToCanvas, canvasToTemplateJson } from './serialization'
import { exportCanvasToBlob } from './export'
import { CanvasHistory } from './history'
import { editorSelection, groupEditorSelection, ungroupEditorSelection, serializeWorldObjects, pasteWorldObjects, alignEditorSelection, distributeEditorSelection, applyObjectLock, coverImageCrop, normalizeEditorColor } from './editorModel'
import { createDocumentRenderSnapshot } from './editorSnapshot'
import {applyImageFrameCrop,cropWithRatio,imageTargetAtPoint,replaceEditorImage} from './imageFrame'
import {documentImageSources,documentImageBudgetError,documentImageWorkload,imageFilterPixelFactor,liveDocumentImagePixels} from './imageBudget'
import { setupShortcuts,commitFocusedEditorDraft } from './shortcuts'
import {flushSync} from 'react-dom'
import {createDocumentThumbnail} from './editorThumbnail'

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
  vi.spyOn(HTMLCanvasElement.prototype,'toBlob').mockImplementation(function(this:HTMLCanvasElement,callback:BlobCallback,type?:string,quality?:number){
    const surface=surfaceFor(this)
    const bytes=type==='image/jpeg'?surface.toBuffer('image/jpeg',Math.round((quality??.85)*100)):surface.toBuffer('image/png')
    const blob=new Blob([new Uint8Array(bytes)],{type:type||'image/png'});Object.defineProperty(blob,'arrayBuffer',{value:async()=>new Uint8Array(bytes).buffer});callback(blob)
  })
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


describe('document editor geometry and resource-independent snapshots',()=>{
  function interactive(){const canvas=new Canvas(document.createElement('canvas'),{width:600,height:400,renderOnAddRemove:false});canvases.push(canvas);canvas.__pageWidth=420;canvas.__pageHeight=280;return canvas}
  function matrices(objects:any[]){return objects.map(o=>o.calcTransformMatrix().map((v:number)=>Math.round(v*1e6)/1e6))}
  it('keeps transformed real groups selected as one object and restores child world geometry when ungrouping',()=>{
    const canvas=interactive(),a=new Rect({left:20,top:30,width:40,height:20,angle:11}),b=new Rect({left:90,top:45,width:20,height:30})
    canvas.add(a,b);canvas.setActiveObject(new ActiveSelection([a,b],{canvas}))
    const group=groupEditorSelection(canvas)!;group.set({angle:27,scaleX:1.8,scaleY:.7,skewX:8,left:160,top:95})
    expect(editorSelection(canvas)).toEqual([group])
    const expected=matrices([a,b])
    const children=ungroupEditorSelection(canvas)
    expect(children).toEqual([a,b]);expect(matrices(children)).toEqual(expected)
    expect(canvas.getObjects()).toEqual([a,b])
  })
  it('ungroups a sole group selected through Select all after reloading',()=>{
    const canvas=interactive(),group=new Group([new Rect({width:20,height:30}),new Rect({left:70,width:30,height:20})],{angle:21,left:60,top:40})
    canvas.add(group);canvas.setActiveObject(new ActiveSelection([group],{canvas}))
    const expected=matrices(group.getObjects());const children=ungroupEditorSelection(canvas)
    expect(children).toHaveLength(2);expect(matrices(children)).toEqual(expected);expect(canvas.getObjects()).toEqual(children)
  })
  it('persists same-origin raster, pattern and background references canonically without altering external hosts',()=>{
    const canvas=interactive(),element=document.createElement('img')
    element.src=location.origin+'/api/media/file/account/image.png?media_preview=old&access=expired'
    const image=new FabricImage(element,{width:20,height:20})
    canvas.add(new Group([image]),new Rect({width:20,height:20,fill:new Pattern({source:element})}))
    const background={color:'#fff',imageUrl:location.origin+'/api/media/file/account/background.png?access=expired'}
    const saved=canvasToTemplateJson(canvas,background),objects=(saved.fabricJson as any).objects
    expect(objects[0].objects[0].src).toBe('/api/media/file/account/image.png')
    expect(objects[1].fill.source).toBe('/api/media/file/account/image.png')
    expect((saved.background as any).imageUrl).toBe('/api/media/file/account/background.png')
    expect(image.getSrc()).toContain('media_preview=old');expect(background.imageUrl).toContain('access=expired')
    element.src='https://different.example/api/media/file/account/image.png?access=legacy'
    const external=canvasToTemplateJson(canvas,{color:'#fff'})
    expect((external.fabricJson as any).objects[0].objects[0].src).toBe(element.src)
  })
  it('encodes a real thumbnail without data URL fetch and preserves hidden object visibility in rendering',async()=>{
    const canvas=makeCanvas()
    canvas.add(new Rect({left:0,top:0,width:100,height:80,fill:'#ff0000',strokeWidth:0}),new Rect({left:0,top:0,width:100,height:80,fill:'#0000ff',visible:false,strokeWidth:0}))
    const shot=await createDocumentRenderSnapshot(canvas,'page')
    expect((shot.canvasJson.fabricJson as any).objects[1].visible).toBe(false)
    const thumbnail=await createDocumentThumbnail(canvas,100)
    expect(thumbnail.type).toBe('image/jpeg')
    const raster=await loadImage(Buffer.from(await blobBytes(thumbnail))),pixels=createCanvas(100,80).getContext('2d')
    pixels.drawImage(raster,0,0);const color=Array.from(pixels.getImageData(10,10,1,1).data)
    expect(color[0]).toBeGreaterThan(245);expect(color[2]).toBeLessThan(10)
    expect(canvas.getObjects()[1].visible).toBe(false)
  })
  it('ungroups a nested group without moving descendants in a transformed parent',()=>{
    const canvas=interactive(),a=new Rect({left:10,top:20,width:30,height:40}),b=new Rect({left:70,top:30,width:20,height:30}),inner=new Group([a,b],{angle:17,scaleX:1.3,left:40,top:60}),outer=new Group([inner,new Rect({left:200,top:50,width:30,height:20})],{angle:28,scaleY:.7,left:100,top:120})
    canvas.add(outer);outer.set({interactive:true,subTargetCheck:true});canvas.setActiveObject(inner)
    const expected=matrices([a,b]);ungroupEditorSelection(canvas);expect(matrices([a,b])).toEqual(expected);expect(outer.getObjects()).toContain(a);expect(outer.getObjects()).toContain(b)
  })
  it('copies group geometry in scene space without clone, network work or selection mutation',async()=>{
    const canvas=interactive(),a=new Rect({left:20,top:30,width:40,height:20,angle:11}),b=new Rect({left:90,top:45,width:20,height:30})
    canvas.add(a,b);const selection=new ActiveSelection([a,b],{canvas});canvas.setActiveObject(selection);selection.set({angle:35,scaleX:1.3,scaleY:.8,skewX:6})
    const expected=matrices([a,b]),before=JSON.stringify(selection.toObject()),clone=vi.spyOn(a,'clone').mockRejectedValue(new Error('must not clone'))
    const data=await serializeWorldObjects([a,b]),restored=await util.enlivenObjects<any>(data)
    expect(matrices(restored)).toEqual(expected);expect(JSON.stringify(selection.toObject())).toBe(before);expect(clone).not.toHaveBeenCalled()
    restored.forEach(o=>o.dispose())
  })
  it('retains page dimensions and selection export bounds independent of zoom and excludes auxiliary objects',async()=>{
    const canvas=interactive(),page=new Rect({width:420,height:280}),object=new Rect({left:70,top:80,width:50,height:30,strokeWidth:0})
    ;(page as any).__isPage=true;canvas.add(page,object);canvas.setActiveObject(object);canvas.setViewportTransform([3,0,0,3,-45,180])
    const before=JSON.stringify(canvas.toObject()),pageShot=await createDocumentRenderSnapshot(canvas,'page'),selected=await createDocumentRenderSnapshot(canvas,'selection',true)
    expect([pageShot.width,pageShot.height]).toEqual([420,280]);expect((pageShot.canvasJson.fabricJson as any).objects).toHaveLength(1)
    expect([selected.width,selected.height]).toEqual([50,30]);expect((selected.canvasJson.fabricJson as any).objects[0]).toMatchObject({left:0,top:0});expect(selected.canvasJson.background).toEqual({color:'transparent'})
    expect(JSON.stringify(canvas.toObject())).toBe(before);expect(canvas.viewportTransform).toEqual([3,0,0,3,-45,180])
  })
  it('aligns and distributes in page coordinates at any zoom and honours locked objects',()=>{
    const canvas=interactive(),a=new Rect({left:20,top:40,width:20,height:20,strokeWidth:0}),b=new Rect({left:80,top:60,width:20,height:20,strokeWidth:0}),c=new Rect({left:200,top:90,width:20,height:20,strokeWidth:0})
    canvas.add(a,b,c);canvas.setActiveObject(new ActiveSelection([a,b,c],{canvas}));canvas.setViewportTransform([2,0,0,2,150,-20])
    alignEditorSelection(canvas,'top',false);expect([a,b,c].map(o=>o.getBoundingRect().top)).toEqual([40,40,40])
    distributeEditorSelection(canvas,'x');expect([a,b,c].map(o=>o.getBoundingRect().left)).toEqual([20,110,200])
    const before=matrices([a,b,c]);applyObjectLock(b,true);alignEditorSelection(canvas,'bottom',true);expect(matrices([a,b,c])).toEqual(before)
  })
  it('pastes unique IDs and preserves cover aspect ratio instead of stretching replacement images',async()=>{
    const canvas=interactive(),source=new Rect({left:20,top:30,width:40,height:20});(source as any).objectId='source';canvas.add(source)
    const pasted=await pasteWorldObjects(canvas,await serializeWorldObjects([source]),{x:100,y:150})
    expect((pasted[0] as any).objectId).not.toBe('source');expect(pasted[0].getBoundingRect().left).toBeCloseTo(100);expect(pasted[0].getBoundingRect().top).toBeCloseTo(150)
    const crop=coverImageCrop(1000,500,100,100);expect(crop.scaleX).toBe(crop.scaleY);expect(crop.width*crop.scaleX).toBe(100);expect(crop.height*crop.scaleY).toBe(100);expect(crop.cropX).toBe(250)
    expect(normalizeEditorColor('#10b981')).toBe('#10B981');expect(normalizeEditorColor('red')).toBeNull();expect(normalizeEditorColor('#fff')).toBeNull()
  })
  it('preserves an image frame through contain and cover without changing its aspect or world bounds',()=>{
    const canvas=interactive(),source=document.createElement('canvas');source.width=1000;source.height=500
    const image=new FabricImage(source,{left:70,top:85,width:400,height:300,scaleX:1.2,scaleY:.9,angle:24})
    canvas.add(image);canvas.setActiveObject(image);const before=image.getBoundingRect()
    const group=applyImageFrameCrop(canvas,image,{x:0,y:0,width:1,height:1},'contain') as Group
    const after=group.getBoundingRect();for(const key of ['left','top','width','height'] as const)expect(after[key]).toBeCloseTo(before[key],5)
    expect(image.scaleX).toBeCloseTo(image.scaleY);expect(group.getObjects()).toContain(image)
    applyImageFrameCrop(canvas,image,{x:.1,y:.1,width:.8,height:.8},'cover',group)
    const filled=group.getBoundingRect();for(const key of ['left','top','width','height'] as const)expect(filled[key]).toBeCloseTo(before[key],5)
    expect(image.scaleX).toBeCloseTo(image.scaleY)
    const constrained=cropWithRatio({x:.2,y:.1,width:.7,height:.7},16/9,1000,500)
    expect(constrained.width*1000/(constrained.height*500)).toBeCloseTo(16/9);expect(constrained.x+constrained.width).toBeLessThanOrEqual(1)
  })
  it('replaces a contain-frame image inside a transformed nested group without inserting or moving its frame',()=>{
    const canvas=interactive(),source=document.createElement('canvas');source.width=400;source.height=200
    const image=new FabricImage(source,{left:30,top:45,width:160,height:120,angle:18,scaleX:1.2,scaleY:.9})
    canvas.add(image)
    const frame=applyImageFrameCrop(canvas,image,{x:0,y:0,width:1,height:1},'contain') as Group
    canvas.remove(frame)
    const parent=new Group([frame,new Rect({left:-50,top:-50,width:10,height:10})],{left:95,top:80,angle:28,scaleX:1.3,scaleY:.8})
    canvas.add(parent);parent.setCoords();frame.setCoords()
    const before=frame.getBoundingRect(),center=frame.getCenterPoint(),filters=image.filters
    expect(imageTargetAtPoint(canvas.getObjects(),center)).toBe(frame)
    const replacement=document.createElement('canvas');replacement.width=300;replacement.height=700
    expect(replaceEditorImage(canvas,frame,new FabricImage(replacement))).toBe(true)
    expect(canvas.getObjects()).toEqual([parent]);expect(parent.getObjects()).toContain(frame)
    const after=frame.getBoundingRect()
    for(const key of ['left','top','width','height'] as const)expect(after[key]).toBeCloseTo(before[key],5)
    expect(image.getOriginalSize()).toEqual({width:300,height:700});expect(image.scaleX).toBeCloseTo(image.scaleY)
    expect(image.filters).toBe(filters);expect((frame as any).imageFit).toBe('contain')
    applyObjectLock(parent,true)
    expect(imageTargetAtPoint(canvas.getObjects(),frame.getCenterPoint())).toBe(frame)
    expect(replaceEditorImage(canvas,frame,new FabricImage(source))).toBe(false)
    expect(image.getOriginalSize()).toEqual({width:300,height:700})
  })
  it('budgets decoded images across nested groups and repeated sources before rendering',()=>{
    const sources=documentImageSources({fabricJson:{objects:[{type:'Image',src:'/one'},{type:'Group',objects:[{type:'Image',src:'/one'},{type:'Image',src:'/two'}]}]},background:{imageUrl:'/background'}})
    expect([...sources]).toEqual([['/one',2],['/two',1],['/background',1]])
    const workloads=documentImageWorkload({objects:[{type:'Image',src:'/raster',filters:[{type:'Resize',scaleX:4,scaleY:3},{type:'Resize',scaleX:.25,scaleY:.25}]},{type:'Rect',fill:{type:'pattern',source:'/pattern'}}]})
    expect(workloads.get('/raster')).toEqual({count:1,factor:12,peak:12});expect(workloads.get('/pattern')?.count).toBe(1)
    expect(imageFilterPixelFactor([{type:'Resize',scaleX:Infinity,scaleY:1}])).toBe(Infinity)
    const canvas=interactive(),source=document.createElement('canvas');source.width=200;source.height=100
    const live=new FabricImage(source);canvas.add(live)
    expect(liveDocumentImagePixels(canvas)).toBe(20000);expect(liveDocumentImagePixels(canvas,live)).toBe(0)
    expect(documentImageBudgetError(63000000,30000000)).toBeNull();expect(documentImageBudgetError(65000000,30000000)).toContain('64');expect(documentImageBudgetError(41000000,41000000)).toContain('40')
  })
  it('gives text and input editing priority over object shortcuts',()=>{
    const canvas=interactive(),input=document.createElement('input');document.body.append(input)
    const actions={onSave:vi.fn(),onDelete:vi.fn(),onDuplicate:vi.fn(),onSelectAll:vi.fn(),onGroup:vi.fn(),onUngroup:vi.fn(),onCopy:vi.fn(),onPaste:vi.fn(),onDeselect:vi.fn(),onUndo:vi.fn(),isEditingText:()=>false}
    const handler=setupShortcuts(canvas,new CanvasHistory(canvas),actions)
    for(const key of ['a','c','v','z','Delete','ArrowLeft'])input.dispatchEvent(new KeyboardEvent('keydown',{key,ctrlKey:true,bubbles:true,cancelable:true}))
    expect(actions.onSelectAll).not.toHaveBeenCalled();expect(actions.onCopy).not.toHaveBeenCalled();expect(actions.onPaste).not.toHaveBeenCalled();expect(actions.onUndo).not.toHaveBeenCalled();expect(actions.onDelete).not.toHaveBeenCalled()
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true}));expect(actions.onSave).toHaveBeenCalledOnce()
    document.removeEventListener('keydown',handler);input.remove()
  })
  it('saves a focused name and the latest IText draft while preserving native editing shortcuts',()=>{
    const canvas=interactive(),root=document.createElement('section'),input=document.createElement('input')
    root.append(input);document.body.append(root)
    let name='Original'
    input.addEventListener('blur',()=>{name=input.value})
    const saved:unknown[]=[]
    const actions={onSave:()=>{flushSync(()=>commitFocusedEditorDraft(canvas,root));saved.push({name,objects:canvasToTemplateJson(canvas,{color:'#fff'})})},onDelete:vi.fn(),onDuplicate:vi.fn(),onSelectAll:vi.fn(),onGroup:vi.fn(),onUngroup:vi.fn(),onCopy:vi.fn(),onPaste:vi.fn(),onDeselect:vi.fn(),isEditingText:()=>!!(canvas.getActiveObject() as any)?.isEditing}
    const handler=setupShortcuts(canvas,new CanvasHistory(canvas),actions)
    input.value='Nombre recién escrito';input.focus()
    const nameSave=new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true})
    input.dispatchEvent(nameSave)
    expect(nameSave.defaultPrevented).toBe(true);expect((saved[0] as any).name).toBe('Nombre recién escrito')
    const text=new Textbox('Anterior',{left:10,top:10,width:200});canvas.add(text);canvas.setActiveObject(text);text.enterEditing()
    text.hiddenTextarea!.value='Texto más reciente'
    const textSave=new KeyboardEvent('keydown',{key:'s',metaKey:true,bubbles:true,cancelable:true})
    text.hiddenTextarea!.dispatchEvent(textSave)
    expect(textSave.defaultPrevented).toBe(true);expect((saved[1] as any).objects.fabricJson.objects[0].text).toBe('Texto más reciente');expect(text.isEditing).toBe(false)
    input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,isComposing:true,bubbles:true,cancelable:true}))
    expect(saved).toHaveLength(2)
    document.removeEventListener('keydown',handler);root.remove()
  })
  it('restores the complete document history and preserves redo after an identical capture',async()=>{
    const canvas=interactive();let state={name:'Inicial',width:210,background:'#fff',guides:[20]};const restore=vi.fn(async(next:any)=>{state=next})
    const history=new CanvasHistory(canvas,{capture:()=>state,restore});history.init();state={name:'Cambio',width:150,background:'#000',guides:[50]};history.save();await history.undo()
    expect(state).toEqual({name:'Inicial',width:210,background:'#fff',guides:[20]});history.save();expect(history.canRedo).toBe(true);await history.redo();expect(state.width).toBe(150)
    restore.mockRejectedValueOnce(new Error('offline'));await expect(history.undo()).rejects.toThrow('offline');expect(history.canUndo).toBe(true);expect(history.busy).toBe(false)
  })
})
