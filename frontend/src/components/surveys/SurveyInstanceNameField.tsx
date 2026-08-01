"use client";

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, WandSparkles, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { SEARCH_DEBOUNCE_MS } from '@/lib/useDebouncedValue';

interface NameAvailability {
  available: boolean;
  suggested_name: string;
}

interface SurveyInstanceNameFieldProps {
  templateId: string;
  programId?: string;
  value: string;
  onChange: (value: string) => void;
  onAvailabilityChange?: (available: boolean | null) => void;
  autoFocus?: boolean;
}

export default function SurveyInstanceNameField({ templateId, programId, value, onChange, onAvailabilityChange, autoFocus }: SurveyInstanceNameFieldProps) {
  const [state, setState] = useState<NameAvailability | null>(null);
  const [checking, setChecking] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);

  useEffect(() => { onAvailabilityChange?.(state?.available ?? null); }, [onAvailabilityChange, state]);

  useEffect(() => {
    if (!templateId) return;
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    const sequence = ++sequenceRef.current;
    setChecking(true);
    const suffix = programId ? `&program_id=${encodeURIComponent(programId)}` : '';
    void api<NameAvailability>(`/api/survey-templates/${templateId}/instance-name?name=${suffix}`, { signal: controller.signal }).then(response => {
      if (controller.signal.aborted || sequence !== sequenceRef.current) return;
      if (response.success && response.data) {
        onChange(response.data.suggested_name);
        setState(response.data);
      }
      setChecking(false);
    });
    return () => controller.abort();
  }, [onChange, programId, templateId]);

  useEffect(() => {
    if (!templateId || !value.trim()) {
      setState(null);
      return;
    }
    const timer = window.setTimeout(() => {
      const controller = new AbortController();
      requestRef.current?.abort();
      requestRef.current = controller;
      const sequence = ++sequenceRef.current;
      setChecking(true);
      const suffix = programId ? `&program_id=${encodeURIComponent(programId)}` : '';
      void api<NameAvailability>(`/api/survey-templates/${templateId}/instance-name?name=${encodeURIComponent(value)}${suffix}`, { signal: controller.signal }).then(response => {
        if (controller.signal.aborted || sequence !== sequenceRef.current) return;
        setState(response.success && response.data ? response.data : null);
        setChecking(false);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [programId, templateId, value]);

  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-700">Nombre de esta aplicación</span>
      <div className="relative">
        <input
          autoFocus={autoFocus}
          value={value}
          onChange={event => onChange(event.target.value)}
          maxLength={180}
          aria-describedby="survey-instance-name-help"
          aria-invalid={state?.available === false}
          className={`min-h-11 w-full rounded-xl border px-3 pr-10 text-sm outline-none focus:ring-2 ${state?.available === false ? 'border-rose-300 focus:border-rose-500 focus:ring-rose-500/15' : 'border-slate-200 focus:border-emerald-500 focus:ring-emerald-500/15'}`}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
          {checking ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : state?.available ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : state ? <XCircle className="h-4 w-4 text-rose-500" /> : null}
        </span>
      </div>
      <div id="survey-instance-name-help" className="mt-1.5 min-h-5 text-xs" aria-live="polite">
        {state?.available === false ? (
          <span className="flex flex-wrap items-center gap-2 text-rose-600">Ese nombre ya existe en esta plantilla.
            <button type="button" onClick={() => onChange(state.suggested_name)} className="inline-flex min-h-8 items-center gap-1 rounded-lg bg-rose-50 px-2 font-semibold text-rose-700 hover:bg-rose-100"><WandSparkles className="h-3.5 w-3.5" />Usar “{state.suggested_name}”</button>
          </span>
        ) : <span className="text-slate-400">El nombre identifica esta aplicación en resultados e historial.</span>}
      </div>
    </label>
  );
}
