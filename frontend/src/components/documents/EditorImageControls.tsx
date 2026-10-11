'use client'
import {useRef,useState} from 'react'
import {Crop,FlipHorizontal2,FlipVertical2,RotateCw,SlidersHorizontal} from 'lucide-react'
import type {FabricImage,Canvas,Group} from '@/lib/fabric/runtime'
import EditorPopover from './EditorPopover'
import {clampCrop,cropWithRatio,applyImageFrameCrop,type NormalizedCrop as CropRect} from '@/lib/fabric/imageFrame'
export default function EditorImageControls({image,frame,canvas,onCommit}:{image:FabricImage;frame?:Group;canvas:Canvas|null;onCommit:()=>void}){
 const anchor=useRef<HTMLButtonElement>(null),[open,setOpen]=useState(false)
 const update=(props:Record<string,unknown>)=>{const target=frame||image;if(target.lockMovementX)return;target.set(props);target.setCoords();canvas?.requestRenderAll();onCommit()}
 return <div className="space-y-2">
 <button ref={anchor} type="button" onClick={()=>setOpen(true)} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-sm"><Crop className="h-4 w-4"/> Recortar y ajustar</button>
 <div className="grid grid-cols-3 gap-1">{[
 {label:'Voltear horizontal',icon:FlipHorizontal2,run:()=>update({flipX:!(frame||image).flipX})},
 {label:'Voltear vertical',icon:FlipVertical2,run:()=>update({flipY:!(frame||image).flipY})},
 {label:'Girar 90°',icon:RotateCw,run:()=>update({angle:(((frame||image).angle||0)+90)%360})},
 ].map(({label,icon:Icon,run})=><button key={label} title={label} aria-label={label} onClick={run} className="flex min-h-11 items-center justify-center rounded-xl border border-slate-200 hover:bg-slate-50"><Icon className="h-4 w-4"/></button>)}</div>
 {open&&<ImageDraft image={image} frame={frame} canvas={canvas} anchor={anchor.current} onClose={()=>setOpen(false)} onCommit={onCommit}/>}
 </div>
}
function ImageDraft({image,frame,canvas,anchor,onClose,onCommit}:{image:FabricImage;frame?:Group;canvas:Canvas|null;anchor:HTMLElement|null;onClose:()=>void;onCommit:()=>void}){
 const size=image.getOriginalSize(),sw=size.width||1,sh=size.height||1
 const [crop,setCrop]=useState<CropRect>(()=>clampCrop({x:(image.cropX||0)/sw,y:(image.cropY||0)/sh,width:image.width/sw,height:image.height/sh}))
 const [ratio,setRatio]=useState<number|null>(null),[fit,setFit]=useState<'cover'|'contain'>((frame as any)?.imageFit||'cover')
 const original=(name:string,key:string)=>Number((image.filters.find(f=>f.type===name) as any)?.[key]||0)
 const [brightness,setBrightness]=useState(()=>original('Brightness','brightness')),[contrast,setContrast]=useState(()=>original('Contrast','contrast')),[saturation,setSaturation]=useState(()=>original('Saturation','saturation'))
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 const preview=useRef<HTMLDivElement>(null),gesture=useRef<{startX:number;startY:number;crop:CropRect;mode:'move'|'resize'}|null>(null)
 const start=(e:React.PointerEvent,mode:'move'|'resize')=>{e.preventDefault();e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId);gesture.current={startX:e.clientX,startY:e.clientY,crop,mode}}
 const move=(e:React.PointerEvent)=>{
   const g=gesture.current,r=preview.current?.getBoundingClientRect();if(!g||!r)return
   const dx=(e.clientX-g.startX)/r.width,dy=(e.clientY-g.startY)/r.height
   setCrop(g.mode==='move'?clampCrop({...g.crop,x:g.crop.x+dx,y:g.crop.y+dy}):cropWithRatio({...g.crop,width:Math.min(1-g.crop.x,g.crop.width+dx),height:Math.min(1-g.crop.y,g.crop.height+dy)},ratio,sw,sh))
 }
 const apply=async()=>{if(image.lockMovementX)return;setBusy(true);try{
   const {filters}=await import('@/lib/fabric/runtime')
   if(!canvas)return
   const previousFilters=image.filters
   image.filters=[...previousFilters.filter(f=>!['Brightness','Contrast','Saturation'].includes(f.type)),new filters.Brightness({brightness}),new filters.Contrast({contrast}),new filters.Saturation({saturation})]
   try{image.applyFilters()}catch(error){image.filters=previousFilters;image.applyFilters();throw error}
   applyImageFrameCrop(canvas,image,crop,fit,frame)
   image.setCoords();canvas?.requestRenderAll();onCommit();onClose()
 }catch{setError('No se pudo aplicar el ajuste. Conserva el borrador y vuelve a intentarlo.')}finally{setBusy(false)}}
 return <EditorPopover label="Editar imagen" anchor={anchor} onClose={onClose} width={410}><div className="space-y-3 p-2">
 <div className="flex items-center justify-between"><h3 className="font-semibold">Recorte y ajustes</h3><span className="text-xs text-slate-500">Original conservado</span></div>
 <div ref={preview} className="relative overflow-hidden rounded-lg bg-slate-100" style={{aspectRatio:sw/sh,width:Math.min(350,260*sw/sh),maxWidth:"100%",margin:"0 auto"}}>
 <img src={image.getSrc()} alt="Vista previa de recorte" draggable={false} className="h-full w-full object-fill" style={{filter:`brightness(${1+brightness}) contrast(${1+contrast}) saturate(${1+saturation})`}}/>
 <div role="group" aria-label="Área de recorte" className="absolute touch-none cursor-move border-2 border-white ring-1 ring-emerald-600" style={{left:crop.x*100+'%',top:crop.y*100+'%',width:crop.width*100+'%',height:crop.height*100+'%',boxShadow:'0 0 0 999px rgba(15,23,42,.48)'}} onPointerDown={e=>start(e,'move')} onPointerMove={move} onPointerUp={()=>gesture.current=null} onPointerCancel={()=>gesture.current=null}>
 <button type="button" aria-label="Cambiar tamaño del recorte" className="absolute -bottom-3 -right-3 h-11 w-11 touch-none cursor-se-resize rounded-full border-2 border-white bg-emerald-600" onPointerDown={e=>start(e,'resize')} onPointerMove={move} onPointerUp={()=>gesture.current=null} onPointerCancel={()=>gesture.current=null}/>
 </div></div>
 <div className="flex flex-wrap gap-1">{[{label:'Libre',ratio:null},{label:'Original',ratio:sw/sh},{label:'1:1',ratio:1},{label:'4:3',ratio:4/3},{label:'16:9',ratio:16/9}].map(p=><button key={p.label} onClick={()=>{setRatio(p.ratio);if(!p.ratio)return;const aspect=p.ratio*sh/sw;const w=Math.min(1,aspect),h=w/aspect;setCrop({x:(1-w)/2,y:(1-h)/2,width:w,height:h})}} className="min-h-9 rounded-lg border border-slate-200 px-2 text-xs">{p.label}</button>)}<button onClick={()=>{setRatio(null);setCrop({x:0,y:0,width:1,height:1})}} className="min-h-9 px-2 text-xs text-emerald-700">Restablecer recorte</button></div>
 <div className="grid grid-cols-4 gap-2">{(['x','y','width','height']as const).map((key,i)=><label key={key} className="text-xs text-slate-500">{['X %','Y %','Ancho %','Alto %'][i]}<input type="number" aria-label={['Posición X del recorte','Posición Y del recorte','Ancho del recorte','Alto del recorte'][i]} min={key==='x'||key==='y'?0:1} max={100} value={Math.round(crop[key]*100)} onChange={e=>setCrop(cropWithRatio({...crop,[key]:Number(e.target.value)/100},ratio,sw,sh,key==='height'?'height':'width'))} className="mt-1 h-10 w-full rounded-lg border border-slate-200 px-2 text-slate-800"/></label>)}</div>
 <div className="grid grid-cols-2 gap-2">{([{value:"cover",label:"Rellenar marco"},{value:"contain",label:"Encajar en marco"}] as const).map(option=><button key={option.value} aria-pressed={fit===option.value} onClick={()=>setFit(option.value)} className={"min-h-11 rounded-xl border px-3 text-xs "+(fit===option.value?"border-emerald-300 bg-emerald-50 text-emerald-800":"border-slate-200")}>{option.label}</button>)}</div><p className="text-xs text-slate-500">El tamaño del marco se conserva. Rellenar recorta los bordes; encajar deja espacio transparente sin deformar.</p>
 <h4 className="flex items-center gap-2 text-sm font-semibold"><SlidersHorizontal className="h-4 w-4"/> Ajustes</h4>
 {[{label:'Brillo',value:brightness,set:setBrightness},{label:'Contraste',value:contrast,set:setContrast},{label:'Saturación',value:saturation,set:setSaturation}].map(a=><label key={a.label} className="grid grid-cols-[80px_1fr_40px] items-center gap-2 text-xs">{a.label}<input type="range" aria-label={a.label} min={-1} max={1} step={.01} value={a.value} onChange={e=>a.set(Number(e.target.value))} className="accent-emerald-600"/><span>{Math.round(a.value*100)}</span></label>)}
 <button className="text-xs text-emerald-700" onClick={()=>{setBrightness(0);setContrast(0);setSaturation(0)}}>Restablecer ajustes</button>
 {error&&<p role="alert" className="text-xs text-rose-700">{error}</p>}<div className="flex justify-end gap-2 border-t border-slate-100 pt-3"><button onClick={onClose} className="min-h-11 rounded-xl border border-slate-200 px-4">Cancelar</button><button disabled={busy} onClick={apply} className="min-h-11 rounded-xl bg-emerald-600 px-4 text-white disabled:opacity-50">{busy?'Aplicando…':'Aplicar'}</button></div>
 </div></EditorPopover>
}
