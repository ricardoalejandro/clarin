"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  BarChart3, Check, ChevronRight, ClipboardList, Copy, ExternalLink,
  FileText, Loader2, Plus, Search, Send, Users, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { SurveyInstanceRecipient, SurveyInstanceSummary, SurveyTemplate } from '@/types/survey-template';

interface ProgramSurveyPanelProps {
  programId: string;
  programName: string;
  canManageSurveys?: boolean;
}

const statusLabel: Record<string, string> = { draft: 'Borrador', active: 'Activa', closed: 'Cerrada' };

export default function ProgramSurveyPanel({ programId, programName, canManageSurveys = false }: ProgramSurveyPanelProps) {
  const [instances, setInstances] = useState<SurveyInstanceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [templates, setTemplates] = useState<SurveyTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [instanceName, setInstanceName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [recipientInstance, setRecipientInstance] = useState<SurveyInstanceSummary | null>(null);

  const loadInstances = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const response = await api<SurveyInstanceSummary[]>(`/api/programs/${programId}/surveys`);
      if (!response.success) throw new Error(response.error || 'No se pudieron cargar las encuestas.');
      setInstances(response.data || []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'No se pudieron cargar las encuestas.');
    } finally {
      setLoading(false);
    }
  }, [programId]);

  useEffect(() => { void loadInstances(); }, [loadInstances]);

  const openCreate = async () => {
    setCreateOpen(true);
    setCreateError('');
    if (templates.length > 0) return;
    setTemplatesLoading(true);
    try {
      const response = await api<SurveyTemplate[]>('/api/survey-templates');
      if (!response.success) throw new Error(response.error || 'No se pudieron cargar las plantillas.');
      const available = (response.data || []).filter(template => template.status === 'active' && template.question_count > 0);
      setTemplates(available);
      if (available.length > 0) setSelectedTemplateId(available[0].id);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'No se pudieron cargar las plantillas.');
    } finally {
      setTemplatesLoading(false);
    }
  };

  const selectedTemplate = useMemo(
    () => templates.find(template => template.id === selectedTemplateId) || null,
    [selectedTemplateId, templates],
  );

  const createInstance = async () => {
    if (!selectedTemplate) return;
    setCreating(true);
    setCreateError('');
    try {
      const response = await api<SurveyInstanceSummary>(`/api/programs/${programId}/surveys`, {
        method: 'POST',
        body: JSON.stringify({
          template_id: selectedTemplate.id,
          name: instanceName.trim() || `${selectedTemplate.name} · ${programName}`,
          status: 'active',
          audience_mode: 'program_participants',
        }),
      });
      if (!response.success || !response.data) throw new Error(response.error || 'No se pudo crear la encuesta.');
      setInstances(current => [response.data!, ...current]);
      setCreateOpen(false);
      setInstanceName('');
      setRecipientInstance(response.data);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'No se pudo crear la encuesta.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-emerald-600" />
            <h2 className="truncate text-base font-semibold text-slate-900">Encuestas del programa</h2>
          </div>
          <p className="mt-1 text-sm text-slate-500">Cada aplicación conserva sus preguntas y resultados.</p>
        </div>
        {canManageSurveys && (
          <button type="button" onClick={() => void openCreate()} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-emerald-600 px-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
            <Plus className="h-4 w-4" /><span className="hidden sm:inline">Crear encuesta</span><span className="sm:hidden">Crear</span>
          </button>
        )}
      </div>

      <div className="p-4 sm:p-5">
        {loading ? (
          <div className="flex min-h-32 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div>
        ) : loadError ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            <p>{loadError}</p><button type="button" onClick={() => void loadInstances()} className="mt-3 min-h-11 font-semibold underline">Reintentar</button>
          </div>
        ) : instances.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-5 text-center">
            <FileText className="mb-3 h-8 w-8 text-slate-300" />
            <p className="font-medium text-slate-700">Todavía no hay encuestas</p>
            <p className="mt-1 max-w-sm text-sm text-slate-500">Aplica una plantilla y guarda los resultados dentro de este programa.</p>
            {canManageSurveys && <button type="button" onClick={() => void openCreate()} className="mt-4 min-h-11 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white">Crear encuesta</button>}
          </div>
        ) : (
          <div className="space-y-3">
            {instances.map(instance => {
              const completion = instance.recipient_count > 0 ? Math.round(instance.response_count / instance.recipient_count * 100) : 0;
              return (
                <article key={instance.id} className="rounded-2xl border border-slate-200 p-4 transition hover:border-emerald-200">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate font-semibold text-slate-900">{instance.name}</h3>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${instance.status === 'active' ? 'bg-emerald-50 text-emerald-700' : instance.status === 'closed' ? 'bg-slate-100 text-slate-600' : 'bg-amber-50 text-amber-700'}`}>{statusLabel[instance.status] || instance.status}</span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">Plantilla v{instance.template_revision} · {instance.question_count} preguntas</p>
                    </div>
                    <Link href={`/dashboard/surveys/${instance.id}?mode=instance&tab=analytics`} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" aria-label={`Ver resultados de ${instance.name}`}>
                      <BarChart3 className="h-4 w-4" />
                    </Link>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                    <Metric value={instance.recipient_count} label="Invitados" />
                    <Metric value={instance.response_count} label="Respuestas" />
                    <Metric value={`${completion}%`} label="Completado" />
                  </div>
                  <div className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-3">
                    {instance.audience_mode === 'program_participants' ? (
                      <button type="button" onClick={() => setRecipientInstance(instance)} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-slate-100 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-200">
                        <Send className="h-4 w-4" /> Enlaces por participante
                      </button>
                    ) : (
                      <CopyPublicLink slug={instance.slug} />
                    )}
                    <Link href={`/dashboard/surveys/${instance.id}?mode=instance&tab=analytics`} className="inline-flex min-h-11 items-center gap-1 rounded-xl px-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-50">Resultados <ChevronRight className="h-4 w-4" /></Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {createOpen && <CreateSurveyDialog templates={templates} loading={templatesLoading} selectedId={selectedTemplateId} setSelectedId={setSelectedTemplateId} name={instanceName} setName={setInstanceName} error={createError} creating={creating} onClose={() => setCreateOpen(false)} onCreate={() => void createInstance()} />}
      {recipientInstance && <RecipientLinksDialog programId={programId} instance={recipientInstance} onClose={() => setRecipientInstance(null)} />}
    </section>
  );
}

function Metric({ value, label }: { value: number | string; label: string }) {
  return <div className="rounded-xl bg-slate-50 px-2 py-2.5"><p className="text-base font-semibold text-slate-800">{value}</p><p className="text-[11px] text-slate-500">{label}</p></div>;
}

function CopyPublicLink({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(`${window.location.origin}/f/${slug}`);
    setCopied(true); window.setTimeout(() => setCopied(false), 1600);
  };
  return <button type="button" onClick={() => void copy()} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-slate-100 px-3 text-sm font-semibold text-slate-700">{copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}{copied ? 'Copiado' : 'Copiar enlace'}</button>;
}

function CreateSurveyDialog({ templates, loading, selectedId, setSelectedId, name, setName, error, creating, onClose, onCreate }: {
  templates: SurveyTemplate[]; loading: boolean; selectedId: string; setSelectedId: (id: string) => void;
  name: string; setName: (value: string) => void; error: string; creating: boolean; onClose: () => void; onCreate: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="create-program-survey-title">
      <div className="flex max-h-[100dvh] w-full flex-col bg-white shadow-2xl sm:max-h-[88vh] sm:max-w-xl sm:rounded-2xl">
        <header className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3.5 sm:px-5">
          <div><h3 id="create-program-survey-title" className="font-semibold text-slate-900">Crear encuesta</h3><p className="text-xs text-slate-500">Elige una plantilla reutilizable</p></div>
          <button type="button" onClick={onClose} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100" aria-label="Cerrar"><X className="h-5 w-5" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          {loading ? <div className="flex min-h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div> : templates.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 p-6 text-center"><p className="font-medium text-slate-700">No hay plantillas listas</p><p className="mt-1 text-sm text-slate-500">Crea una plantilla con al menos una pregunta en Encuestas.</p></div>
          ) : <div className="space-y-2">{templates.map(template => <button key={template.id} type="button" onClick={() => setSelectedId(template.id)} className={`flex min-h-16 w-full items-center gap-3 rounded-xl border p-3 text-left transition ${selectedId === template.id ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-500' : 'border-slate-200 hover:border-slate-300'}`}><span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${selectedId === template.id ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500'}`}><ClipboardList className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-800">{template.name}</span><span className="block text-xs text-slate-500">{template.question_count} preguntas · {template.instance_count} aplicaciones</span></span>{selectedId === template.id && <Check className="h-5 w-5 text-emerald-600" />}</button>)}</div>}
          {templates.length > 0 && <label className="mt-5 block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Nombre de esta aplicación <span className="font-normal text-slate-400">(opcional)</span></span><input value={name} onChange={event => setName(event.target.value)} maxLength={180} placeholder="Se completará con plantilla y programa" className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20" /></label>}
          {error && <p className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
        </div>
        <footer className="flex shrink-0 gap-3 border-t border-slate-200 bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:rounded-b-2xl"><button type="button" onClick={onClose} className="min-h-11 flex-1 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700">Cancelar</button><button type="button" onClick={onCreate} disabled={!selectedId || creating} className="inline-flex min-h-11 flex-[1.4] items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white disabled:opacity-50">{creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}Crear y obtener enlaces</button></footer>
      </div>
    </div>
  );
}

function RecipientLinksDialog({ programId, instance, onClose }: { programId: string; instance: SurveyInstanceSummary; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [recipients, setRecipients] = useState<SurveyInstanceRecipient[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState('');
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAppliedQuery(query.trim());
      setOffset(0);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await api<{ recipients: SurveyInstanceRecipient[]; total: number }>(
          `/api/programs/${programId}/surveys/${instance.id}/recipients?q=${encodeURIComponent(appliedQuery)}&limit=50&offset=${offset}`,
          { signal: controller.signal },
        );
        if (!response.success || !response.data) throw new Error(response.error || 'No se pudieron cargar los destinatarios.');
        const incoming = response.data.recipients || [];
        setRecipients(current => {
          if (offset === 0) return incoming;
          const byId = new Map(current.map(recipient => [recipient.id, recipient]));
          incoming.forEach(recipient => byId.set(recipient.id, recipient));
          return Array.from(byId.values());
        });
        setTotal(response.data.total || 0);
      } catch (loadError) {
        if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : 'No se pudieron cargar los destinatarios.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [appliedQuery, instance.id, offset, programId]);

  const copy = async (recipient: SurveyInstanceRecipient) => {
    await navigator.clipboard.writeText(`${window.location.origin}/f/${instance.slug}?recipient=${recipient.recipient_token}`);
    setCopiedId(recipient.id);
    window.setTimeout(() => setCopiedId(''), 1500);
  };

  return (
    <div className="fixed inset-0 z-[95] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="program-survey-recipient-links-title">
      <div className="flex h-[100dvh] w-full flex-col bg-white sm:h-auto sm:max-h-[88vh] sm:max-w-xl sm:rounded-2xl">
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3.5">
          <div className="min-w-0"><h3 id="program-survey-recipient-links-title" className="truncate font-semibold text-slate-900">Enlaces por participante</h3><p className="text-xs text-slate-500">{instance.name} · {total} destinatarios</p></div>
          <button type="button" onClick={onClose} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-slate-500" aria-label="Cerrar"><X className="h-5 w-5" /></button>
        </header>
        <div className="border-b border-slate-100 p-4">
          <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar por nombre o teléfono" className="min-h-11 w-full rounded-xl border border-slate-200 pl-10 pr-3 text-sm outline-none focus:border-emerald-500" /></div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading && offset === 0 ? <div className="flex min-h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div> : error ? <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p> : recipients.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">No hay destinatarios para esta búsqueda.</p> : (
            <div className="space-y-1">
              {recipients.map(recipient => <div key={recipient.id} className="flex min-h-14 items-center gap-3 rounded-xl px-3 hover:bg-slate-50"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700"><Users className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-slate-800">{recipient.contact_name}</p><p className="text-xs text-slate-500">{recipient.status === 'completed' ? 'Respondida' : recipient.status === 'opened' ? 'Abierta' : 'Pendiente'}</p></div><button type="button" onClick={() => void copy(recipient)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-600" aria-label={`Copiar enlace para ${recipient.contact_name}`}>{copiedId === recipient.id ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}</button></div>)}
              {recipients.length < total && <button type="button" disabled={loading} onClick={() => setOffset(recipients.length)} className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 disabled:opacity-50">{loading && <Loader2 className="h-4 w-4 animate-spin" />}Cargar más</button>}
            </div>
          )}
        </div>
        <footer className="border-t border-slate-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"><button type="button" onClick={onClose} className="min-h-11 w-full rounded-xl bg-slate-900 text-sm font-semibold text-white">Listo</button></footer>
      </div>
    </div>
  );
}
