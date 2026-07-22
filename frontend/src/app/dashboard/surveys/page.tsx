"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Archive, BarChart3, ChevronDown, ChevronRight, ClipboardList, FileText,
  Layers3, Loader2, Plus, RotateCcw, Search, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { SurveyInstanceSummary, SurveyTemplate } from '@/types/survey-template';

export default function SurveyTemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<SurveyTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [instancesByTemplate, setInstancesByTemplate] = useState<Record<string, SurveyInstanceSummary[]>>({});
  const [instancesLoading, setInstancesLoading] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const response = await api<SurveyTemplate[]>('/api/survey-templates?include_archived=true');
      if (!response.success) throw new Error(response.error || 'No se pudieron cargar las plantillas.');
      setTemplates(response.data || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'No se pudieron cargar las plantillas.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => templates.filter(template => {
    if ((template.status === 'archived') !== showArchived) return false;
    const normalized = query.trim().toLocaleLowerCase('es');
    return !normalized || `${template.name} ${template.description}`.toLocaleLowerCase('es').includes(normalized);
  }), [query, showArchived, templates]);

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true); setCreateError('');
    try {
      const response = await api<SurveyTemplate>('/api/survey-templates', { method: 'POST', body: JSON.stringify({ name: name.trim(), description: description.trim() }) });
      if (!response.success || !response.data) throw new Error(response.error || 'No se pudo crear la plantilla.');
      setCreateOpen(false); setName(''); setDescription('');
      router.push(`/dashboard/surveys/${response.data.id}?mode=template`);
    } catch (createFailure) {
      setCreateError(createFailure instanceof Error ? createFailure.message : 'No se pudo crear la plantilla.');
    } finally { setCreating(false); }
  };

  const toggleArchived = async (template: SurveyTemplate) => {
    const status = template.status === 'archived' ? 'active' : 'archived';
    const response = await api<SurveyTemplate>(`/api/survey-templates/${template.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    if (response.success && response.data) setTemplates(current => current.map(item => item.id === template.id ? response.data! : item));
  };

  const toggleInstances = async (templateId: string) => {
    if (expandedId === templateId) { setExpandedId(null); return; }
    setExpandedId(templateId);
    if (instancesByTemplate[templateId]) return;
    setInstancesLoading(templateId);
    try {
      const response = await api<SurveyInstanceSummary[]>(`/api/survey-templates/${templateId}/instances`);
      setInstancesByTemplate(current => ({ ...current, [templateId]: response.success ? response.data || [] : [] }));
    } finally { setInstancesLoading(''); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50">
      <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-4 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700"><ClipboardList className="h-5 w-5" /></span>
            <div className="min-w-0"><h1 className="truncate text-lg font-bold text-slate-900 sm:text-xl">Plantillas de encuesta</h1><p className="text-sm text-slate-500">Diseña una vez y aplícala desde cada origen.</p></div>
          </div>
          <button type="button" onClick={() => setCreateOpen(true)} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-emerald-600 px-3.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"><Plus className="h-4 w-4" /><span className="hidden sm:inline">Nueva plantilla</span><span className="sm:hidden">Nueva</span></button>
        </div>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar plantilla" className="min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-3 text-sm outline-none focus:border-emerald-500 focus:bg-white" /></div>
          <div className="grid min-h-11 grid-cols-2 rounded-xl bg-slate-100 p-1 sm:w-64"><button type="button" onClick={() => setShowArchived(false)} className={`rounded-lg text-sm font-medium ${!showArchived ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`}>Activas</button><button type="button" onClick={() => setShowArchived(true)} className={`rounded-lg text-sm font-medium ${showArchived ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`}>Archivadas</button></div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {loading ? <TemplateSkeleton /> : error ? <div className="mx-auto max-w-xl rounded-2xl border border-rose-200 bg-rose-50 p-5 text-center text-sm text-rose-700"><p>{error}</p><button type="button" onClick={() => void load()} className="mt-3 min-h-11 font-semibold underline">Reintentar</button></div> : filtered.length === 0 ? (
          <div className="mx-auto flex min-h-72 max-w-lg flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center"><Layers3 className="mb-4 h-10 w-10 text-slate-300" /><h2 className="font-semibold text-slate-800">{query ? 'No hay coincidencias' : showArchived ? 'No hay plantillas archivadas' : 'Crea tu primera plantilla'}</h2><p className="mt-1 text-sm text-slate-500">Las aplicaciones y sus respuestas permanecerán separadas por programa.</p>{!query && !showArchived && <button type="button" onClick={() => setCreateOpen(true)} className="mt-5 min-h-11 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white">Nueva plantilla</button>}</div>
        ) : <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 lg:grid-cols-2">{filtered.map(template => {
          const expanded = expandedId === template.id;
          const instances = instancesByTemplate[template.id] || [];
          return <article key={template.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><h2 className="truncate font-semibold text-slate-900">{template.name}</h2>{template.system_key && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">Inicial</span>}</div><p className="mt-1 line-clamp-2 min-h-10 text-sm text-slate-500">{template.description || 'Sin descripción'}</p></div><Link href={`/dashboard/surveys/${template.id}?mode=template`} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" aria-label={`Editar ${template.name}`}><ChevronRight className="h-5 w-5" /></Link></div>
              <div className="mt-4 grid grid-cols-3 gap-2"><Stat icon={FileText} value={template.question_count} label="Preguntas" /><Stat icon={Layers3} value={template.instance_count} label="Aplicaciones" /><Stat icon={BarChart3} value={template.response_count} label="Respuestas" /></div>
              <div className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-3"><button type="button" onClick={() => void toggleInstances(template.id)} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-slate-100 text-sm font-semibold text-slate-700 hover:bg-slate-200">Historial <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} /></button><button type="button" onClick={() => void toggleArchived(template)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-500" aria-label={template.status === 'archived' ? 'Restaurar plantilla' : 'Archivar plantilla'}>{template.status === 'archived' ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}</button></div>
            </div>
            {expanded && <div className="border-t border-slate-100 bg-slate-50 p-3">{instancesLoading === template.id ? <div className="flex min-h-20 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-emerald-600" /></div> : instances.length === 0 ? <p className="p-4 text-center text-sm text-slate-500">Todavía no se ha aplicado esta plantilla.</p> : <div className="space-y-2">{instances.slice(0, 6).map(instance => <Link key={instance.id} href={`/dashboard/surveys/${instance.id}?mode=instance&tab=analytics`} className="flex min-h-14 items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 hover:border-emerald-200"><span className={`h-2.5 w-2.5 rounded-full ${instance.status === 'active' ? 'bg-emerald-500' : 'bg-slate-300'}`} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-slate-800">{instance.name}</span><span className="block truncate text-xs text-slate-500">{instance.origin_label} · {instance.response_count} respuestas</span></span><ChevronRight className="h-4 w-4 text-slate-400" /></Link>)}</div>}</div>}
          </article>;
        })}</div>}
      </main>

      {createOpen && <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="new-survey-template-title"><div className="flex max-h-[100dvh] w-full flex-col bg-white shadow-2xl sm:max-w-md sm:rounded-2xl"><header className="flex items-center justify-between border-b border-slate-200 px-4 py-3.5"><div><h2 id="new-survey-template-title" className="font-semibold text-slate-900">Nueva plantilla</h2><p className="text-xs text-slate-500">Todavía no será pública ni recibirá respuestas.</p></div><button type="button" onClick={() => setCreateOpen(false)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-slate-500" aria-label="Cerrar"><X className="h-5 w-5" /></button></header><div className="space-y-4 overflow-y-auto p-4"><label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Nombre</span><input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={180} placeholder="Ej. Satisfacción del programa" className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-emerald-500" /></label><label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Descripción <span className="font-normal text-slate-400">(opcional)</span></span><textarea value={description} onChange={event => setDescription(event.target.value)} rows={3} className="w-full resize-none rounded-xl border border-slate-200 p-3 text-sm outline-none focus:border-emerald-500" /></label>{createError && <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{createError}</p>}</div><footer className="flex gap-3 border-t border-slate-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"><button type="button" onClick={() => setCreateOpen(false)} className="min-h-11 flex-1 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700">Cancelar</button><button type="button" onClick={() => void create()} disabled={!name.trim() || creating} className="inline-flex min-h-11 flex-[1.3] items-center justify-center gap-2 rounded-xl bg-emerald-600 text-sm font-semibold text-white disabled:opacity-50">{creating && <Loader2 className="h-4 w-4 animate-spin" />}Crear y editar</button></footer></div></div>}
    </div>
  );
}

function Stat({ icon: Icon, value, label }: { icon: typeof FileText; value: number; label: string }) { return <div className="rounded-xl bg-slate-50 px-2 py-2.5 text-center"><Icon className="mx-auto h-4 w-4 text-slate-400" /><p className="mt-1 text-sm font-semibold text-slate-800">{value}</p><p className="text-[11px] text-slate-500">{label}</p></div>; }
function TemplateSkeleton() { return <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 lg:grid-cols-2">{[1, 2, 3, 4].map(item => <div key={item} className="h-60 animate-pulse rounded-2xl border border-slate-200 bg-white p-5"><div className="h-5 w-2/3 rounded bg-slate-200" /><div className="mt-3 h-4 w-full rounded bg-slate-100" /><div className="mt-2 h-4 w-4/5 rounded bg-slate-100" /></div>)}</div>; }
