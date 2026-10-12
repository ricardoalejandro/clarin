import {it,expect} from 'vitest'
import {reconcileEventStageFilters,reconcileEventStageIdentity} from './eventStageReconciliation'
it('reconciles cloned and deleted stage identities without losing unrelated participant state',()=>{
 const stages=[{id:'new',name:'Seguimiento',color:'#334455',position:0}],map={old:'new',deleted:'new'}
 const item={id:'person',stage_id:'deleted',stage_name:'Anterior',stage_color:'#000000',notes:'Conservar'}
 expect(reconcileEventStageIdentity(item,stages,map)).toEqual({...item,stage_id:'new',stage_name:'Seguimiento',stage_color:'#334455'})
 expect([...reconcileEventStageFilters(new Set(['old','deleted','invalid']),stages,map)]).toEqual(['new'])
 expect(reconcileEventStageIdentity({...item,stage_id:null},stages,map).stage_id).toBeNull()
})
