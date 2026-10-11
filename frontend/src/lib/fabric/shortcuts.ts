import type { Canvas } from 'fabric'
import type { CanvasHistory } from './history'
import { editorInputOwnsKeyboard, editorSelection, isObjectLocked } from './editorModel'

export interface ShortcutActions {
 onSave:()=>void;onDelete:()=>void;onDuplicate:()=>void;onSelectAll:()=>void;onGroup:()=>void;onUngroup:()=>void;onCopy:()=>void;onPaste:()=>void;onDeselect:()=>void
 onUndo?:()=>void;onRedo?:()=>void;onChanged?:()=>void;onToolSelect?:()=>void;onToolText?:()=>void;onToolRect?:()=>void;onToolCircle?:()=>void;onToolLine?:()=>void;onToolPencil?:()=>void
 isEditingText?:()=>boolean
}
export function setupShortcuts(canvas:Canvas,history:CanvasHistory,actions:ShortcutActions):(e:KeyboardEvent)=>void {
 const handler=(e:KeyboardEvent)=>{
   if(e.isComposing)return
   const ctrl=e.ctrlKey||e.metaKey,key=e.key.toLowerCase()
   const invoke=(action:()=>void)=>{e.preventDefault();action()}
   // Saving belongs to the document even while its name or text is being edited.
   if(ctrl&&key==='s')return invoke(actions.onSave)
   // Native text editing owns selection, clipboard, Delete, arrows and its history.
   if(editorInputOwnsKeyboard(e.target)||actions.isEditingText?.())return
   if(ctrl){
     if(key==='z')return invoke(e.shiftKey?(actions.onRedo||(()=>void history.redo())):(actions.onUndo||(()=>void history.undo())))
     if(key==='y')return invoke(actions.onRedo||(()=>void history.redo()))
     if(key==='d')return invoke(actions.onDuplicate)
     if(key==='g')return invoke(e.shiftKey?actions.onUngroup:actions.onGroup)
     if(key==='a')return invoke(actions.onSelectAll)
     if(key==='c')return invoke(actions.onCopy)
     if(key==='v')return invoke(actions.onPaste)
   }
   if(key==='delete'||key==='backspace')return invoke(actions.onDelete)
   if(key==='escape')return invoke(actions.onDeselect)
   if(!ctrl&&!e.altKey){
     const tools:Record<string,(()=>void)|undefined>={v:actions.onToolSelect,t:actions.onToolText,r:actions.onToolRect,c:actions.onToolCircle,l:actions.onToolLine,b:actions.onToolPencil}
     if(tools[key])return invoke(tools[key]!)
   }
   if(['arrowup','arrowdown','arrowleft','arrowright'].includes(key)){
     const objects=editorSelection(canvas)
     if(!objects.length||objects.some(isObjectLocked))return
     invoke(()=>{
       const active=canvas.getActiveObject()!;const step=e.shiftKey?10:1
       active.set(key==='arrowup'||key==='arrowdown'?'top':'left',(key==='arrowup'||key==='arrowdown'?(active.top||0):(active.left||0))+(key==='arrowup'||key==='arrowleft'?-step:step))
       active.setCoords();canvas.requestRenderAll();history.save();actions.onChanged?.()
     })
   }
 }
 document.addEventListener('keydown',handler)
 return handler
}

/** Run inside React flushSync before capturing a save, including blur-committed fields. */
export function commitFocusedEditorDraft(canvas:Canvas,root?:HTMLElement|null):void{
 const object=canvas.getActiveObject() as (ReturnType<Canvas['getActiveObject']>&{isEditing?:boolean;updateFromTextArea?:()=>void;exitEditing?:()=>void})
 if(object?.isEditing){object.updateFromTextArea?.();object.exitEditing?.()}
 const active=document.activeElement
 if(active instanceof HTMLElement&&(!root||root.contains(active))&&editorInputOwnsKeyboard(active))active.blur()
}
