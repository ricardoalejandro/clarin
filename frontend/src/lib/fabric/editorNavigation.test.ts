import {describe,it,expect,vi} from 'vitest'
import {installEditorNavigationGuard} from './editorNavigation'
function fixture(){
 const navigation=Object.assign(new EventTarget(),{traverseTo:vi.fn()})
 const emit=(key='prior')=>{const e=Object.assign(new Event('navigate',{cancelable:true}),{navigationType:'traverse',destination:{key,sameDocument:true}});navigation.dispatchEvent(e);return e}
 return {navigation,emit}
}
describe('editor history navigation',()=>{
 it('blocks back before routing, keeps the draft and resumes the same entry only after approval',()=>{
  const {navigation,emit}=fixture(),confirm=vi.fn();let dirty=true
  const dispose=installEditorNavigationGuard({navigation},()=>dirty,confirm)
  expect(emit().defaultPrevented).toBe(true);expect(navigation.traverseTo).not.toHaveBeenCalled()
  // Cancel leaves browser history unchanged. A later attempt asks again.
  expect(emit().defaultPrevented).toBe(true);expect(confirm).toHaveBeenCalledTimes(2)
  confirm.mock.calls[1][0]();expect(navigation.traverseTo).toHaveBeenCalledExactlyOnceWith('prior')
  expect(emit().defaultPrevented).toBe(false)
  expect(emit().defaultPrevented).toBe(true)
  dirty=false;expect(emit('next').defaultPrevented).toBe(false);dispose()
 })
 it('does not navigate from an obsolete editor session',()=>{
  const {navigation,emit}=fixture(),confirm=vi.fn()
  const dispose=installEditorNavigationGuard({navigation},()=>true,confirm)
  emit();dispose();confirm.mock.calls[0][0]();expect(navigation.traverseTo).not.toHaveBeenCalled();expect(emit().defaultPrevented).toBe(false)
 })
})
