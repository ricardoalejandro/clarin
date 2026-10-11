'use client'
import {useEffect,useRef,type ReactNode} from 'react'
import {createPortal} from 'react-dom'
import {OPERATIONAL_OVERLAY_LAYERS} from '@/components/operational-overlay/operationalOverlayLayers'
export default function EditorConfirmDialog({title,children,onCancel,actions}:{title:string;children:ReactNode;onCancel:()=>void;actions:ReactNode}){
 const ref=useRef<HTMLDialogElement>(null)
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;ref.current?.showModal();return()=>{ref.current?.close();previous?.isConnected&&previous.focus()}},[])
 return createPortal(<dialog ref={ref} aria-label={title} onCancel={e=>{e.preventDefault();onCancel()}} className="m-auto w-[min(440px,calc(100vw-32px))] rounded-3xl border border-slate-200 bg-white p-6 text-slate-800 shadow-2xl backdrop:bg-slate-950/50 backdrop:backdrop-blur-sm" style={{zIndex:OPERATIONAL_OVERLAY_LAYERS.confirmation}}><h2 className="text-lg font-semibold">{title}</h2><div className="mt-3 text-sm leading-relaxed text-slate-600">{children}</div><div className="mt-6 flex flex-wrap justify-end gap-2">{actions}</div></dialog>,document.body)
}
