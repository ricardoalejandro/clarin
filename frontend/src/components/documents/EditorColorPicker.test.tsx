import {render,screen,cleanup} from '@testing-library/react'
import {afterEach,it,expect} from 'vitest'
import EditorColorPicker from './EditorColorPicker'
afterEach(cleanup)
it('labels a mixed selection separately from a preserved gradient',()=>{
 const view=render(<EditorColorPicker label="Selección" value={null} mixed onChange={()=>{}}/>)
 expect(screen.getByRole('button',{name:'Selección'}).textContent).toContain('Varios colores')
 expect(screen.queryByText('Degradado existente')).toBeNull()
 view.rerender(<EditorColorPicker label="Selección" value={{type:'linear'}} onChange={()=>{}}/>)
 expect(screen.getByRole('button',{name:'Selección'}).textContent).toContain('Degradado existente')
})
