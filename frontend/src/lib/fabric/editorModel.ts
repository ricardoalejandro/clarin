import { ActiveSelection, Group, Point, FabricObject, type Canvas, util } from './runtime'
import { CUSTOM_PROPS } from './constants'
import {preflightDocumentImages} from './imageBudget'

export function isDocumentObject(object: FabricObject): boolean {
  return !(object as any).__isPage && !(object as any).__isDocumentBackground && !(object as any).__editorPreview
}
export function isObjectLocked(object: FabricObject): boolean {
  return !!object.lockMovementX || (!!object.group && !(object.group instanceof ActiveSelection) && isObjectLocked(object.group))
}
export function editorSelection(canvas: Canvas): FabricObject[] {
  const active = canvas.getActiveObject()
  return !active ? [] : active instanceof ActiveSelection ? active.getObjects() : [active]
}
export function applyObjectLock(object: FabricObject, locked: boolean) {
  if(locked&&object instanceof Group)object.set({interactive:false})
  object.set({ lockMovementX: locked, lockMovementY: locked, lockScalingX: locked, lockScalingY: locked, lockRotation: locked, hasControls: !locked })
}
export function ensureObjectIds(objects: FabricObject[], renew = false) {
  for (const object of objects) {
    if (renew || !(object as any).objectId) (object as any).objectId = crypto.randomUUID()
    if (object instanceof Group) ensureObjectIds(object.getObjects(), renew)
  }
}
export function groupEditorSelection(canvas: Canvas): Group | null {
  const active = canvas.getActiveObject()
  if (!(active instanceof ActiveSelection)) return null
  const objects = active.getObjects().filter(isDocumentObject)
  if (objects.length < 2 || objects.some(isObjectLocked)) return null
  const order = canvas.getObjects()
  objects.sort((a,b) => order.indexOf(a) - order.indexOf(b))
  const index = Math.min(...objects.map(o => order.indexOf(o)))
  canvas.discardActiveObject()
  canvas.remove(...objects)
  const group = new Group(objects, { subTargetCheck: true })
  ;(group as any).elementName = 'Grupo'
  ensureObjectIds([group])
  canvas.insertAt(Math.max(0,index), group)
  canvas.setActiveObject(group)
  canvas.requestRenderAll()
  return group
}
export function ungroupEditorSelection(canvas: Canvas): FabricObject[] {
  let group = canvas.getActiveObject()
  if(group instanceof ActiveSelection && group.getObjects().length===1){
    const only=group.getObjects()[0]
    canvas.discardActiveObject();canvas.setActiveObject(only);group=only
  }
  if (!(group instanceof Group) || group instanceof ActiveSelection || isObjectLocked(group)) return []
  const parent = group.parent
  const collection = parent || canvas
  const index = collection.getObjects().indexOf(group)
  canvas.discardActiveObject()
  // removeAll applies the group's complete world transform to each child.
  const children = group.removeAll()
  collection.remove(group)
  collection.insertAt(Math.max(0,index), ...children)
  if (!parent) canvas.setActiveObject(new ActiveSelection(children, { canvas }))
  else canvas.setActiveObject(parent)
  canvas.requestRenderAll()
  return children
}
export async function serializeWorldObjects(objects: FabricObject[]): Promise<Record<string,unknown>[]> {
  // Serialization must not fetch image sources or mutate the live selection.
  return objects.filter(isDocumentObject).map(object => {
    const data=object.toObject(CUSTOM_PROPS) as Record<string,unknown>
    const geometry=new FabricObject({width:object.width,height:object.height,strokeWidth:object.strokeWidth,strokeUniform:object.strokeUniform,originX:object.originX,originY:object.originY})
    util.applyTransformToObject(geometry,object.calcTransformMatrix())
    for(const key of ['left','top','scaleX','scaleY','flipX','flipY','angle','skewX','skewY'] as const)data[key]=geometry[key]
    return data
  })
}
export async function pasteWorldObjects(canvas: Canvas, serialized: Record<string,unknown>[], at?: {x:number;y:number},signal?:AbortSignal) {
  await preflightDocumentImages({existing:canvas.toObject(CUSTOM_PROPS),incoming:serialized},signal)
  const objects = await util.enlivenObjects<FabricObject>(serialized,{signal})
  signal?.throwIfAborted()
  ensureObjectIds(objects, true)
  if (!objects.length) return []
  const bounds = unionBounds(objects)
  const dx = at ? at.x - bounds.left : 15
  const dy = at ? at.y - bounds.top : 15
  for (const object of objects) {
    object.setXY(object.getXY().add(new Point(dx,dy)))
    canvas.add(object)
  }
  canvas.setActiveObject(objects.length === 1 ? objects[0] : new ActiveSelection(objects, { canvas }))
  canvas.requestRenderAll()
  return objects
}
export function unionBounds(objects: FabricObject[]) {
  const boxes = objects.map(o => o.getBoundingRect())
  if (!boxes.length) return { left:0, top:0, width:0, height:0 }
  const left = Math.min(...boxes.map(b=>b.left)), top = Math.min(...boxes.map(b=>b.top))
  return { left, top, width:Math.max(...boxes.map(b=>b.left+b.width))-left, height:Math.max(...boxes.map(b=>b.top+b.height))-top }
}
export function alignEditorSelection(canvas: Canvas, alignment: string, toPage: boolean) {
  const objects = editorSelection(canvas)
  if (!objects.length || objects.some(isObjectLocked)) return
  canvas.discardActiveObject()
  const b = toPage ? {left:0,top:0,width:canvas.__pageWidth||canvas.width,height:canvas.__pageHeight||canvas.height} : unionBounds(objects)
  for (const object of objects) {
    const current = object.getBoundingRect()
    let dx=0,dy=0
    if(alignment==='left') dx=b.left-current.left
    if(alignment==='right') dx=b.left+b.width-current.left-current.width
    if(alignment==='center-h') dx=b.left+(b.width-current.width)/2-current.left
    if(alignment==='top') dy=b.top-current.top
    if(alignment==='bottom') dy=b.top+b.height-current.top-current.height
    if(alignment==='center-v') dy=b.top+(b.height-current.height)/2-current.top
    object.setXY(object.getXY().add(new Point(dx,dy))); object.setCoords()
  }
  canvas.setActiveObject(objects.length===1?objects[0]:new ActiveSelection(objects,{canvas}))
  canvas.requestRenderAll()
}
export function distributeEditorSelection(canvas: Canvas, axis:'x'|'y') {
  const objects=editorSelection(canvas)
  if(objects.length<3||objects.some(isObjectLocked)) return
  canvas.discardActiveObject()
  const property=axis==='x'?'left':'top',dimension=axis==='x'?'width':'height'
  objects.sort((a,b)=>a.getBoundingRect()[property]-b.getBoundingRect()[property])
  const boxes=objects.map(o=>o.getBoundingRect()),first=boxes[0],last=boxes[boxes.length-1]
  const gap=(last[property]+last[dimension]-first[property]-boxes.reduce((s,b)=>s+b[dimension],0))/(objects.length-1)
  let position=first[property]
  objects.forEach((o,i)=>{
    const delta=position-boxes[i][property]
    o.setXY(o.getXY().add(new Point(axis==='x'?delta:0,axis==='y'?delta:0)));o.setCoords()
    position+=boxes[i][dimension]+gap
  })
  canvas.setActiveObject(new ActiveSelection(objects,{canvas}));canvas.requestRenderAll()
}
export function coverImageCrop(sourceW:number,sourceH:number,frameW:number,frameH:number) {
  const scale=Math.max(frameW/sourceW,frameH/sourceH)
  const width=frameW/scale,height=frameH/scale
  return {cropX:(sourceW-width)/2,cropY:(sourceH-height)/2,width,height,scaleX:scale,scaleY:scale}
}
export function normalizeEditorColor(value: unknown): string | null {
  return typeof value==='string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : null
}
export function editorInputOwnsKeyboard(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="dialog"],[role="menu"],[data-editor-input]')
}

/** Avoid thousands of 256px minimum raster caches for simple print objects. */
export function configureDocumentObjectCaching(objects:FabricObject[]){
 for(const object of objects){
  if(object instanceof Group){configureDocumentObjectCaching(object.getObjects());continue}
  if(['rect','ellipse','circle','triangle','line','text','itext','i-text','textbox','dynamictext','image','fabricimage'].includes(object.type.toLowerCase())&&!object.clipPath&&!object.shadow)object.objectCaching=false
 }
}
