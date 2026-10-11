import {FabricImage,Group,Rect,type Canvas,type FabricObject} from './runtime'
import {ensureObjectIds,isObjectLocked} from './editorModel'
export type NormalizedCrop={x:number;y:number;width:number;height:number}
export function clampCrop(c:NormalizedCrop):NormalizedCrop{
 const width=Math.min(1,Math.max(.01,Number.isFinite(c.width)?c.width:1)),height=Math.min(1,Math.max(.01,Number.isFinite(c.height)?c.height:1))
 return {x:Math.min(1-width,Math.max(0,Number.isFinite(c.x)?c.x:0)),y:Math.min(1-height,Math.max(0,Number.isFinite(c.y)?c.y:0)),width,height}
}
export function cropWithRatio(c:NormalizedCrop,ratio:number|null,sourceW:number,sourceH:number,resizeAxis:'width'|'height'='width'):NormalizedCrop{
 const safe=clampCrop(c);if(!ratio||ratio<=0)return safe
 const normalizedRatio=ratio*sourceH/sourceW
 let width=resizeAxis==='width'?safe.width:safe.height*normalizedRatio,height=width/normalizedRatio
 const scale=Math.min(1,(1-safe.x)/width,(1-safe.y)/height)
 width*=scale;height*=scale
 return {...safe,width,height}
}
export function imageFrameChild(object:FabricObject):FabricImage|null{
 return object instanceof Group&&(object as any).elementType==='image-frame'?(object.getObjects().find(o=>o instanceof FabricImage) as FabricImage||null):null
}
/** Standard Fabric groups keep an independent, transparent frame for contain mode. */
export function applyImageFrameCrop(canvas:Canvas,image:FabricImage,crop:NormalizedCrop,fit:'contain'|'cover',existingFrame?:Group):Group|FabricImage{
 if(isObjectLocked(existingFrame||image))return existingFrame||image
 const size=image.getOriginalSize(),sourceW=size.width,sourceH=size.height,c=clampCrop(crop)
 let x=c.x*sourceW,y=c.y*sourceH,w=c.width*sourceW,h=c.height*sourceH
 const frameW=existingFrame?.width||image.width,frameH=existingFrame?.height||image.height
 let scale=Math[fit==='cover'?'max':'min'](frameW/w,frameH/h)
 if(fit==='cover'){const cropW=frameW/scale,cropH=frameH/scale;x+=(w-cropW)/2;y+=(h-cropH)/2;w=cropW;h=cropH}
 if(existingFrame){
   image.set({left:-frameW/2+(frameW-w*scale)/2,top:-frameH/2+(frameH-h*scale)/2,cropX:x,cropY:y,width:w,height:h,scaleX:scale,scaleY:scale,angle:0,skewX:0,skewY:0,originX:'left',originY:'top',flipX:false,flipY:false})
   image.setCoords();(existingFrame as any).imageFit=fit;existingFrame.dirty=true;canvas.setActiveObject(existingFrame);canvas.requestRenderAll();return existingFrame
 }
 if(fit==='cover'){
   const center=image.getRelativeCenterPoint()
   image.set({cropX:x,cropY:y,width:w,height:h,scaleX:image.scaleX*scale,scaleY:image.scaleY*scale})
   image.setPositionByOrigin(center,'center','center');image.setCoords();canvas.requestRenderAll();return image
 }
 const parent=image.parent,collection=parent||canvas,index=collection.getObjects().indexOf(image)
 const outer={left:image.left,top:image.top,scaleX:image.scaleX,scaleY:image.scaleY,angle:image.angle,skewX:image.skewX,skewY:image.skewY,flipX:image.flipX,flipY:image.flipY,originX:image.originX,originY:image.originY,opacity:image.opacity}
 canvas.discardActiveObject();collection.remove(image)
 image.set({left:(frameW-w*scale)/2,top:(frameH-h*scale)/2,width:w,height:h,cropX:x,cropY:y,scaleX:scale,scaleY:scale,angle:0,skewX:0,skewY:0,flipX:false,flipY:false,originX:'left',originY:'top',opacity:1})
 const frame=new Rect({left:0,top:0,width:frameW,height:frameH,fill:'transparent',strokeWidth:0,selectable:false,evented:false})
 ;(frame as any).elementName='Marco de imagen'
 const group=new Group([frame,image],{...outer,subTargetCheck:true})
 ;(group as any).elementType='image-frame';(group as any).elementName=(image as any).elementName||'Imagen';(group as any).imageFit=fit
 ensureObjectIds([group]);collection.insertAt(Math.max(0,index),group);canvas.setActiveObject(group);canvas.requestRenderAll();return group
}
