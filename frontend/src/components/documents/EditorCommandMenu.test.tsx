import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest'
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react'
import EditorCommandMenu from './EditorCommandMenu'
import type {EditorCommandState} from '@/lib/fabric/editorCommands'
const base:EditorCommandState={ready:true,busy:false,saving:false,count:0,objectCount:0,locked:false,allLocked:false,image:false,group:false,clipboard:false,canUndo:false,canRedo:false,alignToPage:false}
beforeEach(()=>vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){} unobserve(){}}))
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
describe('EditorCommandMenu',()=>{
 it('keeps a short empty menu and exposes document destruction only through its labelled submenu',async()=>{
  const command=vi.fn(),close=vi.fn()
  render(<EditorCommandMenu state={base} point={{x:500,y:600}} documentActions onCommand={command} onClose={close}/>)
  expect(screen.getAllByRole('menuitem')).toHaveLength(5)
  expect(screen.queryByRole('menuitem',{name:'Eliminar plantilla…'})).toBeNull()
  fireEvent.click(screen.getByRole('menuitem',{name:'Documento'}))
  expect(screen.getByRole('menuitem',{name:'Eliminar plantilla…'})).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('menuitem',{name:'Volver a acciones'}),{key:'ArrowLeft'})
  expect(screen.queryByRole('menuitem',{name:'Eliminar plantilla…'})).toBeNull()
  fireEvent.click(screen.getByRole('menuitem',{name:'Ajustar página'}))
  expect(command).toHaveBeenCalledWith('fit');expect(close).toHaveBeenCalledTimes(1)
 })
 it('supports keyboard drill-down and returns image actions to the same executor',async()=>{
  const command=vi.fn()
  render(<EditorCommandMenu state={{...base,count:1,image:true}} point={{x:20,y:20}} documentActions={false} onCommand={command} onClose={()=>{}}/>)
  const align=screen.getByRole('menuitem',{name:'Alinear'})
  align.focus();fireEvent.keyDown(align,{key:'ArrowRight'})
  await waitFor(()=>expect(screen.getByRole('menuitem',{name:'Volver a acciones'})).toBe(document.activeElement))
  fireEvent.click(screen.getByRole('menuitem',{name:'Centrar horizontalmente'}))
  expect(command).toHaveBeenCalledWith('alignCenterH')
 })
})
