import {describe,it,expect} from 'vitest'
import {canonicalLogbook,logbookCanEdit,logbookDraftConflict,logbookMatches,logbookScopeLabels,mergeLogbookPage,orderedLogbookStages,type EventLogbook} from './logbookWorkspace'
const book:EventLogbook={id:'a',event_id:'e',title:'Encuentro',date:'2026-10-12',status:'active',version:3,total_participants:2,general_notes:'',stage_snapshot:{}}
describe('logbook historical and reconciliation contracts',()=>{
 it('keeps distinct IDs for homonymous stages and uses capture order',()=>{const values=orderedLogbookStages({b:{name:'Seguimiento',color:'#123456',count:2,position:1},a:{name:'Seguimiento',color:'#123456',count:3,position:0},unassigned:{name:'',color:'',count:1}});expect(values.map(([id])=>id)).toEqual(['a','b','unassigned'])})
 it('rejects old canonical versions and deduplicates overlapping cursor pages',()=>{expect(canonicalLogbook(book,{...book,version:2,title:'old'})).toBe(book);expect(mergeLogbookPage([{id:'a',v:1},{id:'b',v:1}],[{id:'b',v:2},{id:'c',v:1}],true)).toEqual([{id:'a',v:1},{id:'b',v:2},{id:'c',v:1}])})
 it('requires explicit rebasing after remote changes and never edits completed history',()=>{expect(logbookDraftConflict(2,book)).toBe(true);expect(logbookCanEdit({...book,status:'completed'},false)).toBe(false);expect(logbookCanEdit(book,true)).toBe(false);expect(logbookCanEdit(book,false)).toBe(true)})
 it('labels explicit audience without leaking raw configuration',()=>{expect(logbookScopeLabels({})).toEqual(['Todos los participantes activos']);expect(logbookScopeLabels({text_search:'María',has_phone:true})).toEqual(['Búsqueda: María','Con teléfono']);expect(logbookMatches(book,'encuentro','active')).toBe(true);expect(logbookMatches(book,'','completed')).toBe(false)})
})
