import type { Canvas, StaticCanvas } from './runtime'
import { serializeWorldObjects, editorSelection, isDocumentObject, unionBounds } from './editorModel'

/** Independent JSON snapshot; reading/exporting never changes the interactive canvas. */
export async function createDocumentRenderSnapshot(canvas: Canvas | StaticCanvas, scope:'page'|'selection', transparent=false): Promise<{canvasJson:Record<string,unknown>;width:number;height:number}> {
  const chosen=scope==='selection'?('getActiveObjects' in canvas ? editorSelection(canvas as Canvas) : []):canvas.getObjects().filter(isDocumentObject)
  if(scope==='selection'&&!chosen.length) throw new Error('Selecciona al menos un elemento.')
  const bounds=scope==='selection'?unionBounds(chosen):{left:0,top:0,width:(canvas as any).__pageWidth||canvas.width,height:(canvas as any).__pageHeight||canvas.height}
  const objects=await serializeWorldObjects(chosen)
  for(const object of objects) {
    object.left=Number(object.left||0)-bounds.left
    object.top=Number(object.top||0)-bounds.top
  }
  const background=(canvas as any).__documentBackground||{color:'#FFFFFF'}
  // Selection exports use the same page background, offset to the crop's origin.
  if(scope==='selection'&&!transparent) {
    const image=canvas.getObjects().find(o=>(o as any).__isDocumentBackground)
    if(image) {
      const data=image.toObject() as Record<string,unknown>
      data.left=Number(data.left||0)-bounds.left;data.top=Number(data.top||0)-bounds.top
      objects.unshift(data)
    }
  }
  return {
    canvasJson:{version:3,fabricJson:{objects},background:transparent?{color:'transparent'}:scope==='page'?background:{color:background.color||'#FFFFFF'}},
    width:bounds.width,height:bounds.height,
  }
}
