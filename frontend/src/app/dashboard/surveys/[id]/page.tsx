"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Survey, SurveyQuestion, SurveyQuestionConfig, SurveyLogicRule, SurveyAnalytics, SurveyResponse, SurveyBranding, QUESTION_TYPE_LABELS, QuestionType, FONT_OPTIONS, TITLE_SIZE_OPTIONS, BUTTON_STYLE_OPTIONS } from '@/types/survey';
import type { SurveyInstanceSummary, SurveyTemplate, SurveyTemplateQuestion } from '@/types/survey-template';
import {
  ArrowLeft, Save, Plus, Trash2, GripVertical, Eye, Share2, BarChart3,
  Type, AlignLeft, CircleDot, CheckSquare, Star, SlidersHorizontal,
  Calendar, Mail, Phone, Paperclip, ChevronDown, ChevronUp, Copy,
  ExternalLink, CheckCircle2, XCircle, PenLine, Settings2, Loader2,
  Download, FileText, Hash, Clock, TrendingUp, Users, Palette, PieChart, Radar,
  Layers3
} from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { ResponsiveBar } from '@nivo/bar';
import { ResponsivePie } from '@nivo/pie';
import { ResponsiveRadar } from '@nivo/radar';
import { QRCodeSVG } from 'qrcode.react';

const QUESTION_TYPE_ICON: Record<string, React.ElementType> = {
  short_text: Type,
  long_text: AlignLeft,
  single_choice: CircleDot,
  multiple_choice: CheckSquare,
  rating: Star,
  likert: SlidersHorizontal,
  date: Calendar,
  email: Mail,
  phone: Phone,
  file_upload: Paperclip,
};

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; icon: React.ReactNode }> = {
  draft:  { label: 'Borrador', bg: 'bg-slate-100',   text: 'text-slate-600',   icon: <PenLine className="w-3 h-3" /> },
  active: { label: 'Activa',   bg: 'bg-emerald-50',  text: 'text-emerald-700', icon: <CheckCircle2 className="w-3 h-3" /> },
  closed: { label: 'Cerrada',  bg: 'bg-red-50',      text: 'text-red-600',     icon: <XCircle className="w-3 h-3" /> },
};

type Tab = 'builder' | 'design' | 'share' | 'analytics';

type SurveyResultsState = {
  ownerSurveyId: string;
  analytics: SurveyAnalytics | null;
  responses: SurveyResponse[];
  responsesTotal: number;
  loadingAnalytics: boolean;
  selectedResponse: SurveyResponse | null;
  responsePage: number;
};

function emptySurveyResultsState(ownerSurveyId: string): SurveyResultsState {
  return {
    ownerSurveyId,
    analytics: null,
    responses: [],
    responsesTotal: 0,
    loadingAnalytics: false,
    selectedResponse: null,
    responsePage: 0,
  };
}

function isImmutableSurveyApplication(survey: Survey | null): boolean {
  if (!survey) return false;
  return survey.status !== 'draft' || (!survey.legacy_instance && Boolean(survey.template_id));
}

function emptyQuestion(type: QuestionType = 'short_text'): SurveyQuestion {
  return {
    id: crypto.randomUUID(),
    survey_id: '',
    order_index: 0,
    type,
    title: '',
    description: '',
    required: false,
    config: type === 'single_choice' || type === 'multiple_choice' ? { options: ['Opción 1', 'Opción 2'] } : type === 'rating' ? { max_rating: 5 } : type === 'likert' ? { likert_scale: 5, likert_min: 'Muy en desacuerdo', likert_max: 'Muy de acuerdo' } : {},
    logic_rules: [],
    created_at: '',
    updated_at: '',
  };
}

function validateForwardLogicForEditor(questions: SurveyQuestion[]): string | null {
  const positions = new Map(questions.map((question, index) => [question.id, index]));
  for (let sourceIndex = 0; sourceIndex < questions.length; sourceIndex += 1) {
    for (const rule of questions[sourceIndex].logic_rules || []) {
      const targetIndex = positions.get(rule.jump_to);
      if (targetIndex === undefined || targetIndex <= sourceIndex) {
        return `La lógica de la pregunta ${sourceIndex + 1} debe dirigir a una pregunta posterior.`;
      }
    }
  }
  return null;
}

export default function SurveyDetailPage() {
	const params = useParams();
	const searchParams = useSearchParams();
	const id = params.id as string;
	if (searchParams.get('mode') === 'template') {
		return <SurveyTemplateEditorPage templateId={id} />;
	}
	const requestedTab = searchParams.get('tab');
	return <SurveyBuilderPage requestedTab={requestedTab === 'analytics' || requestedTab === 'share' || requestedTab === 'design' || requestedTab === 'builder' ? requestedTab : undefined} />;
}

type TemplateTab = 'builder' | 'design' | 'instances';

function templateQuestionToEditor(question: SurveyTemplateQuestion): SurveyQuestion {
  return {
    id: question.id,
    survey_id: question.template_id,
    order_index: question.order_index,
    type: question.type,
    title: question.title,
    description: question.description,
    required: question.required,
    config: question.config || {},
    logic_rules: question.logic_rules || [],
    created_at: question.created_at,
    updated_at: question.updated_at,
  };
}

function templateAsSurvey(template: SurveyTemplate): Survey {
  return {
    id: template.id,
    account_id: template.account_id,
    name: template.name,
    description: template.description,
    slug: '',
    status: template.status === 'active' ? 'active' : 'closed',
    welcome_title: template.welcome_title,
    welcome_description: template.welcome_description,
    thank_you_title: template.thank_you_title,
    thank_you_message: template.thank_you_message,
    thank_you_redirect_url: template.thank_you_redirect_url,
    branding: template.branding || {},
    is_template: true,
    created_by: template.created_by,
    created_at: template.created_at,
    updated_at: template.updated_at,
    question_count: template.question_count,
    response_count: template.response_count,
  };
}

function SurveyTemplateEditorPage({ templateId }: { templateId: string }) {
  const router = useRouter();
  const [template, setTemplate] = useState<SurveyTemplate | null>(null);
  const [questions, setQuestions] = useState<SurveyQuestion[]>([]);
  const [activeTab, setActiveTab] = useState<TemplateTab>('builder');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectedQ, setSelectedQ] = useState(0);
  const [hasChanges, setHasChanges] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [instances, setInstances] = useState<SurveyInstanceSummary[]>([]);
  const [instancesLoading, setInstancesLoading] = useState(false);
  const [instancesLoaded, setInstancesLoaded] = useState(false);
  const [createInstanceOpen, setCreateInstanceOpen] = useState(false);

  const loadTemplate = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [templateResponse, questionsResponse] = await Promise.all([
        api<SurveyTemplate>(`/api/survey-templates/${templateId}`),
        api<SurveyTemplateQuestion[]>(`/api/survey-templates/${templateId}/questions`),
      ]);
      if (!templateResponse.success || !templateResponse.data) {
        throw new Error(templateResponse.error || 'No se pudo cargar la plantilla.');
      }
      if (!questionsResponse.success) {
        throw new Error(questionsResponse.error || 'No se pudieron cargar las preguntas.');
      }
      setTemplate(templateResponse.data);
      setQuestions((questionsResponse.data || []).map(templateQuestionToEditor));
      setSelectedQ(0);
      setHasChanges(false);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'No se pudo cargar la plantilla.');
    } finally {
      setLoading(false);
    }
  }, [templateId]);

  useEffect(() => { void loadTemplate(); }, [loadTemplate]);

  const loadInstances = useCallback(async () => {
    setInstancesLoading(true);
    try {
      const response = await api<SurveyInstanceSummary[]>(`/api/survey-templates/${templateId}/instances`);
      if (!response.success) throw new Error(response.error || 'No se pudo cargar el historial.');
      setInstances(response.data || []);
      setInstancesLoaded(true);
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'No se pudo cargar el historial.' });
    } finally {
      setInstancesLoading(false);
    }
  }, [templateId]);

  useEffect(() => {
    if (activeTab === 'instances' && !instancesLoaded) void loadInstances();
  }, [activeTab, instancesLoaded, loadInstances]);

  const updateQuestion = (idx: number, updates: Partial<SurveyQuestion>) => {
    setQuestions(current => current.map((question, index) => index === idx ? { ...question, ...updates } : question));
    setHasChanges(true);
  };
  const addQuestion = (type: QuestionType) => {
    const next = [...questions, { ...emptyQuestion(type), survey_id: templateId }];
    setQuestions(next);
    setSelectedQ(next.length - 1);
    setHasChanges(true);
  };
  const removeQuestion = (idx: number) => {
    const next = questions.filter((_, index) => index !== idx);
    setQuestions(next);
    setSelectedQ(current => Math.min(current, Math.max(0, next.length - 1)));
    setHasChanges(true);
  };
  const moveQuestion = (idx: number, direction: -1 | 1) => {
    const nextIndex = idx + direction;
    if (nextIndex < 0 || nextIndex >= questions.length) return;
    const next = [...questions];
    [next[idx], next[nextIndex]] = [next[nextIndex], next[idx]];
    setQuestions(next);
    setSelectedQ(nextIndex);
    setHasChanges(true);
  };

  const saveQuestions = async () => {
    const emptyIndex = questions.findIndex(question => !question.title.trim());
    if (emptyIndex >= 0) {
      setSelectedQ(emptyIndex);
      setMessage({ type: 'error', text: `La pregunta ${emptyIndex + 1} necesita un título.` });
      return;
    }
    const logicError = validateForwardLogicForEditor(questions);
    if (logicError) {
      setMessage({ type: 'error', text: logicError });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const response = await api<{ questions: SurveyTemplateQuestion[]; revision: number }>(`/api/survey-templates/${templateId}/questions`, {
        method: 'PUT',
        body: JSON.stringify(questions.map((question, index) => ({
          id: question.id,
          order_index: index,
          type: question.type,
          title: question.title.trim(),
          description: question.description,
          required: question.required,
          config: question.config,
          logic_rules: question.logic_rules || [],
        }))),
      });
      if (!response.success || !response.data) throw new Error(response.error || 'No se pudieron guardar las preguntas.');
      setQuestions((response.data.questions || []).map(templateQuestionToEditor));
      setTemplate(current => current ? { ...current, revision: response.data!.revision, question_count: response.data!.questions.length, updated_at: new Date().toISOString() } : current);
      setHasChanges(false);
      setMessage({ type: 'success', text: 'Plantilla guardada. Las aplicaciones existentes no cambiaron.' });
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'No se pudieron guardar las preguntas.' });
    } finally {
      setSaving(false);
    }
  };

  const updateTemplate = async (changes: Partial<SurveyTemplate>, successText: string) => {
    if (!template) return false;
    setSaving(true);
    setMessage(null);
    try {
      const response = await api<SurveyTemplate>(`/api/survey-templates/${templateId}`, {
        method: 'PATCH',
        body: JSON.stringify(changes),
      });
      if (!response.success || !response.data) throw new Error(response.error || 'No se pudo guardar la plantilla.');
      setTemplate(response.data);
      setMessage({ type: 'success', text: successText });
      return true;
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'No se pudo guardar la plantilla.' });
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-emerald-600" /></div>;
  if (loadError || !template) return <div className="flex h-full items-center justify-center p-6"><div className="max-w-md rounded-2xl border border-rose-200 bg-rose-50 p-5 text-center text-sm text-rose-700"><p>{loadError || 'Plantilla no encontrada.'}</p><button type="button" onClick={() => void loadTemplate()} className="mt-3 min-h-11 font-semibold underline">Reintentar</button></div></div>;

  const editorSurvey = templateAsSurvey(template);
  const templateTabs: [TemplateTab, React.ElementType, string][] = [
    ['builder', PenLine, 'Preguntas'], ['design', Palette, 'Diseño'], ['instances', Layers3, 'Aplicaciones'],
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50">
      <header className="shrink-0 border-b border-slate-200 bg-white px-3 py-3 sm:px-4">
        <div className="flex items-center gap-2 sm:gap-3">
          <button type="button" onClick={() => router.push('/dashboard/surveys')} className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100" aria-label="Volver a plantillas"><ArrowLeft className="h-5 w-5" /></button>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2"><h1 className="truncate text-sm font-semibold text-slate-900 sm:text-base">{template.name}</h1><span className="hidden rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700 sm:inline">Plantilla v{template.revision}</span></div>
            <p className="truncate text-xs text-slate-500">No recibe respuestas directamente · {template.instance_count} aplicaciones</p>
          </div>
          <button type="button" onClick={() => setShowSettings(true)} className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50" aria-label="Configurar plantilla"><Settings2 className="h-4 w-4" /></button>
          {activeTab === 'builder' && <button type="button" onClick={() => void saveQuestions()} disabled={saving || !hasChanges} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 text-sm font-semibold text-white disabled:opacity-50 sm:px-4">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}<span className="hidden sm:inline">Guardar</span></button>}
        </div>
        <nav className="mt-3 flex min-h-11 gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1" aria-label="Secciones de la plantilla">
          {templateTabs.map(([tab, Icon, label]) => <button key={tab} type="button" onClick={() => setActiveTab(tab)} className={`inline-flex min-h-9 min-w-max flex-1 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors ${activeTab === tab ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><Icon className="h-4 w-4" />{label}</button>)}
        </nav>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'builder' && <BuilderTab questions={questions} selectedQ={selectedQ} setSelectedQ={setSelectedQ} addQuestion={addQuestion} removeQuestion={removeQuestion} updateQuestion={updateQuestion} moveQuestion={moveQuestion} allQuestions={questions} />}
        {activeTab === 'design' && <DesignTab survey={editorSurvey} onSave={branding => void updateTemplate({ branding }, 'Diseño de plantilla guardado.')} saving={saving} />}
        {activeTab === 'instances' && <TemplateInstancesTab template={template} instances={instances} loading={instancesLoading} onRefresh={() => void loadInstances()} onCreate={() => setCreateInstanceOpen(true)} />}
      </main>

      {message && <div className={`fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 z-[100] flex w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-xl ${message.type === 'success' ? 'bg-emerald-600' : 'bg-rose-600'}`} role="status">{message.type === 'success' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}<span className="min-w-0 flex-1">{message.text}</span><button type="button" onClick={() => setMessage(null)} className="min-h-8 min-w-8" aria-label="Cerrar mensaje">×</button></div>}
      {showSettings && <TemplateSettingsDialog template={template} saving={saving} onClose={() => setShowSettings(false)} onSave={async changes => { const saved = await updateTemplate(changes, 'Configuración de plantilla guardada.'); if (saved) setShowSettings(false); }} />}
      {createInstanceOpen && <StandaloneApplicationDialog template={template} onClose={() => setCreateInstanceOpen(false)} onCreated={instance => { setInstances(current => [instance, ...current]); setInstancesLoaded(true); setTemplate(current => current ? { ...current, instance_count: current.instance_count + 1 } : current); setCreateInstanceOpen(false); setMessage({ type: 'success', text: 'Aplicación creada. Ya puedes compartir su enlace.' }); }} />}
    </div>
  );
}

function TemplateSettingsDialog({ template, saving, onClose, onSave }: { template: SurveyTemplate; saving: boolean; onClose: () => void; onSave: (changes: Partial<SurveyTemplate>) => Promise<void> }) {
  const [form, setForm] = useState({
    name: template.name, description: template.description, status: template.status,
    welcome_title: template.welcome_title, welcome_description: template.welcome_description,
    thank_you_title: template.thank_you_title, thank_you_message: template.thank_you_message,
    thank_you_redirect_url: template.thank_you_redirect_url,
  });
  return <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="template-settings-title"><div className="flex max-h-[100dvh] w-full flex-col bg-white shadow-2xl sm:max-h-[90vh] sm:max-w-xl sm:rounded-2xl"><header className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3.5"><div><h2 id="template-settings-title" className="font-semibold text-slate-900">Configuración de plantilla</h2><p className="text-xs text-slate-500">Los cambios solo afectarán futuras aplicaciones.</p></div><button type="button" onClick={onClose} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-slate-500" aria-label="Cerrar"><XCircle className="h-5 w-5" /></button></header><div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
    <label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Nombre</span><input value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} maxLength={180} className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-emerald-500" /></label>
    <label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Descripción</span><textarea value={form.description} onChange={event => setForm(current => ({ ...current, description: event.target.value }))} rows={3} className="w-full resize-none rounded-xl border border-slate-200 p-3 text-sm outline-none focus:border-emerald-500" /></label>
    <div className="grid gap-4 sm:grid-cols-2"><label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Título de bienvenida</span><input value={form.welcome_title} onChange={event => setForm(current => ({ ...current, welcome_title: event.target.value }))} className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" /></label><label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Título de agradecimiento</span><input value={form.thank_you_title} onChange={event => setForm(current => ({ ...current, thank_you_title: event.target.value }))} className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" /></label></div>
    <label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Mensaje de bienvenida</span><textarea value={form.welcome_description} onChange={event => setForm(current => ({ ...current, welcome_description: event.target.value }))} rows={2} className="w-full resize-none rounded-xl border border-slate-200 p-3 text-sm" /></label>
    <label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Mensaje de agradecimiento</span><textarea value={form.thank_you_message} onChange={event => setForm(current => ({ ...current, thank_you_message: event.target.value }))} rows={2} className="w-full resize-none rounded-xl border border-slate-200 p-3 text-sm" /></label>
    <label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Redirección al finalizar <span className="font-normal text-slate-400">(opcional)</span></span><input value={form.thank_you_redirect_url} onChange={event => setForm(current => ({ ...current, thank_you_redirect_url: event.target.value }))} placeholder="https://" className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" /></label>
    <label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Estado</span><select value={form.status} onChange={event => setForm(current => ({ ...current, status: event.target.value as SurveyTemplate['status'] }))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm"><option value="active">Activa</option><option value="archived">Archivada</option></select></label>
  </div><footer className="flex shrink-0 gap-3 border-t border-slate-200 bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:rounded-b-2xl"><button type="button" onClick={onClose} className="min-h-11 flex-1 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700">Cancelar</button><button type="button" onClick={() => void onSave(form)} disabled={saving || !form.name.trim()} className="inline-flex min-h-11 flex-[1.4] items-center justify-center gap-2 rounded-xl bg-emerald-600 text-sm font-semibold text-white disabled:opacity-50">{saving && <Loader2 className="h-4 w-4 animate-spin" />}Guardar</button></footer></div></div>;
}

function TemplateInstancesTab({ template, instances, loading, onRefresh, onCreate }: { template: SurveyTemplate; instances: SurveyInstanceSummary[]; loading: boolean; onRefresh: () => void; onCreate: () => void }) {
  return <div className="h-full overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-5xl"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-semibold text-slate-900">Aplicaciones e historial</h2><p className="text-sm text-slate-500">Cada aplicación conserva la versión exacta que se publicó.</p></div><button type="button" onClick={onCreate} disabled={template.status === 'archived' || template.question_count === 0} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white disabled:opacity-50"><Plus className="h-4 w-4" />Aplicar plantilla</button></div>
    <div className="mt-5 grid grid-cols-3 gap-2 sm:gap-3"><div className="rounded-2xl border border-slate-200 bg-white p-3 text-center sm:p-4"><p className="text-xl font-bold text-slate-900">{template.instance_count}</p><p className="text-xs text-slate-500">Aplicaciones</p></div><div className="rounded-2xl border border-slate-200 bg-white p-3 text-center sm:p-4"><p className="text-xl font-bold text-slate-900">{template.response_count}</p><p className="text-xs text-slate-500">Respuestas</p></div><div className="rounded-2xl border border-slate-200 bg-white p-3 text-center sm:p-4"><p className="text-xl font-bold text-slate-900">v{template.revision}</p><p className="text-xs text-slate-500">Versión actual</p></div></div>
    {loading ? <div className="flex min-h-56 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-emerald-600" /></div> : instances.length === 0 ? <div className="mt-5 flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center"><Layers3 className="mb-3 h-9 w-9 text-slate-300" /><p className="font-medium text-slate-700">Todavía no hay aplicaciones</p><p className="mt-1 max-w-md text-sm text-slate-500">Aplícala desde un programa para crear enlaces individuales, o crea una aplicación pública independiente.</p><button type="button" onClick={onRefresh} className="mt-4 min-h-11 text-sm font-semibold text-emerald-700">Actualizar</button></div> : <div className="mt-5 space-y-3">{instances.map(instance => <article key={instance.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex items-start gap-3"><span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${instance.status === 'active' ? 'bg-emerald-500' : instance.status === 'draft' ? 'bg-amber-400' : 'bg-slate-300'}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate font-semibold text-slate-900">{instance.name}</h3><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">v{instance.template_revision}</span></div><p className="mt-1 text-sm text-slate-500">{instance.origin_label} · {instance.response_count} respuestas{instance.recipient_count > 0 ? ` de ${instance.recipient_count} destinatarios` : ''}</p><p className="mt-1 text-xs text-slate-400">Creada {format(new Date(instance.created_at), "d MMM yyyy, HH:mm", { locale: es })}</p></div><Link href={`/dashboard/surveys/${instance.id}?mode=instance&tab=analytics`} className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50" aria-label={`Ver resultados de ${instance.name}`}><BarChart3 className="h-4 w-4" /></Link></div>{instance.audience_mode === 'public' && instance.status === 'active' && <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3"><code className="min-w-0 flex-1 truncate rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">/f/{instance.slug}</code><a href={`/f/${instance.slug}`} target="_blank" rel="noreferrer" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-600" aria-label="Abrir aplicación"><ExternalLink className="h-4 w-4" /></a></div>}</article>)}</div>}
  </div></div>;
}

function StandaloneApplicationDialog({ template, onClose, onCreated }: { template: SurveyTemplate; onClose: () => void; onCreated: (instance: SurveyInstanceSummary) => void }) {
  const [name, setName] = useState(template.name);
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const create = async () => {
    setCreating(true); setError('');
    try {
      const response = await api<SurveyInstanceSummary>(`/api/survey-templates/${template.id}/instances`, { method: 'POST', body: JSON.stringify({ name: name.trim(), status: 'active', audience_mode: 'public', opens_at: opensAt ? new Date(opensAt).toISOString() : null, closes_at: closesAt ? new Date(closesAt).toISOString() : null }) });
      if (!response.success || !response.data) throw new Error(response.error || 'No se pudo crear la aplicación.');
      onCreated(response.data);
    } catch (creationError) { setError(creationError instanceof Error ? creationError.message : 'No se pudo crear la aplicación.'); } finally { setCreating(false); }
  };
  return <div className="fixed inset-0 z-[95] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="standalone-survey-title"><div className="w-full bg-white shadow-2xl sm:max-w-lg sm:rounded-2xl"><header className="flex items-center justify-between border-b border-slate-200 px-4 py-3.5"><div><h2 id="standalone-survey-title" className="font-semibold text-slate-900">Aplicación pública</h2><p className="text-xs text-slate-500">Creará una copia inmutable de la plantilla v{template.revision}.</p></div><button type="button" onClick={onClose} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-slate-500" aria-label="Cerrar"><XCircle className="h-5 w-5" /></button></header><div className="space-y-4 p-4 sm:p-5"><label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Nombre de esta aplicación</span><input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={180} className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-emerald-500" /></label><div className="grid gap-4 sm:grid-cols-2"><label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Apertura <span className="font-normal text-slate-400">(opcional)</span></span><input type="datetime-local" value={opensAt} onChange={event => setOpensAt(event.target.value)} className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" /></label><label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">Cierre <span className="font-normal text-slate-400">(opcional)</span></span><input type="datetime-local" value={closesAt} onChange={event => setClosesAt(event.target.value)} className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm" /></label></div>{error && <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}</div><footer className="flex gap-3 border-t border-slate-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"><button type="button" onClick={onClose} className="min-h-11 flex-1 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700">Cancelar</button><button type="button" onClick={() => void create()} disabled={creating || !name.trim()} className="inline-flex min-h-11 flex-[1.4] items-center justify-center gap-2 rounded-xl bg-emerald-600 text-sm font-semibold text-white disabled:opacity-50">{creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers3 className="h-4 w-4" />}Crear aplicación</button></footer></div></div>;
}

function SurveyBuilderPage({ requestedTab }: { requestedTab?: Tab }) {
  const params = useParams();
  const router = useRouter();
  const surveyId = params.id as string;

  const [survey, setSurvey] = useState<Survey | null>(null);
  const [questions, setQuestions] = useState<SurveyQuestion[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>(requestedTab || 'builder');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectedQ, setSelectedQ] = useState<number>(0);
  const [hasChanges, setHasChanges] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Share tab
  const [slugInput, setSlugInput] = useState('');
  const [slugAvailable, setSlugAvailable] = useState<boolean | null>(null);

  // Analytics tab
  const [resultsState, setResultsState] = useState<SurveyResultsState>(() => emptySurveyResultsState(surveyId));
  const surveyRequestSequence = useRef(0);
  const surveyRequestRef = useRef<AbortController | null>(null);
  const analyticsRequestSequence = useRef(0);
  const responsesRequestSequence = useRef(0);
  const responseDetailRequestSequence = useRef(0);
  const responseDetailRequestRef = useRef<AbortController | null>(null);
  const {
    analytics,
    responses,
    responsesTotal,
    loadingAnalytics,
    selectedResponse,
    responsePage,
  } = resultsState;

  // Settings panel
  const [showSettings, setShowSettings] = useState(false);
  const [surveyForm, setSurveyForm] = useState({
    name: '', description: '', welcome_title: '', welcome_description: '',
    thank_you_title: '', thank_you_message: '', thank_you_redirect_url: '',
  });
  const immutableInstance = isImmutableSurveyApplication(survey);
  const effectiveActiveTab: Tab = immutableInstance && activeTab === 'design' ? 'builder' : activeTab;

  useEffect(() => {
    void fetchSurvey(true);
    return () => surveyRequestRef.current?.abort();
  }, [surveyId]);

  useEffect(() => {
    analyticsRequestSequence.current += 1;
    responsesRequestSequence.current += 1;
    responseDetailRequestRef.current?.abort();
    responseDetailRequestSequence.current += 1;
    setResultsState(emptySurveyResultsState(surveyId));

    return () => {
      responseDetailRequestRef.current?.abort();
      responseDetailRequestSequence.current += 1;
    };
  }, [surveyId]);

  useEffect(() => {
    setActiveTab(requestedTab || 'builder');
  }, [requestedTab, surveyId]);

  useEffect(() => {
    if (immutableInstance && activeTab === 'design') {
      setActiveTab('builder');
    }
  }, [activeTab, immutableInstance]);

  useEffect(() => {
    if (effectiveActiveTab !== 'analytics' || resultsState.ownerSurveyId !== surveyId) return;

    const controller = new AbortController();
    const requestSequence = ++analyticsRequestSequence.current;
    setResultsState(current => current.ownerSurveyId === surveyId
      ? { ...current, loadingAnalytics: true }
      : current);

    void (async () => {
      try {
        const response = await api<SurveyAnalytics>(`/api/surveys/${surveyId}/analytics`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted || requestSequence !== analyticsRequestSequence.current) return;
        if (response.success) {
          setResultsState(current => current.ownerSurveyId === surveyId
            ? { ...current, analytics: response.data || null }
            : current);
        }
      } finally {
        if (!controller.signal.aborted && requestSequence === analyticsRequestSequence.current) {
          setResultsState(current => current.ownerSurveyId === surveyId
            ? { ...current, loadingAnalytics: false }
            : current);
        }
      }
    })();

    return () => controller.abort();
  }, [effectiveActiveTab, resultsState.ownerSurveyId, surveyId]);

  useEffect(() => {
    if (effectiveActiveTab !== 'analytics' || resultsState.ownerSurveyId !== surveyId) return;

    const controller = new AbortController();
    const requestSequence = ++responsesRequestSequence.current;
    const requestedPage = resultsState.responsePage;

    void (async () => {
      const response = await api<{ responses: SurveyResponse[]; total: number }>(
        `/api/surveys/${surveyId}/responses?limit=50&offset=${requestedPage * 50}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || requestSequence !== responsesRequestSequence.current) return;
      if (response.success && response.data) {
        setResultsState(current => current.ownerSurveyId === surveyId && current.responsePage === requestedPage
          ? {
              ...current,
              responses: response.data?.responses || [],
              responsesTotal: response.data?.total || 0,
            }
          : current);
      }
    })();

    return () => controller.abort();
  }, [effectiveActiveTab, resultsState.ownerSurveyId, resultsState.responsePage, surveyId]);

  const fetchSurvey = async (resetForSurveyChange = false) => {
    surveyRequestRef.current?.abort();
    const controller = new AbortController();
    surveyRequestRef.current = controller;
    const requestSequence = ++surveyRequestSequence.current;
    try {
      setLoading(true);
      setLoadError('');
      if (resetForSurveyChange) {
        setSurvey(null);
        setQuestions([]);
        setHasChanges(false);
        setSelectedQ(0);
      }
      const [surveyRes, questionsRes] = await Promise.all([
        api<Survey>(`/api/surveys/${surveyId}`, { signal: controller.signal }),
        api<SurveyQuestion[]>(`/api/surveys/${surveyId}/questions`, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted || requestSequence !== surveyRequestSequence.current) return;
      if (!surveyRes.success || !surveyRes.data) {
        setLoadError(surveyRes.error || 'No se pudo cargar la encuesta.');
        return;
      }
      if (!questionsRes.success || !Array.isArray(questionsRes.data)) {
        setLoadError(questionsRes.error || 'No se pudieron cargar las preguntas. No habilitamos la edición para proteger la encuesta.');
        return;
      }

      // Publish the editable snapshot only when the survey and its complete
      // question collection belong to the same successful load. This prevents
      // a transient /questions failure from looking like an empty survey.
      setSurvey(surveyRes.data);
      setQuestions(questionsRes.data);
      setSlugInput(surveyRes.data.slug);
      setSurveyForm({
        name: surveyRes.data.name,
        description: surveyRes.data.description,
        welcome_title: surveyRes.data.welcome_title,
        welcome_description: surveyRes.data.welcome_description,
        thank_you_title: surveyRes.data.thank_you_title,
        thank_you_message: surveyRes.data.thank_you_message,
        thank_you_redirect_url: surveyRes.data.thank_you_redirect_url,
      });
      setLoadError('');
    } finally {
      if (!controller.signal.aborted && requestSequence === surveyRequestSequence.current) {
        setLoading(false);
      }
      if (surveyRequestRef.current === controller) surveyRequestRef.current = null;
    }
  };

  const handleResponsePageChange = useCallback((newPage: number) => {
    setResultsState(current => current.ownerSurveyId === surveyId
      ? { ...current, responsePage: Math.max(0, newPage), responses: [], selectedResponse: null }
      : current);
  }, [surveyId]);

  const handleSaveQuestions = async () => {
    if (!survey || loading || loadError) return;
    setSaveMessage(null);
    // Client-side validation
    const emptyIdx = questions.findIndex(q => !q.title.trim());
    if (emptyIdx >= 0) {
      setSelectedQ(emptyIdx);
      setSaveMessage({ type: 'error', text: `La pregunta ${emptyIdx + 1} necesita un título` });
      return;
    }
    const logicError = validateForwardLogicForEditor(questions);
    if (logicError) {
      setSaveMessage({ type: 'error', text: logicError });
      return;
    }
    setSaving(true);
    try {
      const payload = questions.map((q, i) => ({
        id: q.id,
        type: q.type,
        title: q.title,
        description: q.description,
        required: q.required,
        config: q.config,
        logic_rules: q.logic_rules || [],
        order_index: i,
      }));
      const res = await api<SurveyQuestion[]>(`/api/surveys/${surveyId}/questions`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      if (res.success && res.data) {
        setQuestions(res.data);
        setHasChanges(false);
        setSaveMessage({ type: 'success', text: 'Preguntas guardadas' });
        setTimeout(() => setSaveMessage(null), 3000);
      } else {
        setSaveMessage({ type: 'error', text: res.error || 'Error al guardar' });
      }
    } catch {
      setSaveMessage({ type: 'error', text: 'Error de conexión' });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSurvey = async () => {
    if (!survey) return;
    setSaveMessage(null);
    setSaving(true);
    try {
      const res = await api<Survey>(`/api/surveys/${surveyId}`, {
        method: 'PUT',
        body: JSON.stringify({ ...surveyForm, slug: slugInput, status: survey.status, branding: survey.branding }),
      });
      if (res.success && res.data) {
        setSurvey(res.data);
        setShowSettings(false);
        setSaveMessage({ type: 'success', text: 'Encuesta guardada' });
        setTimeout(() => setSaveMessage(null), 3000);
      } else {
        setSaveMessage({ type: 'error', text: res.error || 'Error al guardar' });
      }
    } catch {
      setSaveMessage({ type: 'error', text: 'Error de conexión' });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveBranding = async (branding: SurveyBranding) => {
    if (!survey) return;
    setSaveMessage(null);
    setSaving(true);
    try {
      const res = await api<Survey>(`/api/surveys/${surveyId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: survey.name, description: survey.description, slug: survey.slug, status: survey.status, welcome_title: survey.welcome_title, welcome_description: survey.welcome_description, thank_you_title: survey.thank_you_title, thank_you_message: survey.thank_you_message, thank_you_redirect_url: survey.thank_you_redirect_url, branding }),
      });
      if (res.success && res.data) {
        setSurvey(res.data);
        setSaveMessage({ type: 'success', text: 'Diseño guardado' });
        setTimeout(() => setSaveMessage(null), 3000);
      } else {
        setSaveMessage({ type: 'error', text: res.error || 'Error al guardar diseño' });
      }
    } catch {
      setSaveMessage({ type: 'error', text: 'Error de conexión' });
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (newStatus: string) => {
    try {
      await api(`/api/surveys/${surveyId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      void fetchSurvey();
    } catch (e) {
      console.error(e);
    }
  };

  const checkSlug = useCallback(async (slug: string) => {
    if (!slug || slug.length < 2) { setSlugAvailable(null); return; }
    const res = await api<{ available: boolean }>('/api/surveys/check-slug', {
      method: 'POST',
      body: JSON.stringify({ slug, exclude_id: surveyId }),
    });
    if (res.success && res.data) setSlugAvailable(res.data.available);
  }, [surveyId]);

  // Question operations
  const addQuestion = (type: QuestionType) => {
    const q = emptyQuestion(type);
    const newList = [...questions, q];
    setQuestions(newList);
    setSelectedQ(newList.length - 1);
    setHasChanges(true);
  };

  const removeQuestion = (idx: number) => {
    const newList = questions.filter((_, i) => i !== idx);
    setQuestions(newList);
    if (selectedQ >= newList.length) setSelectedQ(Math.max(0, newList.length - 1));
    setHasChanges(true);
  };

  const updateQuestion = (idx: number, updates: Partial<SurveyQuestion>) => {
    setQuestions(prev => prev.map((q, i) => i === idx ? { ...q, ...updates } : q));
    setHasChanges(true);
  };

  const moveQuestion = (idx: number, dir: -1 | 1) => {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= questions.length) return;
    const newList = [...questions];
    [newList[idx], newList[newIdx]] = [newList[newIdx], newList[idx]];
    setQuestions(newList);
    setSelectedQ(newIdx);
    setHasChanges(true);
  };

  const handleExportCSV = () => {
    window.open(`/api/surveys/${surveyId}/export`, '_blank');
  };

  const setSelectedResponse = useCallback((response: SurveyResponse | null) => {
    if (!response) {
      responseDetailRequestRef.current?.abort();
      responseDetailRequestSequence.current += 1;
    }
    setResultsState(current => current.ownerSurveyId === surveyId
      ? { ...current, selectedResponse: response }
      : current);
  }, [surveyId]);

  const handleViewResponse = useCallback(async (responseId: string) => {
    responseDetailRequestRef.current?.abort();
    const controller = new AbortController();
    responseDetailRequestRef.current = controller;
    const requestSequence = ++responseDetailRequestSequence.current;
    setResultsState(current => current.ownerSurveyId === surveyId
      ? { ...current, selectedResponse: null }
      : current);

    const response = await api<SurveyResponse>(`/api/surveys/${surveyId}/responses/${responseId}`, {
      signal: controller.signal,
    });
    if (controller.signal.aborted || requestSequence !== responseDetailRequestSequence.current) return;
    if (response.success && response.data) {
      setResultsState(current => current.ownerSurveyId === surveyId
        ? { ...current, selectedResponse: response.data || null }
        : current);
    }
  }, [surveyId]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-emerald-600 animate-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 p-4 sm:p-6">
        <div role="alert" className="w-full max-w-md rounded-2xl border border-rose-200 bg-white p-5 text-center shadow-sm">
          <XCircle className="mx-auto h-9 w-9 text-rose-500" />
          <h1 className="mt-3 font-semibold text-slate-900">No pudimos cargar la encuesta completa</h1>
          <p className="mt-1 text-sm leading-6 text-slate-600">{loadError}</p>
          <p className="mt-2 text-xs leading-5 text-slate-500">La edición permanece bloqueada hasta recuperar también todas las preguntas.</p>
          <button type="button" onClick={() => void fetchSurvey(true)} className="mt-4 min-h-11 rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700">
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  if (!survey) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-slate-500">Encuesta no encontrada</p>
      </div>
    );
  }

  const statusCfg = STATUS_CONFIG[survey.status] || STATUS_CONFIG.draft;
  const publicUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/f/${survey.slug}`;
  const availableTabs: [Tab, React.ElementType, string][] = immutableInstance
    ? [['builder', Eye, 'Vista'], ['share', Share2, 'Compartir'], ['analytics', BarChart3, 'Resultados']]
    : [['builder', PenLine, 'Editor'], ['design', Palette, 'Diseño'], ['share', Share2, 'Compartir'], ['analytics', BarChart3, 'Analíticas']];

  return (
    <div className="h-full flex flex-col bg-slate-50">
      {/* Top bar */}
      <div className="flex-shrink-0 border-b border-slate-200 bg-white px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <button onClick={() => router.push('/dashboard/surveys')} className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-slate-900">{survey.name}</h1>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusCfg.bg} ${statusCfg.text}`}>
                {statusCfg.icon} {statusCfg.label}
              </span>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
            {/* Tab buttons */}
            <div className="mr-auto flex min-w-max items-center rounded-lg bg-slate-100 p-0.5 sm:mr-2">
              {availableTabs.map(([tab, Icon, label]) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    effectiveActiveTab === tab ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" /> {label}
                </button>
              ))}
            </div>
            {!immutableInstance && <button onClick={() => setShowSettings(true)} className="p-2 rounded-lg hover:bg-slate-100 text-slate-500">
              <Settings2 className="w-4 h-4" />
            </button>}
            {effectiveActiveTab === 'builder' && !immutableInstance && (
              <button
                onClick={handleSaveQuestions}
                disabled={saving || !hasChanges}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Guardar
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-hidden">
        {effectiveActiveTab === 'builder' && (immutableInstance ? <PublishedQuestionsView survey={survey} questions={questions} /> : <BuilderTab questions={questions} selectedQ={selectedQ} setSelectedQ={setSelectedQ} addQuestion={addQuestion} removeQuestion={removeQuestion} updateQuestion={updateQuestion} moveQuestion={moveQuestion} allQuestions={questions} />)}
        {effectiveActiveTab === 'design' && <DesignTab survey={survey} onSave={(branding) => handleSaveBranding(branding)} saving={saving} />}
        {effectiveActiveTab === 'share' && <ShareTab survey={survey} publicUrl={publicUrl} slugInput={slugInput} setSlugInput={setSlugInput} slugAvailable={slugAvailable} checkSlug={checkSlug} handleStatusChange={handleStatusChange} handleSaveSurvey={handleSaveSurvey} saving={saving} />}
        {effectiveActiveTab === 'analytics' && <AnalyticsTab analytics={analytics} responses={responses} responsesTotal={responsesTotal} programAudience={survey.audience_mode === 'program_participants'} loading={loadingAnalytics} selectedResponse={selectedResponse} setSelectedResponse={setSelectedResponse} handleViewResponse={handleViewResponse} handleExportCSV={handleExportCSV} questions={questions} responsePage={responsePage} handleResponsePageChange={handleResponsePageChange} />}
      </div>

      {/* Save message toast */}
      {saveMessage && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-lg text-sm font-medium transition-all ${
          saveMessage.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {saveMessage.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          {saveMessage.text}
          <button onClick={() => setSaveMessage(null)} className="ml-1 opacity-70 hover:opacity-100">×</button>
        </div>
      )}

      {/* Settings modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowSettings(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="p-6">
              <h2 className="text-lg font-bold text-slate-900 mb-4">Configuración de encuesta</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Nombre</label>
                  <input value={surveyForm.name} onChange={(e) => setSurveyForm(p => ({ ...p, name: e.target.value }))} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Descripción</label>
                  <textarea value={surveyForm.description} onChange={(e) => setSurveyForm(p => ({ ...p, description: e.target.value }))} rows={2} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 resize-none" />
                </div>
                <hr className="border-slate-100" />
                <h3 className="text-sm font-semibold text-slate-700">Pantalla de bienvenida</h3>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Título</label>
                  <input value={surveyForm.welcome_title} onChange={(e) => setSurveyForm(p => ({ ...p, welcome_title: e.target.value }))} placeholder="¡Hola!" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Descripción</label>
                  <textarea value={surveyForm.welcome_description} onChange={(e) => setSurveyForm(p => ({ ...p, welcome_description: e.target.value }))} rows={2} placeholder="Gracias por tomarte unos minutos..." className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 resize-none" />
                </div>
                <hr className="border-slate-100" />
                <h3 className="text-sm font-semibold text-slate-700">Pantalla de agradecimiento</h3>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Título</label>
                  <input value={surveyForm.thank_you_title} onChange={(e) => setSurveyForm(p => ({ ...p, thank_you_title: e.target.value }))} placeholder="¡Gracias!" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Mensaje</label>
                  <textarea value={surveyForm.thank_you_message} onChange={(e) => setSurveyForm(p => ({ ...p, thank_you_message: e.target.value }))} rows={2} placeholder="Tus respuestas han sido registradas." className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 resize-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">URL de redirección (opcional)</label>
                  <input value={surveyForm.thank_you_redirect_url} onChange={(e) => setSurveyForm(p => ({ ...p, thank_you_redirect_url: e.target.value }))} placeholder="https://..." className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
              </div>
              <div className="flex items-center justify-end gap-3 mt-6">
                <button onClick={() => setShowSettings(false)} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">Cancelar</button>
                <button onClick={handleSaveSurvey} disabled={saving} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
                  {saving ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PublishedQuestionsView({ survey, questions }: { survey: Survey; questions: SurveyQuestion[] }) {
  const fromTemplate = Boolean(survey.template_id);
  return <div className="h-full overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-3xl"><div className="rounded-2xl border border-violet-200 bg-violet-50 p-4"><div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-700"><Layers3 className="h-4 w-4" /></span><div><h2 className="font-semibold text-violet-950">{fromTemplate ? `Aplicación de plantilla · v${survey.template_revision || 1}` : 'Encuesta publicada'}</h2><p className="mt-1 text-sm text-violet-800">{fromTemplate ? 'El contenido quedó congelado al crear esta aplicación, incluso mientras sea borrador. Para cambiar preguntas, edita la plantilla y crea una nueva aplicación.' : 'Las preguntas quedaron congeladas al publicar esta encuesta para proteger la consistencia de sus respuestas.'}</p></div></div></div>{questions.length === 0 ? <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-500">Esta aplicación no contiene preguntas.</div> : <div className="mt-4 space-y-3">{questions.map((question, index) => <article key={question.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex items-start gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-sm font-semibold text-slate-600">{index + 1}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-start gap-2"><h3 className="font-medium text-slate-900">{question.title}</h3>{question.required && <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-600">Obligatoria</span>}</div>{question.description && <p className="mt-1 text-sm text-slate-500">{question.description}</p>}<p className="mt-3 text-xs font-medium uppercase tracking-wide text-slate-400">{QUESTION_TYPE_LABELS[question.type]}</p>{question.config.options && question.config.options.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{question.config.options.map(option => <span key={option} className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">{option}</span>)}</div>}</div></div></article>)}</div>}</div></div>;
}

// ─── Builder Tab ────────────────────────────────────────────────────────────

function BuilderTab({
  questions, selectedQ, setSelectedQ, addQuestion, removeQuestion, updateQuestion, moveQuestion, allQuestions,
}: {
  questions: SurveyQuestion[];
  selectedQ: number;
  setSelectedQ: (i: number) => void;
  addQuestion: (type: QuestionType) => void;
  removeQuestion: (idx: number) => void;
  updateQuestion: (idx: number, updates: Partial<SurveyQuestion>) => void;
  moveQuestion: (idx: number, dir: -1 | 1) => void;
  allQuestions: SurveyQuestion[];
}) {
  const [showTypeMenu, setShowTypeMenu] = useState(false);
  const current = questions[selectedQ];

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* Question list sidebar */}
      <div className="flex max-h-52 w-full shrink-0 flex-col border-b border-slate-200 bg-white md:max-h-none md:w-72 md:border-b-0 md:border-r">
        <div className="p-3 border-b border-slate-100 flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Preguntas ({questions.length})</span>
          <div className="relative">
            <button
              onClick={() => setShowTypeMenu(!showTypeMenu)}
              className="p-1.5 rounded-lg bg-emerald-50 text-emerald-600 hover:bg-emerald-100 transition-colors"
            >
              <Plus className="w-4 h-4" />
            </button>
            {showTypeMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowTypeMenu(false)} />
                <div className="absolute right-0 top-9 bg-white border border-slate-200 rounded-lg shadow-lg py-1 w-56 z-20">
                  {(Object.entries(QUESTION_TYPE_LABELS) as [QuestionType, string][]).map(([type, label]) => {
                    const Icon = QUESTION_TYPE_ICON[type] || Type;
                    return (
                      <button
                        key={type}
                        onClick={() => { addQuestion(type); setShowTypeMenu(false); }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                      >
                        <Icon className="w-4 h-4 text-slate-400" /> {label}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 gap-2 overflow-auto p-2 md:block md:space-y-1">
          {questions.length === 0 ? (
            <div className="text-center py-10">
              <p className="text-sm text-slate-400 mb-2">Sin preguntas aún</p>
              <button onClick={() => { addQuestion('short_text'); }} className="text-sm text-emerald-600 hover:text-emerald-700 font-medium">
                + Añadir primera pregunta
              </button>
            </div>
          ) : questions.map((q, i) => {
            const Icon = QUESTION_TYPE_ICON[q.type] || Type;
            return (
              <button
                key={q.id}
                onClick={() => setSelectedQ(i)}
                className={`flex min-h-11 min-w-[13rem] items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition-colors md:min-w-0 md:w-full ${
                  selectedQ === i ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'hover:bg-slate-50 text-slate-700'
                }`}
              >
                <span className="flex-shrink-0 w-5 h-5 rounded bg-slate-100 flex items-center justify-center text-[10px] font-bold text-slate-500">{i + 1}</span>
                <Icon className="w-3.5 h-3.5 flex-shrink-0 text-slate-400" />
                <span className="truncate flex-1">{q.title || 'Sin título'}</span>
                {q.required && <span className="text-red-400 text-xs">*</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Question editor */}
      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6 lg:p-8">
        {current ? (
          <div className="max-w-2xl mx-auto">
            {/* Question header */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 sm:mb-6">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-400">Pregunta {selectedQ + 1} de {questions.length}</span>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600`}>
                  {QUESTION_TYPE_LABELS[current.type]}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => moveQuestion(selectedQ, -1)} disabled={selectedQ === 0} className="p-1.5 rounded hover:bg-slate-100 text-slate-400 disabled:opacity-30"><ChevronUp className="w-4 h-4" /></button>
                <button onClick={() => moveQuestion(selectedQ, 1)} disabled={selectedQ === questions.length - 1} className="p-1.5 rounded hover:bg-slate-100 text-slate-400 disabled:opacity-30"><ChevronDown className="w-4 h-4" /></button>
                <button onClick={() => removeQuestion(selectedQ)} className="p-1.5 rounded hover:bg-red-50 text-slate-400 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>

            <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
              {/* Title */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Título de la pregunta</label>
                <input
                  value={current.title}
                  onChange={(e) => updateQuestion(selectedQ, { title: e.target.value })}
                  placeholder="Escribe tu pregunta aquí..."
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Descripción (opcional)</label>
                <input
                  value={current.description}
                  onChange={(e) => updateQuestion(selectedQ, { description: e.target.value })}
                  placeholder="Agrega más contexto..."
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                />
              </div>

              {/* Required toggle */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-700">Obligatoria</span>
                <button
                  onClick={() => updateQuestion(selectedQ, { required: !current.required })}
                  className={`w-10 h-6 rounded-full transition-colors relative ${current.required ? 'bg-emerald-500' : 'bg-slate-200'}`}
                >
                  <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${current.required ? 'left-[18px]' : 'left-0.5'}`} />
                </button>
              </div>

              {/* Type-specific config */}
              <QuestionConfig question={current} idx={selectedQ} updateQuestion={updateQuestion} />

              {/* Logic rules */}
              {(current.type === 'single_choice' || current.type === 'rating') && allQuestions.length > 1 && (
                <LogicRulesEditor question={current} idx={selectedQ} updateQuestion={updateQuestion} allQuestions={allQuestions} />
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-slate-400 text-sm">
            Selecciona o crea una pregunta para editarla
          </div>
        )}
      </div>
    </div>
  );
}

function QuestionConfig({ question, idx, updateQuestion }: { question: SurveyQuestion; idx: number; updateQuestion: (i: number, u: Partial<SurveyQuestion>) => void }) {
  const config = question.config || {};

  const updateConfig = (updates: Partial<SurveyQuestionConfig>) => {
    updateQuestion(idx, { config: { ...config, ...updates } });
  };

  switch (question.type) {
    case 'single_choice':
    case 'multiple_choice': {
      const options = config.options || [];
      return (
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Opciones</label>
          <div className="space-y-2">
            {options.map((opt, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-4 h-4 rounded-full border-2 border-slate-300 flex-shrink-0" />
                <input
                  value={opt}
                  onChange={(e) => {
                    const newOpts = [...options];
                    newOpts[i] = e.target.value;
                    updateConfig({ options: newOpts });
                  }}
                  className="flex-1 px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                />
                <button onClick={() => updateConfig({ options: options.filter((_, j) => j !== i) })} className="p-1 text-slate-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
            <button
              onClick={() => updateConfig({ options: [...options, `Opción ${options.length + 1}`] })}
              className="text-sm text-emerald-600 hover:text-emerald-700 font-medium"
            >
              + Agregar opción
            </button>
          </div>
        </div>
      );
    }
    case 'rating':
      return (
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Calificación máxima</label>
          <select
            value={config.max_rating || 5}
            onChange={(e) => updateConfig({ max_rating: parseInt(e.target.value) })}
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
          >
            {[3, 4, 5, 7, 10].map((v) => (
              <option key={v} value={v}>{v} estrellas</option>
            ))}
          </select>
        </div>
      );
    case 'likert':
      return (
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Puntos de escala</label>
            <select
              value={config.likert_scale || 5}
              onChange={(e) => updateConfig({ likert_scale: parseInt(e.target.value) })}
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
            >
              {[3, 5, 7].map((v) => (
                <option key={v} value={v}>{v} puntos</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Etiqueta mínima</label>
              <input value={config.likert_min || ''} onChange={(e) => updateConfig({ likert_min: e.target.value })} placeholder="Muy en desacuerdo" className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Etiqueta máxima</label>
              <input value={config.likert_max || ''} onChange={(e) => updateConfig({ likert_max: e.target.value })} placeholder="Muy de acuerdo" className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
            </div>
          </div>
        </div>
      );
    case 'short_text':
    case 'long_text':
    case 'email':
    case 'phone':
      return (
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Placeholder</label>
          <input value={config.placeholder || ''} onChange={(e) => updateConfig({ placeholder: e.target.value })} placeholder="Texto de ejemplo..." className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
        </div>
      );
    case 'file_upload':
      return (
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Tamaño máximo (MB)</label>
          <input type="number" value={config.max_size_mb || 10} onChange={(e) => updateConfig({ max_size_mb: parseInt(e.target.value) || 10 })} min={1} max={50} className="w-24 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
        </div>
      );
    default:
      return null;
  }
}

function LogicRulesEditor({ question, idx, updateQuestion, allQuestions }: {
  question: SurveyQuestion; idx: number;
  updateQuestion: (i: number, u: Partial<SurveyQuestion>) => void;
  allQuestions: SurveyQuestion[];
}) {
  const rules = question.logic_rules || [];
  const forwardQuestions = allQuestions
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ index }) => index > idx);
  const hasOptions = question.type === 'single_choice' || question.type === 'multiple_choice';
  const options = hasOptions ? (question.config.options || []) : [];

  const addRule = () => {
    if (forwardQuestions.length === 0) return;
    updateQuestion(idx, { logic_rules: [...rules, { value: hasOptions && options.length > 0 ? options[0] : '', operator: 'eq', jump_to: forwardQuestions[0].candidate.id }] });
  };

  const updateRule = (ri: number, updates: Partial<SurveyLogicRule>) => {
    const newRules = rules.map((r, i) => i === ri ? { ...r, ...updates } : r);
    updateQuestion(idx, { logic_rules: newRules });
  };

  const removeRule = (ri: number) => {
    updateQuestion(idx, { logic_rules: rules.filter((_, i) => i !== ri) });
  };

  const operatorOptions = [
    { value: 'eq', label: 'es igual a' },
    { value: 'neq', label: 'no es igual a' },
    { value: 'contains', label: 'contiene' },
    { value: 'gt', label: 'mayor que' },
    { value: 'lt', label: 'menor que' },
  ];

  return (
    <div className="border-t border-slate-100 pt-4">
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm font-medium text-slate-700">Lógica condicional</label>
        <button onClick={addRule} disabled={forwardQuestions.length === 0} className="text-xs text-emerald-600 hover:text-emerald-700 font-medium disabled:cursor-not-allowed disabled:text-slate-300">+ Regla</button>
      </div>
      {rules.length === 0 ? (
        <p className="text-xs text-slate-400">No hay reglas. Las respuestas seguirán el orden normal.</p>
      ) : (
        <div className="space-y-2">
          {rules.map((rule, ri) => (
            <div key={ri} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-2 text-xs">
              <span className="text-slate-500 flex-shrink-0">Si</span>
              <select value={rule.operator || 'eq'} onChange={(e) => updateRule(ri, { operator: e.target.value })} className="px-2 py-1 border border-slate-200 rounded text-xs bg-white">
                {operatorOptions.map((op) => (
                  <option key={op.value} value={op.value}>{op.label}</option>
                ))}
              </select>
              {hasOptions && options.length > 0 ? (
                <select value={rule.value} onChange={(e) => updateRule(ri, { value: e.target.value })} className="w-28 px-2 py-1 border border-slate-200 rounded text-xs bg-white">
                  {options.map((opt: string) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              ) : (
                <input value={rule.value} onChange={(e) => updateRule(ri, { value: e.target.value })} placeholder="valor" className="w-24 px-2 py-1 border border-slate-200 rounded text-xs" />
              )}
              <span className="text-slate-500 flex-shrink-0">→</span>
              <select value={rule.jump_to} onChange={(e) => updateRule(ri, { jump_to: e.target.value })} className="min-w-36 flex-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs">
                {!forwardQuestions.some(({ candidate }) => candidate.id === rule.jump_to) && <option value="">Selecciona una pregunta posterior</option>}
                {forwardQuestions.map(({ candidate, index }) => (
                  <option key={candidate.id} value={candidate.id}>{index + 1}. {candidate.title || 'Sin título'}</option>
                ))}
              </select>
              <button onClick={() => removeRule(ri)} className="p-1 text-slate-400 hover:text-red-500"><Trash2 className="w-3 h-3" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Design Tab ─────────────────────────────────────────────────────────────

const COLOR_PRESETS = [
  '#ffffff', '#f8fafc', '#f1f5f9', '#fef3c7', '#fce7f3', '#ede9fe',
  '#dbeafe', '#d1fae5', '#1e293b', '#0f172a', '#18181b', '#10b981',
  '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#ef4444', '#06b6d4',
];

function DesignTab({ survey, onSave, saving }: {
  survey: Survey; onSave: (branding: SurveyBranding) => void; saving: boolean;
}) {
  const [branding, setBranding] = useState<SurveyBranding>(survey.branding || {});
  const [dirty, setDirty] = useState(false);

  const update = (key: keyof SurveyBranding, value: string) => {
    setBranding(prev => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const fontFamily = branding.font_family || 'Inter';
  const titleSize = branding.title_size || 'lg';
  const accentColor = branding.accent_color || '#10b981';
  const bgColor = branding.bg_color || '#ffffff';
  const textColor = branding.text_color || '#0f172a';
  const buttonStyle = branding.button_style || 'rounded';
  const questionAlign = branding.question_align || 'left';

  const titlePx = TITLE_SIZE_OPTIONS.find(o => o.value === titleSize)?.px || '2.25rem';
  const btnClass = BUTTON_STYLE_OPTIONS.find(o => o.value === buttonStyle)?.className || 'rounded-lg';

  // Load font preview
  const fontUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily)}:wght@400;500;600;700&display=swap`;

  return (
    <div className="h-full overflow-auto">
      <div className="flex min-h-full flex-col lg:h-full lg:flex-row">
        {/* Controls panel */}
        <div className="w-full shrink-0 space-y-6 border-b border-slate-200 bg-white p-4 sm:p-5 lg:w-80 lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-slate-900">Diseño</h3>
            <button
              onClick={() => { onSave(branding); setDirty(false); }}
              disabled={saving || !dirty}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Guardar
            </button>
          </div>

          {/* Font Family */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Tipografía</label>
            <div className="grid grid-cols-2 gap-1.5">
              {FONT_OPTIONS.map(f => (
                <button
                  key={f.value}
                  onClick={() => update('font_family', f.value)}
                  className={`px-3 py-2 text-xs border-2 transition-all text-left truncate ${
                    fontFamily === f.value
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-700 font-medium'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300'
                  } rounded-lg`}
                  style={{ fontFamily: f.value }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Title Size */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Tamaño de título</label>
            <div className="flex items-center gap-1.5">
              {TITLE_SIZE_OPTIONS.map(s => (
                <button
                  key={s.value}
                  onClick={() => update('title_size', s.value)}
                  className={`flex-1 py-2 text-xs font-medium border-2 transition-all rounded-lg ${
                    titleSize === s.value
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Accent Color */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Color de acento</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {['#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#ef4444', '#06b6d4', '#6366f1', '#14b8a6', '#f97316'].map(c => (
                <button
                  key={c}
                  onClick={() => update('accent_color', c)}
                  className={`w-7 h-7 rounded-full border-2 transition-all ${accentColor === c ? 'border-slate-900 scale-110' : 'border-transparent hover:scale-105'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={accentColor}
                onChange={e => update('accent_color', e.target.value)}
                className="w-8 h-8 rounded border-0 cursor-pointer"
              />
              <input
                value={accentColor}
                onChange={e => update('accent_color', e.target.value)}
                className="flex-1 px-2 py-1 text-xs border border-slate-200 rounded font-mono"
                placeholder="#10b981"
              />
            </div>
          </div>

          {/* Text Color */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Color de texto</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {['#0f172a', '#1e293b', '#334155', '#475569', '#ffffff', '#f8fafc'].map(c => (
                <button
                  key={c}
                  onClick={() => update('text_color', c)}
                  className={`w-7 h-7 rounded-full border-2 transition-all ${textColor === c ? 'border-emerald-500 scale-110' : 'border-slate-300 hover:scale-105'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input type="color" value={textColor} onChange={e => update('text_color', e.target.value)} className="w-8 h-8 rounded border-0 cursor-pointer" />
              <input value={textColor} onChange={e => update('text_color', e.target.value)} className="flex-1 px-2 py-1 text-xs border border-slate-200 rounded font-mono" />
            </div>
          </div>

          {/* Background Color */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Color de fondo</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {COLOR_PRESETS.map(c => (
                <button
                  key={c}
                  onClick={() => update('bg_color', c)}
                  className={`w-7 h-7 rounded-full border-2 transition-all ${bgColor === c ? 'border-emerald-500 scale-110' : 'border-slate-300 hover:scale-105'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input type="color" value={bgColor} onChange={e => update('bg_color', e.target.value)} className="w-8 h-8 rounded border-0 cursor-pointer" />
              <input value={bgColor} onChange={e => update('bg_color', e.target.value)} className="flex-1 px-2 py-1 text-xs border border-slate-200 rounded font-mono" />
            </div>
          </div>

          {/* Button Style */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Estilo de botón</label>
            <div className="flex items-center gap-2">
              {BUTTON_STYLE_OPTIONS.map(s => (
                <button
                  key={s.value}
                  onClick={() => update('button_style', s.value)}
                  className={`flex-1 py-2 px-3 text-xs font-medium border-2 transition-all ${s.className} ${
                    buttonStyle === s.value
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Question Alignment */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Alineación</label>
            <div className="flex items-center gap-2">
              {[['left', 'Izquierda'], ['center', 'Centrado']].map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => update('question_align', val)}
                  className={`flex-1 py-2 text-xs font-medium border-2 rounded-lg transition-all ${
                    questionAlign === val
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Logo URL */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Logo URL</label>
            <input
              value={branding.logo_url || ''}
              onChange={e => update('logo_url', e.target.value)}
              placeholder="https://..."
              className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
            />
          </div>

          {/* Background Image URL */}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Imagen de fondo (URL)</label>
            <input
              value={branding.bg_image_url || ''}
              onChange={e => update('bg_image_url', e.target.value)}
              placeholder="https://..."
              className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
            />
            {branding.bg_image_url && (
              <div className="mt-2">
                <label className="block text-xs text-slate-500 mb-1">Opacidad de overlay</label>
                <div className="flex items-center gap-2">
                  {['0', '0.2', '0.4', '0.6', '0.8'].map(v => (
                    <button
                      key={v}
                      onClick={() => update('bg_overlay', v)}
                      className={`flex-1 py-1.5 text-xs font-medium border rounded-lg transition-all ${
                        (branding.bg_overlay || '0') === v
                          ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                          : 'border-slate-200 text-slate-500'
                      }`}
                    >
                      {parseFloat(v) * 100}%
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Live Preview */}
        <div className="flex flex-1 items-center justify-center overflow-auto p-4 sm:p-8" style={{ backgroundColor: '#f1f5f9' }}>
          <link href={fontUrl} rel="stylesheet" />
          <div
            className="w-full max-w-md rounded-2xl shadow-2xl overflow-hidden border border-slate-200"
            style={{ backgroundColor: bgColor, fontFamily: `'${fontFamily}', sans-serif`, minHeight: '480px' }}
          >
            {/* Preview: simulated form */}
            <div className="relative">
              {branding.bg_image_url && (
                <div className="absolute inset-0 h-48">
                  <img src={branding.bg_image_url} alt="" className="w-full h-full object-cover" />
                  <div className="absolute inset-0" style={{ backgroundColor: `rgba(0,0,0,${branding.bg_overlay || '0'})` }} />
                </div>
              )}
              <div className={`relative p-8 ${questionAlign === 'center' ? 'text-center' : 'text-left'}`}>
                {branding.logo_url && (
                  <img src={branding.logo_url} alt="" className={`h-8 object-contain mb-6 ${questionAlign === 'center' ? 'mx-auto' : ''}`} />
                )}
                <h2 style={{ fontSize: titlePx, color: textColor, fontFamily: `'${fontFamily}', sans-serif` }} className="font-bold mb-2 leading-tight">
                  {survey.welcome_title || survey.name || 'Título de la encuesta'}
                </h2>
                <p className="mb-8 opacity-60" style={{ color: textColor }}>
                  {survey.welcome_description || 'Descripción de tu encuesta'}
                </p>
                <button
                  className={`inline-flex items-center gap-2 px-6 py-3 text-white font-semibold ${btnClass} transition-all`}
                  style={{ backgroundColor: accentColor }}
                >
                  Comenzar →
                </button>
              </div>
            </div>

            {/* Preview: simulated question */}
            <div className="border-t border-slate-100">
              <div className="h-1" style={{ backgroundColor: accentColor, width: '40%' }} />
              <div className={`p-8 ${questionAlign === 'center' ? 'text-center' : 'text-left'}`}>
                <p className="text-xs font-medium mb-3 opacity-40" style={{ color: textColor }}>1 / 3</p>
                <h3 style={{ fontSize: `calc(${titlePx} * 0.75)`, color: textColor, fontFamily: `'${fontFamily}', sans-serif` }} className="font-bold mb-4 leading-tight">
                  ¿Cuál es tu nombre?
                </h3>
                <div className="border-b-2 pb-2 mb-6" style={{ borderColor: accentColor + '40' }}>
                  <span className="text-sm opacity-30" style={{ color: textColor }}>Escribe tu respuesta...</span>
                </div>
                <button
                  className={`inline-flex items-center gap-2 px-5 py-2.5 text-white text-sm font-medium ${btnClass} transition-all`}
                  style={{ backgroundColor: accentColor }}
                >
                  Siguiente →
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Share Tab ──────────────────────────────────────────────────────────────

function ShareTab({ survey, publicUrl, slugInput, setSlugInput, slugAvailable, checkSlug, handleStatusChange, handleSaveSurvey, saving }: {
  survey: Survey; publicUrl: string; slugInput: string; setSlugInput: (s: string) => void;
  slugAvailable: boolean | null; checkSlug: (s: string) => void;
  handleStatusChange: (s: string) => void; handleSaveSurvey: () => void; saving: boolean;
}) {
  const immutableInstance = isImmutableSurveyApplication(survey);
  const programAudience = survey.audience_mode === 'program_participants';
  const availableStatuses = survey.status === 'draft' ? ['draft', 'active', 'closed'] : ['active', 'closed'];
  return (
    <div className="h-full overflow-auto p-4 sm:p-8">
      <div className="max-w-xl mx-auto space-y-6">
        {/* Status control */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h3 className="font-semibold text-slate-900 mb-3">Estado de la encuesta</h3>
          <div className="flex items-center gap-3">
            {availableStatuses.map((s) => {
              const cfg = STATUS_CONFIG[s];
              return (
                <button
                  key={s}
                  onClick={() => handleStatusChange(s)}
                  className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border-2 text-sm font-medium transition-all ${
                    survey.status === s ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-500 hover:border-slate-300'
                  }`}
                >
                  {cfg.icon} {cfg.label}
                </button>
              );
            })}
          </div>
          {survey.status !== 'active' && (
            <p className="text-xs text-amber-600 mt-3 bg-amber-50 px-3 py-2 rounded-lg">
              La encuesta debe estar activa para recibir respuestas.
            </p>
          )}
        </div>

        {programAudience ? (
          <div className="rounded-xl border border-emerald-200 bg-white p-5 sm:p-6">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700"><Users className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold text-slate-900">Enlaces individuales por participante</h3>
                <p className="mt-1 text-sm leading-6 text-slate-600">Esta aplicación está restringida a los participantes del programa. Cada persona tiene un enlace único; no existe un enlace o QR general.</p>
                <p className="mt-2 text-xs leading-5 text-slate-500">Administra y copia esos enlaces desde el programa, en Encuestas → Enlaces por participante.</p>
                {survey.program_id && (
                  <Link href={`/dashboard/programs/${survey.program_id}`} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700">
                    <ExternalLink className="h-4 w-4" /> Ir al programa
                  </Link>
                )}
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Public URL */}
            <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-6">
              <h3 className="font-semibold text-slate-900 mb-3">Enlace público</h3>
              <div className="flex items-center gap-2 bg-slate-50 rounded-lg p-3 mb-3">
                <span className="text-sm text-slate-400 flex-shrink-0">{typeof window !== 'undefined' ? window.location.origin : ''}/f/</span>
                <input
                  value={slugInput}
                  onChange={(e) => { setSlugInput(e.target.value); checkSlug(e.target.value); }}
                  disabled={immutableInstance}
                  aria-label={immutableInstance ? 'Enlace congelado en esta aplicación' : 'Identificador del enlace público'}
                  className="min-w-0 flex-1 bg-transparent text-sm font-medium text-slate-900 focus:outline-none disabled:cursor-not-allowed disabled:text-slate-500"
                />
                {slugAvailable !== null && (
                  slugAvailable
                    ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                    : <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                )}
              </div>
              {!immutableInstance && slugInput !== survey.slug && (
                <button onClick={handleSaveSurvey} disabled={saving || slugAvailable === false} className="text-sm text-emerald-600 hover:text-emerald-700 font-medium disabled:opacity-50">
                  {saving ? 'Guardando...' : 'Guardar nuevo slug'}
                </button>
              )}
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <button
                  onClick={() => navigator.clipboard.writeText(publicUrl)}
                  className="flex min-h-11 items-center gap-1.5 rounded-lg bg-slate-100 px-3 text-sm text-slate-700 transition-colors hover:bg-slate-200"
                >
                  <Copy className="w-3.5 h-3.5" /> Copiar enlace
                </button>
                {survey.status === 'active' && (
                  <a href={`/f/${survey.slug}`} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm text-white transition-colors hover:bg-emerald-700">
                    <ExternalLink className="w-3.5 h-3.5" /> Abrir
                  </a>
                )}
              </div>
            </div>

            {/* QR Code */}
            <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-6">
              <h3 className="font-semibold text-slate-900 mb-3">Código QR</h3>
              <p className="text-sm text-slate-500 mb-4">Escanea este código para abrir la encuesta directamente.</p>
              <div className="flex flex-col items-center gap-4">
                <div className="max-w-full bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                  <QRCodeSVG value={publicUrl} size={200} level="M" className="h-auto max-w-full" />
                </div>
                <button
                  onClick={() => {
                    const svg = document.querySelector('.qr-download-area svg');
                    if (!svg) return;
                    const svgData = new XMLSerializer().serializeToString(svg);
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    const img = new Image();
                    img.onload = () => {
                      canvas.width = img.width * 2;
                      canvas.height = img.height * 2;
                      if (ctx) {
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                      }
                      const a = document.createElement('a');
                      a.download = `qr-${survey.slug}.png`;
                      a.href = canvas.toDataURL('image/png');
                      a.click();
                    };
                    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
                  }}
                  className="flex min-h-11 items-center gap-1.5 rounded-lg bg-slate-100 px-3 text-sm text-slate-700 transition-colors hover:bg-slate-200"
                >
                  <Download className="w-3.5 h-3.5" /> Descargar PNG
                </button>
              </div>
              <div className="qr-download-area hidden">
                <QRCodeSVG value={publicUrl} size={400} level="M" />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Analytics Tab ──────────────────────────────────────────────────────────

const CHART_COLORS = ['#10b981', '#34d399', '#6ee7b7', '#059669', '#047857', '#0d9488', '#14b8a6', '#2dd4bf', '#a7f3d0', '#d1fae5'];

type ChartType = 'bar' | 'pie' | 'radar';

function QuestionChart({ stat, chartType }: { stat: { question_id: string; question_type: string; title: string; total_answers: number; option_counts?: Record<string, number>; average?: number; distribution?: Record<string, number> }; chartType: ChartType }) {
  const data = stat.option_counts ?? stat.distribution ?? {};
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;

  if (chartType === 'bar') {
    const barData = entries.map(([label, value]) => ({ label: label.length > 20 ? label.substring(0, 18) + '…' : label, value, fullLabel: label }));
    return (
      <div style={{ height: 280 }}>
        <ResponsiveBar
          data={barData}
          keys={['value']}
          indexBy="label"
          margin={{ top: 10, right: 20, bottom: 60, left: 50 }}
          padding={0.3}
          colors={CHART_COLORS}
          colorBy="indexValue"
          borderRadius={4}
          axisBottom={{ tickSize: 0, tickPadding: 8, tickRotation: entries.length > 5 ? -35 : 0 }}
          axisLeft={{ tickSize: 0, tickPadding: 8 }}
          labelSkipWidth={20}
          labelSkipHeight={20}
          labelTextColor="#fff"
          tooltip={({ data: d, value }) => (
            <div className="bg-slate-800 text-white text-xs px-3 py-2 rounded-lg shadow-lg">
              <strong>{d.fullLabel as string}</strong>: {value} ({stat.total_answers > 0 ? ((value / stat.total_answers) * 100).toFixed(1) : 0}%)
            </div>
          )}
          theme={{ axis: { ticks: { text: { fontSize: 11, fill: '#64748b' } } }, labels: { text: { fontSize: 12, fontWeight: 600 } } }}
          animate={true}
          motionConfig="gentle"
        />
      </div>
    );
  }

  if (chartType === 'pie') {
    const pieData = entries.map(([label, value], i) => ({ id: label, label: label.length > 25 ? label.substring(0, 23) + '…' : label, value, color: CHART_COLORS[i % CHART_COLORS.length] }));
    return (
      <div style={{ height: 300 }}>
        <ResponsivePie
          data={pieData}
          margin={{ top: 20, right: 100, bottom: 20, left: 100 }}
          innerRadius={0.4}
          padAngle={1.5}
          cornerRadius={4}
          activeOuterRadiusOffset={6}
          colors={{ datum: 'data.color' }}
          borderWidth={0}
          arcLinkLabelsSkipAngle={10}
          arcLinkLabelsTextColor="#64748b"
          arcLinkLabelsThickness={1.5}
          arcLinkLabelsColor={{ from: 'color' }}
          arcLabelsSkipAngle={10}
          arcLabelsTextColor="#fff"
          tooltip={({ datum }) => (
            <div className="bg-slate-800 text-white text-xs px-3 py-2 rounded-lg shadow-lg">
              <strong>{datum.id}</strong>: {datum.value} ({stat.total_answers > 0 ? ((datum.value / stat.total_answers) * 100).toFixed(1) : 0}%)
            </div>
          )}
          animate={true}
          motionConfig="gentle"
        />
      </div>
    );
  }

  // Radar
  const radarData = entries.map(([label]) => {
    const item: Record<string, string | number> = { option: label.length > 15 ? label.substring(0, 13) + '…' : label };
    item.value = data[label];
    return item;
  });
  return (
    <div style={{ height: 300 }}>
      <ResponsiveRadar
        data={radarData}
        keys={['value']}
        indexBy="option"
        maxValue="auto"
        margin={{ top: 30, right: 60, bottom: 30, left: 60 }}
        curve="linearClosed"
        borderWidth={2}
        borderColor="#10b981"
        gridLevels={4}
        gridShape="circular"
        dotSize={8}
        dotColor="#10b981"
        dotBorderWidth={2}
        dotBorderColor="#fff"
        colors={['#10b981']}
        fillOpacity={0.25}
        blendMode="normal"
        animate={true}
        motionConfig="gentle"
        sliceTooltip={({ index, data: sliceData }) => (
          <div className="bg-slate-800 text-white text-xs px-3 py-2 rounded-lg shadow-lg">
            <strong>{entries.find(e => (e[0].length > 15 ? e[0].substring(0, 13) + '…' : e[0]) === index)?.[0] ?? index}</strong>: {sliceData[0]?.value ?? 0}
          </div>
        )}
        theme={{ axis: { ticks: { text: { fontSize: 10, fill: '#64748b' } } } }}
      />
    </div>
  );
}

function AnalyticsTab({ analytics, responses, responsesTotal, programAudience, loading, selectedResponse, setSelectedResponse, handleViewResponse, handleExportCSV, questions, responsePage, handleResponsePageChange }: {
  analytics: SurveyAnalytics | null; responses: SurveyResponse[]; responsesTotal: number;
  programAudience: boolean;
  loading: boolean; selectedResponse: SurveyResponse | null; setSelectedResponse: (r: SurveyResponse | null) => void;
  handleViewResponse: (rid: string) => void; handleExportCSV: () => void; questions: SurveyQuestion[];
  responsePage: number; handleResponsePageChange: (page: number) => void;
}) {
  const [chartTypes, setChartTypes] = useState<Record<string, ChartType>>({});

  if (loading) {
    return <div className="h-full flex items-center justify-center"><Loader2 className="w-6 h-6 text-emerald-600 animate-spin" /></div>;
  }

  const qMap = new Map(questions.map(q => [q.id, q]));

  const setChartType = (qid: string, type: ChartType) => {
    setChartTypes(prev => ({ ...prev, [qid]: type }));
  };

  return (
    <div className="h-full overflow-auto p-3 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Summary cards */}
        {analytics && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="flex items-center gap-2 text-slate-500 mb-2">
                <Users className="w-4 h-4" />
                <span className="text-xs font-medium uppercase">Respuestas</span>
              </div>
              <p className="text-2xl font-bold text-slate-900">{analytics.total_responses}</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="flex items-center gap-2 text-slate-500 mb-2">
                <TrendingUp className="w-4 h-4" />
                <span className="text-xs font-medium uppercase">Tasa de completado</span>
              </div>
              <p className="text-2xl font-bold text-slate-900">{analytics.completion_rate.toFixed(1)}%</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="flex items-center gap-2 text-slate-500 mb-2">
                <Clock className="w-4 h-4" />
                <span className="text-xs font-medium uppercase">Tiempo promedio</span>
              </div>
              <p className="text-2xl font-bold text-slate-900">
                {analytics.avg_completion_seconds < 60
                  ? `${Math.round(analytics.avg_completion_seconds)}s`
                  : `${Math.round(analytics.avg_completion_seconds / 60)}m ${Math.round(analytics.avg_completion_seconds % 60)}s`}
              </p>
            </div>
          </div>
        )}

        {/* Per-question stats */}
        {analytics && analytics.question_stats.length > 0 && (
          <div className="space-y-4">
            <h3 className="font-semibold text-slate-900">Resultados por pregunta</h3>
            {analytics.question_stats.map((stat, i) => {
              const hasOptions = stat.option_counts && Object.keys(stat.option_counts).length > 0;
              const hasDistribution = stat.distribution && Object.keys(stat.distribution).length > 0;
              const hasChart = hasOptions || hasDistribution;
              const ct = chartTypes[stat.question_id] || 'bar';

              return (
                <div key={stat.question_id} className="bg-white rounded-xl border border-slate-200 p-6">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="w-6 h-6 rounded bg-emerald-50 flex items-center justify-center text-xs font-bold text-emerald-600">{i + 1}</span>
                      <h4 className="text-sm font-medium text-slate-800">{stat.title}</h4>
                      <span className="text-xs text-slate-400">({stat.total_answers} respuestas)</span>
                    </div>
                    {hasChart && (
                      <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
                        <button
                          onClick={() => setChartType(stat.question_id, 'bar')}
                          className={`p-1.5 rounded-md transition ${ct === 'bar' ? 'bg-white shadow text-emerald-600' : 'text-slate-400 hover:text-slate-600'}`}
                          title="Barras"
                        >
                          <BarChart3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setChartType(stat.question_id, 'pie')}
                          className={`p-1.5 rounded-md transition ${ct === 'pie' ? 'bg-white shadow text-emerald-600' : 'text-slate-400 hover:text-slate-600'}`}
                          title="Circular"
                        >
                          <PieChart className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setChartType(stat.question_id, 'radar')}
                          className={`p-1.5 rounded-md transition ${ct === 'radar' ? 'bg-white shadow text-emerald-600' : 'text-slate-400 hover:text-slate-600'}`}
                          title="Radar"
                        >
                          <Radar className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Rating/Likert average badge */}
                  {stat.average !== undefined && stat.average !== null && (
                    <div className="flex items-center gap-2 mb-3">
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-50 rounded-full text-sm font-semibold text-emerald-700">
                        <Star className="w-3.5 h-3.5" /> {stat.average.toFixed(1)}
                      </span>
                      <span className="text-xs text-slate-400">promedio</span>
                    </div>
                  )}

                  {/* Chart */}
                  {hasChart && <QuestionChart stat={stat} chartType={ct} />}

                  {/* Text-based questions without options */}
                  {!hasChart && stat.total_answers > 0 && (
                    <p className="text-sm text-slate-500 ml-8">{stat.total_answers} respuestas de texto libre</p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Responses list */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold text-slate-900">Respuestas individuales ({responsesTotal})</h3>
            <button onClick={handleExportCSV} className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 rounded-lg text-sm text-slate-700 hover:bg-slate-200 transition-colors">
              <Download className="w-3.5 h-3.5" /> Exportar CSV
            </button>
          </div>
          {responses.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">No hay respuestas aún</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {responses.map((r) => (
                <div key={r.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-700">
                      {programAudience ? (r.contact_name || 'Participante sin identidad disponible') : 'Respuesta anónima'}
                    </p>
                    {programAudience && r.contact_phone && <p className="truncate text-xs text-slate-500">{r.contact_phone}</p>}
                    <p className="text-xs text-slate-400">
                      {r.completed_at && format(new Date(r.completed_at), "d MMM yyyy HH:mm", { locale: es })}
                      {r.source && <span className="ml-2 text-slate-300">via {r.source}</span>}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                    <button
                      onClick={() => handleViewResponse(r.id)}
                      className="text-xs text-emerald-600 hover:text-emerald-700 font-medium"
                    >
                      Ver detalle
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* Pagination */}
          {responsesTotal > 50 && (
            <div className="flex items-center justify-between pt-4 mt-4 border-t border-slate-100">
              <p className="text-xs text-slate-400">
                Mostrando {responsePage * 50 + 1}-{Math.min((responsePage + 1) * 50, responsesTotal)} de {responsesTotal}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleResponsePageChange(responsePage - 1)}
                  disabled={responsePage === 0}
                  className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Anterior
                </button>
                <span className="text-xs text-slate-500">
                  Página {responsePage + 1} de {Math.ceil(responsesTotal / 50)}
                </span>
                <button
                  onClick={() => handleResponsePageChange(responsePage + 1)}
                  disabled={(responsePage + 1) * 50 >= responsesTotal}
                  className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Response detail modal */}
      {selectedResponse && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setSelectedResponse(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold text-slate-900">Detalle de respuesta</h3>
                <button onClick={() => setSelectedResponse(null)} className="p-1 rounded-lg hover:bg-slate-100 text-slate-400">
                  <XCircle className="w-5 h-5" />
                </button>
              </div>
              <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-sm font-semibold text-slate-800">
                  {programAudience ? (selectedResponse.contact_name || 'Participante sin identidad disponible') : 'Respuesta anónima'}
                </p>
                {programAudience && selectedResponse.contact_phone && <p className="mt-0.5 text-xs text-slate-500">{selectedResponse.contact_phone}</p>}
                {selectedResponse.completed_at && <p className="mt-1 text-xs text-slate-400">Respondida {format(new Date(selectedResponse.completed_at), "d MMM yyyy HH:mm", { locale: es })}</p>}
              </div>
              <div className="space-y-3">
                {selectedResponse.answers?.map((a) => {
                  const q = qMap.get(a.question_id);
                  return (
                    <div key={a.id} className="bg-slate-50 rounded-lg p-3">
                      <p className="text-xs font-medium text-slate-500 mb-1">{q?.title || 'Pregunta eliminada'}</p>
                      <p className="text-sm text-slate-800">{a.file_url ? <a href={a.file_url} target="_blank" rel="noopener noreferrer" className="text-emerald-600 underline">Ver archivo</a> : a.value || <span className="text-slate-300">Sin respuesta</span>}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
