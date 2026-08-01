"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import {
  ChevronDown, ChevronUp, Check, Star, Upload, Loader2,
  ArrowRight, AlertCircle
} from 'lucide-react';
import { buildSurveySessionEvent, surveySessionStorageKey, type SurveySessionPhase } from '@/lib/surveySession';

interface SurveyBranding {
  logo_url?: string;
  logo_size?: 'sm' | 'md' | 'lg';
  bg_color?: string;
  accent_color?: string;
  bg_image_url?: string;
  bg_position?: 'top' | 'center' | 'bottom';
  font_family?: string;
  title_size?: string;
  text_color?: string;
  button_style?: string;
  bg_overlay?: string;
  question_align?: string;
}

interface SurveyData {
  id: string; name: string; description: string; slug: string; status: string;
  welcome_title: string; welcome_description: string;
  thank_you_title: string; thank_you_message: string; thank_you_redirect_url: string;
  branding: SurveyBranding;
}

interface QuestionConfig {
  options?: string[]; max_rating?: number; likert_scale?: number;
  likert_min?: string; likert_max?: string; placeholder?: string; max_size_mb?: number;
}

interface LogicRule {
  value: string; operator?: string; jump_to: string;
}

interface Question {
  id: string; type: string; title: string; description: string;
  required: boolean; config: QuestionConfig; logic_rules: LogicRule[];
}

function safeSurveyRedirect(raw: string): string {
  try {
    const target = new URL(raw);
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || !target.hostname || target.username || target.password) {
      return '';
    }
    return target.href;
  } catch {
    return '';
  }
}

export default function PublicFormPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const slug = params.slug as string;
  const recipientToken = searchParams.get('recipient') || '';

  const [survey, setSurvey] = useState<SurveyData | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // -1 = welcome, 0..n-1 = questions, n = thank you
  const [step, setStep] = useState(-1);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const [fileUploadIds, setFileUploadIds] = useState<Record<string, string>>({});
  const [navigationHistory, setNavigationHistory] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const flowEpochRef = useRef(0);
  const submitInFlightRef = useRef(false);
  const submitAbortRef = useRef<AbortController | null>(null);
  const startedAtRef = useRef('');
  const respondentTokenRef = useRef('');
  const sessionStartedRef = useRef(false);
  const telemetryControllersRef = useRef<Set<AbortController>>(new Set());

  const trackSession = useCallback((phase: SurveySessionPhase, questionId?: string) => {
    const respondentToken = respondentTokenRef.current;
    if (!respondentToken) return;
    const controller = new AbortController();
    telemetryControllersRef.current.add(controller);
    void fetch(`/api/public/surveys/${encodeURIComponent(slug)}/session`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify(buildSurveySessionEvent(respondentToken, recipientToken, phase, questionId)),
    }).catch(() => undefined).finally(() => telemetryControllersRef.current.delete(controller));
  }, [recipientToken, slug]);

  const ensureSessionStarted = useCallback(() => {
    if (sessionStartedRef.current) return;
    sessionStartedRef.current = true;
    trackSession('started');
  }, [trackSession]);

  useEffect(() => {
    const epoch = flowEpochRef.current + 1;
    flowEpochRef.current = epoch;
    const controller = new AbortController();
    submitAbortRef.current?.abort();
    submitAbortRef.current = null;
    submitInFlightRef.current = false;

    setSurvey(null);
    setQuestions([]);
    setLoading(true);
    setError('');
    setStep(-1);
    setAnswers({});
    setFileUrls({});
    setFileUploadIds({});
    setNavigationHistory([]);
    setSubmitting(false);
    setSubmitted(false);
    setValidationError('');
    setUploading(false);
    setCloseBlocked(false);
    startedAtRef.current = new Date().toISOString();
    sessionStartedRef.current = false;
    const storageKey = surveySessionStorageKey(slug, recipientToken);
    respondentTokenRef.current = crypto.randomUUID();
    try {
      const storedToken = window.sessionStorage.getItem(storageKey);
      respondentTokenRef.current = storedToken || respondentTokenRef.current;
      if (!storedToken) window.sessionStorage.setItem(storageKey, respondentTokenRef.current);
    } catch {
      // Storage can be unavailable in strict privacy contexts. Tracking remains
      // best-effort and must never prevent the survey itself from loading.
    }

    const loadSurvey = async () => {
      try {
        const query = recipientToken ? `?recipient=${encodeURIComponent(recipientToken)}` : '';
        const res = await fetch(`/api/public/surveys/${encodeURIComponent(slug)}${query}`, { signal: controller.signal });
        if (controller.signal.aborted || flowEpochRef.current !== epoch) return;
        if (!res.ok) {
          setError('Encuesta no encontrada o no está activa.');
          return;
        }
        const data = await res.json();
        if (controller.signal.aborted || flowEpochRef.current !== epoch) return;
        setSurvey(data.survey);
        setQuestions(data.questions || []);
        setStep(data.survey.welcome_title || data.survey.welcome_description ? -1 : 0);
        trackSession('opened');
      } catch (loadError) {
        if (controller.signal.aborted || flowEpochRef.current !== epoch) return;
        setError(loadError instanceof Error ? 'Error al cargar la encuesta.' : 'Error al cargar la encuesta.');
      } finally {
        if (!controller.signal.aborted && flowEpochRef.current === epoch) setLoading(false);
      }
    };
    void loadSurvey();

    return () => {
      if (flowEpochRef.current === epoch) flowEpochRef.current += 1;
      controller.abort();
      submitAbortRef.current?.abort();
      telemetryControllersRef.current.forEach(activeController => activeController.abort());
      telemetryControllersRef.current.clear();
    };
  }, [slug, recipientToken, trackSession]);

  const currentQuestion = step >= 0 && step < questions.length ? questions[step] : null;

  useEffect(() => {
    if (currentQuestion) trackSession('reached', currentQuestion.id);
  }, [currentQuestion, trackSession]);

  const evaluateLogic = useCallback((q: Question, value: string): number | null => {
    if (!q.logic_rules || q.logic_rules.length === 0) return null;
    for (const rule of q.logic_rules) {
      let match = false;
      const op = rule.operator || 'eq';
      if (op === 'eq') match = value === rule.value;
      else if (op === 'neq') match = value !== rule.value;
      else if (op === 'contains') match = value.includes(rule.value);
      else if (op === 'gt') match = parseFloat(value) > parseFloat(rule.value);
      else if (op === 'lt') match = parseFloat(value) < parseFloat(rule.value);

      if (match) {
        const jumpIdx = questions.findIndex(qq => qq.id === rule.jump_to);
        const sourceIdx = questions.findIndex(qq => qq.id === q.id);
        if (jumpIdx > sourceIdx) return jumpIdx;
      }
    }
    return null;
  }, [questions]);

  const submitResponses = useCallback(async () => {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    setValidationError('');
    const epoch = flowEpochRef.current;
    const controller = new AbortController();
    submitAbortRef.current?.abort();
    submitAbortRef.current = controller;
    try {
      const reachableQuestionIDs = new Set<string>();
      for (let index = 0; index < questions.length;) {
        const question = questions[index];
        reachableQuestionIDs.add(question.id);
        const jumpIndex = evaluateLogic(question, answers[question.id] || '');
        index = jumpIndex !== null && jumpIndex > index ? jumpIndex : index + 1;
      }
      const answersList = questions
        .filter(q => reachableQuestionIDs.has(q.id) && (answers[q.id] || fileUploadIds[q.id]))
        .map(q => ({
          question_id: q.id,
          value: answers[q.id] || '',
          upload_id: fileUploadIds[q.id] || undefined,
        }));

      const res = await fetch(`/api/public/surveys/${encodeURIComponent(slug)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          respondent_token: respondentTokenRef.current,
          recipient_token: recipientToken,
          source: 'direct',
          started_at: startedAtRef.current,
          answers: answersList,
        }),
      });
      if (controller.signal.aborted || flowEpochRef.current !== epoch) return;

      if (res.ok) {
        setSubmitted(true);
        return;
      }
      const payload = await res.json().catch(() => ({}));
      if (flowEpochRef.current === epoch) {
        setValidationError(typeof payload.error === 'string' ? payload.error : 'No se pudo enviar la encuesta.');
      }
    } catch (submitError) {
      if (!controller.signal.aborted && flowEpochRef.current === epoch) {
        setValidationError('Error al enviar respuestas. Intenta nuevamente.');
      }
    } finally {
      if (flowEpochRef.current === epoch) {
        submitInFlightRef.current = false;
        setSubmitting(false);
      }
      if (submitAbortRef.current === controller) submitAbortRef.current = null;
    }
  }, [answers, evaluateLogic, fileUploadIds, questions, recipientToken, slug, survey?.thank_you_redirect_url]);

  const goNext = useCallback(async () => {
    if (submitInFlightRef.current || submitting || uploading) return;
    ensureSessionStarted();
    setValidationError('');

    // Validate current question
    if (currentQuestion && currentQuestion.required) {
      const val = answers[currentQuestion.id] || '';
      if (!val && !fileUrls[currentQuestion.id]) {
        setValidationError('Esta pregunta es obligatoria');
        return;
      }
    }

    if (step === -1) {
      // Welcome → first question
      setNavigationHistory(current => [...current, -1]);
      setStep(0);
      return;
    }

    if (currentQuestion) {
      if (answers[currentQuestion.id] || fileUploadIds[currentQuestion.id]) trackSession('answered', currentQuestion.id);
      // Check logic rules
      const jumpIdx = evaluateLogic(currentQuestion, answers[currentQuestion.id] || '');
      if (jumpIdx !== null) {
        if (jumpIdx >= questions.length) {
          await submitResponses();
        } else {
          setNavigationHistory(current => [...current, step]);
          setStep(jumpIdx);
        }
        return;
      }
    }

    if (step < questions.length - 1) {
      setNavigationHistory(current => [...current, step]);
      setStep(step + 1);
    } else {
      await submitResponses();
    }
  }, [step, currentQuestion, answers, fileUrls, fileUploadIds, questions, evaluateLogic, submitResponses, submitting, uploading, ensureSessionStarted, trackSession]);

  const goPrev = () => {
    if (submitInFlightRef.current || submitting || uploading) return;
    setValidationError('');
    if (navigationHistory.length === 0) return;
    setStep(navigationHistory[navigationHistory.length - 1]);
    setNavigationHistory(navigationHistory.slice(0, -1));
  };

  const handleFileUpload = async (questionId: string, file: File) => {
    ensureSessionStarted();
	const epoch = flowEpochRef.current;
    setUploading(true);
	setValidationError('');
    try {
      const form = new FormData();
      form.append('file', file);
	  form.append('question_id', questionId);
	  form.append('respondent_token', respondentTokenRef.current);
      const query = recipientToken ? `?recipient=${encodeURIComponent(recipientToken)}` : '';
      const res = await fetch(`/api/public/surveys/${encodeURIComponent(slug)}/upload${query}`, {
        method: 'POST',
        body: form,
      });
	  if (flowEpochRef.current !== epoch) return;
      if (res.ok) {
        const data = await res.json();
        setFileUrls(prev => ({ ...prev, [questionId]: data.url }));
		setFileUploadIds(prev => ({ ...prev, [questionId]: data.upload_id }));
        setAnswers(prev => ({ ...prev, [questionId]: data.filename || file.name }));
		return;
      }
	  const payload = await res.json().catch(() => ({}));
	  setValidationError(typeof payload.error === 'string' ? payload.error : 'No se pudo subir el archivo.');
    } catch {
	  if (flowEpochRef.current === epoch) setValidationError('Error al subir archivo.');
    } finally {
	  if (flowEpochRef.current === epoch) setUploading(false);
    }
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        const target = e.target;
        if (target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement || (target instanceof HTMLElement && target.isContentEditable)) return;
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goNext]);

  const b = survey?.branding || {};
  const accent = b.accent_color || '#10b981';
  const bgColor = b.bg_color || '#ffffff';
  const textColor = b.text_color || '#0f172a';
  const fontFamily = b.font_family || 'Inter';
  const titleSizeMap: Record<string, string> = { sm: '1.25rem', md: '1.75rem', lg: '2.25rem', xl: '3rem' };
  const titlePx = titleSizeMap[b.title_size || 'lg'] || '2.25rem';
  const btnStyleMap: Record<string, string> = { rounded: 'rounded-lg', pill: 'rounded-full', square: 'rounded-none' };
  const btnClass = btnStyleMap[b.button_style || 'rounded'] || 'rounded-lg';
  const alignCenter = b.question_align === 'center';
  const buttonForeground = (() => {
    const luminance = (hex: string) => {
      const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    if (!/^#[0-9A-Fa-f]{6}$/.test(accent)) return '#FFFFFF';
    const backgroundLuminance = luminance(accent);
    const whiteContrast = 1.05 / (backgroundLuminance + 0.05);
    const darkLuminance = luminance('#0F172A');
    const darkContrast = (Math.max(backgroundLuminance, darkLuminance) + 0.05) / (Math.min(backgroundLuminance, darkLuminance) + 0.05);
    return whiteContrast >= darkContrast ? '#FFFFFF' : '#0F172A';
  })();
  const logoClass = b.logo_size === 'sm' ? 'h-8' : b.logo_size === 'lg' ? 'h-16' : 'h-12';
  const fontUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily)}:wght@400;500;600;700&display=swap`;

  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center" style={{ backgroundColor: bgColor }}>
        <link href={fontUrl} rel="stylesheet" />
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: accent }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center p-8" style={{ backgroundColor: bgColor }}>
        <AlertCircle className="w-12 h-12 text-slate-400 mb-4" />
        <p className="text-lg text-slate-600">{error}</p>
      </div>
    );
  }

  if (!survey) return null;

  // Thank you screen
  if (submitted) {
    const redirectURL = safeSurveyRedirect(survey.thank_you_redirect_url || '');
    const finish = () => {
      if (redirectURL) {
        window.location.assign(redirectURL);
        return;
      }
      setCloseBlocked(false);
      window.close();
      window.setTimeout(() => setCloseBlocked(true), 250);
    };
    return (
      <div className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden px-6 py-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]" style={{ backgroundColor: bgColor, color: textColor, fontFamily: `'${fontFamily}', sans-serif` }}>
        <link href={fontUrl} rel="stylesheet" />
        {b.bg_image_url && <><div className="absolute inset-0 bg-cover" style={{ backgroundImage: `url(${b.bg_image_url})`, backgroundPosition: b.bg_position || 'center' }} /><div className="absolute inset-0 bg-black" style={{ opacity: Number(b.bg_overlay || 0) }} /></>}
        <div className="survey-step-enter relative z-10 flex w-full max-w-lg flex-col items-center text-center motion-reduce:animate-none">
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full" style={{ backgroundColor: accent + '20' }}>
          <Check className="w-8 h-8" style={{ color: accent }} />
        </div>
        <h1 className="text-3xl font-bold mb-3 text-center" style={{ color: textColor, fontSize: titlePx }}>
          {survey.thank_you_title || '¡Gracias!'}
        </h1>
        <p className="text-lg text-center max-w-md" style={{ color: textColor, opacity: 0.6 }}>
          {survey.thank_you_message || 'Tus respuestas han sido registradas exitosamente.'}
        </p>
        <button type="button" onClick={finish} className={`mt-8 inline-flex min-h-12 items-center justify-center gap-2 px-7 font-semibold shadow-md transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 motion-reduce:transform-none motion-reduce:transition-none ${btnClass}`} style={{ backgroundColor: accent, color: buttonForeground, '--tw-ring-color': accent } as React.CSSProperties}>{redirectURL ? <>Continuar <ArrowRight className="h-4 w-4" /></> : 'Cerrar'}</button>
        {closeBlocked && <p className="mt-4 max-w-sm text-sm leading-6 opacity-65" role="status">Tu respuesta ya fue enviada. El navegador no permitió cerrar esta pestaña; puedes cerrarla manualmente con tranquilidad.</p>}
        </div>
      </div>
    );
  }

  // Welcome screen
  if (step === -1) {
    return (
      <div
        className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden px-6 py-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]"
        style={{
          backgroundColor: bgColor,
          fontFamily: `'${fontFamily}', sans-serif`,
        }}
      >
        <link href={fontUrl} rel="stylesheet" />
        {b.bg_image_url && (
          <>
            <div className="absolute inset-0 bg-cover" style={{ backgroundImage: `url(${b.bg_image_url})`, backgroundPosition: b.bg_position || 'center' }} />
            <div className="absolute inset-0 bg-black" style={{ opacity: Number(b.bg_overlay || 0) }} />
          </>
        )}
        <div className={`survey-step-enter relative max-w-lg motion-reduce:animate-none ${alignCenter ? 'text-center' : 'text-left'}`}>
          {b.logo_url && (
            <img src={b.logo_url} alt="" className={`${logoClass} mb-8 max-w-[70%] object-contain ${alignCenter ? 'mx-auto' : ''}`} />
          )}
          <h1 className="font-bold mb-4" style={{ color: textColor, fontSize: titlePx }}>
            {survey.welcome_title || survey.name}
          </h1>
          {survey.welcome_description && (
            <p className="text-lg mb-8" style={{ color: textColor, opacity: 0.6 }}>{survey.welcome_description}</p>
          )}
          <button
            onClick={goNext}
            disabled={submitting}
            className={`inline-flex min-h-12 items-center gap-2 px-8 py-3.5 ${btnClass} font-semibold text-lg shadow-md transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 motion-reduce:transform-none motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-60`}
            style={{ backgroundColor: accent, color: buttonForeground, '--tw-ring-color': accent } as React.CSSProperties}
          >
            Comenzar <ArrowRight className="w-5 h-5" />
          </button>
          <p className="text-sm mt-6" style={{ color: textColor, opacity: 0.4 }}>{questions.length} pregunta{questions.length !== 1 ? 's' : ''}</p>
        </div>
      </div>
    );
  }

  // Question screen
  if (!currentQuestion) return null;

  const progress = ((step + 1) / questions.length) * 100;

  return (
    <div ref={containerRef} className="flex min-h-[100dvh] flex-col overflow-hidden" style={{ backgroundColor: bgColor, color: textColor, fontFamily: `'${fontFamily}', sans-serif`, '--survey-accent': accent } as React.CSSProperties}>
      <link href={fontUrl} rel="stylesheet" />
      {/* Progress bar */}
      <div className="fixed top-0 left-0 right-0 h-1 bg-slate-100 z-50">
        <div className="h-full transition-[width] duration-[180ms] ease-out motion-reduce:transition-none" style={{ width: `${progress}%`, backgroundColor: accent }} />
      </div>

      {/* Question */}
      <div className="flex min-h-[32rem] flex-1 items-center justify-center px-6 py-[max(4rem,env(safe-area-inset-top))] pb-[max(6rem,env(safe-area-inset-bottom))] sm:px-8">
        <div key={currentQuestion.id} className={`survey-step-enter w-full max-w-xl motion-reduce:animate-none ${alignCenter ? 'text-center' : 'text-left'}`}>
          {/* Question number */}
          <div className={`flex items-center gap-2 mb-4 ${alignCenter ? 'justify-center' : ''}`}>
            <span className="text-sm font-medium" style={{ color: accent }}>{step + 1}</span>
            <span className="text-sm" style={{ color: textColor, opacity: 0.4 }}>/ {questions.length}</span>
            {currentQuestion.required && <span className="text-xs text-red-400">*</span>}
          </div>

          {/* Title */}
          <h2 className="font-bold mb-2" style={{ color: textColor, fontSize: `calc(${titlePx} * 0.75)` }}>
            {currentQuestion.title}
          </h2>
          {currentQuestion.description && (
            <p className="text-base mb-8" style={{ color: textColor, opacity: 0.5 }}>{currentQuestion.description}</p>
          )}

          {/* Input */}
          <div className="mb-8">
            <QuestionInput
              question={currentQuestion}
              value={answers[currentQuestion.id] || ''}
              onChange={(val) => { ensureSessionStarted(); setAnswers(prev => ({ ...prev, [currentQuestion.id]: val })); }}
              onFileUpload={(file) => handleFileUpload(currentQuestion.id, file)}
              fileUrl={fileUrls[currentQuestion.id]}
              uploading={uploading}
              disabled={submitting}
              accent={accent}
            />
          </div>

          {/* Validation error */}
          {validationError && (
            <p className="mb-4 flex items-center gap-1 text-sm text-red-500" role="alert">
              <AlertCircle className="w-4 h-4" /> {validationError}
            </p>
          )}

          {/* Next button */}
          <button
            onClick={goNext}
            disabled={submitting || uploading}
            className={`inline-flex min-h-12 items-center gap-2 px-6 py-3 ${btnClass} font-medium shadow-md transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 motion-reduce:transform-none motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-60`}
            style={{ backgroundColor: accent, color: buttonForeground, '--tw-ring-color': accent } as React.CSSProperties}
          >
            {submitting ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Enviando...</>
            ) : step === questions.length - 1 ? (
              <><Check className="w-4 h-4" /> Enviar</>
            ) : (
              <>Siguiente <ArrowRight className="w-4 h-4" /></>
            )}
          </button>

          <p className="text-xs mt-4" style={{ color: textColor, opacity: 0.4 }}>
            Presiona <kbd className="px-1.5 py-0.5 bg-slate-100 rounded" style={{ color: textColor, opacity: 0.5 }}>Enter ↵</kbd> para continuar
          </p>
        </div>
      </div>

      {/* Navigation */}
      <div className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] flex flex-col gap-1">
        <button aria-label="Pregunta anterior" onClick={goPrev} disabled={submitting || uploading || navigationHistory.length === 0} className="p-2 rounded-lg bg-white shadow border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-30">
          <ChevronUp className="w-4 h-4" />
        </button>
        <button aria-label="Siguiente pregunta" onClick={goNext} disabled={submitting || uploading} className="p-2 rounded-lg bg-white shadow border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-30">
          <ChevronDown className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Question Input Renderer ────────────────────────────────────────────────

function QuestionInput({ question, value, onChange, onFileUpload, fileUrl, uploading, disabled, accent }: {
  question: Question; value: string; onChange: (v: string) => void;
  onFileUpload: (f: File) => void; fileUrl?: string; uploading: boolean; disabled: boolean; accent: string;
}) {
  const config = question.config || {};

  switch (question.type) {
    case 'short_text':
    case 'email':
    case 'phone':
      return (
        <input
          autoFocus
          disabled={disabled}
          type={question.type === 'email' ? 'email' : question.type === 'phone' ? 'tel' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={config.placeholder || (question.type === 'email' ? 'nombre@ejemplo.com' : question.type === 'phone' ? '+51 999 999 999' : 'Escribe tu respuesta...')}
          className="survey-focus w-full border-b-2 border-slate-200 bg-transparent py-3 text-xl outline-none transition-colors duration-200 motion-reduce:transition-none"
          style={{ '--tw-ring-color': accent } as React.CSSProperties}
        />
      );

    case 'long_text':
      return (
        <textarea
          autoFocus
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={config.placeholder || 'Escribe tu respuesta...'}
          rows={4}
          className="survey-focus w-full resize-y border-b-2 border-slate-200 bg-transparent py-3 text-lg outline-none transition-colors duration-200 motion-reduce:transition-none"
        />
      );

    case 'single_choice':
      return (
        <div className="space-y-2">
          {(config.options || []).map((opt, i) => (
            <button
              key={i}
              disabled={disabled}
              onClick={() => onChange(opt)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left transition-all ${
                value === opt ? 'bg-emerald-50 border-emerald-500 text-emerald-700' : 'border-slate-200 hover:border-slate-300 text-slate-700'
              }`}
              style={value === opt ? { borderColor: accent, backgroundColor: accent + '10', color: accent } : {}}
            >
              <span className={`w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                value === opt ? 'border-emerald-500' : 'border-slate-300'
              }`} style={value === opt ? { borderColor: accent } : {}}>
                {value === opt && <span className="w-3 h-3 rounded-full" style={{ backgroundColor: accent }} />}
              </span>
              <span className="flex-1 font-medium">{opt}</span>
              <span className="text-xs text-slate-400 uppercase font-medium">{String.fromCharCode(65 + i)}</span>
            </button>
          ))}
        </div>
      );

    case 'multiple_choice': {
      const selected: string[] = value ? (() => { try { return JSON.parse(value); } catch { return []; } })() : [];
      const toggle = (opt: string) => {
        const newSel = selected.includes(opt) ? selected.filter(s => s !== opt) : [...selected, opt];
        onChange(JSON.stringify(newSel));
      };
      return (
        <div className="space-y-2">
          {(config.options || []).map((opt, i) => (
            <button
              key={i}
              disabled={disabled}
              onClick={() => toggle(opt)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left transition-all ${
                selected.includes(opt) ? 'bg-emerald-50 border-emerald-500' : 'border-slate-200 hover:border-slate-300'
              }`}
              style={selected.includes(opt) ? { borderColor: accent, backgroundColor: accent + '10' } : {}}
            >
              <span className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                selected.includes(opt) ? 'border-emerald-500 bg-emerald-500' : 'border-slate-300'
              }`} style={selected.includes(opt) ? { borderColor: accent, backgroundColor: accent } : {}}>
                {selected.includes(opt) && <Check className="w-3 h-3 text-white" />}
              </span>
              <span className="flex-1 font-medium text-slate-700">{opt}</span>
            </button>
          ))}
        </div>
      );
    }

    case 'rating': {
      const max = config.max_rating || 5;
      const current = parseInt(value) || 0;
      return (
        <div className="flex items-center gap-2">
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              disabled={disabled}
              onClick={() => onChange(String(n))}
              className="transition-transform hover:scale-110"
            >
              <Star
                className={`w-10 h-10 ${n <= current ? 'fill-amber-400 text-amber-400' : 'text-slate-200'}`}
              />
            </button>
          ))}
          {current > 0 && <span className="ml-3 text-lg font-medium text-slate-600">{current}/{max}</span>}
        </div>
      );
    }

    case 'likert': {
      const scale = config.likert_scale || 5;
      const current = parseInt(value) || 0;
      return (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-slate-400">{config.likert_min || '1'}</span>
            <span className="text-sm text-slate-400">{config.likert_max || String(scale)}</span>
          </div>
          <div className="flex items-center gap-2">
            {Array.from({ length: scale }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                disabled={disabled}
                onClick={() => onChange(String(n))}
                className={`flex-1 py-3 rounded-xl border-2 font-medium text-lg transition-all ${
                  current === n ? 'text-white' : 'border-slate-200 text-slate-600 hover:border-slate-300'
                }`}
                style={current === n ? { backgroundColor: accent, borderColor: accent } : {}}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      );
    }

    case 'date':
      return (
        <input
          type="date"
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="survey-focus w-full border-b-2 border-slate-200 bg-transparent py-3 text-xl outline-none transition-colors duration-200 motion-reduce:transition-none"
        />
      );

    case 'file_upload':
      return (
        <div>
          {fileUrl ? (
            <div className="flex items-center gap-3 p-4 bg-emerald-50 rounded-xl border border-emerald-200">
              <Check className="w-5 h-5 text-emerald-600" />
              <span className="text-sm text-emerald-700 font-medium">{value || 'Archivo subido'}</span>
            </div>
          ) : (
            <label className={`flex h-40 w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 transition-colors ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-slate-400'}`}>
              {uploading ? (
                <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
              ) : (
                <>
                  <Upload className="w-8 h-8 text-slate-400 mb-2" />
                  <span className="text-sm text-slate-500">Haz clic para subir un archivo</span>
                  <span className="text-xs text-slate-400 mt-1">Máximo {config.max_size_mb || 10}MB</span>
                </>
              )}
              <input
                type="file"
                disabled={disabled}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onFileUpload(file);
                }}
              />
            </label>
          )}
        </div>
      );

    default:
      return (
        <input
          autoFocus
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Escribe tu respuesta..."
          className="survey-focus w-full border-b-2 border-slate-200 bg-transparent py-3 text-xl outline-none transition-colors duration-200 motion-reduce:transition-none"
        />
      );
  }
}
