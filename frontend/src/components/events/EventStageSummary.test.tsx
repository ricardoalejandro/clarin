import {render,screen,cleanup} from '@testing-library/react'
import {afterEach,it,expect} from 'vitest'
import {EventStageSummary} from './EventStageSummary'
afterEach(cleanup)
it('preserves equal-name stage identities and unassigned participants',()=>{
 render(<EventStageSummary total={6} stages={[{id:'one',name:'Seguimiento',color:'#334455',position:0,count:1},{id:'two',name:'Seguimiento',color:'#556677',position:1,count:2},{id:null,name:'Sin etapa',color:'#94a3b8',position:2,count:3}]}/>)
 expect(screen.getAllByText('Seguimiento')).toHaveLength(2)
 expect(screen.getByText('Sin etapa')).toBeInTheDocument()
 expect(screen.getByText('3')).toBeInTheDocument()
})
