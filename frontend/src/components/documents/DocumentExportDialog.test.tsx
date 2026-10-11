import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DocumentExportDialog from './DocumentExportDialog'
import { api } from '@/lib/api'
import { renderDocumentSnapshotWithPreview, downloadBlob } from '@/lib/fabric/export'
vi.mock('@/components/storage/StorageDialog', () => ({ StorageDialog: ({ children, footer }: any) => <div>{children}{footer}</div> }))
vi.mock('@/lib/api', () => ({ api: vi.fn().mockResolvedValue({success:true,data:{user:{id:'user',account_id:'account'}}}) }))
vi.mock('@/lib/authScope', () => ({ getAuthScope: () => 'account:user' }))
vi.mock('@/lib/fabric/editorSnapshot', () => ({ createDocumentRenderSnapshot: vi.fn().mockResolvedValue({ canvasJson: {}, width: 420, height: 280 }) }))
vi.mock('@/lib/fabric/export', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/fabric/export')>(), renderDocumentSnapshotWithPreview: vi.fn(), downloadBlob: vi.fn() }))
afterEach(()=>{cleanup();vi.useRealTimers()})
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); URL.createObjectURL = vi.fn().mockReturnValue('blob:preview'); URL.revokeObjectURL = vi.fn() })
it('downloads exactly the preview Blob, showing its real weight', async () => {
 const blob = new Blob(['x'.repeat(2048)], { type: 'application/pdf' }); vi.mocked(renderDocumentSnapshotWithPreview).mockResolvedValue({ blob, preview: blob })
 const canvas = { getActiveObjects: () => [] } as any
 const { unmount } = render(<DocumentExportDialog canvas={canvas} templateName="Ficha" onClose={() => {}} />)
 await waitFor(() => expect(screen.getByText(/tamaño exacto/)).toHaveTextContent('2 KiB'))
 fireEvent.click(screen.getByRole('button', { name: 'Descargar' }))
 expect(downloadBlob).toHaveBeenCalledWith(blob, 'Ficha.pdf'); expect(renderDocumentSnapshotWithPreview).toHaveBeenCalledTimes(1)
 expect(renderDocumentSnapshotWithPreview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dpi: 300, quality: .95, format: 'pdf' }))
 expect(screen.getByRole('button', { name: 'Selección (0)' })).toBeDisabled()
 unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')
})
it('aborts pending render on close so a late Blob never gets an object URL', async () => {
 let complete!: (result: { blob: Blob; preview: Blob }) => void
 vi.mocked(renderDocumentSnapshotWithPreview).mockReturnValue(new Promise(resolve => { complete = resolve }))
 const { unmount } = render(<DocumentExportDialog canvas={{ getActiveObjects: () => [] } as any} templateName="Ficha" onClose={() => {}} />)
 await waitFor(() => expect(renderDocumentSnapshotWithPreview).toHaveBeenCalled())
 const signal = vi.mocked(renderDocumentSnapshotWithPreview).mock.calls[0][1].signal
 unmount(); expect(signal?.aborted).toBe(true); complete({ blob: new Blob(['late']), preview: new Blob(['late']) })
 await Promise.resolve(); await Promise.resolve(); expect(URL.createObjectURL).not.toHaveBeenCalled()
})

it('falls back to isolated preferences when identity lookup hangs and rejects its late result',async()=>{
 let resolveIdentity!:(value:any)=>void
 vi.mocked(api).mockReturnValueOnce(new Promise(resolve=>resolveIdentity=resolve))
 vi.mocked(renderDocumentSnapshotWithPreview).mockResolvedValue({blob:new Blob(['pdf']),preview:new Blob(['image'])})
 vi.useFakeTimers()
 render(<DocumentExportDialog canvas={{getActiveObjects:()=>[]} as any} templateName="Ficha" onClose={()=>{}}/>)
 expect(screen.getByRole('status')).toHaveTextContent('Preparando exportación')
 await act(async()=>{vi.advanceTimersByTime(1500)})
 expect(screen.getByRole('button',{name:'PDF'})).toBeInTheDocument()
 expect(vi.mocked(api).mock.calls.at(-1)![1]!.signal!.aborted).toBe(true)
 await act(async()=>{resolveIdentity({success:true,data:{user:{id:'late',account_id:'other'}}})})
 expect(localStorage.getItem('clarin:document-export:v1:other:late:pdf')).toBeNull()
})

it('runs one renderer at a time and starts only the latest pending profile',async()=>{
 let first!:(value:{blob:Blob;preview:Blob})=>void
 vi.mocked(renderDocumentSnapshotWithPreview).mockReturnValueOnce(new Promise(resolve=>first=resolve)).mockResolvedValue({blob:new Blob(['new']),preview:new Blob(['new'])})
 render(<DocumentExportDialog canvas={{getActiveObjects:()=>[]} as any} templateName="Ficha" onClose={()=>{}}/>)
 await waitFor(()=>expect(renderDocumentSnapshotWithPreview).toHaveBeenCalledTimes(1))
 fireEvent.click(screen.getByRole('button',{name:/Ligero/}));fireEvent.click(screen.getByRole('button',{name:/Equilibrado/}))
 expect(renderDocumentSnapshotWithPreview).toHaveBeenCalledTimes(1)
 await act(async()=>first({blob:new Blob(['old']),preview:new Blob(['old'])}))
 await waitFor(()=>expect(renderDocumentSnapshotWithPreview).toHaveBeenCalledTimes(2))
 expect(vi.mocked(renderDocumentSnapshotWithPreview).mock.calls[1][1].dpi).toBe(150)
 fireEvent.click(screen.getByRole('button',{name:'Personalizado'}))
 await waitFor(()=>expect(screen.getByRole('button',{name:'Descargar'})).not.toBeDisabled())
 fireEvent.change(screen.getByLabelText('Resolución personalizada'),{target:{value:'96'}})
 expect(screen.getByRole('button',{name:'Descargar'})).toBeDisabled()
 fireEvent.blur(screen.getByLabelText('Resolución personalizada'))
 await waitFor(()=>expect(vi.mocked(renderDocumentSnapshotWithPreview).mock.calls.at(-1)![1].dpi).toBe(96))
})
