'use client'
import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react'
import {createPortal} from 'react-dom'
import {OPERATIONAL_OVERLAY_LAYERS} from '@/components/operational-overlay/operationalOverlayLayers'
export default function EditorPopover({children,onClose,anchor,point,label,menu=false,width=280}:{children:ReactNode;onClose:()=>void;anchor?:HTMLElement|null;point?:{x:number;y:number};label:string;menu?:boolean;width?:number}) {
 const ref=useRef<HTMLDivElement>(null),close=useRef(onClose);close.current=onClose
 const [position,setPosition]=useState({left:8,top:8})
 useLayoutEffect(()=>{
   const update=()=>{
     const r=anchor?.getBoundingClientRect(),v=window.visualViewport
     const w=v?.width||window.innerWidth,h=v?.height||window.innerHeight
     const actualW=Math.min(width,w-16),actualH=Math.min(ref.current?.scrollHeight||300,h-16)
     const x=point?.x??r?.left??8,y=point?.y??r?.bottom??8
     setPosition({left:Math.max(8,Math.min(x,w-actualW-8)),top:Math.max(8,Math.min(y+4,h-actualH-8))})
   }
   update();window.addEventListener('resize',update);window.addEventListener('scroll',update,true)
   const observer=new ResizeObserver(update);if(ref.current)observer.observe(ref.current)
   return()=>{observer.disconnect();window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true)}
 },[anchor,point?.x,point?.y,width])
 useEffect(()=>{
   const previous=document.activeElement as HTMLElement|null
   const frame=requestAnimationFrame(()=>ref.current?.querySelector<HTMLElement>('input,button:not(:disabled),[tabindex="0"]')?.focus())
   const down=(e:PointerEvent)=>{if(!ref.current?.contains(e.target as Node)&&!anchor?.contains(e.target as Node))close.current()}
   const key=(e:KeyboardEvent)=>{
     if(e.key==='Escape'){e.stopPropagation();e.preventDefault();close.current();return}
     if(!menu||!['ArrowUp','ArrowDown','Home','End','Tab'].includes(e.key))return
     const items=[...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')||[])]
     if(!items.length)return
     if(e.key==='Tab'){close.current();return}
     e.preventDefault();const i=items.indexOf(document.activeElement as HTMLButtonElement)
     items[e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowUp'?-1:1)+items.length)%items.length].focus()
   }
   document.addEventListener('pointerdown',down,true);document.addEventListener('keydown',key,true)
   return()=>{cancelAnimationFrame(frame);document.removeEventListener('pointerdown',down,true);document.removeEventListener('keydown',key,true);if(previous?.isConnected)previous.focus()}
 },[anchor,menu])
 return createPortal(<div ref={ref} role={menu?'menu':'dialog'} aria-label={label} data-editor-input className="fixed overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2 text-sm text-slate-800 shadow-xl" style={{...position,width,maxWidth:'calc(100vw - 16px)',maxHeight:'calc(100dvh - 16px)',zIndex:OPERATIONAL_OVERLAY_LAYERS.picker}}>{children}</div>,document.body)
}
