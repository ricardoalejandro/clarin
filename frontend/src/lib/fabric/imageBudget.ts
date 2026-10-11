import {util,type FabricObject,type Canvas,type StaticCanvas} from './runtime'
import {DocumentImageLoadError,DOCUMENT_IMAGE_ISSUE_LIMIT,type DocumentImageIssue,type DocumentImageIssueReason} from '../documents/resourceErrors'
export {DocumentImageLoadError} from '../documents/resourceErrors'
export const DOCUMENT_IMAGE_PIXEL_BUDGET=64_000_000
export const DOCUMENT_IMAGE_MAX_PIXELS=40_000_000
export const DOCUMENT_IMAGE_PREFLIGHT_TIMEOUT_MS=30_000
const DOCUMENT_IMAGE_DIAGNOSTIC_TIMEOUT_MS=3_000
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
function imageLoadAbortError():DOMException{return new DOMException('La carga fue cancelada.','AbortError')}

/** Settle promptly even if an image loader or diagnostic transport ignores its signal. */
function abortableImageWork<T>(work:()=>Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(imageLoadAbortError());return}
  const cleanup=()=>signal.removeEventListener('abort',onAbort)
  const onAbort=()=>{cleanup();reject(imageLoadAbortError())}
  signal.addEventListener('abort',onAbort,{once:true})
  try{Promise.resolve(work()).then(value=>{cleanup();resolve(value)},error=>{cleanup();reject(error)})}
  catch(error){cleanup();reject(error)}
 })
}

/** A failed browser image has no HTTP status. Diagnose only our authenticated media route. */
async function diagnoseImageFailure(source:string,parent:AbortSignal):Promise<DocumentImageIssueReason>{
 if(parent.aborted)throw imageLoadAbortError()
 if(typeof location==='undefined')return 'load-failed'
 let url:URL
 try{url=new URL(source,location.href)}catch{return 'load-failed'}
 if(url.origin!==location.origin||!/^https?:$/.test(url.protocol)||url.username||url.password||!url.pathname.startsWith('/api/media/file/'))return 'load-failed'
 const controller=new AbortController(),abort=()=>controller.abort()
 let timedOut=false
 parent.addEventListener('abort',abort,{once:true})
 const timer=setTimeout(()=>{timedOut=true;controller.abort()},DOCUMENT_IMAGE_DIAGNOSTIC_TIMEOUT_MS)
 try{
  const response=await abortableImageWork(()=>fetch(url.href,{method:'HEAD',credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal}),controller.signal)
  if(response.status===404)return 'unavailable'
  if(response.status===401)return 'unauthorized'
  if(response.status===403)return 'forbidden'
  return 'load-failed'
 }catch{
  if(parent.aborted)throw imageLoadAbortError()
  return timedOut?'timeout':'load-failed'
 }finally{clearTimeout(timer);parent.removeEventListener('abort',abort)}
}

/** Four bounded reads at a time; collect useful failures before Fabric enlivens any composition. */
export async function preflightDocumentImages(value:unknown,signal?:AbortSignal):Promise<void>{
 if(signal?.aborted)throw imageLoadAbortError()
 const sources=[...documentImageWorkload(value)];if(!sources.length)return
 const invalidImage=()=>new Error('Una imagen tiene un tamaño o un filtro de resolución no válido. Revisa la imagen antes de abrir la plantilla.')
 if(sources.some(([,work])=>!Number.isFinite(work.factor)||!Number.isFinite(work.peak)))throw invalidImage()
 const controller=new AbortController(),abort=()=>controller.abort()
 signal?.addEventListener('abort',abort,{once:true})
 let index=0,total=0,completed=0,timedOut=false,failure:Error|undefined
 const issues=new Map<number,DocumentImageIssue>()
 const addIssue=(position:number,source:string,reason:DocumentImageIssueReason)=>{
  if(issues.size>=DOCUMENT_IMAGE_ISSUE_LIMIT)return
  issues.set(position,{name:source,reason})
  if(issues.size===DOCUMENT_IMAGE_ISSUE_LIMIT)controller.abort()
 }
 const timeout=setTimeout(()=>{timedOut=true;controller.abort()},DOCUMENT_IMAGE_PREFLIGHT_TIMEOUT_MS)
 try{
  await Promise.all(Array.from({length:Math.min(4,sources.length)},async()=>{
   while(index<sources.length&&!controller.signal.aborted){
    const position=index++,[src,work]=sources[position]
    let image:HTMLImageElement
    try{image=await abortableImageWork(()=>util.loadImage(src,{crossOrigin:'anonymous',signal:controller.signal}),controller.signal)}
    catch{
     if(controller.signal.aborted){if(timedOut)addIssue(position,src,'timeout');return}
     try{
      const reason=await diagnoseImageFailure(src,controller.signal)
      if(controller.signal.aborted){if(timedOut)addIssue(position,src,'timeout');return}
      completed++;addIssue(position,src,reason)
     }catch{if(timedOut)addIssue(position,src,'timeout');return}
     continue
    }
    if(controller.signal.aborted)return
    const pixels=image.naturalWidth*image.naturalHeight
    if(!Number.isFinite(pixels)||image.naturalWidth<=0||image.naturalHeight<=0){failure=invalidImage();controller.abort();return}
    total+=pixels*work.factor
    const error=documentImageBudgetError(total,pixels*work.peak)
    if(error){failure=new Error(error);controller.abort();return}
    completed++
   }
  }))
  // Caller cancellation wins over partially collected diagnostics and deadline failures.
  if(signal?.aborted)throw imageLoadAbortError()
  if(failure)throw failure
  if(issues.size)throw new DocumentImageLoadError([...issues].sort(([a],[b])=>a-b).map(([,issue])=>issue),timedOut||completed<sources.length)
  if(controller.signal.aborted)throw imageLoadAbortError()
 }finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort)}
}
