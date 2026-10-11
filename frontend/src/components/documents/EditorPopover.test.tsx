import {useEffect,useRef,useState} from 'react'
import {flushSync} from 'react-dom'
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react'
import {afterEach,describe,expect,it,vi} from 'vitest'
import EditorPopover from './EditorPopover'
afterEach(cleanup)
describe('editor context menu pointer ownership',()=>{
 it('survives the native pointer event that opens it and closes on the next outside pointer',()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}})
  function Surface(){
   const canvas=useRef<HTMLCanvasElement>(null),[open,setOpen]=useState(false)
   useEffect(()=>{const el=canvas.current!,down=(e:PointerEvent)=>{if(e.button===2)flushSync(()=>setOpen(true))};el.addEventListener('pointerdown',down);return()=>el.removeEventListener('pointerdown',down)},[])
   return <><canvas ref={canvas} aria-label="Lienzo"/>{open&&<EditorPopover point={{x:3,y:3}} menu label="Acciones de la plantilla" onClose={()=>setOpen(false)}><button role="menuitem">Insertar texto</button></EditorPopover>}</>
  }
  render(<Surface/>)
  fireEvent(screen.getByLabelText('Lienzo'),new MouseEvent('pointerdown',{button:2,bubbles:true}))
  expect(screen.getByRole('menu',{name:'Acciones de la plantilla'})).toBeVisible()
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('menu')).toBeNull()
  vi.unstubAllGlobals()
 })
})
