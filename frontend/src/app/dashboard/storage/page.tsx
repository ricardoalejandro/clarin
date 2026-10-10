'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, CheckSquare, Clock3, Grid3X3, HardDrive, History, LayoutList, Loader2, RefreshCw, Search, ShieldCheck, Trash2, Undo2, X } from 'lucide-react'
import { api, apiGet } from '@/lib/api'
import { getAuthScope, isAuthIdentityChanging, subscribeAuthScope } from '@/lib/authScope'
import { SEARCH_DEBOUNCE_MS } from '@/lib/useDebouncedValue'
import { SearchRequestLifecycle } from '@/lib/searchRequestLifecycle'
import { StorageDialog } from '@/components/storage/StorageDialog'
import { MediaIcon, StoragePreview, StorageThumbnail } from '@/components/storage/StoragePreview'
import { canSelectStorageFile, EMPTY_FILTERS, formatStorageBytes, nextStorageTab, ORIGIN_LABELS, reconcileStorageSelection, resultStorageMessage, STORAGE_PAGE_SIZE, STORAGE_SELECTION_LIMIT, storageDate, storageFilesQuery, storagePreviewExpired, toggleStorageSelection, type StorageAction, type StorageActivity, type StorageFile, type StorageFilesResponse, type StorageFilters, type StorageResult, type StorageReview, type StorageTab, type StorageUsage } from '@/components/storage/storageModel'

const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45'
const secondary = `${button} border border-slate-200 bg-white text-slate-700 hover:bg-slate-50`
const primary = `${button} bg-emerald-600 text-white hover:bg-emerald-700`
const select = 'h-11 w-full min-w-0 rounded-xl border border-slate-200 bg-white pl-3 pr-6 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-emerald-500'
const actionLabels: Record<StorageAction, string> = { trash: 'Mover a la papelera', restore: 'Restaurar archivos', purge: 'Eliminar definitivamente' }
const actionTitles: Record<StorageAction, string> = { trash: 'Revisar eliminación', restore: 'Revisar restauración', purge: 'Revisar borrado definitivo' }

export default function StoragePage() {
  const scope = useSyncExternalStore(subscribeAuthScope, getAuthScope, () => 'server')
  if (scope === 'server' || isAuthIdentityChanging(scope)) return <div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-slate-500"><Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />Preparando el almacenamiento de la cuenta…</div>
  return <StorageWorkspace key={scope} scope={scope} />
}

function StorageWorkspace({ scope }: { scope: string }) {
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [collection, setCollection] = useState<StorageFilesResponse | null>(null)
  const [activity, setActivity] = useState<StorageActivity | null>(null)
  const [filters, setFilters] = useState<StorageFilters>({ ...EMPTY_FILTERS })
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<StorageTab>('files')
  const [offset, setOffset] = useState(0)
  const [view, setView] = useState<'list' | 'grid'>('list')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [operationError, setOperationError] = useState('')
  const [selected, setSelected] = useState<Map<string, StorageFile>>(new Map())
  const [preview, setPreview] = useState<StorageFile | null>(null)
  const [review, setReview] = useState<StorageReview | null>(null)
  const [reviewAction, setReviewAction] = useState<StorageAction | null>(null)
  const [reviewError, setReviewError] = useState('')
  const [reviewBusy, setReviewBusy] = useState(false)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [retryingOperation, setRetryingOperation] = useState<string | null>(null)
  const [result, setResult] = useState<StorageResult | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const [refresh, setRefresh] = useState(0)
  const requests = useRef(new SearchRequestLifecycle())
  const usageCache = useRef<{ refresh: number; data: StorageUsage & { success: boolean; error?: string } } | null>(null)
  const mutation = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const confirmLock = useRef(false)
  const filesSection = useRef<HTMLElement>(null)
  const files = collection?.files || []
  const canManage = usage?.can_manage === true && collection?.can_manage === true
  const pendingSearch = query.trim() !== filters.query
  const isCurrent = useCallback(() => mounted.current && getAuthScope() === scope, [scope])

  useEffect(() => {
    mounted.current = true
    try { const saved = localStorage.getItem('storage_view_mode'); if (saved === 'grid' || saved === 'list') setView(saved) } catch { /* Preference is optional. */ }
    return () => { mounted.current = false; requests.current.invalidate(); mutation.current?.abort() }
  }, [])

  useEffect(() => {
    if (!pendingSearch) return
    const timer = window.setTimeout(() => { setFilters(previous => ({ ...previous, query: query.trim() })); setOffset(0) }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query, pendingSearch])

  useEffect(() => {
    if (!review) return
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [review])

  useEffect(() => {
    if (pendingSearch || !isCurrent()) return
    const lease = requests.current.begin()
    setLoading(true); setError('')
    const load = async () => {
      const [usageResult, dataResult] = await Promise.all([
        usageCache.current?.refresh === refresh
          ? Promise.resolve({ success: true, data: usageCache.current.data, error: undefined })
          : apiGet<StorageUsage & { success: boolean; error?: string }>('/api/storage/usage', { signal: lease.signal }),
        tab === 'activity'
          ? apiGet<StorageActivity>(`/api/storage/activity?limit=${STORAGE_PAGE_SIZE}&offset=${offset}`, { signal: lease.signal })
          : apiGet<StorageFilesResponse>(`/api/storage/files?${storageFilesQuery(filters, tab, offset)}`, { signal: lease.signal }),
      ])
      if (!requests.current.isCurrent(lease) || !isCurrent()) return
      if (usageResult.success && usageResult.data?.success) { usageCache.current = { refresh, data: usageResult.data }; setUsage(usageResult.data) }
      if (dataResult.success && dataResult.data?.success) {
        if (tab === 'activity') setActivity(dataResult.data as StorageActivity)
        else {
          const data = dataResult.data as StorageFilesResponse
          if (offset > 0 && data.files.length === 0 && data.total <= offset) { setOffset(Math.max(0, Math.ceil(data.total / STORAGE_PAGE_SIZE) * STORAGE_PAGE_SIZE - STORAGE_PAGE_SIZE)); return }
          setCollection(data)
          setSelected(previous => {
            const next = new Map(previous)
            for (const file of data.files) if (next.has(file.object_key)) {
              if (canSelectStorageFile(file, tab, data.can_manage)) next.set(file.object_key, file)
              else next.delete(file.object_key)
            }
            if (!data.can_manage) next.clear()
            return next
          })
        }
      }
      if (!dataResult.success || !dataResult.data?.success || !usageResult.success || !usageResult.data?.success) setError(dataResult.error || dataResult.data?.error || usageResult.error || usageResult.data?.error || 'No se pudo actualizar el almacenamiento. Revisa tu conexión y vuelve a intentarlo.')
    }
    void load().catch(() => { if (requests.current.isCurrent(lease) && isCurrent()) setError('No se pudo actualizar el almacenamiento. Inténtalo de nuevo.') }).finally(() => { if (requests.current.finish(lease) && isCurrent()) setLoading(false) })
    return () => requests.current.invalidate()
  }, [filters, offset, tab, refresh, scope, pendingSearch, isCurrent])

  const applyFilter = (key: keyof StorageFilters, value: string) => {
    requests.current.invalidate(); setFilters(previous => ({ ...previous, [key]: value })); setOffset(0); setSelected(new Map())
  }
  const updateQuery = (value: string) => {
    if (value.trim() !== filters.query) requests.current.invalidate()
    setQuery(value); setSelected(new Map())
  }
  const clearSearch = () => { requests.current.invalidate(); setQuery(''); setFilters(previous => ({ ...previous, query: '' })); setOffset(0); setSelected(new Map()) }
  const changeTab = (value: StorageTab) => {
    requests.current.invalidate(); setTab(value); setOffset(0); setSelected(new Map()); setCollection(null); setActivity(null); setQuery(''); setFilters({ ...EMPTY_FILTERS }); setPreview(null); setError('')
  }
  const resetFilters = () => { requests.current.invalidate(); setQuery(''); setFilters({ ...EMPTY_FILTERS }); setOffset(0); setSelected(new Map()) }
  const reviewFiles = () => { requests.current.invalidate(); setTab('files'); setQuery(''); setFilters({ ...EMPTY_FILTERS, status: 'removable' }); setOffset(0); setSelected(new Map()); filesSection.current?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }) }
  const changeView = (value: 'list' | 'grid') => { setView(value); try { localStorage.setItem('storage_view_mode', value) } catch { /* Preference is optional. */ } }

  const eligiblePage = useMemo(() => files.filter(file => canSelectStorageFile(file, tab, canManage)), [files, tab, canManage])
  const allPageSelected = eligiblePage.length > 0 && eligiblePage.every(file => selected.has(file.object_key))
  const togglePage = () => setSelected(previous => {
    const next = new Map(previous)
    if (allPageSelected) eligiblePage.forEach(file => next.delete(file.object_key))
    else for (const file of eligiblePage) { if (next.size >= STORAGE_SELECTION_LIMIT) break; next.set(file.object_key, file) }
    return next
  })

  const prepare = async (action: StorageAction) => {
    if (!isCurrent() || selected.size === 0 || reviewBusy || confirmBusy) return
    mutation.current?.abort(); const controller = new AbortController(); mutation.current = controller
    setReviewAction(action); setReview(null); setReviewError(''); setAcknowledged(false); setReviewBusy(true)
    try {
      const response = await api<StorageReview>('/api/storage/cleanup/preview', { method: 'POST', body: JSON.stringify({ object_keys: Array.from(selected.keys()), action }), signal: controller.signal })
      if (!isCurrent() || controller.signal.aborted) return
      if (!response.success || !response.data?.success) { setReviewError(response.error || response.data?.error || 'No se pudo revisar la selección.'); return }
      setReview(response.data); setClock(Date.now())
    } catch { if (isCurrent() && !controller.signal.aborted) setReviewError('No se pudo revisar la selección. Revisa tu conexión e inténtalo de nuevo.') }
    finally { if (isCurrent() && !controller.signal.aborted) setReviewBusy(false) }
  }
  const closeReview = () => { if (confirmBusy) return; mutation.current?.abort(); setReviewAction(null); setReview(null); setReviewBusy(false); setReviewError('') }
  const confirmReview = async () => {
    if (!review || !isCurrent() || confirmLock.current || reviewBusy || storagePreviewExpired(review) || !review.eligible_count || (review.action === 'purge' && !acknowledged)) return
    confirmLock.current = true; setConfirmBusy(true); setReviewError('')
    mutation.current?.abort(); const controller = new AbortController(); mutation.current = controller
    try {
      const response = await api<StorageResult>('/api/storage/cleanup/confirm', { method: 'POST', body: JSON.stringify({ preview_id: review.preview_id }), signal: controller.signal })
      if (!isCurrent() || controller.signal.aborted) return
      if (!response.data?.operation_id) {
        setReviewError(response.error || response.data?.error || 'No se pudo confirmar el resultado. Consulta Actividad antes de volver a intentarlo.')
        setRefresh(value => value + 1)
        return
      }
      setResult(response.data); setSelected(previous => reconcileStorageSelection(previous, response.data!)); setReview(null); setReviewAction(null); setPreview(null); setRefresh(value => value + 1)
    } catch { if (isCurrent() && !controller.signal.aborted) setReviewError('Se interrumpió la conexión. Consulta Actividad para comprobar el resultado antes de volver a intentarlo.') }
    finally { confirmLock.current = false; if (isCurrent() && !controller.signal.aborted) setConfirmBusy(false) }
  }
  const retryOperation = async (operationID: string) => {
    if (!isCurrent() || confirmLock.current || !usage?.can_manage) return
    confirmLock.current = true; setRetryingOperation(operationID); setOperationError('')
    mutation.current?.abort(); const controller = new AbortController(); mutation.current = controller
    try {
      const response = await api<StorageResult>('/api/storage/cleanup/confirm', { method: 'POST', body: JSON.stringify({ preview_id: operationID }), signal: controller.signal })
      if (!isCurrent() || controller.signal.aborted) return
      if (response.data?.operation_id) setResult(response.data)
      else setOperationError(response.error || response.data?.error || 'No se pudo confirmar el resultado. Vuelve a consultar Actividad.')
      setRefresh(value => value + 1)
    } catch { if (isCurrent() && !controller.signal.aborted) setOperationError('Se interrumpió la conexión. Vuelve a consultar Actividad para comprobar el resultado.') }
    finally { confirmLock.current = false; if (isCurrent() && !controller.signal.aborted) setRetryingOperation(null) }
  }
  const expired = review ? storagePreviewExpired(review, clock) : false
  const selectedBytes = Array.from(selected.values()).reduce((sum, file) => sum + file.size_bytes, 0)
  const selectedCanRestore = Array.from(selected.values()).some(file => file.can_restore)
  const selectedCanPurge = Array.from(selected.values()).some(file => file.can_purge)
  const total = tab === 'activity' ? activity?.total || 0 : collection?.total || 0
  const shown = tab === 'activity' ? activity?.operations.length || 0 : files.length
  const hasMore = tab === 'activity' ? activity?.has_more : collection?.has_more
  const activeFilters = Object.entries(filters).some(([key, value]) => value !== EMPTY_FILTERS[key as keyof StorageFilters]) || !!query
  const showSkeleton = loading && (tab === 'activity' ? !activity : !collection)

  return <div className="h-full min-h-0 overflow-y-auto overscroll-contain pr-1" data-storage-workspace>
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 pb-6">
      <header className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h1 className="text-2xl font-semibold tracking-tight text-slate-900">Almacenamiento</h1><p className="mt-1 text-sm text-slate-500">Tus fotos, videos, audios y documentos, en un solo lugar.</p></div><button onClick={() => setRefresh(value => value + 1)} disabled={loading || pendingSearch} className={secondary}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} />Actualizar</button></header>
      {(error || operationError) && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><AlertCircle className="h-5 w-5 shrink-0" /><p className="min-w-0 flex-1">{error || operationError}{error && (collection || activity) ? ' Se conserva la última información disponible.' : ''}</p><button className={`${secondary} border-rose-200`} onClick={() => setRefresh(value => value + 1)} disabled={loading}>Reintentar</button></div>}
      {usage && !usage.can_manage && <p role="status" className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />Puedes consultar los archivos a los que tienes acceso. Necesitas permiso para gestionar el almacenamiento.</p>}
      {result && <section aria-label="Resultado de la operación" className={`rounded-2xl border p-4 ${result.status === 'completed' ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}><div className="flex items-start gap-3"><CheckCircle2 className={`mt-0.5 h-5 w-5 shrink-0 ${result.status === 'completed' ? 'text-emerald-600' : 'text-amber-600'}`} /><div className="min-w-0 flex-1"><p role="status" className="text-sm font-medium text-slate-800">{resultStorageMessage(result)}</p>{result.items.some(item => item.status !== 'completed') && <details className="mt-2 text-sm text-slate-600"><summary className="cursor-pointer py-2">Ver archivos pendientes</summary><ul className="space-y-2">{result.items.filter(item => item.status !== 'completed').map(item => <li key={item.object_key} className="break-words"><span className="font-medium">{item.filename}</span>: {item.reason || 'No se pudo completar. Vuelve a revisar el archivo.'}</li>)}</ul></details>}</div><button onClick={() => setResult(null)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl hover:bg-white/60" aria-label="Cerrar resultado"><X className="h-4 w-4" /></button></div></section>}
      <section aria-label="Resumen del almacenamiento" className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))' }}>
        <div><p className="text-sm font-medium text-slate-500">{usage?.scope === 'account' ? 'Espacio de la cuenta' : 'Archivos a los que tienes acceso'}</p><div className="mt-2 flex flex-wrap items-baseline gap-2"><span className="text-3xl font-semibold tracking-tight text-slate-900">{usage ? formatStorageBytes(usage.scope === 'account' ? usage.used_bytes : usage.visible_bytes) : '—'}</span><span className="text-sm text-slate-500">{usage?.scope === 'account' ? (usage.limit_bytes ? `de ${formatStorageBytes(usage.limit_bytes)}` : 'sin límite configurado') : usage ? 'en tus medios' : 'Calculando…'}</span></div>{usage?.scope === 'account' && usage.limit_bytes > 0 && <><div role="progressbar" aria-label="Espacio utilizado" aria-valuenow={Math.max(0, Math.min(100, Math.round(usage.percent_used)))} aria-valuemin={0} aria-valuemax={100} className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${usage.percent_used >= 90 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.max(0, Math.min(100, usage.percent_used))}%` }} /></div><p className="mt-2 text-xs text-slate-500">{formatStorageBytes(usage.available_bytes)} disponibles</p></>}<p className="mt-3 text-xs leading-5 text-slate-500">{usage ? `${usage.object_count.toLocaleString('es-PE')} archivos visibles · ${formatStorageBytes(usage.visible_bytes)}` : 'Cargando tus archivos…'}<br />Solo ves contenido al que tienes acceso.</p>{usage?.scope === 'account' && (usage.managed_elsewhere_bytes || 0) > 0 && <p className="mt-2 text-xs leading-5 text-slate-500">{formatStorageBytes(usage.managed_elsewhere_bytes)} corresponden a contenido gestionado desde otros módulos.</p>}</div>
        <div className="rounded-xl bg-slate-50 p-4"><div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><ShieldCheck className="h-4 w-4 text-emerald-600" />Limpieza con revisión</div><p className="mt-2 text-sm leading-6 text-slate-500">{usage?.removable_count ? `${usage.removable_count} archivos (${formatStorageBytes(usage.removable_bytes)}) se pueden revisar para enviarlos a la papelera.` : 'Elige qué conservar. Antes de retirar archivos, comprobarás qué se verá afectado.'}</p><button onClick={reviewFiles} disabled={!usage?.can_manage} className={`${primary} mt-3`}>Revisar archivos<ArrowRight className="h-4 w-4" /></button></div>
        <div className="flex flex-col justify-center"><div className="flex items-center gap-2 text-sm font-medium text-slate-600"><Trash2 className="h-4 w-4" />En la papelera</div><p className="mt-2 text-xl font-semibold text-slate-900">{usage ? formatStorageBytes(usage.trash_bytes) : '—'}</p><p className="mt-2 text-sm leading-6 text-slate-500">Los archivos en papelera siguen ocupando espacio. Puedes restaurarlos o eliminarlos definitivamente después de {usage?.retention_days || 7} días.</p><button onClick={() => changeTab('trash')} className="mt-1 inline-flex min-h-11 w-fit items-center gap-2 text-sm font-medium text-emerald-700 hover:underline">Ver papelera<ArrowRight className="h-4 w-4" /></button></div>
      </section>
      <section ref={filesSection} className="min-w-0 rounded-2xl border border-slate-200 bg-white" aria-label="Gestión de archivos">
        <div className="flex flex-wrap gap-1 border-b border-slate-200 px-2 pt-2 sm:px-4" role="tablist" aria-label="Vistas de almacenamiento">{([{ key: 'files', label: 'Archivos', icon: HardDrive }, { key: 'trash', label: 'Papelera', icon: Trash2 }, { key: 'activity', label: 'Actividad', icon: History }] as const).map(item => <button key={item.key} role="tab" tabIndex={tab === item.key ? 0 : -1} onKeyDown={event => { const next = nextStorageTab(tab, event.key, !!usage?.can_manage); if (next) { event.preventDefault(); changeTab(next); document.getElementById(`storage-tab-${next}`)?.focus() } }} aria-selected={tab === item.key} aria-controls={`storage-${item.key}`} id={`storage-tab-${item.key}`} disabled={item.key === 'activity' && !usage?.can_manage} title={item.key === 'activity' && !usage?.can_manage ? 'Necesitas permiso para gestionar el almacenamiento.' : undefined} onClick={() => changeTab(item.key)} className={`inline-flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 ${tab === item.key ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}><item.icon className="h-4 w-4" />{item.label}</button>)}</div>
        <div role="tabpanel" id={`storage-${tab}`} aria-labelledby={`storage-tab-${tab}`}>
          {tab !== 'activity' && <div className="space-y-3 border-b border-slate-100 p-4">
            <div className="flex flex-wrap items-center gap-2" aria-label="Tipos de archivo">{[{ key: '', label: 'Todos' }, { key: 'image', label: 'Fotos' }, { key: 'video', label: 'Videos' }, { key: 'audio', label: 'Audios' }, { key: 'document', label: 'Documentos' }].map(item => <button key={item.key} aria-pressed={filters.type === item.key} onClick={() => applyFilter('type', item.key)} className={`inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 text-sm font-medium ${filters.type === item.key ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-transparent text-slate-500 hover:bg-slate-50'}`}>{item.key && <MediaIcon type={item.key} className="h-4 w-4" />}{item.label}{item.key && tab === 'files' && usage && <span className="text-xs font-normal opacity-70">{formatStorageBytes(usage.by_type?.[item.key])}</span>}</button>)}</div>
            <div className="flex flex-wrap items-center gap-2"><div className="relative min-w-0 flex-1 basis-56"><Search className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" /><input aria-label="Buscar archivos" placeholder="Buscar por nombre de archivo" value={query} onChange={event => updateQuery(event.target.value)} className="h-11 w-full rounded-xl border border-slate-200 pl-9 pr-20 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-emerald-500" />{pendingSearch && <Loader2 aria-label="Esperando para buscar" className="absolute right-12 top-3.5 h-4 w-4 animate-spin text-emerald-500 motion-reduce:animate-none" />}{query && <button onClick={clearSearch} aria-label="Limpiar búsqueda" className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:text-slate-700"><X className="h-4 w-4" /></button>}</div><div className="flex rounded-xl border border-slate-200 p-0.5" aria-label="Presentación de archivos"><button aria-label="Vista de lista" aria-pressed={view === 'list'} onClick={() => changeView('list')} className={`flex h-11 w-11 items-center justify-center rounded-lg ${view === 'list' ? 'bg-slate-100 text-slate-800' : 'text-slate-400'}`}><LayoutList className="h-4 w-4" /></button><button aria-label="Vista de cuadrícula" aria-pressed={view === 'grid'} onClick={() => changeView('grid')} className={`flex h-11 w-11 items-center justify-center rounded-lg ${view === 'grid' ? 'bg-slate-100 text-slate-800' : 'text-slate-400'}`}><Grid3X3 className="h-4 w-4" /></button></div></div>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))' }}>
              <label className="min-w-0"><span className="mb-1 block text-xs text-slate-500">Origen</span><select aria-label="Filtrar por origen" className={select} value={filters.origin} onChange={event => applyFilter('origin', event.target.value)}><option value="">Todos los orígenes</option>{Object.entries(ORIGIN_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
              <label className="min-w-0"><span className="mb-1 block text-xs text-slate-500">Tamaño</span><select aria-label="Tamaño mínimo" className={select} value={filters.minSize} onChange={event => applyFilter('minSize', event.target.value)}><option value="">Cualquier tamaño</option><option value="10485760">Más de 10 MB</option><option value="52428800">Más de 50 MB</option><option value="104857600">Más de 100 MB</option></select></label>
              <label className="min-w-0"><span className="mb-1 block text-xs text-slate-500">Antigüedad</span><select aria-label="Antigüedad" className={select} value={filters.age} onChange={event => applyFilter('age', event.target.value)}><option value="">Cualquier fecha</option><option value="30">Más de 30 días</option><option value="90">Más de 90 días</option><option value="365">Más de un año</option></select></label>
              <label className="min-w-0"><span className="mb-1 block text-xs text-slate-500">Orden</span><select aria-label="Ordenar archivos" className={select} value={filters.sort} onChange={event => applyFilter('sort', event.target.value)}><option value="size">Más grandes primero</option><option value="date">Más recientes primero</option><option value="name">Nombre: A a Z</option></select></label>
              {tab === 'files' && <label className="min-w-0"><span className="mb-1 block text-xs text-slate-500">Disponibilidad</span><select aria-label="Disponibilidad para limpiar" className={select} value={filters.status} onChange={event => applyFilter('status', event.target.value)}><option value="all">Todos los archivos</option><option value="removable">Se pueden retirar</option><option value="protected">Se deben conservar</option></select></label>}
            </div>
            {activeFilters && <button onClick={resetFilters} className="inline-flex min-h-11 items-center gap-2 text-sm text-slate-600 hover:text-slate-900"><X className="h-4 w-4" />Limpiar filtros</button>}
          </div>}
          {tab === 'trash' && <p className="flex items-start gap-2 border-b border-slate-100 bg-slate-50/70 px-4 py-3 text-sm text-slate-600"><Clock3 className="mt-0.5 h-4 w-4 shrink-0" />Puedes restaurar los archivos mientras sigan aquí. El borrado definitivo estará disponible a partir de la fecha indicada.</p>}
          {selected.size > 0 && <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-emerald-100 bg-emerald-50 p-3"><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-emerald-900">{selected.size} seleccionado{selected.size === 1 ? '' : 's'} · {formatStorageBytes(selectedBytes)}</p><p className="text-xs text-emerald-700">{selected.size === STORAGE_SELECTION_LIMIT ? 'Has llegado al máximo de 100 archivos por operación.' : 'Revisarás el impacto antes de confirmar.'}</p></div><button onClick={() => setSelected(new Map())} className={secondary}>Cancelar selección</button>{tab === 'trash' ? <><button onClick={() => void prepare('restore')} disabled={!selectedCanRestore || reviewBusy || confirmBusy || loading || pendingSearch || !!error} className={primary}><Undo2 className="h-4 w-4" />Restaurar</button><button onClick={() => void prepare('purge')} disabled={!selectedCanPurge || reviewBusy || confirmBusy || loading || pendingSearch || !!error} className={`${secondary} text-rose-700`}>Revisar borrado</button></> : <button onClick={() => void prepare('trash')} disabled={reviewBusy || confirmBusy || loading || pendingSearch || !!error} className={primary}><CheckSquare className="h-4 w-4" />Revisar selección</button>}</div>}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2"><div className="flex min-h-11 items-center gap-2 text-xs text-slate-500">{canManage && tab !== 'activity' && files.length > 0 && <label className="flex min-h-11 cursor-pointer items-center gap-2"><input aria-label="Seleccionar archivos de esta página" type="checkbox" checked={allPageSelected} disabled={!eligiblePage.length || loading || pendingSearch} onChange={togglePage} className="h-4 w-4 accent-emerald-600" /><span>Seleccionar página</span></label>}{tab === 'activity' ? <span>Historial de las operaciones de esta cuenta</span> : <span>{total.toLocaleString('es-PE')} archivo{total === 1 ? '' : 's'}</span>}</div>{(loading || pendingSearch) && <span role="status" className="flex items-center gap-2 text-xs text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{pendingSearch ? 'Esperando búsqueda…' : 'Actualizando…'}</span>}</div>
          {showSkeleton ? <div role="status" aria-label="Cargando archivos" className="space-y-3 p-4">{[0, 1, 2, 3].map(value => <div key={value} className="h-16 animate-pulse rounded-xl bg-slate-100 motion-reduce:animate-none" />)}</div> : total === 0 ? <div className="px-5 py-14 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-50 text-slate-400">{tab === 'activity' ? <History className="h-6 w-6" /> : <HardDrive className="h-6 w-6" />}</div><h3 className="mt-4 text-sm font-semibold text-slate-800">{error ? 'No se pudieron cargar los archivos' : tab === 'activity' ? 'Todavía no hay operaciones' : tab === 'trash' ? 'La papelera está vacía' : activeFilters ? 'No hay archivos con estos filtros' : 'No hay archivos disponibles'}</h3><p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-500">{tab === 'activity' ? 'Aquí verás las limpiezas, restauraciones y su resultado.' : activeFilters ? 'Prueba con otro nombre o amplía los filtros.' : 'Los archivos que puedes consultar aparecerán aquí.'}</p>{activeFilters && <button onClick={resetFilters} className={`${secondary} mt-4`}>Limpiar filtros</button>}</div> : tab === 'activity' ? <div className="divide-y divide-slate-100">{activity?.operations.map(operation => <article key={operation.id} className="flex flex-wrap items-start gap-3 p-4"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500">{operation.action === 'restore' ? <Undo2 className="h-5 w-5" /> : <Trash2 className="h-5 w-5" />}</span><div className="min-w-0 flex-1"><h3 className="text-sm font-medium text-slate-800">{operation.action === 'trash' ? 'Archivos enviados a la papelera' : operation.action === 'restore' ? 'Restauración de archivos' : 'Borrado definitivo'}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{storageDate(operation.created_at)} · {operation.files_count} archivos procesados{operation.action === 'purge' ? ` · ${formatStorageBytes(operation.freed_bytes)} liberados` : operation.action === 'trash' ? ' · El espacio sigue ocupado' : ''}</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${operation.status === 'completed' ? 'bg-emerald-50 text-emerald-700' : operation.status === 'processing' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-800'}`}>{operation.status === 'completed' ? 'Completada' : operation.status === 'partial' ? 'Completada con pendientes' : operation.status === 'processing' ? 'Eliminación pendiente' : 'No se pudo completar'}</span>{operation.can_retry && <button onClick={() => void retryOperation(operation.id)} disabled={!!retryingOperation || loading} className={secondary}>{retryingOperation === operation.id ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="h-4 w-4" />}Reintentar operación</button>}</article>)}</div> : <div className={view === 'grid' ? 'grid gap-3 p-4' : 'divide-y divide-slate-100'} style={view === 'grid' ? { gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 210px), 1fr))' } : undefined}>{files.map(file => {
            const selectable = canSelectStorageFile(file, tab, canManage)
            return <article key={file.object_key} className={`${view === 'grid' ? 'flex flex-col rounded-2xl border p-3' : 'flex flex-wrap items-center gap-3 p-3 sm:px-4'} ${selected.has(file.object_key) ? 'border-emerald-200 bg-emerald-50/60' : 'border-slate-200 hover:bg-slate-50/70'}`}>
              <div className={view === 'grid' ? 'mb-2 flex items-center justify-between gap-2' : 'shrink-0'}>{canManage && <label className="flex h-11 w-11 cursor-pointer items-center justify-center" title={!selectable ? file.blocked_reason || 'Este archivo debe conservarse' : 'Seleccionar archivo'}><input aria-label={`Seleccionar ${file.filename}`} type="checkbox" checked={selected.has(file.object_key)} disabled={!selectable || loading || pendingSearch || (!selected.has(file.object_key) && selected.size >= STORAGE_SELECTION_LIMIT)} onChange={() => setSelected(previous => toggleStorageSelection(previous, file))} className="h-4 w-4 accent-emerald-600 disabled:cursor-not-allowed disabled:opacity-40" /></label>}{view === 'grid' && <span className="text-xs text-slate-500">{formatStorageBytes(file.size_bytes)}</span>}</div>
              <button onClick={() => setPreview(file)} aria-label={`Ver ${file.filename}`} className={view === 'grid' ? 'mb-3 aspect-[4/3] w-full overflow-hidden rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500' : 'h-12 w-12 shrink-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500'}><StorageThumbnail file={file} scope={scope} /></button>
              <div className="min-w-0 flex-1"><button onClick={() => setPreview(file)} className="min-h-11 max-w-full text-left text-sm font-medium text-slate-900 hover:text-emerald-700"><span className="block break-all">{file.filename || 'Archivo'}</span></button><p className="text-xs leading-5 text-slate-500">{view === 'list' && `${formatStorageBytes(file.size_bytes)} · `}{storageDate(file.last_modified)}</p><p className="mt-1 break-words text-xs leading-5 text-slate-500">{file.origins?.map(origin => origin.label).join(' · ') || 'Archivo de la cuenta'}</p>{file.status === 'trash' ? <p className="mt-1 text-xs leading-5 text-amber-700">{file.can_purge ? 'Disponible para borrado definitivo' : `Borrado disponible desde ${storageDate(file.purge_after)}`}</p> : !file.can_remove && <p className="mt-1 flex items-start gap-1 text-xs leading-5 text-slate-500"><ShieldCheck className="mt-1 h-3 w-3 shrink-0" /><span>{file.blocked_reason || 'Se conserva porque sigue en uso.'}</span></p>}</div>
              <button onClick={() => setPreview(file)} className={`min-h-11 rounded-xl px-3 text-xs font-medium text-emerald-700 hover:bg-emerald-50 ${view === 'grid' ? 'mt-3 border border-slate-200' : 'ml-auto'}`}>Ver detalles</button>
            </article>
          })}</div>}
          {total > 0 && <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 p-4"><p className="text-xs text-slate-500">{offset + 1}–{Math.min(offset + shown, total)} de {total.toLocaleString('es-PE')}{selected.size ? ` · ${selected.size} seleccionados en total` : ''}</p><div className="flex gap-2"><button aria-label="Página anterior" onClick={() => { requests.current.invalidate(); setOffset(Math.max(0, offset - STORAGE_PAGE_SIZE)) }} disabled={offset === 0 || loading || pendingSearch} className={secondary}><ArrowLeft className="h-4 w-4" /><span>Anterior</span></button><button aria-label="Página siguiente" onClick={() => { requests.current.invalidate(); setOffset(tab === 'activity' ? offset + STORAGE_PAGE_SIZE : collection?.next_offset ?? offset + STORAGE_PAGE_SIZE) }} disabled={!hasMore || loading || pendingSearch} className={secondary}><span>Siguiente</span><ArrowRight className="h-4 w-4" /></button></div></footer>}
        </div>
      </section>
    </div>
    {preview && <StoragePreview key={`${scope}:${preview.object_key}`} file={preview} scope={scope} onClose={() => setPreview(null)} />}
    {reviewAction && <StorageDialog title={actionTitles[reviewAction]} description="Comprueba los archivos y el efecto de la operación antes de confirmar." busy={confirmBusy} onClose={closeReview} footer={<><button onClick={closeReview} disabled={confirmBusy} className={secondary}>Cancelar</button>{(!review || expired) && !reviewBusy ? <button onClick={() => void prepare(reviewAction)} className={primary}>Volver a revisar</button> : <button onClick={() => void confirmReview()} disabled={reviewBusy || confirmBusy || !review?.eligible_count || expired || (reviewAction === 'purge' && !acknowledged)} className={reviewAction === 'purge' ? `${button} bg-rose-600 text-white hover:bg-rose-700` : primary}>{confirmBusy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}{actionLabels[reviewAction]}</button>}</>}>
      {reviewBusy ? <p role="status" className="flex items-center gap-2 py-8 text-sm text-slate-500"><Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />Comprobando dónde se utilizan los archivos…</p> : <>
        {reviewError && <p role="alert" className="mb-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{reviewError}</p>}
        {review && <><div className={`rounded-xl p-4 ${reviewAction === 'purge' ? 'bg-rose-50' : 'bg-emerald-50'}`}><p className="text-sm font-semibold text-slate-900">{review.eligible_count} archivo{review.eligible_count === 1 ? '' : 's'} · {formatStorageBytes(review.estimated_bytes)}</p><p className="mt-2 text-sm leading-6 text-slate-600">{reviewAction === 'trash' ? `Los adjuntos se retirarán de sus chats; el texto de los mensajes se conserva. Podrás recuperarlos desde la papelera. El espacio se liberará cuando los elimines definitivamente, a partir de ${usage?.retention_days || 7} días.` : reviewAction === 'restore' ? 'Los archivos volverán a estar disponibles en sus ubicaciones originales, si estas siguen existiendo.' : 'Esta acción elimina los archivos definitivamente. No podrás recuperarlos. El espacio se confirmará cuando termine el borrado.'}</p></div>
          <ul className="mt-4 divide-y divide-slate-100">{review.items.map(item => <li key={item.object_key} className="flex items-start gap-2 py-3">{item.eligible ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />}<div className="min-w-0 flex-1"><p className="break-all text-sm font-medium text-slate-800">{item.filename}</p><p className="mt-0.5 text-xs leading-5 text-slate-500">{item.reason || (item.eligible ? 'Listo para procesar' : 'Se conservará porque no se puede retirar con seguridad.')}</p></div><span className="shrink-0 text-xs text-slate-500">{formatStorageBytes(item.size_bytes)}</span></li>)}</ul>
          {reviewAction === 'purge' && review.eligible_count > 0 && <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-rose-200 p-3 text-sm text-slate-700"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-rose-600" />Entiendo que estos archivos no se podrán recuperar.</label>}
          {expired && <p role="alert" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">La revisión venció. Vuelve a comprobar los archivos antes de confirmar.</p>}
        </>}
      </>}
    </StorageDialog>}
  </div>
}
