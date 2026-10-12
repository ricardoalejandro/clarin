export interface CanonicalEventStage {id:string;name:string;color:string;position:number}
export function reconcileEventStageIdentity<T extends {stage_id?:string|null;stage_name?:string|null;stage_color?:string|null}>(item:T,stages:CanonicalEventStage[],mapping:Record<string,string>):T {
 if (!item.stage_id) return item
 const id=mapping[item.stage_id]||item.stage_id, stage=stages.find(stage=>stage.id===id)
 return {...item,stage_id:stage?.id??null,stage_name:stage?.name??null,stage_color:stage?.color??null}
}
export function reconcileEventStageFilters(ids:Set<string>,stages:CanonicalEventStage[],mapping:Record<string,string>) {
 const valid=new Set(stages.map(stage=>stage.id))
 return new Set([...ids].map(id=>mapping[id]||id).filter(id=>valid.has(id)))
}
