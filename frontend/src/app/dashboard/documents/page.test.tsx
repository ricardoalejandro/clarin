import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DocumentsPage from './page'
import { api } from '@/lib/api'
const state=vi.hoisted(()=>({scope:'active:a',listeners:new Set<()=>void>(),push:vi.fn()}))
vi.mock('next/navigation',()=>({useRouter:()=>({push:state.push})}))
vi.mock('@/lib/api',()=>({api:vi.fn()}))
vi.mock('@/lib/authScope',()=>({getAuthScope:()=>state.scope,isAuthIdentityChanging:(value:string)=>value.startsWith('changing:'),subscribeAuthScope:(listener:()=>void)=>{state.listeners.add(listener);return()=>state.listeners.delete(listener)}}))
vi.mock('@/components/storage/StorageDialog',()=>({StorageDialog:({title,children,footer}:any)=><section role="dialog" aria-label={title}>{children}{footer}</section>}))
const row={id:'a',name:'Ficha original',revision:7,page_width:210,page_height:140,updated_at:'2026-10-11'}
const page={success:true,data:{templates:[row],total:1,next_cursor:''}}
afterEach(()=>{cleanup();vi.useRealTimers()})
beforeEach(()=>{state.scope='active:a';state.push.mockReset();vi.mocked(api).mockReset().mockResolvedValue(page as any)})
it('creates a preset with orientation and opens only the canonical returned id',async()=>{
 vi.mocked(api).mockImplementation(async(_path,options)=>options?.method==='POST'?{success:true,data:{template:{id:'canonical'}}} as any:page as any)
 render(<DocumentsPage/>);await screen.findByText('Ficha original')
 fireEvent.click(screen.getByRole('button',{name:'Nueva plantilla'}));fireEvent.change(screen.getByLabelText('Nombre'),{target:{value:'Registro'}})
 fireEvent.click(screen.getByRole('button',{name:'Ficha'}));fireEvent.click(screen.getByRole('button',{name:'Crear y diseñar'}))
 await waitFor(()=>expect(state.push).toHaveBeenCalledWith('/dashboard/documents/canonical'))
 const write=vi.mocked(api).mock.calls.find(([,options])=>options?.method==='POST')!
 expect(JSON.parse(write[1]!.body as string)).toMatchObject({name:'Registro',page_width:210,page_height:140,page_orientation:'landscape'})
})
it('aborts pending mutation and removes cached rows immediately on identity change',async()=>{
 let complete!:(value:any)=>void
 vi.mocked(api).mockImplementation(async(_path,options)=>options?.method==='POST'?await new Promise(resolve=>complete=resolve):page as any)
 render(<DocumentsPage/>);await screen.findByText('Ficha original')
 fireEvent.click(screen.getByRole('button',{name:'Nueva plantilla'}));fireEvent.change(screen.getByLabelText('Nombre'),{target:{value:'Registro'}});fireEvent.click(screen.getByRole('button',{name:'Crear y diseñar'}))
 await waitFor(()=>expect(complete).toBeTypeOf('function'))
 const signal=vi.mocked(api).mock.calls.find(([,options])=>options?.method==='POST')![1]!.signal!
 act(()=>{state.scope='changing:b';state.listeners.forEach(listener=>listener())})
 expect(screen.queryByText('Ficha original')).not.toBeInTheDocument();expect(signal.aborted).toBe(true)
 await act(async()=>complete({success:true,data:{template:{id:'old-account'}}}))
 expect(state.push).not.toHaveBeenCalled()
})
it('uses the selected revision for deletion and keeps the dialog after a conflict',async()=>{
 vi.mocked(api).mockImplementation(async(_path,options)=>options?.method==='DELETE'?{success:false,status:409,error:'La plantilla cambió'} as any:page as any)
 render(<DocumentsPage/>);await screen.findByText('Ficha original')
 fireEvent.click(screen.getByRole('button',{name:'Eliminar: Ficha original'}));fireEvent.click(screen.getByRole('button',{name:'Eliminar plantilla'}))
 await waitFor(()=>expect(vi.mocked(api).mock.calls.some(([path,options])=>path==='/api/document-templates/a?expected_revision=7'&&options?.method==='DELETE')).toBe(true))
 expect(screen.getByRole('dialog',{name:'Eliminar plantilla'})).toBeInTheDocument();await screen.findAllByText('La plantilla cambió')
})

it('keeps mutations alive when search changes and reconciles the latest query',async()=>{
 let complete!:(value:any)=>void
 vi.mocked(api).mockImplementation(async(_path,options)=>options?.method==='POST'?await new Promise(resolve=>complete=resolve):page as any)
 render(<DocumentsPage/>);await screen.findByText('Ficha original')
 fireEvent.click(screen.getByRole('button',{name:'Duplicar: Ficha original'}))
 await waitFor(()=>expect(complete).toBeTypeOf('function'))
 const signal=vi.mocked(api).mock.calls.find(([,options])=>options?.method==='POST')![1]!.signal!
 vi.useFakeTimers();fireEvent.change(screen.getByLabelText('Buscar plantillas'),{target:{value:'actual'}})
 await act(async()=>vi.advanceTimersByTime(500))
 expect(signal.aborted).toBe(false)
 await act(async()=>complete({success:true,data:{template:{id:'copy'}}}))
 expect(vi.mocked(api).mock.calls.at(-1)![0]).toContain('q=actual')
 expect(screen.getByRole('button',{name:'Duplicar: Ficha original'})).not.toBeDisabled()
})
