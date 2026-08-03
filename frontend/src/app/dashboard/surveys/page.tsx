"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Archive, BarChart3, ChevronDown, ChevronRight, ClipboardList, Copy, Ellipsis,
  FileText, Grid2X2, Layers3, List, Loader2, Plus, RotateCcw, Rows3, Search, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import type { SurveyInstanceSummary, SurveyTemplate } from '@/types/survey-template';
import DuplicateSurveyTemplateDialog from '@/components/surveys/DuplicateSurveyTemplateDialog';
import ArchiveSurveyTemplateDialog from '@/components/surveys/ArchiveSurveyTemplateDialog';
import SurveyApplicationLifecycleActions from '@/components/surveys/SurveyApplicationLifecycleActions';
import { parseSurveyCatalogView, resolveSurveyCatalogView, type SurveyCatalogView } from '@/lib/surveyCatalogView';
import { reconcileTemplateInstanceCounts, removeSurveyInstance, replaceSurveyInstance } from '@/lib/surveyInstanceLifecycle';

const VIEW_KEY = 'clarin.surveys.catalog.view.v1';

export default function SurveyTemplatesPage() {
  const router = useRouter();
  const contentRef = useRef<HTMLElement | null>(null);
  const [contentWidth, setContentWidth] = useState(0);
  const [view, setView] = useState<SurveyCatalogView>('cards');
  const [templates, setTemplates] = useState<SurveyTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useDebouncedValue(query);
  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [instancesByTemplate, setInstancesByTemplate] = useState<Record<string, SurveyInstanceSummary[]>>({});
  const [instancesLoading, setInstancesLoading] = useState('');
  const [duplicateTemplate, setDuplicateTemplate] = useState<SurveyTemplate | null>(null);
  const [archiveTemplate, setArchiveTemplate] = useState<SurveyTemplate | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState('');

  useEffect(() => {
    setView(parseSurveyCatalogView(window.localStorage.getItem(VIEW_KEY)));
  }, []);
  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => setContentWidth(entries[0]?.contentRect.width || 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const resolvedView = resolveSurveyCatalogView(view, contentWidth);
  const chooseView = (next: SurveyCatalogView) => { setView(next); window.localStorage.setItem(VIEW_KEY, next); };

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const response = await api<SurveyTemplate[]>('/api/survey-templates?include_archived=true');
    if (response.success) setTemplates(response.data || []);
    else setError(response.error || 'No se pudieron cargar las plantillas.');
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => templates.filter(template => {
    if ((template.status === 'archived') !== showArchived) return false;
    const normalized = debouncedQuery.trim().toLocaleLowerCase('es');
    return !normalized || `${template.name} ${template.description}`.toLocaleLowerCase('es').includes(normalized);
  }), [debouncedQuery, showArchived, templates]);

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true); setCreateError('');
    const response = await api<SurveyTemplate>('/api/survey-templates', { method: 'POST', body: JSON.stringify({ name: name.trim(), description: description.trim() }) });
    setCreating(false);
    if (!response.success || !response.data) { setCreateError(response.error || 'No se pudo crear la plantilla.'); return; }
    setCreateOpen(false); setName(''); setDescription('');
    router.push(`/dashboard/surveys/${response.data.id}?mode=template`);
  };

  const changeArchiveStatus = async (template: SurveyTemplate, status: SurveyTemplate['status']) => {
    const response = await api<SurveyTemplate>(`/api/survey-templates/${template.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    if (!response.success || !response.data) throw new Error(response.error || 'No se pudo actualizar la plantilla.');
    setTemplates(current => current.map(item => item.id === template.id ? response.data! : item));
  };
  const requestArchive = (template: SurveyTemplate) => {
    if (template.status === 'archived') {
      void changeArchiveStatus(template, 'active').catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo restaurar la plantilla.'));
      return;
    }
    setArchiveError(''); setArchiveTemplate(template);
  };
  const confirmArchive = async () => {
    if (!archiveTemplate) return;
    setArchiving(true); setArchiveError('');
    try { await changeArchiveStatus(archiveTemplate, 'archived'); setArchiveTemplate(null); }
    catch (failure) { setArchiveError(failure instanceof Error ? failure.message : 'No se pudo archivar la plantilla.'); }
    finally { setArchiving(false); }
  };

  const toggleInstances = async (templateId: string) => {
    if (expandedId === templateId) { setExpandedId(null); return; }
    setExpandedId(templateId);
    if (instancesByTemplate[templateId]) return;
    setInstancesLoading(templateId);
    const response = await api<SurveyInstanceSummary[]>(`/api/survey-templates/${templateId}/instances?include_archived=true`);
    setInstancesByTemplate(current => ({ ...current, [templateId]: response.success ? response.data || [] : [] }));
    setInstancesLoading('');
  };

  const duplicate = async (template: SurveyTemplate, copyName: string) => {
    const response = await api<SurveyTemplate>(`/api/survey-templates/${template.id}/duplicate`, { method: 'POST', body: JSON.stringify({ name: copyName }) });
    if (!response.success || !response.data) throw new Error(response.error || 'No se pudo duplicar la plantilla.');
    setDuplicateTemplate(null);
    router.push(`/dashboard/surveys/${response.data.id}?mode=template`);
  };

  const updateInstance = (templateId: string, updated: SurveyInstanceSummary) => {
    const previous = instancesByTemplate[templateId]?.find(instance => instance.id === updated.id);
    setInstancesByTemplate(current => ({ ...current, [templateId]: replaceSurveyInstance(current[templateId] || [], updated) }));
    if (previous) setTemplates(current => current.map(template => template.id === templateId ? reconcileTemplateInstanceCounts(template, previous, updated) : template));
  };

  const deleteInstance = (templateId: string, id: string) => {
    const previous = instancesByTemplate[templateId]?.find(instance => instance.id === id);
    setInstancesByTemplate(current => ({ ...current, [templateId]: removeSurveyInstance(current[templateId] || [], id) }));
    if (previous) setTemplates(current => current.map(template => template.id === templateId ? reconcileTemplateInstanceCounts(template, previous, null) : template));
  };

  const itemProps = { expandedId, instancesByTemplate, instancesLoading, onToggleInstances: toggleInstances, onDuplicate: setDuplicateTemplate, onArchive: requestArchive, onInstanceUpdated: updateInstance, onInstanceDeleted: deleteInstance };

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50">
      <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-4 sm:px-6">
        <div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700"><ClipboardList className="h-5 w-5" /></span><div className="min-w-0"><h1 className="truncate text-lg font-bold text-slate-900 sm:text-xl">Plantillas de encuesta</h1><p className="text-sm text-slate-500">Diseña una vez y aplícala desde cada origen.</p></div></div><button type="button" onClick={() => setCreateOpen(true)} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-emerald-600 px-3.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"><Plus className="h-4 w-4" /><span className="hidden sm:inline">Nueva plantilla</span><span className="sm:hidden">Nueva</span></button></div>
        <div className="mt-4 flex flex-col gap-3 lg:flex-row"><div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value) setDebouncedQuery(''); }} placeholder="Buscar plantilla" className="min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-10 text-sm outline-none focus:border-emerald-500 focus:bg-white" />{query !== debouncedQuery && <Loader2 aria-label="Buscando plantillas" className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-emerald-500" />}</div><div className="flex gap-3"><div className="grid min-h-11 flex-1 grid-cols-2 rounded-xl bg-slate-100 p-1 lg:w-64"><button type="button" onClick={() => setShowArchived(false)} className={`rounded-lg text-sm font-medium ${!showArchived ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`}>Activas</button><button type="button" onClick={() => setShowArchived(true)} className={`rounded-lg text-sm font-medium ${showArchived ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`}>Archivadas</button></div><div className="hidden min-h-11 items-center rounded-xl border border-slate-200 bg-white p-1 sm:flex" role="group" aria-label="Vista del catálogo">{([['cards', Grid2X2, 'Fichas'], ['list', List, 'Lista'], ['compact', Rows3, 'Compacta']] as const).map(([mode, Icon, label]) => <button key={mode} type="button" onClick={() => chooseView(mode)} aria-label={label} aria-pressed={view === mode} className={`inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg ${view === mode ? 'bg-slate-100 text-slate-900' : 'text-slate-400 hover:text-slate-700'}`}><Icon className="h-4 w-4" /></button>)}</div></div></div>
      </header>

      <main ref={contentRef} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {loading ? <TemplateSkeleton /> : error ? <ErrorState error={error} retry={load} /> : filtered.length === 0 ? <EmptyState searched={Boolean(debouncedQuery)} archived={showArchived} create={() => setCreateOpen(true)} /> : resolvedView === 'cards' ? (
          <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 lg:grid-cols-2">{filtered.map(template => <TemplateCard key={template.id} template={template} {...itemProps} />)}</div>
        ) : resolvedView === 'list' ? (
          <div className="mx-auto max-w-7xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">{filtered.map(template => <TemplateListRow key={template.id} template={template} {...itemProps} />)}</div>
        ) : (
          <div className="mx-auto grid max-w-7xl grid-cols-2 gap-3 xl:grid-cols-3">{filtered.map(template => <TemplateCompact key={template.id} template={template} {...itemProps} />)}</div>
        )}
      </main>

      {createOpen && <CreateTemplateDialog name={name} description={description} creating={creating} error={createError} setName={setName} setDescription={setDescription} close={() => setCreateOpen(false)} create={create} />}
      {duplicateTemplate && <DuplicateSurveyTemplateDialog sourceName={duplicateTemplate.name} questionCount={duplicateTemplate.question_count} measurementDimensionCount={duplicateTemplate.measurement_config?.dimensions?.length || 0} onClose={() => setDuplicateTemplate(null)} onDuplicate={copyName => duplicate(duplicateTemplate, copyName)} />}
      {archiveTemplate && <ArchiveSurveyTemplateDialog template={archiveTemplate} archiving={archiving} error={archiveError} onClose={() => !archiving && setArchiveTemplate(null)} onConfirm={() => void confirmArchive()} />}
    </div>
  );
}

interface ItemProps {
  template: SurveyTemplate; expandedId: string | null; instancesByTemplate: Record<string, SurveyInstanceSummary[]>; instancesLoading: string;
  onToggleInstances: (id: string) => Promise<void>; onDuplicate: (template: SurveyTemplate) => void; onArchive: (template: SurveyTemplate) => void;
  onInstanceUpdated: (templateId: string, instance: SurveyInstanceSummary) => void; onInstanceDeleted: (templateId: string, id: string) => void;
}

function TemplateCard(props: ItemProps) {
  const { template } = props;
  return <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="p-4 sm:p-5"><TemplateHeading template={template} /><div className="mt-4 grid grid-cols-3 gap-2"><Stat icon={FileText} value={template.question_count} label="Preguntas" /><Stat icon={Layers3} value={template.instance_count} label="Activas" /><Stat icon={BarChart3} value={template.response_count} label="Respuestas" /></div><TemplateActions {...props} /></div><History {...props} /></article>;
}

function TemplateListRow(props: ItemProps) {
  const { template } = props;
  return <article className="border-b border-slate-100 last:border-b-0"><div className="grid items-center gap-4 p-4 lg:grid-cols-[minmax(16rem,1.6fr)_repeat(3,6rem)_9rem_11rem]"><TemplateHeading template={template} compact /><Metric value={template.question_count} label="Preguntas" /><Metric value={template.instance_count} label="Aplicaciones" /><Metric value={template.response_count} label="Respuestas" /><div className="text-xs text-slate-500"><span className="block">Actualizada</span><span className="font-medium text-slate-700">{new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(template.updated_at))}</span></div><TemplateActions {...props} condensed /></div><History {...props} /></article>;
}

function TemplateCompact(props: ItemProps) {
  const { template } = props;
  return <article className="relative rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><h2 className="truncate font-semibold text-slate-900">{template.name}</h2><p className="mt-2 text-xs text-slate-500">{template.question_count} preguntas · {template.instance_count} activas · {template.archived_instance_count || 0} archivadas · {template.response_count} respuestas</p></div><details className="relative"><summary className="flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center rounded-xl border border-slate-200 text-slate-500" aria-label={`Acciones de ${template.name}`}><Ellipsis className="h-4 w-4" /></summary><div className="absolute right-0 top-12 z-20 w-48 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl"><Link href={`/dashboard/surveys/${template.id}?mode=template`} className="flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm text-slate-700 hover:bg-slate-50"><ChevronRight className="h-4 w-4" />Editar</Link><button type="button" onClick={() => props.onDuplicate(template)} className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-sm text-slate-700 hover:bg-slate-50"><Copy className="h-4 w-4" />Duplicar</button><button type="button" onClick={() => props.onArchive(template)} className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-sm text-slate-700 hover:bg-slate-50">{template.status === 'archived' ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}{template.status === 'archived' ? 'Restaurar' : 'Archivar'}</button></div></details></div><button type="button" onClick={() => void props.onToggleInstances(template.id)} className="mt-3 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl bg-slate-100 text-xs font-semibold text-slate-700">Historial <ChevronDown className={`h-4 w-4 ${props.expandedId === template.id ? 'rotate-180' : ''}`} /></button><History {...props} inset /></article>;
}

function TemplateHeading({ template, compact = false }: { template: SurveyTemplate; compact?: boolean }) {
  return <div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><h2 className="truncate font-semibold text-slate-900">{template.name}</h2>{template.system_key && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">Inicial</span>}</div><p className={`${compact ? 'line-clamp-1' : 'line-clamp-2 min-h-10'} mt-1 text-sm text-slate-500`}>{template.description || 'Sin descripción'}</p></div>{!compact && <Link href={`/dashboard/surveys/${template.id}?mode=template`} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" aria-label={`Editar ${template.name}`}><ChevronRight className="h-5 w-5" /></Link>}</div>;
}

function TemplateActions(props: ItemProps & { condensed?: boolean }) {
  const { template, condensed } = props;
  return <div className={`${condensed ? 'mt-0 border-0 pt-0' : 'mt-4 border-t border-slate-100 pt-3'} flex items-center gap-2`}><button type="button" onClick={() => void props.onToggleInstances(template.id)} className={`${condensed ? 'min-w-11 px-2' : 'flex-1 px-3'} inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-slate-100 text-sm font-semibold text-slate-700 hover:bg-slate-200`} aria-label={condensed ? `Historial de ${template.name}` : undefined}>{!condensed && 'Historial'}<ChevronDown className={`h-4 w-4 transition-transform ${props.expandedId === template.id ? 'rotate-180' : ''}`} /></button><button type="button" onClick={() => props.onDuplicate(template)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" aria-label={`Duplicar ${template.name}`}><Copy className="h-4 w-4" /></button><button type="button" onClick={() => props.onArchive(template)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" aria-label={template.status === 'archived' ? 'Restaurar plantilla' : 'Archivar plantilla'}>{template.status === 'archived' ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}</button>{condensed && <Link href={`/dashboard/surveys/${template.id}?mode=template`} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-500" aria-label={`Editar ${template.name}`}><ChevronRight className="h-4 w-4" /></Link>}</div>;
}

function History(props: ItemProps & { inset?: boolean }) {
  const { template } = props;
  if (props.expandedId !== template.id) return null;
  const instances = props.instancesByTemplate[template.id] || [];
  return <div className={`${props.inset ? 'mt-3 rounded-xl border border-slate-100' : 'border-t border-slate-100'} bg-slate-50 p-3`}>{props.instancesLoading === template.id ? <div className="flex min-h-20 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-emerald-600" /></div> : instances.length === 0 ? <p className="p-4 text-center text-sm text-slate-500">Todavía no se ha aplicado esta plantilla.</p> : <div className="space-y-2">{instances.slice(0, 8).map(instance => <div key={instance.id} className="flex min-h-14 items-center gap-2 rounded-xl border border-slate-200 bg-white p-1.5 pl-3"><Link href={`/dashboard/surveys/${instance.id}?mode=instance&tab=analytics`} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${instance.archived_at ? 'bg-slate-300' : instance.status === 'active' ? 'bg-emerald-500' : 'bg-slate-300'}`} /><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="block truncate text-sm font-medium text-slate-800">{instance.name}</span>{instance.archived_at && <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Archivada</span>}</span><span className="block truncate text-xs text-slate-500">{instance.origin_label} · {instance.response_count} respuestas</span></span><ChevronRight className="h-4 w-4 shrink-0 text-slate-400" /></Link><SurveyApplicationLifecycleActions target={instance} onUpdated={updated => props.onInstanceUpdated(template.id, updated)} onDeleted={id => props.onInstanceDeleted(template.id, id)} /></div>)}</div>}</div>;
}

function Stat({ icon: Icon, value, label }: { icon: typeof FileText; value: number; label: string }) { return <div className="rounded-xl bg-slate-50 px-2 py-2.5 text-center"><Icon className="mx-auto h-4 w-4 text-slate-400" /><p className="mt-1 text-sm font-semibold text-slate-800">{value}</p><p className="text-[11px] text-slate-500">{label}</p></div>; }
function Metric({ value, label }: { value: number; label: string }) { return <div className="hidden text-center lg:block"><p className="font-semibold text-slate-800">{value}</p><p className="text-[11px] text-slate-500">{label}</p></div>; }
function TemplateSkeleton() { return <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 lg:grid-cols-2">{[1, 2, 3, 4].map(item => <div key={item} className="h-60 animate-pulse rounded-2xl border border-slate-200 bg-white p-5"><div className="h-5 w-2/3 rounded bg-slate-200" /><div className="mt-3 h-4 w-full rounded bg-slate-100" /></div>)}</div>; }
function ErrorState({ error, retry }: { error: string; retry: () => Promise<void> }) { return <div className="mx-auto max-w-xl rounded-2xl border border-rose-200 bg-rose-50 p-5 text-center text-sm text-rose-700"><p>{error}</p><button type="button" onClick={() => void retry()} className="mt-3 min-h-11 font-semibold underline">Reintentar</button></div>; }
function EmptyState({ searched, archived, create }: { searched: boolean; archived: boolean; create: () => void }) { return <div className="mx-auto flex min-h-72 max-w-lg flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center"><Layers3 className="mb-4 h-10 w-10 text-slate-300" /><h2 className="font-semibold text-slate-800">{searched ? 'No hay coincidencias' : archived ? 'No hay plantillas archivadas' : 'Crea tu primera plantilla'}</h2><p className="mt-1 text-sm text-slate-500">Las aplicaciones y sus respuestas permanecerán separadas por programa.</p>{!searched && !archived && <button type="button" onClick={create} className="mt-5 min-h-11 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white">Nueva plantilla</button>}</div>; }

function CreateTemplateDialog({ name, description, creating, error, setName, setDescription, close, create }: { name: string; description: string; creating: boolean; error: string; setName: (value: string) => void; setDescription: (value: string) => void; close: () => void; create: () => Promise<void> }) {
  return <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="new-survey-template-title"><div className="flex max-h-[100dvh] w-full flex-col bg-white shadow-2xl sm:max-w-md sm:rounded-2xl"><header className="flex items-center justify-between border-b border-slate-200 px-4 py-3.5"><div><h2 id="new-survey-template-title" className="font-semibold text-slate-900">Nueva plantilla</h2><p className="text-xs text-slate-500">Todavía no será pública ni recibirá respuestas.</p></div><button type="button" onClick={close} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-slate-500" aria-label="Cerrar"><X className="h-5 w-5" /></button></header><div className="space-y-4 overflow-y-auto p-4"><label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Nombre</span><input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={180} placeholder="Ej. Satisfacción del programa" className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-emerald-500" /></label><label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Descripción <span className="font-normal text-slate-400">(opcional)</span></span><textarea value={description} onChange={event => setDescription(event.target.value)} rows={3} className="w-full resize-none rounded-xl border border-slate-200 p-3 text-sm outline-none focus:border-emerald-500" /></label>{error && <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}</div><footer className="flex gap-3 border-t border-slate-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"><button type="button" onClick={close} className="min-h-11 flex-1 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700">Cancelar</button><button type="button" onClick={() => void create()} disabled={!name.trim() || creating} className="inline-flex min-h-11 flex-[1.3] items-center justify-center gap-2 rounded-xl bg-emerald-600 text-sm font-semibold text-white disabled:opacity-50">{creating && <Loader2 className="h-4 w-4 animate-spin" />}Crear y editar</button></footer></div></div>;
}
