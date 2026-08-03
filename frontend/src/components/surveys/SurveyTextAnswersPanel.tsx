"use client";

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, MessageSquareText, RotateCcw } from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { api } from '@/lib/api';
import type { SurveyTextAnswer, SurveyTextAnswersPage } from '@/types/survey';

const PAGE_SIZE = 25;
const PREVIEW_LENGTH = 320;

export default function SurveyTextAnswersPanel({ surveyId, questionId, answerCount, programAudience }: {
  surveyId: string;
  questionId: string;
  answerCount: number;
  programAudience: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [answers, setAnswers] = useState<SurveyTextAnswer[]>([]);
  const [total, setTotal] = useState(answerCount);
  const [nextCursor, setNextCursor] = useState('');
  const [retryCursor, setRetryCursor] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    requestRef.current?.abort();
    generationRef.current += 1;
    setOpen(false);
    setLoaded(false);
    setAnswers([]);
    setTotal(answerCount);
    setNextCursor('');
    setRetryCursor('');
    setLoading(false);
    setError('');
    setExpanded(new Set());
    return () => requestRef.current?.abort();
  }, [answerCount, questionId, surveyId]);

  const load = async (cursor = '') => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const generation = ++generationRef.current;
    setLoading(true);
    setError('');
    setRetryCursor(cursor);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor) params.set('cursor', cursor);
    const response = await api<SurveyTextAnswersPage>(`/api/surveys/${surveyId}/questions/${questionId}/text-answers?${params}`, { signal: controller.signal });
    if (controller.signal.aborted || generation !== generationRef.current) return;
    setLoading(false);
    if (!response.success || !response.data) {
      setError(response.error || 'No se pudieron cargar las respuestas de texto.');
      return;
    }
    const incoming = response.data.items || [];
    setAnswers(current => {
      if (!cursor) return incoming;
      const byId = new Map(current.map(answer => [answer.id, answer]));
      incoming.forEach(answer => byId.set(answer.id, answer));
      return Array.from(byId.values());
    });
    setTotal(response.data.total);
    setNextCursor(response.data.next_cursor || '');
    setLoaded(true);
  };

  const toggle = () => {
    if (open) {
      requestRef.current?.abort();
      generationRef.current += 1;
      setLoading(false);
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!loaded) void load();
  };

  const toggleAnswer = (id: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const errorState = error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
    <p>{error}</p>
    <button type="button" onClick={() => void load(retryCursor)} className="mt-2 inline-flex min-h-10 items-center gap-2 font-semibold underline"><RotateCcw className="h-4 w-4" />Reintentar</button>
  </div> : null;

  return <div className="rounded-xl border border-slate-200 bg-slate-50/70">
    <button type="button" onClick={toggle} aria-expanded={open} aria-controls={`text-answers-${questionId}`} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-semibold text-slate-700 hover:bg-slate-100">
      <MessageSquareText className="h-4 w-4 shrink-0 text-emerald-600" />
      <span className="min-w-0 flex-1">{answerCount} {answerCount === 1 ? 'respuesta de texto' : 'respuestas de texto'}</span>
      {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
    </button>
    {open && <div id={`text-answers-${questionId}`} className="border-t border-slate-200 p-3">
      {loading && answers.length === 0 ? <div className="flex min-h-24 items-center justify-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin text-emerald-600" />Cargando respuestas…</div> : answers.length === 0 && errorState ? errorState : answers.length === 0 ? <p className="p-5 text-center text-sm text-slate-500">No hay respuestas de texto completadas.</p> : <div className="space-y-2">
        {answers.map(answer => {
          const isLong = answer.value.length > PREVIEW_LENGTH;
          const showFull = expanded.has(answer.id);
          const value = isLong && !showFull ? `${answer.value.slice(0, PREVIEW_LENGTH)}…` : answer.value;
          return <article key={answer.id} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-slate-600">{programAudience ? (answer.contact_name || 'Participante sin identidad disponible') : 'Respuesta anónima'}</p><time className="text-[11px] text-slate-400" dateTime={answer.completed_at}>{format(new Date(answer.completed_at), 'd MMM yyyy, HH:mm', { locale: es })}</time></div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{value}</p>
            {isLong && <button type="button" onClick={() => toggleAnswer(answer.id)} className="mt-2 min-h-10 text-xs font-semibold text-emerald-700">{showFull ? 'Ver menos' : 'Ver completo'}</button>}
          </article>;
        })}
        {errorState || (nextCursor && <button type="button" disabled={loading} onClick={() => void load(nextCursor)} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700 disabled:opacity-50">{loading && <Loader2 className="h-4 w-4 animate-spin" />}Cargar más ({answers.length} de {total})</button>)}
      </div>}
    </div>}
  </div>;
}
