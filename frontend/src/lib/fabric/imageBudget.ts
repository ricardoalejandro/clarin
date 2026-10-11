import {util,type FabricObject,type Canvas,type StaticCanvas} from './runtime'
export const DOCUMENT_IMAGE_PIXEL_BUDGET=64_000_000
export const DOCUMENT_IMAGE_MAX_PIXELS=40_000_000
export function imageFilterPixelFactor(filters:unknown):number{
 let scale=1,peak=1
 if(Array.isArray(filters))for(const filter of filters){
  if(String(filter?.type).toLowerCase()!=='resize')continue
  const x=Number(filter.scaleX??1),y=Number(filter.scaleY??1)
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<=0||y<=0)return Infinity
  scale*=x*y;peak=Math.max(peak,scale)
 }
 return peak
}
export function documentImageWorkload(value:unknown):Map<string,{count:number;factor:number;peak:number}>{
 const sources=new Map<string,{count:number;factor:number;peak:number}>()
 const add=(src:string,factor=1)=>{if(!src)return;const prev=sources.get(src)||{count:0,factor:0,peak:1};sources.set(src,{count:prev.count+1,factor:prev.factor+factor,peak:Math.max(prev.peak,factor)})}
 const walk=(item:any)=>{if(!item||typeof item!=='object')return;if(Array.isArray(item)){item.forEach(walk);return}
  for(const [key,entry] of Object.entries(item)){
   if(typeof entry==='string'&&(key==='src'||key==='imageUrl'||key==='source'&&String(item.type).toLowerCase()==='pattern'))add(entry,key==='src'?imageFilterPixelFactor(item.filters):1)
   else if(entry&&typeof entry==='object')walk(entry)
  }
 }
 walk(value);return sources
}
export function documentImageSources(value:unknown):Map<string,number>{
 return new Map([...documentImageWorkload(value)].map(([src,work])=>[src,work.count]))
}
export function documentImageBudgetError(totalPixels:number,sourcePixels:number):string|null{
 if(sourcePixels>DOCUMENT_IMAGE_MAX_PIXELS)return 'Una imagen supera los 40 megapíxeles. Reduce su resolución antes de abrirla.'
 if(totalPixels>DOCUMENT_IMAGE_PIXEL_BUDGET)return 'Las imágenes de esta página superan los 64 megapíxeles en conjunto. Reduce su resolución para mantener una edición fluida.'
 return null
}
/** Count decoded source/filter pixels already owned by the visible composition. */
export function liveDocumentImagePixels(canvas:Canvas|StaticCanvas,exclude?:FabricObject):number{
 let total=0
 const dimensions=(element:any)=>Number(element?.naturalWidth||element?.width||0)*Number(element?.naturalHeight||element?.height||0)
 const walk=(object:any)=>{
  if(object===exclude)return
  if(typeof object.getOriginalSize==='function'){const size=object.getOriginalSize();total+=size.width*size.height*imageFilterPixelFactor(object.filters)}
  if(typeof object.getObjects==='function')object.getObjects().forEach(walk)
  for(const paint of [object.fill,object.stroke])if(paint?.source)total+=dimensions(paint.source)
 }
 canvas.getObjects().forEach(walk);if(canvas.backgroundImage)walk(canvas.backgroundImage)
 return total
}
/** Four metadata reads at a time; reject excessive decoded memory before Fabric enlivens the composition. */
export async function preflightDocumentImages(value:unknown,signal?:AbortSignal):Promise<void>{
 const sources=[...documentImageWorkload(value)];if(!sources.length)return
 const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort()
 let index=0,total=0,failure:unknown
 const timeout=setTimeout(abort,30000)
 try{
  await Promise.all(Array.from({length:Math.min(4,sources.length)},async()=>{
   try{while(index<sources.length&&!controller.signal.aborted){const [src,work]=sources[index++],image=await util.loadImage(src,{crossOrigin:'anonymous',signal:controller.signal})
     const pixels=image.naturalWidth*image.naturalHeight;total+=pixels*work.factor
     const error=documentImageBudgetError(total,pixels*work.peak);if(error)throw new Error(error)
   }}catch(error){failure??=error;controller.abort()}
  }))
  if(failure)throw failure
  controller.signal.throwIfAborted()
 }finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort)}
}
