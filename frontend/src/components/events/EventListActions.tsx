'use client'
import { useState } from 'react'
import { MoreHorizontal, Settings2, Copy, Ban, FolderInput, ListOrdered, BookOpen } from 'lucide-react'
import WorkspaceActionsMenu from '@/components/operational-overlay/WorkspaceActionsMenu'

export function EventListActions({ name, readOnly, busy, configurationOpen = false, onConfigure, onStages, onLogbooks, onDuplicate, onCancel, folders, folderID, onMove }: {
 name:string; readOnly:boolean; busy:boolean; configurationOpen?:boolean; onConfigure:()=>void;onStages:()=>void;onLogbooks:()=>void;onDuplicate:()=>void;onCancel:()=>void;
 folders:{id:string;name:string}[];folderID?:string|null;onMove:(id:string|null)=>void
}) {
 const [anchor,setAnchor]=useState<HTMLElement|null>(null)
 const [moving,setMoving]=useState(false)
 const close=()=>{setAnchor(null);setMoving(false)}
 const action=(run:()=>void)=>()=>{close();run()}
 const style="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm text-slate-600 hover:bg-slate-50 focus-visible:bg-slate-50 disabled:opacity-40"
 return <>
  <button type="button" onClick={e=>{e.stopPropagation();setAnchor(e.currentTarget)}} aria-label={`Acciones de ${name}`} aria-haspopup="menu" aria-expanded={!!anchor} className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"><MoreHorizontal className="h-4 w-4"/></button>
  <WorkspaceActionsMenu anchor={anchor} id="event-actions" label={`Acciones de ${name}`} onClose={close}>
   {moving ? <>
    <button role="menuitem" className={style} onClick={()=>setMoving(false)}>← Acciones del evento</button>
    {folderID && <button role="menuitem" className={style} onClick={action(()=>onMove(null))}>Sin carpeta</button>}
    {folders.filter(f=>f.id!==folderID).map(f=><button role="menuitem" key={f.id} className={style} onClick={action(()=>onMove(f.id))}>{f.name}</button>)}
    {!folders.some(f=>f.id!==folderID)&&!folderID&&<p className="px-3 py-2 text-xs text-slate-500">Crea una carpeta para organizar tus eventos.</p>}
   </> : <>
    <button role="menuitem" className={style} disabled={readOnly || configurationOpen} title={configurationOpen ? 'Cierra la configuración abierta para editar otro evento' : undefined} onClick={action(onConfigure)}><Settings2 className="h-4 w-4"/>Configurar evento</button>
    <button role="menuitem" className={style} disabled={readOnly || configurationOpen} title={configurationOpen ? 'Cierra la configuración abierta para editar otro evento' : undefined} onClick={action(onStages)}><ListOrdered className="h-4 w-4"/>Organizar etapas</button>
    <button role="menuitem" className={style} disabled={configurationOpen} title={configurationOpen ? "Cierra la configuración abierta antes de navegar" : undefined} onClick={action(onLogbooks)}><BookOpen className="h-4 w-4"/>Bitácoras</button>
    <div className="my-1 border-t border-slate-100"/>
    <button role="menuitem" className={style} onClick={()=>setMoving(true)}><FolderInput className="h-4 w-4"/>Mover a carpeta</button>
    <button role="menuitem" className={style} disabled={busy || configurationOpen} title={configurationOpen ? "Cierra la configuración abierta antes de duplicar" : undefined} onClick={action(onDuplicate)}><Copy className="h-4 w-4"/>Duplicar</button>
    <button role="menuitem" className={style+" text-red-600"} disabled={readOnly || busy} title={readOnly ? "Este evento ya está cerrado y conserva su historial" : undefined} onClick={action(onCancel)}><Ban className="h-4 w-4"/>Cancelar evento</button>
   </>}
  </WorkspaceActionsMenu>
 </>
}
