'use client'
import {useState} from 'react'
import {ChevronRight,Eye,EyeOff,Lock,Unlock,GripVertical,ArrowUp,ArrowDown,Type,Image as ImageIcon,Layers,Square} from 'lucide-react'
import type {Canvas,FabricObject} from '@/lib/fabric/runtime'
import {Group,ActiveSelection} from '@/lib/fabric/runtime'
import {applyObjectLock,ensureObjectIds,isObjectLocked} from '@/lib/fabric/editorModel'
export default function EditorLayers({objects,selected,canvas,onChange,onEditGroup}:{objects:FabricObject[];selected:FabricObject[];canvas:Canvas|null;onChange:()=>void;onEditGroup:(group:FabricObject|null)=>void}){
 const [expanded,setExpanded]=useState<Set<string>>(new Set()),[renaming,setRenaming]=useState<string|null>(null),[dragged,setDragged]=useState<FabricObject|null>(null)
 const select=(object:FabricObject)=>{
   if(!canvas)return
   while(object.parent&&isObjectLocked(object.parent))object=object.parent
   if(object.parent){let parent=object.parent;while(parent){parent.set({interactive:true,subTargetCheck:true});parent=parent.parent!}onEditGroup(object.parent)}
   canvas.setActiveObject(object);canvas.requestRenderAll()
 }
 const reorder=(object:FabricObject,direction:number)=>{
   if(!canvas||isObjectLocked(object))return
   const collection=object.parent||canvas,index=collection.getObjects().indexOf(object)
   collection.moveObjectTo(object,Math.max(object.parent?0:canvas.getObjects().filter(o=>(o as any).__isPage||(o as any).__isDocumentBackground).length,index+direction))
   canvas.requestRenderAll();onChange()
 }
 const row=(object:FabricObject,depth=0):React.ReactNode=>{
   ensureObjectIds([object])
   const id=(object as any).objectId as string,isGroup=object instanceof Group&&!(object instanceof ActiveSelection),open=expanded.has(id)
   const name=(object as any).elementName||(object as any).text?.slice(0,30)||(isGroup?'Grupo':object.type==='image'?'Imagen':object.type==='path'?'Trazo':'Elemento')
   const Icon=isGroup?Layers:(object as any).text!==undefined?Type:object.type.toLowerCase().includes('image')?ImageIcon:Square
   return <div key={id} role="treeitem" aria-selected={selected.includes(object)} aria-expanded={isGroup?open:undefined}>
   <div onClick={()=>select(object)} onDoubleClick={()=>setRenaming(id)} className={`group flex min-h-11 items-center gap-1 rounded-xl px-1 text-xs ${selected.includes(object)?'bg-emerald-50 text-emerald-800':'text-slate-700 hover:bg-slate-50'}`} style={{paddingLeft:depth*14+4}} onDragOver={e=>{if(dragged&&dragged.parent===object.parent){e.preventDefault();e.dataTransfer.dropEffect='move'}}} onDrop={e=>{e.preventDefault();if(!dragged||dragged===object||dragged.parent!==object.parent||isObjectLocked(dragged))return;const collection=object.parent||canvas;if(collection){collection.moveObjectTo(dragged,collection.getObjects().indexOf(object));canvas?.requestRenderAll();onChange()}setDragged(null)}}>
    <button draggable={!isObjectLocked(object)} aria-label={'Mover capa '+name} title="Arrastrar para ordenar" onDragStart={e=>{setDragged(object);e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',id)}} onDragEnd={()=>setDragged(null)} onClick={e=>e.stopPropagation()} className="flex h-8 w-5 shrink-0 cursor-grab items-center justify-center text-slate-400"><GripVertical className="h-3 w-3"/></button>
    {isGroup&&<button aria-label={open?'Contraer grupo':'Expandir grupo'} onClick={e=>{e.stopPropagation();setExpanded(prev=>{const next=new Set(prev);if(next.has(id))next.delete(id);else next.add(id);return next})}} className="flex h-8 w-5 shrink-0 items-center"><ChevronRight className={`h-3 w-3 ${open?'rotate-90':''}`}/></button>}
    <Icon className="h-3.5 w-3.5 shrink-0"/>
    {renaming===id?<input autoFocus aria-label="Nombre de capa" defaultValue={name} onClick={e=>e.stopPropagation()} onBlur={e=>{(object as any).elementName=e.target.value.trim()||name;setRenaming(null);onChange()}} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();if(e.key==='Escape')setRenaming(null)}} className="h-8 min-w-0 flex-1 rounded border border-emerald-300 px-1"/>:<button onClick={()=>select(object)} className="min-w-0 flex-1 truncate text-left" title={name}>{name}</button>}
    <button aria-label={object.visible?'Ocultar '+name:'Mostrar '+name} onClick={e=>{e.stopPropagation();object.set('visible',!object.visible);canvas?.requestRenderAll();onChange()}} className="flex h-8 w-7 shrink-0 items-center justify-center">{object.visible?<Eye className="h-3.5 w-3.5"/>:<EyeOff className="h-3.5 w-3.5"/>}</button>
    <button aria-label={object.lockMovementX?'Desbloquear '+name:'Bloquear '+name} onClick={e=>{e.stopPropagation();applyObjectLock(object,!object.lockMovementX);canvas?.requestRenderAll();onChange()}} className="flex h-8 w-7 shrink-0 items-center justify-center">{object.lockMovementX?<Lock className="h-3.5 w-3.5 text-amber-600"/>:<Unlock className="h-3.5 w-3.5"/>}</button>
   </div>
   {selected.includes(object)&&<div className="mb-1 flex justify-end gap-1 px-1"><button aria-label="Subir capa" onClick={()=>reorder(object,1)} className="flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs text-slate-600 hover:bg-slate-100"><ArrowUp className="h-3 w-3"/>Subir</button><button aria-label="Bajar capa" onClick={()=>reorder(object,-1)} className="flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs text-slate-600 hover:bg-slate-100"><ArrowDown className="h-3 w-3"/>Bajar</button></div>}
   {isGroup&&open&&<div role="group">{[...object.getObjects()].reverse().map(o=>row(o,depth+1))}</div>}
   </div>
 }
 return <div role="tree" aria-label="Capas del documento">{objects.length?[...objects].reverse().map(o=>row(o)):<div className="px-3 py-8 text-center text-sm text-slate-500"><Layers className="mx-auto mb-3 h-8 w-8 text-slate-300"/>Añade texto, formas o imágenes.<p className="mt-1 text-xs">Aquí podrás organizar cada elemento.</p></div>}</div>
}
