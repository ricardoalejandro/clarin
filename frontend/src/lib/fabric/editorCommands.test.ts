import {describe,it,expect,vi} from 'vitest'
import {EDITOR_COMMANDS,editorMenuItems,resolveEditorCommand,executeEditorCommand,editorShortcutCommand,type EditorCommandHandlers,type EditorCommandState} from './editorCommands'
import {selectionPaintCapabilities} from './selectionStyle'
const base:EditorCommandState={ready:true,busy:false,saving:false,count:0,objectCount:0,locked:false,allLocked:false,image:false,group:false,clipboard:false,canUndo:false,canRedo:false,alignToPage:false}
const ids=(state:EditorCommandState,documentActions=false)=>editorMenuItems(state,'root',documentActions).filter(item=>item.kind==='command').map(item=>item.id)
describe('contextual editor command registry',()=>{
 it('shows a compact useful empty canvas menu without unavailable object or document actions',()=>{
  expect(ids(base)).toEqual(['text','rect','image','fit'])
  expect(editorMenuItems(base).every(item=>item.kind!=='command'||!resolveEditorCommand(item.id,base).disabled)).toBe(true)
  expect(ids({...base,objectCount:2,clipboard:true})).toEqual(['text','rect','image','paste','selectAll','fit'])
  expect(editorMenuItems(base,'root',true)).toContainEqual({kind:'submenu',id:'document',label:'Documento',icon:'document'})
  expect(editorMenuItems(base,'document')).toContainEqual({kind:'command',id:'deleteTemplate'})
 })
 it('offers image actions for one image and grouping for multiple objects with secondary alignment and order',()=>{
  const image={...base,count:1,image:true,objectCount:1}
  expect(ids(image)).toEqual(['crop','replace','copy','duplicate','lock','delete'])
  expect(editorMenuItems(image)).toContainEqual({kind:'submenu',id:'align',label:'Alinear',icon:'align'})
  expect(ids({...base,count:2})).toContain('group')
  expect(ids({...base,count:1,group:true})).toContain('ungroup')
  expect(editorMenuItems({...base,count:3},'align')).toContainEqual({kind:'command',id:'distributeH'})
 })
 it('uses identical live availability for keyboard, toolbar and menu execution including locks and busy sessions',()=>{
  const call=vi.fn(),handlers=Object.fromEntries(Object.keys(EDITOR_COMMANDS).map(id=>[id,call])) as unknown as EditorCommandHandlers
  const locked={...base,count:1,image:true,locked:true,allLocked:true}
  expect(ids(locked)).toEqual(['copy','lock'])
  expect(resolveEditorCommand('lock',locked).label).toBe('Desbloquear')
  for(const id of ['delete','crop','replace','duplicate','front','alignLeft'] as const){
   expect(executeEditorCommand(id,locked,handlers)).toBe(false)
  }
  expect(call).not.toHaveBeenCalled()
  executeEditorCommand('copy',locked,handlers);expect(call).toHaveBeenCalledTimes(1)
  expect(executeEditorCommand('copy',{...locked,busy:true},handlers)).toBe(false)
  expect(executeEditorCommand('save',{...base,saving:true},handlers)).toBe(false)
  const point={x:-25,y:91};executeEditorCommand('paste',{...base,clipboard:true},handlers,{point})
  expect(call).toHaveBeenLastCalledWith({point})
 })
 it('resolves shortcuts to the same command identifiers and keeps selection semantics separate from text ownership',()=>{
  const event={key:'g',ctrlKey:true,metaKey:false,altKey:false,shiftKey:false}
  expect(editorShortcutCommand(event)).toBe('group')
  expect(editorShortcutCommand({...event,shiftKey:true})).toBe('ungroup')
  expect(editorShortcutCommand({...event,key:'a'})).toBe('selectAll')
  expect(editorShortcutCommand({...event,key:'s'})).toBe('save')
  expect(editorShortcutCommand({...event,key:'r',ctrlKey:false})).toBe('rect')
  expect(editorShortcutCommand({...event,key:'r',ctrlKey:false,altKey:true})).toBeUndefined()
 })
 it('exposes compatible paint controls for paths, lines and text, excluding group/image pseudo-properties',()=>{
  expect(selectionPaintCapabilities([{type:'Path'},{type:'Path'}])).toEqual({fill:true,stroke:true})
  expect(selectionPaintCapabilities([{type:'Line'},{type:'Path'}])).toEqual({fill:false,stroke:true})
  expect(selectionPaintCapabilities([{type:'Rect'},{type:'Textbox'}])).toEqual({fill:true,stroke:true})
  expect(selectionPaintCapabilities([{type:'Group'},{type:'Path'}])).toEqual({fill:false,stroke:false})
 })
})
