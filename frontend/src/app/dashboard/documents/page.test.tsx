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

const canonical = { ...row, description: 'Descripción preservada', page_orientation: 'landscape', canvas_json: { version: 3, canvas: { objects: [{ type: 'Text', text: 'Contenido conservado' }] } }, fields_used: ['name'], thumbnail_url: '/api/storage/content/own/thumb.png' }
const beginRename = () => { fireEvent.click(screen.getByRole('button', { name: 'Renombrar: Ficha original' })); fireEvent.change(screen.getByLabelText('Nuevo nombre'), { target: { value: '  Nombre nuevo  ' } }); fireEvent.click(screen.getByRole('button', { name: 'Guardar nombre' })) }
it('renames from the complete canonical resource and reconciles the latest search', async () => {
 let finish!: (value: any) => void
 vi.mocked(api).mockImplementation(async(path, options) => options?.method === 'PUT' ? await new Promise(resolve => { finish = resolve }) : path === '/api/document-templates/a' ? { success: true, data: { template: canonical } } as any : page as any)
 render(<DocumentsPage/>); await screen.findByText('Ficha original'); beginRename()
 await waitFor(() => expect(finish).toBeTypeOf('function'))
 const call = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'PUT')!
 expect(JSON.parse(call[1]!.body as string)).toEqual({ name: 'Nombre nuevo', description: canonical.description, page_width: 210, page_height: 140, page_orientation: 'landscape', canvas_json: canonical.canvas_json, fields_used: canonical.fields_used, thumbnail_url: canonical.thumbnail_url, expected_revision: 7 })
 vi.useFakeTimers(); fireEvent.change(screen.getByLabelText('Buscar plantillas'), { target: { value: 'actual' } }); await act(async () => vi.advanceTimersByTime(500))
 expect(call[1]!.signal!.aborted).toBe(false)
 await act(async () => finish({ success: true, data: { template: { ...canonical, name: 'Nombre nuevo', revision: 8 } } }))
 expect(vi.mocked(api).mock.calls.at(-1)![0]).toContain('q=actual'); expect(screen.queryByRole('dialog', { name: 'Renombrar plantilla' })).not.toBeInTheDocument()
})
it('preserves the rename draft on conflict and failure, retrying explicitly with the canonical revision', async () => {
 let writes = 0
 vi.mocked(api).mockImplementation(async(path, options) => {
  if (options?.method === 'PUT') { writes++; return writes === 1 ? { success: false, status: 409, data: { template: { ...canonical, name: 'Cambio de otra sesión', revision: 8 } } } as any : { success: false, status: 503, error: 'No se pudo confirmar el cambio.' } as any }
  return path === '/api/document-templates/a' ? { success: true, data: { template: canonical } } as any : page as any
 })
 render(<DocumentsPage/>); await screen.findByText('Ficha original'); beginRename()
 await screen.findByText(/ahora se llama «Cambio de otra sesión»/)
 expect(screen.getByLabelText('Nuevo nombre')).toHaveValue('  Nombre nuevo  '); expect(writes).toBe(1)
 await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar nombre' })).not.toBeDisabled())
 fireEvent.click(screen.getByRole('button', { name: 'Guardar nombre' })); await screen.findByText('No se pudo confirmar el cambio.')
 expect(screen.getByLabelText('Nuevo nombre')).toHaveValue('  Nombre nuevo  ')
 const calls = vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'PUT')
 expect(calls.map(([, options]) => JSON.parse(options!.body as string).expected_revision)).toEqual([7, 8])
})
it.each(['GET', 'PUT'])('aborts a pending rename %s and ignores its late result when identity changes', async stage => {
 let finish!: (value: any) => void
 vi.mocked(api).mockImplementation(async(path, options) => {
  if (path === '/api/document-templates/a') { if ((options?.method || 'GET') === stage) return await new Promise(resolve => { finish = resolve }); return { success: true, data: { template: canonical } } as any }
  return page as any
 })
 render(<DocumentsPage/>); await screen.findByText('Ficha original'); beginRename(); await waitFor(() => expect(finish).toBeTypeOf('function'))
 const call = vi.mocked(api).mock.calls.find(([path, options]) => path === '/api/document-templates/a' && (options?.method || 'GET') === stage)!
 const count = vi.mocked(api).mock.calls.length
 act(() => { state.scope = 'changing:b'; state.listeners.forEach(listener => listener()) }); expect(call[1]!.signal!.aborted).toBe(true)
 await act(async () => finish({ success: true, data: { template: { ...canonical, revision: 8 } } }))
 expect(vi.mocked(api).mock.calls).toHaveLength(count); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.queryByText('Nombre de la plantilla actualizado.')).not.toBeInTheDocument()
})
it.each(['GET', 'PUT'])('ends a pending rename %s after 30 seconds with the draft preserved', async stage => {
 let finish!: (value: any) => void
 vi.mocked(api).mockImplementation(async(path, options) => {
  if (path === '/api/document-templates/a') { if ((options?.method || 'GET') === stage) return await new Promise(resolve => { finish = resolve }); return { success: true, data: { template: canonical } } as any }
  return page as any
 })
 render(<DocumentsPage/>); await screen.findByText('Ficha original'); vi.useFakeTimers(); beginRename(); await act(async () => {})
 const call = vi.mocked(api).mock.calls.find(([path, options]) => path === '/api/document-templates/a' && (options?.method || 'GET') === stage)!
 await act(async () => vi.advanceTimersByTimeAsync(30_000))
 expect(screen.getByText(/No se pudo confirmar la operación en 30 segundos/)).toBeInTheDocument(); expect(screen.getByLabelText('Nuevo nombre')).toHaveValue('  Nombre nuevo  '); expect(screen.getByRole('button', { name: 'Guardar nombre' })).not.toBeDisabled(); expect(call[1]!.signal!.aborted).toBe(true)
 const count = vi.mocked(api).mock.calls.length
 await act(async () => finish({ success: true, data: { template: { ...canonical, revision: 8 } } }))
 expect(vi.mocked(api).mock.calls).toHaveLength(count); expect(screen.getByRole('dialog', { name: 'Renombrar plantilla' })).toBeInTheDocument()
})
it('bounds library loading and creation without accepting late results or losing the creation draft', async () => {
 let finishLoad!: (value: any) => void; let finishCreate!: (value: any) => void
 vi.mocked(api).mockImplementation(async(_path, options) => options?.method === 'POST' ? await new Promise(resolve => { finishCreate = resolve }) : await new Promise(resolve => { finishLoad = resolve }))
 vi.useFakeTimers(); render(<DocumentsPage/>); await act(async () => vi.advanceTimersByTimeAsync(30_000))
 expect(screen.getByText('No se pudieron cargar las plantillas en 30 segundos. Puedes reintentar.')).toBeInTheDocument()
 await act(async () => finishLoad(page)); expect(screen.queryByText('Ficha original')).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button', { name: 'Nueva plantilla' })); fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Borrador seguro' } }); fireEvent.click(screen.getByRole('button', { name: 'Crear y diseñar' }))
 await act(async () => vi.advanceTimersByTimeAsync(30_000)); expect(screen.getByText(/No se pudo confirmar la operación en 30 segundos/)).toBeInTheDocument(); expect(screen.getByLabelText('Nombre')).toHaveValue('Borrador seguro')
 await act(async () => finishCreate({ success: true, data: { template: { id: 'late' } } })); expect(state.push).not.toHaveBeenCalled()
})
