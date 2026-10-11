interface TraversalEvent extends Event {
 navigationType:string
 destination:{key:string;sameDocument:boolean}
}
interface EditorNavigation extends EventTarget {traverseTo(key:string):unknown}
/**
 * A cancellable same-document traversal is stopped before Next changes routes.
 * Resume the browser's original entry; never insert sentinels or rewrite Next's
 * history state. Cross-document/unavailable navigation uses beforeunload.
 */
export function installEditorNavigationGuard(
 target:Window|{navigation?:EditorNavigation},
 isDirty:()=>boolean,
 confirm:(resume:()=>void)=>void,
):()=>void {
 const navigation=(target as {navigation?:EditorNavigation}).navigation
 if(!navigation)return ()=>{}
 let disposed=false,approved:string|null=null
 const handler=(event:Event)=>{
  const e=event as TraversalEvent
  if(e.navigationType!=='traverse'||!e.destination.sameDocument)return
  if(approved===e.destination.key){approved=null;return}
  if(!e.cancelable||!isDirty())return
  e.preventDefault()
  const key=e.destination.key
  confirm(()=>{if(disposed)return;approved=key;navigation.traverseTo(key)})
 }
 navigation.addEventListener('navigate',handler)
 return()=>{disposed=true;navigation.removeEventListener('navigate',handler)}
}
