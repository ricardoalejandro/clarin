import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CanonicalContactTags from './CanonicalContactTags'
import { api } from '@/lib/api'
vi.mock('@/lib/api', () => ({ api: vi.fn() }))
const mocks=vi.hoisted(()=>({profile:{} as any}))
vi.mock('@/components/contact-details/useContactProfile',()=>({useContactProfile:()=>mocks.profile}))
const tag={id:'tag-1',account_id:'account-1',name:'Prioridad',color:'#2563EB'}
const props={contactId:'c1',context:{type:'lead' as const,id:'l1'},initialTags:[tag]}
beforeEach(()=>{vi.mocked(api).mockReset(); mocks.profile={contact:{id:'c1',account_id:'account-1',structured_tags:[tag]},capabilities:{can_edit:true,can_create_tags:false},loading:false,error:'',refresh:vi.fn(),updateContact:vi.fn()}})
afterEach(()=>{cleanup(); vi.useRealTimers()})
describe('canonical tags in legacy recipient detail',()=>{
 it('uses one canonical write with pending feedback, exact rollback and retry',async()=>{
  let complete!:(result:any)=>void
  mocks.profile.updateContact.mockReturnValueOnce(new Promise(resolve=>{complete=resolve})).mockResolvedValueOnce({success:true,contact:{id:'c1',structured_tags:[]}})
  const onChange=vi.fn()
  render(<CanonicalContactTags {...props} onChange={onChange}/>)
  fireEvent.click(screen.getByRole('button',{name:'Quitar etiqueta Prioridad'}))
  expect(mocks.profile.updateContact).toHaveBeenCalledExactlyOnceWith({tag_ids:[]})
  expect(onChange).toHaveBeenLastCalledWith([])
  expect(screen.getByRole('status')).toHaveTextContent('Actualizando')
  expect(screen.getByRole('combobox')).toBeDisabled()
  await act(async()=>{complete({success:false,error:'Conflicto'})})
  expect(onChange).toHaveBeenLastCalledWith([tag])
  expect(screen.getByRole('button',{name:'Quitar etiqueta Prioridad'})).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Reintentar'}))
  await act(async()=>{await Promise.resolve()})
  expect(mocks.profile.updateContact).toHaveBeenCalledTimes(2)
  expect(onChange).toHaveBeenLastCalledWith([])
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
 })
 it('honors a membership cancellation before any write or optimistic change',async()=>{
  const onChange=vi.fn()
  render(<CanonicalContactTags {...props} onChange={onChange} onBeforeRemove={async()=>false}/>)
  fireEvent.click(screen.getByRole('button',{name:'Quitar etiqueta Prioridad'}))
  await act(async()=>{await Promise.resolve()})
  expect(mocks.profile.updateContact).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.getByRole('button',{name:'Quitar etiqueta Prioridad'})).toBeInTheDocument()
 })
 it('binds optimistic search tags to the canonical Contact account before notifying the legacy Lead',async()=>{
  vi.useFakeTimers()
  const available={id:'new',name:'Grupo',color:'#16A34A'}
  const canonical={...available,account_id:'canonical-account'}
  mocks.profile.contact={id:'c1',account_id:'canonical-account',structured_tags:[]}
  mocks.profile.updateContact.mockResolvedValue({success:true,contact:{id:'c1',account_id:'canonical-account',structured_tags:[canonical]}})
  vi.mocked(api).mockResolvedValue({success:true,data:{success:true,tags:[available]}})
  const onChange=vi.fn()
  render(<CanonicalContactTags {...props} initialTags={[]} onChange={onChange}/>)
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'grupo'}})
  await act(async()=>{await vi.advanceTimersByTimeAsync(500)})
  fireEvent.click(screen.getByRole('option',{name:'Grupo'}))
  expect(onChange).toHaveBeenNthCalledWith(1,[canonical])
  expect(mocks.profile.updateContact).toHaveBeenCalledExactlyOnceWith({tag_ids:['new']})
  await act(async()=>{await Promise.resolve()})
  expect(onChange).toHaveBeenLastCalledWith([canonical])
 })
 it('rejects completion from a previously selected Contact',async()=>{
  let complete!:(result:any)=>void
  mocks.profile.updateContact.mockReturnValueOnce(new Promise(resolve=>{complete=resolve}))
  const onChange=vi.fn()
  const {rerender}=render(<CanonicalContactTags {...props} onChange={onChange}/>)
  fireEvent.click(screen.getByRole('button',{name:'Quitar etiqueta Prioridad'}))
  onChange.mockClear()
  mocks.profile={...mocks.profile,contact:{id:'c2',account_id:'account-2',structured_tags:[]}}
  rerender(<CanonicalContactTags contactId="c2" context={{type:'lead',id:'l2'}} initialTags={[]} onChange={onChange}/>)
  await act(async()=>{complete({success:true,contact:{id:'c1',structured_tags:[tag]}})})
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.queryByText('Prioridad')).not.toBeInTheDocument()
 })
})
