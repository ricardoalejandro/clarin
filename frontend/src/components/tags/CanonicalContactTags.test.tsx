import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CanonicalContactTags from './CanonicalContactTags'
const mocks=vi.hoisted(()=>({profile:{} as any}))
vi.mock('@/components/contact-details/useContactProfile',()=>({useContactProfile:()=>mocks.profile}))
const tag={id:'tag-1',account_id:'account-1',name:'Prioridad',color:'#2563EB'}
const props={contactId:'c1',context:{type:'lead' as const,id:'l1'},initialTags:[tag]}
beforeEach(()=>{mocks.profile={contact:{id:'c1',structured_tags:[tag]},capabilities:{can_edit:true,can_create_tags:false},loading:false,error:'',refresh:vi.fn(),updateContact:vi.fn()}})
afterEach(cleanup)
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
 it('rejects completion from a previously selected Contact',async()=>{
  let complete!:(result:any)=>void
  mocks.profile.updateContact.mockReturnValueOnce(new Promise(resolve=>{complete=resolve}))
  const onChange=vi.fn()
  const {rerender}=render(<CanonicalContactTags {...props} onChange={onChange}/>)
  fireEvent.click(screen.getByRole('button',{name:'Quitar etiqueta Prioridad'}))
  onChange.mockClear()
  mocks.profile={...mocks.profile,contact:{id:'c2',structured_tags:[]}}
  rerender(<CanonicalContactTags contactId="c2" context={{type:'lead',id:'l2'}} initialTags={[]} onChange={onChange}/>)
  await act(async()=>{complete({success:true,contact:{id:'c1',structured_tags:[tag]}})})
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.queryByText('Prioridad')).not.toBeInTheDocument()
 })
})
