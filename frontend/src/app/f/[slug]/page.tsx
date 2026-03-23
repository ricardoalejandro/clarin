"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import {
  ChevronDown, ChevronUp, Check, Star, Upload, Loader2,
  ArrowRight, AlertCircle
} from 'lucide-react';

interface SurveyBranding {
  logo_url?: string;
  bg_color?: string;
  accent_color?: string;
  bg_image_url?: string;
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

export default function PublicFormPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [survey, setSurvey] = useState<SurveyData | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // -1 = welcome, 0..n-1 = questions, n = thank you
  const [step, setStep] = useState(-1);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [startedAt] = useState(new Date().toISOString());
  const [respondentToken] = useState(() => crypto.randomUUID());
  const [validationError, setValidationError] = useState('');
  const [uploading, setUploading] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchSurvey();
  }, [slug]);

  const fetchSurvey = async () => {
    try {
      const res = await fetch(`/api/public/surveys/${encodeURIComponent(slug)}`);
      if (!res.ok) {
        setError('Encuesta no encontrada o no está activa.');
        return;
      }
      const data = await res.json();
      setSurvey(data.survey);
      setQuestions(data.questions || []);
      // If no welcome screen, start at first question
      if (!data.survey.welcome_title && !data.survey.welcome_description) {
        setStep(0);
      }
    } catch {
      setError('Error al cargar la encuesta.');
    } finally {
      setLoading(false);
    }
  };

  const currentQuestion = step >= 0 && step < questions.length ? questions[step] : null;

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
        if (jumpIdx >= 0) return jumpIdx;
      }
    }
    return null;
  }, [questions]);

  const goNext = useCallback(async () => {
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
      setStep(0);
      return;
    }

    if (currentQuestion) {
      // Check logic rules
      const jumpIdx = evaluateLogic(currentQuestion, answers[currentQuestion.id] || '');
      if (jumpIdx !== null) {
        if (jumpIdx >= questions.length) {
          await submitResponses();
        } else {
          setStep(jumpIdx);
        }
        return;
      }
    }

    if (step < questions.length - 1) {
      setStep(step + 1);
    } else {
      await submitResponses();
    }
  }, [step, currentQuestion, answers, fileUrls, questions, evaluateLogic]);

  const goPrev = () => {
    setValidationError('');
    if (step > (survey?.welcome_title || survey?.welcome_description ? -1 : 0)) {
      setStep(step - 1);
    }
  };

  const submitResponses = async () => {
    setSubmitting(true);
    try {
      const answersList = questions
        .filter(q => answers[q.id] || fileUrls[q.id])
        .map(q => ({
          question_id: q.id,
          value: answers[q.id] || '',
          file_url: fileUrls[q.id] || '',
        }));

      const res = await fetch(`/api/public/surveys/${encodeURIComponent(slug)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          respondent_token: respondentToken,
          source: 'direct',
          started_at: startedAt,
          answers: answersList,
        }),
      });

      if (res.ok) {
        setSubmitted(true);
        if (survey?.thank_you_redirect_url) {
          setTimeout(() => {
            window.location.href = survey.thank_you_redirect_url;
          }, 2000);
        }
      }
    } catch {
      setValidationError('Error al enviar respuestas. Intenta nuevamente.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFileUpload = async (questionId: string, file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/public/surveys/${encodeURIComponent(slug)}/upload`, {
        method: 'POST',
        body: form,
      });
      if (res.ok) {
        const data = await res.json();
        setFileUrls(prev => ({ ...prev, [questionId]: data.url }));
        setAnswers(prev => ({ ...prev, [questionId]: data.filename || file.name }));
      }
    } catch {
      setValidationError('Error al subir archivo.');
    } finally {
      setUploading(false);
    }
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
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
  const fontUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily)}:wght@400;500;600;700&display=swap`;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: bgColor }}>
        <link href={fontUrl} rel="stylesheet" />
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: accent }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-8" style={{ backgroundColor: bgColor }}>
        <AlertCircle className="w-12 h-12 text-slate-400 mb-4" />
        <p className="text-lg text-slate-600">{error}</p>
      </div>
    );
  }

  if (!survey) return null;

  // Thank you screen
  if (submitted) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-8" style={{ backgroundColor: bgColor, fontFamily: `'${fontFamily}', sans-serif` }}>
        <link href={fontUrl} rel="stylesheet" />
        <div className="w-16 h-16 rounded-full flex items-center justify-center mb-6" style={{ backgroundColor: accent + '20' }}>
          <Check className="w-8 h-8" style={{ color: accent }} />
        </div>
        <h1 className="text-3xl font-bold mb-3 text-center" style={{ color: textColor, fontSize: titlePx }}>
          {survey.thank_you_title || '¡Gracias!'}
        </h1>
        <p className="text-lg text-center max-w-md" style={{ color: textColor, opacity: 0.6 }}>
          {survey.thank_you_message || 'Tus respuestas han sido registradas exitosamente.'}
        </p>
        {survey.thank_you_redirect_url && (
          <p className="text-sm mt-4" style={{ color: textColor, opacity: 0.4 }}>Redirigiendo...</p>
        )}
      </div>
    );
  }

  // Welcome screen
  if (step === -1) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center p-8 relative"
        style={{
          backgroundColor: bgColor,
          fontFamily: `'${fontFamily}', sans-serif`,
        }}
      >
        <link href={fontUrl} rel="stylesheet" />
        {b.bg_image_url && (
          <>
            <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${b.bg_image_url})` }} />
            <div className="absolute inset-0" style={{ backgroundColor: `rgba(0,0,0,${b.bg_overlay || '0'})` }} />
          </>
        )}
        <div className={`relative max-w-lg ${alignCenter ? 'text-center' : 'text-left'}`}>
          {b.logo_url && (
            <img src={b.logo_url} alt="" className={`h-12 mb-8 object-contain ${alignCenter ? 'mx-auto' : ''}`} />
          )}
          <h1 className="font-bold mb-4" style={{ color: textColor, fontSize: titlePx }}>
            {survey.welcome_title || survey.name}
          </h1>
          {survey.welcome_description && (
            <p className="text-lg mb-8" style={{ color: textColor, opacity: 0.6 }}>{survey.welcome_description}</p>
          )}
          <button
            onClick={goNext}
            className={`inline-flex items-center gap-2 px-8 py-4 ${btnClass} text-white font-semibold text-lg shadow-lg hover:shadow-xl transition-all transform hover:scale-[1.02]`}
            style={{ backgroundColor: accent }}
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
    <div ref={containerRef} className="min-h-screen flex flex-col" style={{ backgroundColor: bgColor, fontFamily: `'${fontFamily}', sans-serif` }}>
      <link href={fontUrl} rel="stylesheet" />
      {/* Progress bar */}
      <div className="fixed top-0 left-0 right-0 h-1 bg-slate-100 z-50">
        <div className="h-full transition-all duration-500" style={{ width: `${progress}%`, backgroundColor: accent }} />
      </div>

      {/* Question */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className={`w-full max-w-xl ${alignCenter ? 'text-center' : 'text-left'}`}>
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
              onChange={(val) => setAnswers(prev => ({ ...prev, [currentQuestion.id]: val }))}
              onFileUpload={(file) => handleFileUpload(currentQuestion.id, file)}
              fileUrl={fileUrls[currentQuestion.id]}
              uploading={uploading}
              accent={accent}
            />
          </div>

          {/* Validation error */}
          {validationError && (
            <p className="text-sm text-red-500 mb-4 flex items-center gap-1">
              <AlertCircle className="w-4 h-4" /> {validationError}
            </p>
          )}

          {/* Next button */}
          <button
            onClick={goNext}
            disabled={submitting}
            className={`inline-flex items-center gap-2 px-6 py-3 ${btnClass} text-white font-medium shadow-md hover:shadow-lg transition-all`}
            style={{ backgroundColor: accent }}
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
      <div className="fixed bottom-4 right-4 flex flex-col gap-1">
        <button onClick={goPrev} disabled={step <= (survey.welcome_title ? -1 : 0)} className="p-2 rounded-lg bg-white shadow border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-30">
          <ChevronUp className="w-4 h-4" />
        </button>
        <button onClick={goNext} className="p-2 rounded-lg bg-white shadow border border-slate-200 text-slate-600 hover:bg-slate-50">
          <ChevronDown className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Question Input Renderer ────────────────────────────────────────────────

function QuestionInput({ question, value, onChange, onFileUpload, fileUrl, uploading, accent }: {
  question: Question; value: string; onChange: (v: string) => void;
  onFileUpload: (f: File) => void; fileUrl?: string; uploading: boolean; accent: string;
}) {
  const config = question.config || {};

  switch (question.type) {
    case 'short_text':
    case 'email':
    case 'phone':
      return (
        <input
          autoFocus
          type={question.type === 'email' ? 'email' : question.type === 'phone' ? 'tel' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={config.placeholder || (question.type === 'email' ? 'nombre@ejemplo.com' : question.type === 'phone' ? '+51 999 999 999' : 'Escribe tu respuesta...')}
          className="w-full border-b-2 border-slate-200 focus:border-emerald-500 bg-transparent text-xl py-3 focus:outline-none transition-colors"
          style={{ '--tw-ring-color': accent } as React.CSSProperties}
        />
      );

    case 'long_text':
      return (
        <textarea
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={config.placeholder || 'Escribe tu respuesta...'}
          rows={4}
          className="w-full border-b-2 border-slate-200 focus:border-emerald-500 bg-transparent text-lg py-3 focus:outline-none transition-colors resize-none"
        />
      );

    case 'single_choice':
      return (
        <div className="space-y-2">
          {(config.options || []).map((opt, i) => (
            <button
              key={i}
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
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full border-b-2 border-slate-200 focus:border-emerald-500 bg-transparent text-xl py-3 focus:outline-none transition-colors"
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
            <label className="flex flex-col items-center justify-center w-full h-40 border-2 border-dashed border-slate-300 rounded-xl cursor-pointer hover:border-slate-400 transition-colors">
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
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Escribe tu respuesta..."
          className="w-full border-b-2 border-slate-200 focus:border-emerald-500 bg-transparent text-xl py-3 focus:outline-none transition-colors"
        />
      );
  }
}
