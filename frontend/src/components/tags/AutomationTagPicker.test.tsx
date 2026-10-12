import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import AutomationTagPicker from './AutomationTagPicker'
vi.mock('@/lib/api',()=>({api:vi.fn()}))
beforeEach(()=>{vi.useFakeTimers();vi.mocked(api).mockReset()})
afterEach(()=>{cleanup();vi.useRealTimers()})
describe('AutomationTagPicker',()=>{
 it('hydrates saved names by bounded ID lookup and clears the same stored value',async()=>{
  vi.mocked(api).mockResolvedValue({success:true,data:{success:true,tags:[{id:'saved',name:'Prioridad',color:'#2563EB'}]}})
  const onChange=vi.fn()
  render(<AutomationTagPicker sessionKey="node-1" data={{config:{tag_id:'saved'}}} onChange={onChange}/> )
  await act(async()=>{await Promise.resolve()})
  expect(api).toHaveBeenCalledWith('/api/tags/search?context_type=automation&q=&limit=20&ids=saved',expect.objectContaining({signal:expect.any(AbortSignal)}))
  fireEvent.click(screen.getByRole('button',{name:'Quitar etiqueta Prioridad'}))
  expect(onChange).toHaveBeenCalledExactlyOnceWith('')
 })
 it('shows unavailable selection honestly and ignores hydration from another node',async()=>{
  let old!:(value:any)=>void
  vi.mocked(api).mockReturnValueOnce(new Promise(resolve=>{old=resolve})).mockResolvedValue({success:true,data:{success:true,tags:[]}})
  const {rerender}=render(<AutomationTagPicker sessionKey="node-1" data={{tag_id:'old'}} onChange={vi.fn()}/> )
  const signal=vi.mocked(api).mock.calls[0][1]?.signal as AbortSignal
  rerender(<AutomationTagPicker sessionKey="node-2" data={{tag_id:'missing'}} onChange={vi.fn()}/> )
  await act(async()=>{old({success:true,data:{success:true,tags:[{id:'old',name:'Obsoleta',color:'#000000'}]}});await Promise.resolve()})
  expect(signal.aborted).toBe(true)
  expect(screen.queryByText('Obsoleta')).not.toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('ya no está disponible')
 })
})
