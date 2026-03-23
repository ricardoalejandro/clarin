"use client";

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Survey, SurveyQuestion, SurveyQuestionConfig, SurveyLogicRule, SurveyAnalytics, SurveyResponse, SurveyBranding, QUESTION_TYPE_LABELS, QuestionType, FONT_OPTIONS, TITLE_SIZE_OPTIONS, BUTTON_STYLE_OPTIONS } from '@/types/survey';
import {
  ArrowLeft, Save, Plus, Trash2, GripVertical, Eye, Share2, BarChart3,
  Type, AlignLeft, CircleDot, CheckSquare, Star, SlidersHorizontal,
  Calendar, Mail, Phone, Paperclip, ChevronDown, ChevronUp, Copy,
  ExternalLink, CheckCircle2, XCircle, PenLine, Settings2, Loader2,
  Download, FileText, Hash, Clock, TrendingUp, Users, Palette, PieChart, Radar
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

export default function SurveyBuilderPage() {
  const params = useParams();
  const router = useRouter();
  const surveyId = params.id as string;

  const [survey, setSurvey] = useState<Survey | null>(null);
  const [questions, setQuestions] = useState<SurveyQuestion[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('builder');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedQ, setSelectedQ] = useState<number>(0);
  const [hasChanges, setHasChanges] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Share tab
  const [slugInput, setSlugInput] = useState('');
  const [slugAvailable, setSlugAvailable] = useState<boolean | null>(null);

  // Analytics tab
  const [analytics, setAnalytics] = useState<SurveyAnalytics | null>(null);
  const [responses, setResponses] = useState<SurveyResponse[]>([]);
  const [responsesTotal, setResponsesTotal] = useState(0);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);
  const [selectedResponse, setSelectedResponse] = useState<SurveyResponse | null>(null);
  const [responsePage, setResponsePage] = useState(0);
  const [deletingResponse, setDeletingResponse] = useState<string | null>(null);

  // Settings panel
  const [showSettings, setShowSettings] = useState(false);
  const [surveyForm, setSurveyForm] = useState({
    name: '', description: '', welcome_title: '', welcome_description: '',
    thank_you_title: '', thank_you_message: '', thank_you_redirect_url: '',
  });

  useEffect(() => {
    fetchSurvey();
  }, [surveyId]);

  useEffect(() => {
    if (activeTab === 'analytics') {
      fetchAnalytics();
      fetchResponses();
    }
  }, [activeTab]);

  const fetchSurvey = async () => {
    try {
      setLoading(true);
      const [surveyRes, questionsRes] = await Promise.all([
        api<Survey>(`/api/surveys/${surveyId}`),
        api<SurveyQuestion[]>(`/api/surveys/${surveyId}/questions`),
      ]);
      if (surveyRes.success && surveyRes.data) {
        setSurvey(surveyRes.data);
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
      }
      if (questionsRes.success) {
        setQuestions(questionsRes.data || []);
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchAnalytics = async () => {
    setLoadingAnalytics(true);
    try {
      const res = await api<SurveyAnalytics>(`/api/surveys/${surveyId}/analytics`);
      if (res.success) setAnalytics(res.data || null);
    } finally {
      setLoadingAnalytics(false);
    }
  };

  const fetchResponses = async (page = responsePage) => {
    const res = await api<{ responses: SurveyResponse[]; total: number }>(`/api/surveys/${surveyId}/responses?limit=50&offset=${page * 50}`);
    if (res.success && res.data) {
      setResponses(res.data.responses || []);
      setResponsesTotal(res.data.total);
    }
  };

  const handleDeleteResponse = async (rid: string) => {
    try {
      const res = await api(`/api/surveys/${surveyId}/responses/${rid}`, { method: 'DELETE' });
      if (res.success) {
        setDeletingResponse(null);
        fetchResponses(responsePage);
        fetchAnalytics();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleResponsePageChange = (newPage: number) => {
    setResponsePage(newPage);
    fetchResponses(newPage);
  };

  const handleSaveQuestions = async () => {
    setSaveMessage(null);
    // Client-side validation
    const emptyIdx = questions.findIndex(q => !q.title.trim());
    if (emptyIdx >= 0) {
      setSelectedQ(emptyIdx);
      setSaveMessage({ type: 'error', text: `La pregunta ${emptyIdx + 1} necesita un título` });
      return;
    }
    setSaving(true);
    try {
      const payload = questions.map((q, i) => ({
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
      fetchSurvey();
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

  const handleViewResponse = async (rid: string) => {
    const res = await api<SurveyResponse>(`/api/surveys/${surveyId}/responses/${rid}`);
    if (res.success && res.data) setSelectedResponse(res.data);
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-emerald-600 animate-spin" />
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

  return (
    <div className="h-full flex flex-col bg-slate-50">
      {/* Top bar */}
      <div className="flex-shrink-0 bg-white border-b border-slate-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/dashboard/surveys')} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="font-semibold text-slate-900 text-sm">{survey.name}</h1>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusCfg.bg} ${statusCfg.text}`}>
                {statusCfg.icon} {statusCfg.label}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Tab buttons */}
            <div className="flex items-center bg-slate-100 rounded-lg p-0.5 mr-2">
              {([['builder', PenLine, 'Editor'], ['design', Palette, 'Diseño'], ['share', Share2, 'Compartir'], ['analytics', BarChart3, 'Analíticas']] as [Tab, React.ElementType, string][]).map(([tab, Icon, label]) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    activeTab === tab ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" /> {label}
                </button>
              ))}
            </div>
            <button onClick={() => setShowSettings(true)} className="p-2 rounded-lg hover:bg-slate-100 text-slate-500">
              <Settings2 className="w-4 h-4" />
            </button>
            {activeTab === 'builder' && (
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
        {activeTab === 'builder' && <BuilderTab questions={questions} selectedQ={selectedQ} setSelectedQ={setSelectedQ} addQuestion={addQuestion} removeQuestion={removeQuestion} updateQuestion={updateQuestion} moveQuestion={moveQuestion} allQuestions={questions} />}
        {activeTab === 'design' && <DesignTab survey={survey} onSave={(branding) => handleSaveBranding(branding)} saving={saving} />}
        {activeTab === 'share' && <ShareTab survey={survey} publicUrl={publicUrl} slugInput={slugInput} setSlugInput={setSlugInput} slugAvailable={slugAvailable} checkSlug={checkSlug} handleStatusChange={handleStatusChange} handleSaveSurvey={handleSaveSurvey} saving={saving} />}
        {activeTab === 'analytics' && <AnalyticsTab analytics={analytics} responses={responses} responsesTotal={responsesTotal} loading={loadingAnalytics} selectedResponse={selectedResponse} setSelectedResponse={setSelectedResponse} handleViewResponse={handleViewResponse} handleExportCSV={handleExportCSV} questions={questions} deletingResponse={deletingResponse} setDeletingResponse={setDeletingResponse} handleDeleteResponse={handleDeleteResponse} responsePage={responsePage} handleResponsePageChange={handleResponsePageChange} />}
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
    <div className="h-full flex">
      {/* Question list sidebar */}
      <div className="w-72 bg-white border-r border-slate-200 flex flex-col">
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
        <div className="flex-1 overflow-auto p-2 space-y-1">
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
                className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-left text-sm transition-colors ${
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
      <div className="flex-1 overflow-auto p-8">
        {current ? (
          <div className="max-w-2xl mx-auto">
            {/* Question header */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
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

            <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
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
          <div className="grid grid-cols-2 gap-3">
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
  const otherQuestions = allQuestions.filter((_, i) => i !== idx);
  const hasOptions = question.type === 'single_choice' || question.type === 'multiple_choice';
  const options = hasOptions ? (question.config.options || []) : [];

  const addRule = () => {
    updateQuestion(idx, { logic_rules: [...rules, { value: hasOptions && options.length > 0 ? options[0] : '', operator: 'eq', jump_to: otherQuestions[0]?.id || '' }] });
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
        <button onClick={addRule} className="text-xs text-emerald-600 hover:text-emerald-700 font-medium">+ Regla</button>
      </div>
      {rules.length === 0 ? (
        <p className="text-xs text-slate-400">No hay reglas. Las respuestas seguirán el orden normal.</p>
      ) : (
        <div className="space-y-2">
          {rules.map((rule, ri) => (
            <div key={ri} className="flex items-center gap-2 p-2 bg-slate-50 rounded-lg text-xs">
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
              <select value={rule.jump_to} onChange={(e) => updateRule(ri, { jump_to: e.target.value })} className="flex-1 px-2 py-1 border border-slate-200 rounded text-xs bg-white">
                {otherQuestions.map((q, qi) => (
                  <option key={q.id} value={q.id}>{qi + 1}. {q.title || 'Sin título'}</option>
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
      <div className="flex h-full">
        {/* Controls panel */}
        <div className="w-80 bg-white border-r border-slate-200 overflow-y-auto p-5 space-y-6 flex-shrink-0">
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
        <div className="flex-1 overflow-auto flex items-center justify-center p-8" style={{ backgroundColor: '#f1f5f9' }}>
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
  return (
    <div className="h-full overflow-auto p-8">
      <div className="max-w-xl mx-auto space-y-6">
        {/* Status control */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h3 className="font-semibold text-slate-900 mb-3">Estado de la encuesta</h3>
          <div className="flex items-center gap-3">
            {['draft', 'active', 'closed'].map((s) => {
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

        {/* Public URL */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h3 className="font-semibold text-slate-900 mb-3">Enlace público</h3>
          <div className="flex items-center gap-2 bg-slate-50 rounded-lg p-3 mb-3">
            <span className="text-sm text-slate-400 flex-shrink-0">{typeof window !== 'undefined' ? window.location.origin : ''}/f/</span>
            <input
              value={slugInput}
              onChange={(e) => { setSlugInput(e.target.value); checkSlug(e.target.value); }}
              className="flex-1 bg-transparent text-sm font-medium text-slate-900 focus:outline-none"
            />
            {slugAvailable !== null && (
              slugAvailable
                ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                : <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
            )}
          </div>
          {slugInput !== survey.slug && (
            <button onClick={handleSaveSurvey} disabled={saving || slugAvailable === false} className="text-sm text-emerald-600 hover:text-emerald-700 font-medium disabled:opacity-50">
              {saving ? 'Guardando...' : 'Guardar nuevo slug'}
            </button>
          )}
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={() => navigator.clipboard.writeText(publicUrl)}
              className="flex items-center gap-1.5 px-3 py-2 bg-slate-100 rounded-lg text-sm text-slate-700 hover:bg-slate-200 transition-colors"
            >
              <Copy className="w-3.5 h-3.5" /> Copiar enlace
            </button>
            {survey.status === 'active' && (
              <a href={`/f/${survey.slug}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 text-white rounded-lg text-sm hover:bg-emerald-700 transition-colors">
                <ExternalLink className="w-3.5 h-3.5" /> Abrir
              </a>
            )}
          </div>
        </div>

        {/* QR Code */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h3 className="font-semibold text-slate-900 mb-3">Código QR</h3>
          <p className="text-sm text-slate-500 mb-4">Escanea este código para abrir la encuesta directamente.</p>
          <div className="flex flex-col items-center gap-4">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <QRCodeSVG value={publicUrl} size={200} level="M" />
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
              className="flex items-center gap-1.5 px-3 py-2 bg-slate-100 rounded-lg text-sm text-slate-700 hover:bg-slate-200 transition-colors"
            >
              <Download className="w-3.5 h-3.5" /> Descargar PNG
            </button>
          </div>
          <div className="qr-download-area hidden">
            <QRCodeSVG value={publicUrl} size={400} level="M" />
          </div>
        </div>
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

function AnalyticsTab({ analytics, responses, responsesTotal, loading, selectedResponse, setSelectedResponse, handleViewResponse, handleExportCSV, questions, deletingResponse, setDeletingResponse, handleDeleteResponse, responsePage, handleResponsePageChange }: {
  analytics: SurveyAnalytics | null; responses: SurveyResponse[]; responsesTotal: number;
  loading: boolean; selectedResponse: SurveyResponse | null; setSelectedResponse: (r: SurveyResponse | null) => void;
  handleViewResponse: (rid: string) => void; handleExportCSV: () => void; questions: SurveyQuestion[];
  deletingResponse: string | null; setDeletingResponse: (id: string | null) => void; handleDeleteResponse: (rid: string) => void;
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
    <div className="h-full overflow-auto p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Summary cards */}
        {analytics && (
          <div className="grid grid-cols-3 gap-4">
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
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
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
                <div key={r.id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="text-sm text-slate-700 font-mono">{r.respondent_token.substring(0, 12)}...</p>
                    <p className="text-xs text-slate-400">
                      {r.completed_at && format(new Date(r.completed_at), "d MMM yyyy HH:mm", { locale: es })}
                      {r.source && <span className="ml-2 text-slate-300">via {r.source}</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleViewResponse(r.id)}
                      className="text-xs text-emerald-600 hover:text-emerald-700 font-medium"
                    >
                      Ver detalle
                    </button>
                    {deletingResponse === r.id ? (
                      <div className="flex items-center gap-1">
                        <button onClick={() => handleDeleteResponse(r.id)} className="text-xs text-red-600 hover:text-red-700 font-medium px-2 py-1 bg-red-50 rounded">Confirmar</button>
                        <button onClick={() => setDeletingResponse(null)} className="text-xs text-slate-500 hover:text-slate-700 font-medium px-2 py-1">Cancelar</button>
                      </div>
                    ) : (
                      <button onClick={() => setDeletingResponse(r.id)} className="p-1 text-slate-300 hover:text-red-500 transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
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
