import type { Canvas } from 'fabric'
import type { CanvasHistory } from './history'
import { editorInputOwnsKeyboard, editorSelection, isObjectLocked } from './editorModel'
import {editorShortcutCommand,type EditorCommandId} from './editorCommands'

export interface ShortcutActions {
 onCommand?:(id:EditorCommandId)=>void
 onSave?:()=>void;onDelete?:()=>void;onDuplicate?:()=>void;onSelectAll?:()=>void;onGroup?:()=>void;onUngroup?:()=>void;onCopy?:()=>void;onPaste?:()=>void;onDeselect?:()=>void
 onUndo?:()=>void;onRedo?:()=>void;onChanged?:()=>void;onToolSelect?:()=>void;onToolText?:()=>void;onToolRect?:()=>void;onToolCircle?:()=>void;onToolLine?:()=>void;onToolPencil?:()=>void
 isEditingText?:()=>boolean
}
export function setupShortcuts(canvas:Canvas,history:CanvasHistory,actions:ShortcutActions):(e:KeyboardEvent)=>void {
 const handler=(e:KeyboardEvent)=>{
   if(e.isComposing)return
   const key=e.key.toLowerCase(),command=editorShortcutCommand(e)
   const invoke=(action:()=>void)=>{e.preventDefault();action()}
   const run=(id:EditorCommandId)=>{
     if(actions.onCommand)return actions.onCommand(id)
     const legacy:Partial<Record<EditorCommandId,(()=>void)|undefined>>={save:actions.onSave,undo:actions.onUndo||(()=>void history.undo()),redo:actions.onRedo||(()=>void history.redo()),duplicate:actions.onDuplicate,group:actions.onGroup,ungroup:actions.onUngroup,selectAll:actions.onSelectAll,copy:actions.onCopy,paste:actions.onPaste,delete:actions.onDelete,cancel:actions.onDeselect,select:actions.onToolSelect,text:actions.onToolText,rect:actions.onToolRect,circle:actions.onToolCircle,line:actions.onToolLine,pencil:actions.onToolPencil}
     legacy[id]?.()
   }
   // Saving belongs to the document even while its name or text is being edited.
   if(command==='save')return invoke(()=>run(command))
   // Native text editing owns selection, clipboard, Delete, arrows and its history.
   if(editorInputOwnsKeyboard(e.target)||actions.isEditingText?.())return
   if(command)return invoke(()=>run(command))
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
