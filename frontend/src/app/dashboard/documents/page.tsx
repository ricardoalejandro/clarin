 'use client'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Plus, Search, FileText, Trash2, Copy, Download, Upload, LayoutGrid, List, Loader2, ArrowRight, RefreshCw, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { getAuthScope, subscribeAuthScope, isAuthIdentityChanging } from '@/lib/authScope'
import type { DocumentTemplate } from '@/types/document'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { documentLibraryPath, mergeDocumentPage, safeDocumentFilename, type DocumentLibraryPage } from '@/lib/documents/documentLibrary'
import { DOCUMENT_MAX_BYTES, validateDocumentTemplate, validDocumentAssetURL } from '@/lib/documents/documentValidation'
import { downloadBlob } from '@/lib/fabric/export'
import { StorageDialog as DocumentDialog } from '@/components/storage/StorageDialog'
const presets = [{ name: 'A4', w: 210, h: 297 }, { name: 'A5', w: 148, h: 210 }, { name: 'Carta', w: 216, h: 279 }, { name: 'Ficha', w: 210, h: 140 }]
const emptyDraft = { name: '', description: '', page_width: 210, page_height: 297, page_orientation: 'portrait' as 'portrait' | 'landscape', canvas_json: {} }
const control = 'min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500/30'
export default function DocumentsPage() {
  const scope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  if (scope === 'server' || isAuthIdentityChanging(scope)) return <div role="status" className="flex h-full items-center justify-center text-sm text-slate-500">Preparando las plantillas de la cuenta…</div>
  return <DocumentsLibrary key={scope} />
}
function DocumentsLibrary() {
  const router = useRouter()
  const [templates, setTemplates] = useState<DocumentTemplate[]>([])
  const [total, setTotal] = useState(0)
  const [cursor, setCursor] = useState('')
  const [query, setQuery] = useState('')
  const [settledQuery, setSettledQuery] = useDebouncedValue(query)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [create, setCreate] = useState(false)
  const [draft, setDraft] = useState(emptyDraft)
  const [draftError, setDraftError] = useState('')
  const [discard, setDiscard] = useState(false)
  const [deleting, setDeleting] = useState<DocumentTemplate | null>(null)
  const request = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null })
  const mounted = useRef(true)
  const mutations = useRef(new Set<AbortController>())
  const importRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const load = useCallback(async (next = '') => {
    request.current.controller?.abort()
    const controller = new AbortController(); const id = ++request.current.id; const identity = getAuthScope()
    request.current.controller = controller; setLoading(true); setError('')
    const result = await api<DocumentLibraryPage>(documentLibraryPath(settledQuery, next), { signal: controller.signal })
    if (controller.signal.aborted || request.current.id !== id || !mounted.current || identity !== getAuthScope()) return
    if (result.success && result.data) { setTemplates(previous => next ? mergeDocumentPage(previous, result.data!.templates) : result.data!.templates); setTotal(result.data.total); setCursor(result.data.next_cursor || '') }
    else setError(result.error || 'No se pudieron cargar las plantillas.')
    setLoading(false)
  }, [settledQuery])
  const latestLoad=useRef(load);latestLoad.current=load
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current.controller?.abort(); mutations.current.forEach(controller => controller.abort()) } }, [])
  useEffect(() => { void load(); return () => request.current.controller?.abort() }, [load])
  const mutation = async (key: string, work: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
    if (busy) return
    const controller = new AbortController(); const identity = getAuthScope(); mutations.current.add(controller)
    const current = () => mounted.current && !controller.signal.aborted && identity === getAuthScope()
    setBusy(key); setError(''); setNotice('')
    try { await work(controller.signal, current) } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : 'No se pudo completar la operación.') }
    finally { mutations.current.delete(controller); if (current()) setBusy('') }
  }
  const duplicate = (item: DocumentTemplate) => void mutation(item.id, async (signal, current) => {
    const response = await api<{ template: DocumentTemplate }>(`/api/document-templates/${item.id}/duplicate`, { method: 'POST', signal })
    if (!current()) return
    if (!response.success) throw new Error(response.error)
    setNotice('Copia creada.'); await latestLoad.current()
  })
  const exportJSON = (item: DocumentTemplate) => void mutation(item.id, async (signal, current) => {
    const response = await api<{ template: DocumentTemplate }>(`/api/document-templates/${item.id}`, { signal })
    if (!current()) return
    if (!response.success || !response.data) throw new Error(response.error)
    const { name, description, page_width, page_height, page_orientation, fields_used, canvas_json } = response.data.template
    downloadBlob(new Blob([JSON.stringify({ name, description, page_width, page_height, page_orientation, fields_used, canvas_json }, null, 2)], { type: 'application/json' }), `${safeDocumentFilename(name)}.json`)
    setNotice('Diseño descargado. Los recursos de Clarin conservan sus permisos de cuenta.')
  })
  const importJSON = (file?: File) => {
    if (!file) return
    void mutation('import', async (signal, current) => {
      if (file.size > DOCUMENT_MAX_BYTES + 1024 * 1024) throw new Error('La plantilla supera el tamaño permitido.')
      let data: typeof emptyDraft
      try { data = JSON.parse(await file.text()) } catch { throw new Error('El archivo no contiene una plantilla JSON válida.') }
      if (!current()) return
      if (!data || typeof data !== 'object') throw new Error('El archivo no contiene una plantilla válida.')
      const invalid = validateDocumentTemplate(data); if (invalid) throw new Error(invalid)
      const response = await api<{ template: DocumentTemplate }>('/api/document-templates/import', { method: 'POST', body: JSON.stringify(data), signal })
      if (!current()) return
      if (!response.success) throw new Error(response.error)
      setNotice('Plantilla importada.'); await latestLoad.current()
    })
  }
  const closeCreate = () => { if (busy === 'create') return; if (JSON.stringify(draft) !== JSON.stringify(emptyDraft)) setDiscard(true); else setCreate(false) }
  const saveCreate = async (event: React.FormEvent) => {
    event.preventDefault(); const invalid = validateDocumentTemplate(draft); if (invalid) { setDraftError(invalid); return }
    if (busy) return; setBusy('create'); setDraftError('')
    const controller = new AbortController(); const identity = getAuthScope(); mutations.current.add(controller)
    const response = await api<{ template: DocumentTemplate }>('/api/document-templates', { method: 'POST', body: JSON.stringify(draft), signal: controller.signal })
    mutations.current.delete(controller)
    if (!mounted.current || controller.signal.aborted || identity !== getAuthScope()) return
    setBusy('')
    if (!response.success || !response.data) { setDraftError(response.error || 'No se pudo crear la plantilla.'); return }
    setCreate(false); setDraft(emptyDraft); router.push(`/dashboard/documents/${response.data.template.id}`)
  }
  const remove = () => { if (!deleting) return; const item = deleting; void mutation(item.id, async (signal, current) => {
    const response = await api(`/api/document-templates/${item.id}?expected_revision=${item.revision}`, { method: 'DELETE', signal })
    if (!current()) return
    if (!response.success) { if (response.status === 409 || response.status === 404) await latestLoad.current(); throw new Error(response.error) }
    setDeleting(null); setNotice('Plantilla eliminada.'); setTemplates(values => values.filter(v => v.id !== item.id)); setTotal(value => Math.max(0, value - 1)); await latestLoad.current()
  }) }
  const changeDimensions = (w: number, h: number) => setDraft(value => ({ ...value, page_width: w, page_height: h, page_orientation: w > h ? 'landscape' : 'portrait' }))
  return <div className="flex h-full min-h-0 flex-col bg-slate-50/50 text-slate-900">
    <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-4 sm:px-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold tracking-tight">Plantillas</h1><p className="mt-1 text-sm text-slate-500">Diseña fichas, certificados y documentos con los datos de tus contactos.</p></div><div className="flex flex-wrap gap-2"><input type="file" accept=".json,application/json" ref={importRef} className="hidden" onChange={e => { importJSON(e.target.files?.[0]); e.target.value = '' }} /><button disabled={!!busy} onClick={() => importRef.current?.click()} className={`${control} inline-flex items-center gap-2 disabled:opacity-40`}><Upload className="h-4 w-4" />Importar diseño</button><button onClick={() => { setDraftError(''); setCreate(true) }} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700"><Plus className="h-4 w-4" />Nueva plantilla</button></div></div></header>
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6"><div className="relative min-w-0 flex-1 basis-56"><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" /><input value={query} maxLength={256} onChange={e => { setQuery(e.target.value); if (!e.target.value) setSettledQuery('') }} aria-label="Buscar plantillas" placeholder="Buscar por nombre o descripción" className={`${control} w-full pl-10 pr-11`} />{query && <button aria-label="Limpiar búsqueda" className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-slate-500" onClick={() => { setQuery(''); setSettledQuery('') }}><X className="h-4 w-4" /></button>}</div><span aria-live="polite" className="text-xs text-slate-500">{loading || query !== settledQuery ? 'Buscando…' : `${total} ${total === 1 ? 'plantilla' : 'plantillas'}`}</span><div className="flex rounded-xl border border-slate-200 p-1">{(['grid', 'list'] as const).map(mode => <button key={mode} onClick={() => setView(mode)} aria-label={mode === 'grid' ? 'Vista de tarjetas' : 'Vista de lista'} aria-pressed={mode === view} className={`flex h-11 w-11 items-center justify-center rounded-lg ${view === mode ? 'bg-slate-100 text-emerald-700' : 'text-slate-500'}`}>{mode === 'grid' ? <LayoutGrid className="h-4 w-4" /> : <List className="h-4 w-4" />}</button>)}</div></div>
    <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
      {error && <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"><span className="min-w-0 flex-1">{error}</span><button onClick={() => void load()} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-rose-200 px-3"><RefreshCw className="h-4 w-4" />Reintentar</button></div>}
      {notice && <p role="status" className="mb-4 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}
      {loading && !templates.length ? <div role="status" className="flex items-center justify-center gap-3 py-20 text-sm text-slate-500"><Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />Cargando plantillas…</div> : !templates.length && !error ? <div className="flex min-h-72 flex-col items-center justify-center text-center"><FileText className="mb-4 h-10 w-10 text-slate-300" /><h2 className="font-semibold">{settledQuery ? 'No hay plantillas con esa búsqueda' : 'Tu próximo documento empieza aquí'}</h2><p className="mt-2 max-w-md text-sm text-slate-500">{settledQuery ? 'Prueba otro nombre o limpia la búsqueda.' : 'Define el formato, añade tu contenido y reutiliza el diseño cuando lo necesites.'}</p>{!settledQuery && <button className="mt-5 min-h-11 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white" onClick={() => setCreate(true)}>Crear primera plantilla</button>}</div> : <div className={view === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-4' : 'space-y-2'}>
        {templates.map(item => <article key={item.id} className={`min-w-0 rounded-2xl border border-slate-200 bg-white transition-shadow hover:shadow-sm ${view === 'list' ? 'flex flex-wrap items-center gap-4 p-3' : 'overflow-hidden'}`}>
          <a href={`/dashboard/documents/${item.id}`} className={`${view === 'list' ? 'h-16 w-20 shrink-0 rounded-lg' : 'flex h-40 w-full border-b border-slate-100'} flex items-center justify-center bg-slate-100/80 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500`} aria-label={`Editar ${item.name}`}>{item.thumbnail_url && validDocumentAssetURL(item.thumbnail_url) ? <img src={item.thumbnail_url} alt="" loading="lazy" className="max-h-full max-w-full object-contain shadow-sm" onError={e => { e.currentTarget.style.visibility = 'hidden' }} /> : <FileText className="h-9 w-9 text-slate-300" />}</a>
          <div className={view === 'list' ? 'min-w-0 flex-1 basis-40' : 'p-4 pb-2'}><a href={`/dashboard/documents/${item.id}`} className="break-words text-sm font-semibold hover:text-emerald-700">{item.name}</a>{item.description && <p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-slate-500">{item.description}</p>}<p className="mt-2 text-xs text-slate-400">{item.page_width} × {item.page_height} mm · {new Date(item.updated_at).toLocaleDateString('es-PE', { day: 'numeric', month: 'short', year: 'numeric' })}</p></div>
          <div className={`flex flex-wrap items-center gap-1 ${view === 'grid' ? 'px-3 pb-3' : ''}`}><a href={`/dashboard/documents/${item.id}`} className="mr-auto inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-50">Editar<ArrowRight className="h-4 w-4" /></a>{[{ label: 'Duplicar', Icon: Copy, run: () => duplicate(item) }, { label: 'Descargar diseño', Icon: Download, run: () => exportJSON(item) }, { label: 'Eliminar', Icon: Trash2, run: () => { setError(''); setDeleting(item) } }].map(({ label, Icon, run }) => <button key={label} title={label} aria-label={`${label}: ${item.name}`} disabled={!!busy} onClick={run} className={`flex h-11 w-11 items-center justify-center rounded-xl disabled:opacity-40 ${label === 'Eliminar' ? 'text-slate-400 hover:bg-rose-50 hover:text-rose-600' : 'text-slate-500 hover:bg-slate-100'}`}><Icon className="h-4 w-4" /></button>)}</div>
        </article>)}
      </div>}
      {cursor && <div className="mt-5 text-center"><button disabled={loading} onClick={() => void load(cursor)} className={`${control} inline-flex items-center gap-2 disabled:opacity-50`}>{loading && <Loader2 className="h-4 w-4 animate-spin" />}Cargar más plantillas</button></div>}
    </main>
    {create && <DocumentDialog title="Nueva plantilla" description="Elige un formato; podrás ajustar el diseño en el editor." onClose={closeCreate} busy={busy === 'create'} initialFocusRef={nameRef} footer={<><button onClick={closeCreate} disabled={busy === 'create'} className={control}>Cancelar</button><button form="new-document" type="submit" disabled={busy === 'create' || !draft.name.trim()} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white disabled:opacity-40">{busy === 'create' && <Loader2 className="h-4 w-4 animate-spin" />}Crear y diseñar</button></>}><form id="new-document" onSubmit={saveCreate} className="space-y-4">
      {draftError && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{draftError}</p>}
      <label className="block text-sm font-medium">Nombre<input ref={nameRef} maxLength={200} required value={draft.name} onChange={e => setDraft(v => ({ ...v, name: e.target.value }))} className={`${control} mt-2 w-full`} placeholder="Por ejemplo, ficha de inscripción" /></label>
      <label className="block text-sm font-medium">Descripción opcional<textarea rows={2} maxLength={2000} value={draft.description} onChange={e => setDraft(v => ({ ...v, description: e.target.value }))} className={`${control} mt-2 w-full resize-y`} /></label>
      <fieldset><legend className="mb-2 text-sm font-medium">Formato</legend><div className="flex flex-wrap gap-2">{presets.map(preset => <button key={preset.name} type="button" className={`${control} ${draft.page_width === preset.w && draft.page_height === preset.h ? 'border-emerald-400 bg-emerald-50 text-emerald-800' : ''}`} onClick={() => changeDimensions(preset.w, preset.h)}>{preset.name}</button>)}</div></fieldset>
      <div className="grid grid-cols-2 gap-3"><label className="text-sm font-medium">Ancho (mm)<input type="number" min={10} max={2000} step="0.1" required className={`${control} mt-2 w-full`} value={draft.page_width} onChange={e => changeDimensions(Number(e.target.value), draft.page_height)} /></label><label className="text-sm font-medium">Alto (mm)<input type="number" min={10} max={2000} step="0.1" required className={`${control} mt-2 w-full`} value={draft.page_height} onChange={e => changeDimensions(draft.page_width, Number(e.target.value))} /></label></div><button type="button" className={control} onClick={() => changeDimensions(draft.page_height, draft.page_width)}>Cambiar orientación</button>
    </form></DocumentDialog>}
    {discard && <DocumentDialog title="Descartar nueva plantilla" description="Los datos que escribiste todavía no se han guardado." onClose={() => setDiscard(false)} footer={<><button className={control} onClick={() => setDiscard(false)}>Seguir editando</button><button className="min-h-11 rounded-xl bg-rose-600 px-4 text-sm font-medium text-white" onClick={() => { setDiscard(false); setCreate(false); setDraft(emptyDraft) }}>Descartar</button></>}><p className="text-sm text-slate-600">Podrás crear una nueva plantilla cuando quieras.</p></DocumentDialog>}
    {deleting && <DocumentDialog title="Eliminar plantilla" description={deleting.name} onClose={() => { if (!busy) setDeleting(null) }} busy={!!busy} footer={<><button disabled={!!busy} className={control} onClick={() => setDeleting(null)}>Cancelar</button><button disabled={!!busy} onClick={remove} className="min-h-11 rounded-xl bg-rose-600 px-4 text-sm font-medium text-white disabled:opacity-40">{busy ? 'Eliminando…' : 'Eliminar plantilla'}</button></>}><p className="text-sm text-slate-600">Se eliminará este diseño. Los documentos que ya descargaste y los archivos compartidos conservarán su contenido.</p>{error && <div role="alert" className="mt-3 text-sm text-rose-700"><p>{error}</p><button onClick={()=>setDeleting(null)} className="mt-2 min-h-11 rounded-xl border border-rose-200 px-3">Volver a revisar</button></div>}</DocumentDialog>}
  </div>
}
