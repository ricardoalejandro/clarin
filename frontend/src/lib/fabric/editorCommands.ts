/** Shared editor command contract. No DOM, React or Fabric dependencies. */
export interface EditorCommandState {
 ready:boolean;busy:boolean;saving:boolean;count:number;objectCount:number;locked:boolean;allLocked:boolean;image:boolean;group:boolean;clipboard:boolean;canUndo:boolean;canRedo:boolean;alignToPage:boolean
}
export type EditorCommandIcon='save'|'undo'|'redo'|'select'|'hand'|'text'|'rect'|'circle'|'triangle'|'line'|'pencil'|'image'|'copy'|'paste'|'group'|'ungroup'|'front'|'back'|'up'|'down'|'lock'|'unlock'|'delete'|'crop'|'replace'|'align'|'left'|'centerH'|'right'|'top'|'centerV'|'bottom'|'distributeH'|'distributeV'|'fit'|'zoomIn'|'zoomOut'|'grid'|'rulers'|'margins'|'export'|'document'
type Definition={toolbarLabel?:string;label:string|((s:EditorCommandState)=>string);icon:EditorCommandIcon;shortcut?:string;available?:(s:EditorCommandState)=>boolean;mutates?:boolean}
const selected=(s:EditorCommandState)=>s.count>0
const mutable=(s:EditorCommandState)=>selected(s)&&!s.locked
const image=(s:EditorCommandState)=>s.image&&!s.locked
export const EDITOR_COMMANDS={
 save:{label:'Guardar',icon:'save',shortcut:'Ctrl+S',available:(s)=>!s.saving},
 undo:{label:'Deshacer',icon:'undo',shortcut:'Ctrl+Z',available:s=>s.canUndo,mutates:true},
 redo:{label:'Rehacer',icon:'redo',shortcut:'Ctrl+Mayús+Z',available:s=>s.canRedo,mutates:true},
 select:{label:'Seleccionar',icon:'select',shortcut:'V'},hand:{label:'Mover lienzo',icon:'hand',shortcut:'Espacio'},
 text:{toolbarLabel:'Texto',label:'Insertar texto',icon:'text',shortcut:'T',mutates:true},
 rect:{toolbarLabel:'Rectángulo',label:'Insertar rectángulo',icon:'rect',shortcut:'R',mutates:true},
 circle:{toolbarLabel:'Círculo',label:'Insertar círculo',icon:'circle',shortcut:'C',mutates:true},
 triangle:{toolbarLabel:'Triángulo',label:'Insertar triángulo',icon:'triangle',mutates:true},
 line:{toolbarLabel:'Línea',label:'Insertar línea',icon:'line',shortcut:'L',mutates:true},
 pencil:{label:'Dibujo libre',icon:'pencil',shortcut:'B',mutates:true},
 image:{label:'Insertar imagen',icon:'image',mutates:true},
 copy:{label:'Copiar',icon:'copy',shortcut:'Ctrl+C',available:selected},
 paste:{label:'Pegar aquí',icon:'paste',shortcut:'Ctrl+V',available:s=>s.clipboard,mutates:true},
 duplicate:{label:'Duplicar',icon:'copy',shortcut:'Ctrl+D',available:mutable,mutates:true},
 group:{label:'Agrupar',icon:'group',shortcut:'Ctrl+G',available:s=>s.count>1&&!s.locked,mutates:true},
 ungroup:{label:'Desagrupar',icon:'ungroup',shortcut:'Ctrl+Mayús+G',available:s=>s.group&&!s.locked,mutates:true},
 front:{label:'Traer al frente',icon:'front',available:mutable,mutates:true},
 back:{label:'Enviar al fondo',icon:'back',available:mutable,mutates:true},
 forward:{label:'Adelantar',icon:'up',available:mutable,mutates:true},
 backward:{label:'Retroceder',icon:'down',available:mutable,mutates:true},
 lock:{label:s=>s.allLocked?'Desbloquear':'Bloquear',icon:'lock',available:selected,mutates:true},
 delete:{label:'Eliminar selección',icon:'delete',shortcut:'Supr',available:mutable,mutates:true},
 crop:{label:'Recortar y ajustar',icon:'crop',available:image,mutates:true},
 replace:{label:'Reemplazar imagen',icon:'replace',available:image,mutates:true},
 alignTarget:{label:s=>s.alignToPage?'Alinear a la selección':'Alinear a la página',icon:'align',available:s=>s.count>1&&!s.locked},
 alignLeft:{label:'Alinear a la izquierda',icon:'left',available:mutable,mutates:true},
 alignCenterH:{label:'Centrar horizontalmente',icon:'centerH',available:mutable,mutates:true},
 alignRight:{label:'Alinear a la derecha',icon:'right',available:mutable,mutates:true},
 alignTop:{label:'Alinear arriba',icon:'top',available:mutable,mutates:true},
 alignCenterV:{label:'Centrar verticalmente',icon:'centerV',available:mutable,mutates:true},
 alignBottom:{label:'Alinear abajo',icon:'bottom',available:mutable,mutates:true},
 distributeH:{label:'Distribuir horizontalmente',icon:'distributeH',available:s=>s.count>=3&&!s.locked,mutates:true},
 distributeV:{label:'Distribuir verticalmente',icon:'distributeV',available:s=>s.count>=3&&!s.locked,mutates:true},
 selectAll:{label:'Seleccionar todo',icon:'select',shortcut:'Ctrl+A',available:s=>s.objectCount>0},
 fit:{label:'Ajustar página',icon:'fit'},
 zoomIn:{label:'Acercar',icon:'zoomIn'},zoomOut:{label:'Alejar',icon:'zoomOut'},zoom100:{label:'Restablecer zoom al 100%',icon:'fit'},
 grid:{label:'Grilla',icon:'grid'},rulers:{label:'Reglas',icon:'rulers'},margins:{label:'Márgenes',icon:'margins'},
 export:{label:'Exportar',icon:'export'},
 saveCopy:{label:'Guardar como copia',icon:'copy',available:s=>!s.saving},
 deleteTemplate:{label:'Eliminar plantilla…',icon:'delete',available:s=>!s.saving},
 cancel:{label:'Cancelar selección o gesto',icon:'select'},
} satisfies Record<string,Definition>
export type EditorCommandId=keyof typeof EDITOR_COMMANDS
export interface EditorCommandInvocation{point?:{x:number;y:number}}
export type EditorCommandHandlers=Record<EditorCommandId,(invocation:EditorCommandInvocation)=>unknown>
export function resolveEditorCommand(id:EditorCommandId,state:EditorCommandState){
 const definition:Definition=EDITOR_COMMANDS[id]
 return {id,toolbarLabel:definition.toolbarLabel,label:typeof definition.label==='function'?definition.label(state):definition.label,icon:id==='lock'&&state.allLocked?'unlock' as const:definition.icon,shortcut:definition.shortcut,
  disabled:id==='cancel'?false:!state.ready||state.busy||!!definition.available&&!definition.available(state)}
}
/** Every entry point rechecks the current state, not the menu's rendered snapshot. */
export function executeEditorCommand(id:EditorCommandId,state:EditorCommandState,handlers:EditorCommandHandlers,invocation:EditorCommandInvocation={}){
 if(resolveEditorCommand(id,state).disabled)return false
 return handlers[id](invocation)
}
export type EditorMenuSection='root'|'align'|'arrange'|'document'
export type EditorMenuItem={kind:'command';id:EditorCommandId}|{kind:'submenu';id:Exclude<EditorMenuSection,'root'>;label:string;icon:EditorCommandIcon}|{kind:'separator'}
export function editorMenuItems(s:EditorCommandState,section:EditorMenuSection='root',documentActions=false):EditorMenuItem[]{
 const command=(id:EditorCommandId):EditorMenuItem=>({kind:'command',id}),separator:EditorMenuItem={kind:'separator'}
 if(section==='document')return [command('saveCopy'),command('export'),separator,command('deleteTemplate')]
 if(section==='arrange')return ['front','forward','backward','back'].map(id=>command(id as EditorCommandId))
 if(section==='align')return [...(s.count>1?[command('alignTarget'),separator]:[]),...['alignLeft','alignCenterH','alignRight','alignTop','alignCenterV','alignBottom'].map(id=>command(id as EditorCommandId)),...(s.count>=3?[separator,command('distributeH'),command('distributeV')]:[])]
 const groups:EditorMenuItem[][]=[]
 if(!s.count){
  groups.push(['text','rect','image'].map(id=>command(id as EditorCommandId)))
  if(s.clipboard)groups.push([command('paste')])
  groups.push([...(s.objectCount?[command('selectAll')]:[]),command('fit')])
 }else{
  if(s.image&&!s.locked)groups.push([command('crop'),command('replace')])
  groups.push([command('copy'),...(s.clipboard?[command('paste')]:[]),...(!s.locked?[command('duplicate')]:[])])
  if(!s.locked)groups.push([...(s.count>1?[command('group')]:s.group?[command('ungroup')]:[]),{kind:'submenu',id:'align',label:'Alinear',icon:'align'},{kind:'submenu',id:'arrange',label:'Ordenar',icon:'front'}])
  groups.push([command('lock'),...(!s.locked?[command('delete')]:[])])
 }
 if(documentActions)groups.push([{kind:'submenu',id:'document',label:'Documento',icon:'document'}])
 return groups.filter(g=>g.length).flatMap((group,index)=>index?[separator,...group]:group)
}
export function editorShortcutCommand(e:Pick<KeyboardEvent,'key'|'ctrlKey'|'metaKey'|'altKey'|'shiftKey'>):EditorCommandId|undefined{
 const key=e.key.toLowerCase()
 if(e.ctrlKey||e.metaKey)return ({s:'save',z:e.shiftKey?'redo':'undo',y:'redo',d:'duplicate',g:e.shiftKey?'ungroup':'group',a:'selectAll',c:'copy',v:'paste'} as Record<string,EditorCommandId>)[key]
 if(key==='delete'||key==='backspace')return 'delete'
 if(key==='escape')return 'cancel'
 if(!e.altKey)return ({v:'select',t:'text',r:'rect',c:'circle',l:'line',b:'pencil'} as Record<string,EditorCommandId>)[key]
}
