/** A group/image's inherited Fabric properties do not style its visible content. */
export function selectionPaintCapabilities(objects:readonly {type:string}[]){
 const types=objects.map(object=>object.type.toLowerCase())
 const painted=new Set(['rect','ellipse','circle','triangle','polygon','polyline','path','line','text','i-text','itext','textbox','dynamictext'])
 return {fill:types.length>0&&types.every(type=>painted.has(type)&&type!=='line'),stroke:types.length>0&&types.every(type=>painted.has(type))}
}
