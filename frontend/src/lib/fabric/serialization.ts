/**
 * Fabric.js Serialization Helpers
 * Convert between our domain model and Fabric.js canvas JSON.
 */

import {
  Canvas, StaticCanvas, Rect, Ellipse, Line, FabricImage,
  Shadow, type FabricObject,
} from './runtime'
import {preflightDocumentImages} from './imageBudget'
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

/** Strip only legacy same-origin read tickets; durable document access uses the cookie. */
export function normalizeDocumentAssetURL(value:string):string {
  try{
    const base=typeof location==='undefined'?'http://localhost':location.origin
    const url=new URL(value,base)
    if(url.origin!==base||!url.pathname.startsWith('/api/media/file/'))return value
    url.searchParams.delete('media_preview');url.searchParams.delete('access')
    return url.pathname+url.search+url.hash
  }catch{return value}
}
function normalizedDocumentJSON<T>(value:T):T{
  if(Array.isArray(value))return value.map(normalizedDocumentJSON) as T
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,(key==='src'||key==='imageUrl'||key==='source'&&String((value as any).type).toLowerCase()==='pattern')&&typeof item==='string'?normalizeDocumentAssetURL(item):normalizedDocumentJSON(item)])) as T
  return value
}

// ─── Font Loading ─────────────────────────────────────────────────────────────

let fontsLoaded = false

export async function ensureFontsLoaded(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  if (fontsLoaded) {
    await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 4000))])
    return
  }
  const existing = document.querySelector(`link[href*="fonts.googleapis.com"]`)
  if (!existing) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = GOOGLE_FONTS_URL
    document.head.appendChild(link)
  }
  await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 4000))])
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
    fabricJson.objects = fabricJson.objects.filter((o: any) => !o.__isPage && !o.__isDocumentBackground && !o.__editorPreview)
  }
  delete fabricJson.backgroundImage
  delete fabricJson.background
  return normalizedDocumentJSON({
    version: 3,
    fabricJson,
    background,
  })
}

// ─── Load: Backend JSON → Canvas ──────────────────────────────────────────────

export async function loadTemplateToCanvas(
  canvas: Canvas | StaticCanvas,
  canvasJson: Record<string, unknown>,
  pageWidth: number,
  pageHeight: number,
  signal?: AbortSignal
): Promise<CanvasBackground> {
  const normalized=normalizedDocumentJSON(canvasJson)
  await preflightDocumentImages(normalized,signal)
  const data=normalized as unknown as TemplateData
  const background=data.background||{color:'#ffffff'}
  // All asynchronous resources are ready before replacing the visible document.
  const prepared=background.imageUrl?await FabricImage.fromURL(background.imageUrl,{crossOrigin:'anonymous',signal}):undefined
  try{
    signal?.throwIfAborted()
    if(data.version===3&&data.fabricJson)await canvas.loadFromJSON(data.fabricJson,undefined,{signal})
    else await migrateV2ToFabric(canvas,normalized,pageWidth,pageHeight,signal)
    await applyDocumentBackground(canvas,background,pageWidth,pageHeight,signal,prepared)
    return background
  }catch(error){prepared?.dispose();throw error}
}

/** The same page composition is used in editor, generated documents and export. */
export async function applyDocumentBackground(canvas:Canvas|StaticCanvas,background:CanvasBackground,widthMm:number,heightMm:number,signal?:AbortSignal,prepared?:FabricImage){
  const image=background.imageUrl?(prepared||await FabricImage.fromURL(normalizeDocumentAssetURL(background.imageUrl),{crossOrigin:'anonymous',signal})):undefined
  signal?.throwIfAborted()
  const pageW=widthMm*MM_TO_PX,pageH=heightMm*MM_TO_PX,editor=canvas instanceof Canvas&&canvas.__pageWidth!==undefined
  ;(canvas as any).__documentBackground={...background}
  canvas.getObjects().filter(o=>(o as any).__isPage||(o as any).__isDocumentBackground).forEach(o=>{canvas.remove(o);o.dispose()})
  const oldBackground=canvas.backgroundImage;canvas.backgroundImage=undefined;if(oldBackground&&oldBackground!==image)oldBackground.dispose()
  if(editor){
    canvas.__pageWidth=pageW;canvas.__pageHeight=pageH
    const page=new Rect({left:0,top:0,width:pageW,height:pageH,fill:background.color||'#FFFFFF',strokeWidth:0,selectable:false,evented:false,hasControls:false})
    ;(page as any).__isPage=true;canvas.__pageRect=page;canvas.insertAt(0,page)
  }else canvas.backgroundColor=background.color||'#FFFFFF'
  if(image){
    const source=image.getOriginalSize(),scale=Math.max(pageW/(source.width||1),pageH/(source.height||1))
    image.set({left:0,top:0,width:pageW/scale,height:pageH/scale,cropX:((source.width||0)-pageW/scale)/2,cropY:((source.height||0)-pageH/scale)/2,scaleX:scale,scaleY:scale,selectable:false,evented:false,hasControls:false})
    if(editor){(image as any).__isDocumentBackground=true;canvas.insertAt(1,image)}else canvas.backgroundImage=image
  }
  canvas.requestRenderAll()
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
  _pageHeight: number,
  signal?:AbortSignal
): Promise<CanvasBackground> {
  const cj = canvasJson as any
  const elements: LegacyElement[] = cj?.elements || []
  const bg: CanvasBackground = cj?.background || { color: '#ffffff' }

  const objects:FabricObject[]=[]
  try{for(const el of elements){signal?.throwIfAborted();const object=await legacyElementToFabric(el,signal);if(object)objects.push(object)}}
  catch(error){objects.forEach(object=>object.dispose());throw error}
  signal?.throwIfAborted();canvas.clear();canvas.add(...objects)

  canvas.renderAll()
  return bg
}

async function legacyElementToFabric(el: LegacyElement,signal?:AbortSignal): Promise<FabricObject | null> {
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
        const img = await FabricImage.fromURL(el.src, { crossOrigin: 'anonymous',signal })
        img.set({
          ...commonOpts,
          scaleX: el.width / (img.width || el.width),
          scaleY: el.height / (img.height || el.height),
        })
        return img
      } catch {
        throw new Error("No se pudo cargar una imagen de la plantilla. Reintenta antes de editar.")
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
