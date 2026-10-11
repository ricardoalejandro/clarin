'use client'
import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react'
import type {Canvas} from '@/lib/fabric/runtime'
import {normalizeEditorColor} from '@/lib/fabric/editorModel'
type DesignContext={canvas:Canvas|null;recent:string[];remember:(color:string)=>void;pick:(commit:(color:string)=>void)=>void}
const Context=createContext<DesignContext>({canvas:null,recent:[],remember:()=>{},pick:()=>{}})
export const useEditorDesign=()=>useContext(Context)
export default function EditorDesignProvider({canvas,children}:{canvas:Canvas|null;children:ReactNode}){
 const [recent,setRecent]=useState<string[]>([]),[picking,setPicking]=useState(false),[error,setError]=useState('')
 const commit=useRef<((color:string)=>void)|null>(null)
 useEffect(()=>{
  if(!picking||!canvas)return
  const previous=canvas.defaultCursor;canvas.defaultCursor='crosshair';canvas.setCursor('crosshair')
  const cancel=()=>{commit.current=null;setPicking(false)}
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel()}}
  const down=(e:PointerEvent)=>{e.preventDefault();e.stopImmediatePropagation()
    const point=canvas.getScenePoint(e)
    if(point.x<0||point.y<0||point.x>(canvas.__pageWidth||canvas.width)||point.y>(canvas.__pageHeight||canvas.height)){setError('Elige un color dentro de la página.');return}
    try{const rect=canvas.lowerCanvasEl.getBoundingClientRect(),ratio=canvas.lowerCanvasEl.width/rect.width,ctx=canvas.lowerCanvasEl.getContext('2d')!,pixel=ctx.getImageData(Math.floor((e.clientX-rect.left)*ratio),Math.floor((e.clientY-rect.top)*ratio),1,1).data
      const color='#'+[...pixel.slice(0,3)].map(value=>value.toString(16).padStart(2,'0')).join('').toUpperCase()
      commit.current?.(color);cancel()
    }catch{setError('Este recurso externo no permite leer sus colores. Usa el selector hexadecimal.');cancel()}
  }
  canvas.upperCanvasEl.addEventListener('pointerdown',down,true);document.addEventListener('keydown',key,true)
  return()=>{canvas.upperCanvasEl.removeEventListener('pointerdown',down,true);document.removeEventListener('keydown',key,true);canvas.defaultCursor=previous;canvas.setCursor(previous)}
 },[picking,canvas])
 const remember=(value:string)=>{const color=normalizeEditorColor(value);if(color)setRecent(items=>[color,...items.filter(item=>item!==color)].slice(0,10))}
 return <Context.Provider value={{canvas,recent,remember,pick:callback=>{commit.current=callback;setError('');setPicking(true)}}}>{children}{(picking||error)&&<div role={error?'alert':'status'} className="fixed bottom-5 left-1/2 z-[180] flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 shadow-xl"><span>{error||'Haz clic en la página para tomar un color. Esc para cancelar.'}</span><button className="min-h-11 text-emerald-700" onClick={()=>{commit.current=null;setPicking(false);setError('')}}>{error?'Cerrar':'Cancelar'}</button></div>}</Context.Provider>
}
