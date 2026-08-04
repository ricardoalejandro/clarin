'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { BarChart3, ExternalLink, Layers3, Loader2, Plus, Search, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import { surveyApplicationsURL, type SurveyApplicationArchiveState, type SurveyApplicationOrigin, type SurveyApplicationStatus } from '@/lib/surveyApplications'
import type { SurveyInstanceSummary, SurveyTemplate } from '@/types/survey-template'
import { useAccessibleDialog } from '@/components/pipelines/useAccessibleDialog'
import StandaloneSurveyApplicationDialog from './StandaloneSurveyApplicationDialog'
import SurveyApplicationLifecycleActions, { surveyDeletionExplanation } from './SurveyApplicationLifecycleActions'

export interface SurveyApplicationCounts {
  current: number
  archived: number
}

interface SurveyApplicationsPage {
  items: SurveyInstanceSummary[]
  next_cursor: string
  has_more: boolean
  counts: SurveyApplicationCounts
}

export default function SurveyApplicationsBrowser({ template, variant = 'drawer', onClose, onCountsChange }: {
  template: SurveyTemplate
  variant?: 'drawer' | 'embedded'
  onClose?: () => void
  onCountsChange?: (counts: SurveyApplicationCounts) => void
}) {
  const router = useRouter()
  const dialogRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef<AbortController | null>(null)
  const requestSequence = useRef(0)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useDebouncedValue(query)
  const [archiveState, setArchiveState] = useState<SurveyApplicationArchiveState>('current')
  const [status, setStatus] = useState<SurveyApplicationStatus>('all')
  const [originType, setOriginType] = useState<SurveyApplicationOrigin>('all')
  const [items, setItems] = useState<SurveyInstanceSummary[]>([])
  const [counts, setCounts] = useState<SurveyApplicationCounts>({ current: template.instance_count, archived: template.archived_instance_count || 0 })
  const [nextCursor, setNextCursor] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)

  useAccessibleDialog(variant === 'drawer' && !createOpen, dialogRef, () => onClose?.(), searchRef)

  const load = useCallback(async (append = false) => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    const sequence = ++requestSequence.current
    if (append) setLoadingMore(true)
    else setLoading(true)
    setError('')
    const response = await api<SurveyApplicationsPage>(surveyApplicationsURL(template.id, {
      query: debouncedQuery,
      archiveState,
      status,
      originType,
      cursor: append ? nextCursor : undefined,
    }), { signal: controller.signal })
    if (controller.signal.aborted || sequence !== requestSequence.current) return
    setLoading(false)
    setLoadingMore(false)
    if (!response.success || !response.data) {
      setError(response.error || 'No se pudieron cargar las aplicaciones.')
      return
    }
    setItems(current => {
      if (!append) return response.data!.items || []
      const merged = new Map(current.map(item => [item.id, item]))
      for (const item of response.data!.items || []) merged.set(item.id, item)
      return Array.from(merged.values())
    })
    const canonicalCounts = response.data.counts || { current: 0, archived: 0 }
    setCounts(canonicalCounts)
    onCountsChange?.(canonicalCounts)
    setNextCursor(response.data.next_cursor || '')
    setHasMore(Boolean(response.data.has_more))
  }, [archiveState, debouncedQuery, nextCursor, onCountsChange, originType, status, template.id])

  useEffect(() => {
    void load(false)
    return () => requestRef.current?.abort()
    // Loading the first page must not depend on the cursor returned by that page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archiveState, debouncedQuery, originType, status, template.id])

  const reconcile = () => void load(false)
  const createDisabled = template.status === 'archived' || template.question_count === 0
  const browser = <div ref={dialogRef} tabIndex={variant === 'drawer' ? -1 : undefined} role={variant === 'drawer' ? 'dialog' : undefined} aria-modal={variant === 'drawer' ? true : undefined} aria-labelledby="survey-applications-title" className={`${variant === 'drawer' ? 'h-full w-full max-w-[720px] shadow-2xl' : 'h-full w-full'} flex min-h-0 flex-col bg-slate-50 outline-none`}>
    <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700"><Layers3 className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1"><h2 id="survey-applications-title" className="truncate text-lg font-bold text-slate-900">Aplicaciones</h2><p className="mt-0.5 truncate text-sm text-slate-500">{template.name} · cada aplicación conserva su versión publicada</p></div>
        {variant === 'drawer' && <button type="button" onClick={onClose} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100" aria-label="Cerrar aplicaciones"><X className="h-5 w-5" /></button>}
      </div>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input ref={searchRef} value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value) setDebouncedQuery('') }} placeholder="Buscar por nombre, origen o slug" className="min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-10 text-sm outline-none focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100" />{query !== debouncedQuery && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-500" aria-label="Buscando" />}</div>
        <button type="button" onClick={() => setCreateOpen(true)} disabled={createDisabled} title={template.status === 'archived' ? 'Restaura la plantilla para aplicarla.' : template.question_count === 0 ? 'Agrega al menos una pregunta.' : undefined} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"><Plus className="h-4 w-4" />Nueva aplicación</button>
      </div>
      <div className="mt-3 grid min-h-11 grid-cols-2 rounded-xl bg-slate-100 p-1" role="group" aria-label="Estado de archivo"><button type="button" onClick={() => setArchiveState('current')} className={`rounded-lg text-sm font-semibold ${archiveState === 'current' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>Actuales ({counts.current})</button><button type="button" onClick={() => setArchiveState('archived')} className={`rounded-lg text-sm font-semibold ${archiveState === 'archived' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>Archivadas ({counts.archived})</button></div>
      <div className="mt-3 grid grid-cols-2 gap-2"><label className="sr-only" htmlFor={`survey-status-${variant}`}>Estado</label><select id={`survey-status-${variant}`} value={status} onChange={event => setStatus(event.target.value as SurveyApplicationStatus)} className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700"><option value="all">Todos los estados</option><option value="draft">Borrador</option><option value="active">Activa</option><option value="closed">Cerrada</option></select><label className="sr-only" htmlFor={`survey-origin-${variant}`}>Origen</label><select id={`survey-origin-${variant}`} value={originType} onChange={event => setOriginType(event.target.value as SurveyApplicationOrigin)} className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700"><option value="all">Todos los orígenes</option><option value="standalone">Independiente</option><option value="program">Programa</option></select></div>
    </header>

    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5" aria-busy={loading || loadingMore}>
      {error && <div role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"><p>{error}</p><button type="button" onClick={() => void load(false)} className="mt-2 min-h-9 font-semibold underline">Reintentar</button></div>}
      {loading && items.length === 0 ? <div className="flex min-h-56 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div> : items.length === 0 && !error ? <div className="flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center"><Layers3 className="h-9 w-9 text-slate-300" /><p className="mt-3 font-semibold text-slate-700">{debouncedQuery ? 'No hay coincidencias' : archiveState === 'archived' ? 'No hay aplicaciones archivadas' : 'Todavía no hay aplicaciones'}</p><p className="mt-1 max-w-md text-sm text-slate-500">{archiveState === 'current' ? 'Crea una aplicación pública aquí o una aplicación con destinatarios congelados desde Programas.' : 'Las aplicaciones archivadas conservarán aquí sus resultados.'}</p></div> : <div className={`space-y-3 transition-opacity ${loading ? 'opacity-60' : ''}`}>{items.map(instance => <ApplicationRow key={instance.id} instance={instance} onChanged={reconcile} />)}{hasMore && <button type="button" onClick={() => void load(true)} disabled={loadingMore} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">{loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}Cargar más</button>}</div>}
    </div>
    {createOpen && <StandaloneSurveyApplicationDialog template={template} onClose={() => setCreateOpen(false)} onCreated={instance => { setCreateOpen(false); router.push(`/dashboard/surveys/${instance.id}?mode=instance&tab=share`) }} />}
  </div>

  if (variant === 'embedded') return browser
  return createPortal(<div className="fixed inset-0 z-[85] flex justify-end bg-slate-950/45 backdrop-blur-[1px]" onMouseDown={event => { if (event.target === event.currentTarget) onClose?.() }}>{browser}</div>, document.body)
}

function ApplicationRow({ instance, onChanged }: { instance: SurveyInstanceSummary; onChanged: () => void }) {
  const date = new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(instance.created_at))
  const statusLabel = instance.archived_at ? 'Archivada' : instance.status === 'active' ? 'Activa' : instance.status === 'draft' ? 'Borrador' : 'Cerrada'
  return <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
    <div className="flex items-start gap-3"><span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${instance.archived_at ? 'bg-slate-300' : instance.status === 'active' ? 'bg-emerald-500' : instance.status === 'draft' ? 'bg-amber-400' : 'bg-slate-400'}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="min-w-0 truncate font-semibold text-slate-900">{instance.name}</h3><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">v{instance.template_revision}</span><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{statusLabel}</span></div><p className="mt-1 truncate text-sm text-slate-500">{instance.origin_label} · {instance.origin_type === 'program' ? 'Programa' : 'Independiente'}</p><p className="mt-1 text-xs text-slate-400">{instance.response_count} respuestas{instance.recipient_count > 0 ? ` · ${instance.recipient_count} destinatarios` : ''} · {date}</p></div></div>
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3"><Link href={`/dashboard/surveys/${instance.id}?mode=instance&tab=analytics`} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"><BarChart3 className="h-4 w-4" />Resultados</Link>{instance.audience_mode === 'public' && <a href={`/f/${instance.slug}`} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"><ExternalLink className="h-4 w-4" />Enlace público</a>}<div className="ml-auto"><SurveyApplicationLifecycleActions target={instance} onUpdated={onChanged} onDeleted={onChanged} /></div></div>
    {!instance.can_delete && <p className="mt-2 text-xs leading-5 text-slate-500">{surveyDeletionExplanation(instance)}{!instance.archived_at && instance.can_archive !== false ? ' Puedes archivarla para conservar su historial.' : ''}</p>}
  </article>
}
