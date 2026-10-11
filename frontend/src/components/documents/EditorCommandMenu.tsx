'use client'
import {useEffect,useRef,useState} from 'react'
import {ChevronLeft,ChevronRight} from 'lucide-react'
import {editorMenuItems,resolveEditorCommand,type EditorCommandState,type EditorCommandId,type EditorMenuSection} from '@/lib/fabric/editorCommands'
import EditorPopover from './EditorPopover'
import EditorCommandIcon from './EditorCommandIcon'
export default function EditorCommandMenu({state,point,documentActions,onClose,onCommand}:{state:EditorCommandState;point:{x:number;y:number};documentActions:boolean;onClose:()=>void;onCommand:(id:EditorCommandId)=>void}){
 const [section,setSection]=useState<EditorMenuSection>('root'),content=useRef<HTMLDivElement>(null)
 useEffect(()=>{const frame=requestAnimationFrame(()=>content.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());return()=>cancelAnimationFrame(frame)},[section])
 const title=section==='align'?'Alinear':section==='arrange'?'Ordenar':section==='document'?'Documento':state.image?'Imagen':state.count?state.count===1?'Objeto':state.count+' objetos':'Lienzo'
 return <EditorPopover point={point} menu label="Acciones de la plantilla" onClose={onClose} width={288}><div ref={content} onKeyDown={event=>{if(event.key==='ArrowLeft'&&section!=='root'){event.preventDefault();event.stopPropagation();setSection('root')}}}>
 <div className="flex min-h-8 items-center gap-2 px-2 text-xs font-semibold text-slate-500">{section!=='root'&&<button role="menuitem" aria-label="Volver a acciones" onClick={()=>setSection('root')} className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-slate-100"><ChevronLeft className="h-4 w-4"/></button>}<span>{title}</span>{section==='align'&&<span className="ml-auto font-normal">{state.count===1||state.alignToPage?'En página':'En selección'}</span>}</div>
 {editorMenuItems(state,section,documentActions).map((entry,index)=>{
  if(entry.kind==='separator')return <div key={'separator-'+index} role="separator" className="my-1 border-t border-slate-100"/>
  if(entry.kind==='submenu')return <button role="menuitem" aria-haspopup="menu" aria-expanded="false" key={entry.id} onClick={()=>setSection(entry.id)} onKeyDown={event=>{if(event.key==='ArrowRight'){event.preventDefault();setSection(entry.id)}}} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-slate-100 focus-visible:bg-emerald-50 focus-visible:outline-none"><EditorCommandIcon name={entry.icon}/><span className="flex-1">{entry.label}</span><ChevronRight className="h-4 w-4 text-slate-400"/></button>
  const command=resolveEditorCommand(entry.id,state)
  return <button role="menuitem" key={entry.id} disabled={command.disabled} onClick={()=>{onCommand(entry.id);onClose()}} className={'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-slate-100 focus-visible:bg-emerald-50 focus-visible:outline-none disabled:opacity-40 '+(entry.id==='delete'||entry.id==='deleteTemplate'?'text-rose-700':'')}><EditorCommandIcon name={command.icon}/><span className="flex-1">{command.label}</span>{command.shortcut&&<span className="text-[11px] text-slate-400">{command.shortcut}</span>}</button>
 })}
 </div></EditorPopover>
}
