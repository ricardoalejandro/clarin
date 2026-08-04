'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Archive, BarChart3, ChevronRight, ClipboardList, Copy, FileText, Grid2X2, Layers3, List, Loader2, Plus, RotateCcw, Rows3, Search } from 'lucide-react'
import { api } from '@/lib/api'
import { useDebouncedValue } from '@/lib/useDebouncedValue'
import type { SurveyTemplate } from '@/types/survey-template'
import DuplicateSurveyTemplateDialog from '@/components/surveys/DuplicateSurveyTemplateDialog'
import ArchiveSurveyTemplateDialog from '@/components/surveys/ArchiveSurveyTemplateDialog'
import CreateSurveyTemplateDialog from '@/components/surveys/CreateSurveyTemplateDialog'
import StandaloneSurveyApplicationDialog from '@/components/surveys/StandaloneSurveyApplicationDialog'
import SurveyApplicationsBrowser, { type SurveyApplicationCounts } from '@/components/surveys/SurveyApplicationsBrowser'
import { parseSurveyCatalogView, resolveSurveyCatalogView, type SurveyCatalogView } from '@/lib/surveyCatalogView'

const VIEW_KEY = 'clarin.surveys.catalog.view.v1'

export default function SurveyTemplatesPage() {
  const router = useRouter()
  const contentRef = useRef<HTMLElement | null>(null)
  const [contentWidth, setContentWidth] = useState(0)
  const [view, setView] = useState<SurveyCatalogView>('compact')
  const [templates, setTemplates] = useState<SurveyTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useDebouncedValue(query)
  const [showArchived, setShowArchived] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [applyTemplate, setApplyTemplate] = useState<SurveyTemplate | null>(null)
  const [applicationsTemplate, setApplicationsTemplate] = useState<SurveyTemplate | null>(null)
  const [duplicateTemplate, setDuplicateTemplate] = useState<SurveyTemplate | null>(null)
  const [archiveTemplate, setArchiveTemplate] = useState<SurveyTemplate | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [archiveError, setArchiveError] = useState('')

  useEffect(() => setView(parseSurveyCatalogView(window.localStorage.getItem(VIEW_KEY))), [])
  useEffect(() => {
    const node = contentRef.current
    if (!node) return
    const observer = new ResizeObserver(entries => setContentWidth(entries[0]?.contentRect.width || 0))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const resolvedView = resolveSurveyCatalogView(view, contentWidth)
  const chooseView = (next: SurveyCatalogView) => {
    setView(next)
    window.localStorage.setItem(VIEW_KEY, next)
  }

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    const response = await api<SurveyTemplate[]>('/api/survey-templates?include_archived=true')
    if (response.success) setTemplates(response.data || [])
    else setLoadError(response.error || 'No se pudieron cargar las plantillas.')
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => templates.filter(template => {
    if ((template.status === 'archived') !== showArchived) return false
    const normalized = debouncedQuery.trim().toLocaleLowerCase('es')
    return !normalized || `${template.name} ${template.description}`.toLocaleLowerCase('es').includes(normalized)
  }), [debouncedQuery, showArchived, templates])

  const patchTemplate = (templateId: string, patch: Partial<SurveyTemplate>) => {
    setTemplates(current => current.map(template => template.id === templateId ? { ...template, ...patch } : template))
    setApplicationsTemplate(current => current?.id === templateId ? { ...current, ...patch } : current)
  }
  const reconcileCounts = (templateId: string, counts: SurveyApplicationCounts) => patchTemplate(templateId, {
    instance_count: counts.current,
    archived_instance_count: counts.archived,
  })
  const changeArchiveStatus = async (template: SurveyTemplate, status: SurveyTemplate['status']) => {
    const response = await api<SurveyTemplate>(`/api/survey-templates/${template.id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
    if (!response.success || !response.data) throw new Error(response.error || 'No se pudo actualizar la plantilla.')
    setTemplates(current => current.map(item => item.id === template.id ? response.data! : item))
  }
  const requestArchive = (template: SurveyTemplate) => {
    setActionError('')
    if (template.status === 'archived') {
      void changeArchiveStatus(template, 'active').catch(error => setActionError(error instanceof Error ? error.message : 'No se pudo restaurar la plantilla.'))
      return
    }
    setArchiveError('')
    setArchiveTemplate(template)
  }
  const confirmArchive = async () => {
    if (!archiveTemplate) return
    setArchiving(true)
    setArchiveError('')
    try {
      await changeArchiveStatus(archiveTemplate, 'archived')
      setArchiveTemplate(null)
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : 'No se pudo archivar la plantilla.')
    } finally { setArchiving(false) }
  }
  const duplicate = async (template: SurveyTemplate, copyName: string) => {
    const response = await api<SurveyTemplate>(`/api/survey-templates/${template.id}/duplicate`, { method: 'POST', body: JSON.stringify({ name: copyName }) })
    if (!response.success || !response.data) throw new Error(response.error || 'No se pudo duplicar la plantilla.')
    setDuplicateTemplate(null)
    router.push(`/dashboard/surveys/${response.data.id}?mode=template`)
  }

  const itemProps: Omit<ItemProps, 'template'> = {
    onApply: setApplyTemplate,
    onApplications: setApplicationsTemplate,
    onDuplicate: setDuplicateTemplate,
    onArchive: requestArchive,
  }

  return <div className="flex h-full min-h-0 flex-col bg-slate-50">
    <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-4 sm:px-6">
      <div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700"><ClipboardList className="h-5 w-5" /></span><div className="min-w-0"><h1 className="truncate text-lg font-bold text-slate-900 sm:text-xl">Plantillas de encuesta</h1><p className="text-sm text-slate-500">Diseña una vez y genera aplicaciones independientes.</p></div></div><button type="button" onClick={() => setCreateOpen(true)} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-emerald-600 px-3.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"><Plus className="h-4 w-4" /><span className="hidden sm:inline">Nueva plantilla</span><span className="sm:hidden">Nueva</span></button></div>
      <div className="mt-4 flex flex-col gap-3 lg:flex-row"><div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value) setDebouncedQuery('') }} placeholder="Buscar plantilla" className="min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-10 text-sm outline-none focus:border-emerald-500 focus:bg-white" />{query !== debouncedQuery && <Loader2 aria-label="Buscando plantillas" className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-500" />}</div><div className="flex gap-3"><div className="grid min-h-11 flex-1 grid-cols-2 rounded-xl bg-slate-100 p-1 lg:w-64"><button type="button" onClick={() => setShowArchived(false)} className={`rounded-lg text-sm font-medium ${!showArchived ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`}>Activas</button><button type="button" onClick={() => setShowArchived(true)} className={`rounded-lg text-sm font-medium ${showArchived ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`}>Archivadas</button></div><div className="hidden min-h-11 items-center rounded-xl border border-slate-200 bg-white p-1 sm:flex" role="group" aria-label="Vista del catálogo">{([['cards', Grid2X2, 'Fichas'], ['list', List, 'Lista'], ['compact', Rows3, 'Compacta']] as const).map(([mode, Icon, label]) => <button key={mode} type="button" onClick={() => chooseView(mode)} aria-label={label} aria-pressed={view === mode} className={`inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg ${view === mode ? 'bg-slate-100 text-slate-900' : 'text-slate-400 hover:text-slate-700'}`}><Icon className="h-4 w-4" /></button>)}</div></div></div>
      {actionError && <div role="alert" className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"><span>{actionError}</span><button type="button" onClick={() => setActionError('')} className="min-h-9 px-2 font-semibold">Cerrar</button></div>}
    </header>

    <main ref={contentRef} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      {loading ? <TemplateSkeleton /> : loadError ? <ErrorState error={loadError} retry={load} /> : filtered.length === 0 ? <EmptyState searched={Boolean(debouncedQuery)} archived={showArchived} create={() => setCreateOpen(true)} /> : resolvedView === 'cards' ? <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 lg:grid-cols-2">{filtered.map(template => <TemplateCard key={template.id} template={template} {...itemProps} />)}</div> : resolvedView === 'list' ? <div className="mx-auto max-w-7xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">{filtered.map(template => <TemplateListRow key={template.id} template={template} {...itemProps} />)}</div> : <div className="mx-auto grid max-w-7xl grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{filtered.map(template => <TemplateCompact key={template.id} template={template} {...itemProps} />)}</div>}
    </main>

    {createOpen && <CreateSurveyTemplateDialog onClose={() => setCreateOpen(false)} onCreated={template => { setCreateOpen(false); router.push(`/dashboard/surveys/${template.id}?mode=template`) }} />}
    {applyTemplate && <StandaloneSurveyApplicationDialog template={applyTemplate} onClose={() => setApplyTemplate(null)} onCreated={instance => { setApplyTemplate(null); router.push(`/dashboard/surveys/${instance.id}?mode=instance&tab=share`) }} />}
    {applicationsTemplate && <SurveyApplicationsBrowser template={applicationsTemplate} onClose={() => setApplicationsTemplate(null)} onCountsChange={counts => reconcileCounts(applicationsTemplate.id, counts)} />}
    {duplicateTemplate && <DuplicateSurveyTemplateDialog sourceName={duplicateTemplate.name} questionCount={duplicateTemplate.question_count} measurementDimensionCount={duplicateTemplate.measurement_config?.dimensions?.length || 0} onClose={() => setDuplicateTemplate(null)} onDuplicate={copyName => duplicate(duplicateTemplate, copyName)} />}
    {archiveTemplate && <ArchiveSurveyTemplateDialog template={archiveTemplate} archiving={archiving} error={archiveError} onClose={() => !archiving && setArchiveTemplate(null)} onConfirm={() => void confirmArchive()} />}
  </div>
}

interface ItemProps {
  template: SurveyTemplate
  onApply: (template: SurveyTemplate) => void
  onApplications: (template: SurveyTemplate) => void
  onDuplicate: (template: SurveyTemplate) => void
  onArchive: (template: SurveyTemplate) => void
}

function TemplateCard(props: ItemProps) {
  return <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><TemplateHeading template={props.template} /><div className="mt-4 grid grid-cols-3 gap-2"><Stat icon={FileText} value={props.template.question_count} label="Preguntas" /><Stat icon={Layers3} value={props.template.instance_count} label="Actuales" /><Stat icon={BarChart3} value={props.template.response_count} label="Respuestas" /></div><TemplateActions {...props} /></article>
}

function TemplateListRow(props: ItemProps) {
  return <article className="grid items-center gap-4 border-b border-slate-100 p-4 last:border-b-0 xl:grid-cols-[minmax(16rem,1.5fr)_repeat(3,5.5rem)_minmax(22rem,1fr)]"><TemplateHeading template={props.template} compact /><Metric value={props.template.question_count} label="Preguntas" /><Metric value={props.template.instance_count} label="Actuales" /><Metric value={props.template.response_count} label="Respuestas" /><TemplateActions {...props} condensed /></article>
}

function TemplateCompact(props: ItemProps) {
  const template = props.template
  return <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><TemplateHeading template={template} compact /><p className="mt-2 text-xs text-slate-500">{template.question_count} preguntas · {template.instance_count} actuales · {template.archived_instance_count || 0} archivadas · {template.response_count} respuestas</p><TemplateActions {...props} /></article>
}

function TemplateHeading({ template, compact = false }: { template: SurveyTemplate; compact?: boolean }) {
  return <div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><h2 className="truncate font-semibold text-slate-900">{template.name}</h2>{template.system_key && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">Inicial</span>}</div><p className={`${compact ? 'line-clamp-1' : 'line-clamp-2 min-h-10'} mt-1 text-sm text-slate-500`}>{template.description || 'Sin descripción'}</p></div>{!compact && <Link href={`/dashboard/surveys/${template.id}?mode=template`} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" aria-label={`Editar ${template.name}`}><ChevronRight className="h-5 w-5" /></Link>}</div>
}

function TemplateActions({ template, onApply, onApplications, onDuplicate, onArchive, condensed = false }: ItemProps & { condensed?: boolean }) {
  const applicationDisabled = template.status === 'archived' || template.question_count === 0
  return <div className={`${condensed ? 'mt-0' : 'mt-4 border-t border-slate-100 pt-3'} flex flex-wrap items-center gap-2`}><button type="button" onClick={() => onApply(template)} disabled={applicationDisabled} title={template.status === 'archived' ? 'Restaura la plantilla para aplicarla.' : template.question_count === 0 ? 'Agrega al menos una pregunta.' : undefined} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-45"><Plus className="h-4 w-4" />Aplicar plantilla</button><button type="button" onClick={() => onApplications(template)} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-slate-100 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-200"><Layers3 className="h-4 w-4" />Aplicaciones ({template.instance_count + (template.archived_instance_count || 0)})</button><Link href={`/dashboard/surveys/${template.id}?mode=template`} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" aria-label={`Editar ${template.name}`}><ChevronRight className="h-4 w-4" /></Link><button type="button" onClick={() => onDuplicate(template)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" aria-label={`Duplicar ${template.name}`}><Copy className="h-4 w-4" /></button><button type="button" onClick={() => onArchive(template)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" aria-label={template.status === 'archived' ? 'Restaurar plantilla' : 'Archivar plantilla'}>{template.status === 'archived' ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}</button></div>
}

function Stat({ icon: Icon, value, label }: { icon: typeof FileText; value: number; label: string }) { return <div className="rounded-xl bg-slate-50 px-2 py-2.5 text-center"><Icon className="mx-auto h-4 w-4 text-slate-400" /><p className="mt-1 text-sm font-semibold text-slate-800">{value}</p><p className="text-[11px] text-slate-500">{label}</p></div> }
function Metric({ value, label }: { value: number; label: string }) { return <div className="hidden text-center xl:block"><p className="font-semibold text-slate-800">{value}</p><p className="text-[11px] text-slate-500">{label}</p></div> }
function TemplateSkeleton() { return <div className="mx-auto grid max-w-7xl grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{[1, 2, 3, 4, 5, 6].map(item => <div key={item} className="h-44 animate-pulse rounded-2xl border border-slate-200 bg-white p-4"><div className="h-5 w-2/3 rounded bg-slate-200" /><div className="mt-3 h-4 w-full rounded bg-slate-100" /></div>)}</div> }
function ErrorState({ error, retry }: { error: string; retry: () => Promise<void> }) { return <div className="mx-auto max-w-xl rounded-2xl border border-rose-200 bg-rose-50 p-5 text-center text-sm text-rose-700"><p>{error}</p><button type="button" onClick={() => void retry()} className="mt-3 min-h-11 font-semibold underline">Reintentar</button></div> }
function EmptyState({ searched, archived, create }: { searched: boolean; archived: boolean; create: () => void }) { return <div className="mx-auto flex min-h-72 max-w-lg flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center"><Layers3 className="mb-4 h-10 w-10 text-slate-300" /><h2 className="font-semibold text-slate-800">{searched ? 'No hay coincidencias' : archived ? 'No hay plantillas archivadas' : 'Crea tu primera plantilla'}</h2><p className="mt-1 text-sm text-slate-500">Cada aplicación conservará su propia versión, público y resultados.</p>{!searched && !archived && <button type="button" onClick={create} className="mt-5 min-h-11 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white">Nueva plantilla</button>}</div> }
